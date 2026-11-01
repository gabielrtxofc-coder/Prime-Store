-- ============================================================================
-- 0012 FUNCOES ADMIN
-- Funções administrativas protegidas por allowlist + MFA.
-- ============================================================================

--

CREATE FUNCTION public.admin_add_stock_unit(p_product_id uuid, p_email_enc_b64 text, p_password_enc_b64 text, p_fingerprint text, p_notes text DEFAULT ''::text, p_import_batch_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_actor uuid := public.assert_admin();
  v_unit public.stock_units;
begin
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_fingerprint' using errcode = '22023';
  end if;

  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'product_not_found' using errcode = 'P0002';
  end if;

  begin
    insert into public.stock_units (
      product_id, account_email_enc, account_password_enc, credential_fingerprint,
      notes, import_batch_id, created_by
    )
    values (p_product_id, decode(p_email_enc_b64, 'base64'), decode(p_password_enc_b64, 'base64'),
            p_fingerprint, coalesce(p_notes, ''), p_import_batch_id, v_actor)
    returning * into v_unit;
  exception
    when unique_violation then
      raise exception 'duplicate_credential' using errcode = '23505';
  end;

  perform public.log_admin_action('stock_unit_added', 'stock_unit', v_unit.id::text,
    jsonb_build_object('product_id', p_product_id));

  return jsonb_build_object('id', v_unit.id, 'status', v_unit.status, 'created_at', v_unit.created_at);
end;
$_$;

--

CREATE FUNCTION public.admin_audit_log(p_limit integer DEFAULT 50) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_items jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at desc), '[]'::jsonb)
    into v_items
  from (
    select * from public.admin_audit_log
    order by created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
  ) l;

  return v_items;
end;
$$;

--

CREATE FUNCTION public.admin_create_product(p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_product public.products;
begin
  insert into public.products (
    slug, name, short_description, description, image_url, category_id,
    price_cents, cost_cents, access_validity_days, access_validity_label,
    instructions, conditions, modality, period, monogram, theme,
    max_quantity_per_order, is_featured, is_active, created_by, updated_by
  )
  values (
    btrim(p_payload ->> 'slug'),
    btrim(p_payload ->> 'name'),
    coalesce(p_payload ->> 'short_description', ''),
    coalesce(p_payload ->> 'description', ''),
    nullif(btrim(coalesce(p_payload ->> 'image_url', '')), ''),
    btrim(p_payload ->> 'category_id'),
    (p_payload ->> 'price_cents')::integer,
    coalesce((p_payload ->> 'cost_cents')::integer, 0),
    nullif(p_payload ->> 'access_validity_days', '')::integer,
    coalesce(p_payload ->> 'access_validity_label', ''),
    coalesce(p_payload ->> 'instructions', ''),
    coalesce(
      (select array_agg(value) from jsonb_array_elements_text(coalesce(p_payload -> 'conditions', '[]'::jsonb)) as value),
      '{}'::text[]
    ),
    coalesce(p_payload ->> 'modality', ''),
    coalesce(p_payload ->> 'period', ''),
    coalesce(p_payload ->> 'monogram', ''),
    coalesce(p_payload ->> 'theme', 'blue'),
    coalesce((p_payload ->> 'max_quantity_per_order')::integer, 1),
    coalesce((p_payload ->> 'is_featured')::boolean, false),
    coalesce((p_payload ->> 'is_active')::boolean, true),
    v_actor, v_actor
  )
  returning * into v_product;

  perform public.log_admin_action('product_created', 'product', v_product.id::text,
    jsonb_build_object('name', v_product.name, 'price_cents', v_product.price_cents, 'cost_cents', v_product.cost_cents));

  return to_jsonb(v_product);
end;
$$;

--

CREATE FUNCTION public.admin_expire_reservations() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_released integer;
begin
  v_released := public.expire_overdue_reservations(null);
  perform public.log_admin_action('reservations_expired_sweep', 'system', null,
    jsonb_build_object('released_units', v_released));
  return jsonb_build_object('released_units', v_released);
end;
$$;

--

CREATE FUNCTION public.admin_get_order(p_order_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_order jsonb;
  v_payments jsonb;
  v_delivery jsonb;
  v_events jsonb;
  v_units jsonb;
  v_refunds jsonb;
begin
  select to_jsonb(o) - 'client_token_hash' into v_order from public.orders o where o.id = p_order_id;
  if v_order is null then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc), '[]'::jsonb)
    into v_payments from public.payments p where p.order_id = p_order_id;

  select to_jsonb(d) - 'token_hash' - 'token_enc'
    into v_delivery from public.deliveries d where d.order_id = p_order_id;

  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc), '[]'::jsonb)
    into v_events from public.order_events e where e.order_id = p_order_id;

  select coalesce(jsonb_agg(to_jsonb(rr) order by rr.created_at desc), '[]'::jsonb)
    into v_refunds from public.refund_requests rr where rr.order_id = p_order_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'stock_unit_id', su.id,
           'status', su.status,
           'sold_at', su.sold_at,
           'notes', su.notes
         ) order by su.id), '[]'::jsonb)
    into v_units
  from public.stock_units su
  where su.sold_order_id = p_order_id;

  perform public.log_admin_action('order_viewed', 'order', p_order_id::text, '{}'::jsonb);

  return jsonb_build_object(
    'order', v_order,
    'payments', v_payments,
    'delivery', v_delivery,
    'delivery_units', v_units,
    'events', v_events,
    'refund_requests', v_refunds
  );
end;
$$;

--

CREATE FUNCTION public.admin_get_product(p_product_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_product jsonb;
  v_history jsonb;
begin
  select to_jsonb(p) into v_product from public.products p where p.id = p_product_id;
  if v_product is null then
    raise exception 'product_not_found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(to_jsonb(h) order by h.changed_at desc), '[]'::jsonb)
    into v_history
  from public.product_price_history h
  where h.product_id = p_product_id;

  return jsonb_build_object('product', v_product, 'price_history', v_history);
end;
$$;

--

CREATE FUNCTION public.admin_import_stock_units(p_product_id uuid, p_rows jsonb, p_rejected jsonb DEFAULT '[]'::jsonb, p_file_name text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_actor uuid := public.assert_admin();
  v_batch public.import_batches;
  v_row jsonb;
  v_imported integer := 0;
  v_duplicates integer := 0;
  v_invalid integer := 0;
  v_failures jsonb := '[]'::jsonb;
  v_total integer := 0;
begin
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'product_not_found' using errcode = 'P0002';
  end if;

  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'invalid_rows' using errcode = '22023';
  end if;

  insert into public.import_batches (product_id, file_name, created_by)
  values (p_product_id, left(coalesce(p_file_name, ''), 200), v_actor)
  returning * into v_batch;

  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    v_total := v_total + 1;
    begin
      if coalesce(v_row ->> 'fingerprint', '') !~ '^[0-9a-f]{64}$' then
        raise exception 'invalid_fingerprint' using errcode = '22023';
      end if;

      insert into public.stock_units (
        product_id, account_email_enc, account_password_enc, credential_fingerprint,
        notes, import_batch_id, created_by
      )
      values (
        p_product_id,
        decode(v_row ->> 'email_enc', 'base64'),
        decode(v_row ->> 'password_enc', 'base64'),
        v_row ->> 'fingerprint',
        left(coalesce(v_row ->> 'notes', ''), 500),
        v_batch.id,
        v_actor
      );
      v_imported := v_imported + 1;
    exception
      when unique_violation then
        v_duplicates := v_duplicates + 1;
        v_failures := v_failures || jsonb_build_object(
          'row_number', (v_row ->> 'row_number')::integer,
          'reason', 'duplicate_credential'
        );
      when others then
        v_invalid := v_invalid + 1;
        v_failures := v_failures || jsonb_build_object(
          'row_number', (v_row ->> 'row_number')::integer,
          'reason', 'invalid_row'
        );
    end;
  end loop;

  for v_row in select * from jsonb_array_elements(coalesce(p_rejected, '[]'::jsonb))
  loop
    v_total := v_total + 1;
    v_invalid := v_invalid + 1;
    v_failures := v_failures || jsonb_build_object(
      'row_number', (v_row ->> 'row_number')::integer,
      'reason', coalesce(v_row ->> 'reason', 'invalid_row')
    );
  end loop;

  update public.import_batches
     set total_rows = v_total,
         accepted_rows = v_imported,
         rejected_rows = v_total - v_imported
   where id = v_batch.id;

  perform public.log_admin_action('stock_imported', 'import_batch', v_batch.id::text,
    jsonb_build_object(
      'product_id', p_product_id,
      'total', v_total,
      'imported', v_imported,
      'duplicates', v_duplicates,
      'invalid', v_invalid
    ));

  return jsonb_build_object(
    'batch_id', v_batch.id,
    'total_rows', v_total,
    'imported', v_imported,
    'duplicates', v_duplicates,
    'invalid', v_invalid,
    'failures', v_failures
  );
end;
$_$;

--

CREATE FUNCTION public.admin_indicators() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_result jsonb;
begin
  select jsonb_build_object(
    'orders_total', (select count(*) from public.orders),
    'orders_pending_payment', (select count(*) from public.orders where status = 'pending_payment'),
    'orders_paid', (select count(*) from public.orders where status = 'paid'),
    'orders_expired', (select count(*) from public.orders where status = 'expired'),
    'orders_refund_pending', (select count(*) from public.orders where status = 'refund_pending'),
    'orders_failed', (select count(*) from public.orders where status = 'failed'),
    'revenue_total_cents', coalesce((select sum(total_cents) from public.orders where payment_status = 'approved' and status in ('paid', 'refund_pending')), 0),
    'revenue_30d_cents', coalesce((select sum(total_cents) from public.orders where payment_status = 'approved' and status in ('paid', 'refund_pending') and created_at >= now() - interval '30 days'), 0),
    'units_sold', (select count(*) from public.stock_units where status = 'sold'),
    'units_available', (select count(*) from public.stock_units where status = 'available'),
    'units_reserved', (select count(*) from public.stock_units where status = 'reserved'),
    'active_reservations', (select count(*) from public.stock_reservations where status = 'active' and expires_at > now()),
    'open_refund_requests', (select count(*) from public.refund_requests where status in ('pending', 'authorized')),
    'deliveries_active', (select count(*) from public.deliveries where status = 'active'),
    'deliveries_revoked', (select count(*) from public.deliveries where status = 'revoked'),
    'products_active', (select count(*) from public.products where is_active and archived_at is null),
    'products_inactive', (select count(*) from public.products where not is_active and archived_at is null),
    'low_stock_products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'available_units', coalesce(s.available_units, 0)
             ) order by coalesce(s.available_units, 0), p.name)
      from public.products p
      left join (
        select product_id, count(*) as available_units
        from public.stock_units where status = 'available' group by product_id
      ) s on s.product_id = p.id
      where p.is_active and p.archived_at is null and coalesce(s.available_units, 0) <= 2
    ), '[]'::jsonb),
    'generated_at', now()
  ) into v_result;

  return v_result;
end;
$$;

--

CREATE FUNCTION public.admin_list_orders(p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_payment_status text DEFAULT NULL::text, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_problem_only boolean DEFAULT false, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_items jsonb;
  v_total integer;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  select count(*) into v_total
  from public.orders o
  where (p_status is null or o.status::text = p_status)
    and (p_payment_status is null or o.payment_status::text = p_payment_status)
    and (p_from is null or o.created_at >= p_from)
    and (p_to is null or o.created_at <= p_to)
    and (not p_problem_only or o.status in ('refund_pending', 'failed') or o.payment_status = 'amount_mismatch')
    and (
      p_search is null or btrim(p_search) = ''
      or o.reference ilike '%' || btrim(p_search) || '%'
      or o.product_name ilike '%' || btrim(p_search) || '%'
    );

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc), '[]'::jsonb)
    into v_items
  from (
    select
      o.id, o.reference, o.product_id, o.product_name, o.quantity,
      o.unit_price_cents, o.total_cents, o.status, o.payment_status,
      o.delivery_status, o.created_at, o.paid_at, o.reservation_expires_at,
      d.id as delivery_id, d.status as delivery_link_status,
      (select count(*) from public.refund_requests rr
        where rr.order_id = o.id and rr.status in ('pending', 'authorized')) as open_refund_requests
    from public.orders o
    left join public.deliveries d on d.order_id = o.id
    where (p_status is null or o.status::text = p_status)
      and (p_payment_status is null or o.payment_status::text = p_payment_status)
      and (p_from is null or o.created_at >= p_from)
      and (p_to is null or o.created_at <= p_to)
      and (not p_problem_only or o.status in ('refund_pending', 'failed') or o.payment_status = 'amount_mismatch')
      and (
        p_search is null or btrim(p_search) = ''
        or o.reference ilike '%' || btrim(p_search) || '%'
        or o.product_name ilike '%' || btrim(p_search) || '%'
      )
    order by o.created_at desc
    limit v_limit offset greatest(coalesce(p_offset, 0), 0)
  ) t;

  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', coalesce(p_offset, 0));
end;
$$;

--

CREATE FUNCTION public.admin_list_products(p_search text DEFAULT NULL::text, p_include_inactive boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_result jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.name), '[]'::jsonb)
    into v_result
  from (
    select
      p.id, p.slug, p.name, p.category_id, c.label as category_label,
      p.price_cents, p.cost_cents,
      (p.price_cents - p.cost_cents) as margin_cents,
      p.is_active, p.is_featured, p.max_quantity_per_order,
      p.access_validity_days, p.access_validity_label,
      p.short_description, p.description, p.instructions, p.conditions,
      p.modality, p.period, p.monogram, p.theme, p.image_url,
      p.created_at, p.updated_at,
      coalesce(s.available_units, 0) as available_units,
      coalesce(s.reserved_units, 0) as reserved_units,
      coalesce(s.sold_units, 0) as sold_units
    from public.products p
    join public.product_categories c on c.id = p.category_id
    left join (
      select product_id,
             count(*) filter (where status = 'available') as available_units,
             count(*) filter (where status = 'reserved') as reserved_units,
             count(*) filter (where status = 'sold') as sold_units
      from public.stock_units
      group by product_id
    ) s on s.product_id = p.id
    where p.archived_at is null
      and (p_include_inactive or p.is_active)
      and (
        p_search is null or btrim(p_search) = ''
        or p.name ilike '%' || btrim(p_search) || '%'
        or p.slug ilike '%' || btrim(p_search) || '%'
      )
  ) t;

  return v_result;
end;
$$;

--

CREATE FUNCTION public.admin_list_refund_requests(p_status text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_items jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc), '[]'::jsonb)
    into v_items
  from (
    select rr.*, o.reference, o.product_name, o.status as order_status,
           o.payment_status, o.delivery_status
    from public.refund_requests rr
    join public.orders o on o.id = rr.order_id
    where p_status is null or rr.status = p_status
  ) t;

  return v_items;
end;
$$;

--

CREATE FUNCTION public.admin_list_stock(p_product_id uuid DEFAULT NULL::uuid, p_status text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_include_credentials boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_items jsonb;
  v_total integer;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
begin
  select count(*) into v_total
  from public.stock_units su
  where (p_product_id is null or su.product_id = p_product_id)
    and (p_status is null or su.status::text = p_status)
    and (
      p_search is null or btrim(p_search) = ''
      or su.notes ilike '%' || btrim(p_search) || '%'
      or su.credential_fingerprint like btrim(p_search) || '%'
    );

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc), '[]'::jsonb)
    into v_items
  from (
    select
      su.id, su.product_id, p.name as product_name, su.status, su.notes,
      su.credential_fingerprint,
      su.import_batch_id, su.sold_order_id, su.sold_at, su.created_at, su.updated_at,
      case when p_include_credentials then encode(su.account_email_enc, 'base64') end as email_enc,
      case when p_include_credentials then encode(su.account_password_enc, 'base64') end as password_enc,
      r.expires_at as reservation_expires_at,
      r.order_id as reservation_order_id
    from public.stock_units su
    join public.products p on p.id = su.product_id
    left join public.stock_reservation_units sru
      on sru.stock_unit_id = su.id and sru.released_at is null
    left join public.stock_reservations r
      on r.id = sru.reservation_id and r.status = 'active'
    where (p_product_id is null or su.product_id = p_product_id)
      and (p_status is null or su.status::text = p_status)
      and (
        p_search is null or btrim(p_search) = ''
        or su.notes ilike '%' || btrim(p_search) || '%'
        or su.credential_fingerprint like btrim(p_search) || '%'
      )
    order by su.created_at desc
    limit v_limit offset greatest(coalesce(p_offset, 0), 0)
  ) t;

  if p_include_credentials then
    perform public.log_admin_action('stock_credentials_listed', 'stock_unit', null,
      jsonb_build_object('product_id', p_product_id, 'count', jsonb_array_length(v_items)));
  end if;

  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', coalesce(p_offset, 0));
end;
$$;

--

CREATE FUNCTION public.admin_resolve_refund(p_refund_id uuid, p_status text, p_notes text DEFAULT ''::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_refund public.refund_requests;
begin
  if p_status not in ('authorized', 'processed', 'rejected') then
    raise exception 'invalid_refund_status' using errcode = '22023';
  end if;

  select * into v_refund from public.refund_requests where id = p_refund_id for update;
  if not found then
    raise exception 'refund_not_found' using errcode = 'P0002';
  end if;

  if v_refund.status in ('processed', 'rejected') then
    return jsonb_build_object('id', v_refund.id, 'status', v_refund.status, 'already_resolved', true);
  end if;

  update public.refund_requests
     set status = p_status,
         notes = case when p_notes = '' then notes else left(p_notes, 1000) end,
         resolved_at = case when p_status in ('processed', 'rejected') then now() else resolved_at end,
         resolved_by = v_actor
   where id = p_refund_id
   returning * into v_refund;

  if p_status = 'processed' then
    update public.orders
       set status = 'refunded',
           delivery_status = 'revoked'
     where id = v_refund.order_id;

    update public.deliveries
       set status = 'revoked',
           revoked_at = coalesce(revoked_at, now()),
           revoked_by = v_actor,
           revoke_reason = coalesce(revoke_reason, 'Reembolso processado')
     where order_id = v_refund.order_id and status = 'active';

    insert into public.order_events (order_id, event_type, actor, actor_user_id, metadata)
    values (v_refund.order_id, 'refund_processed', 'admin', v_actor,
            jsonb_build_object('refund_id', v_refund.id));
  end if;

  if p_status = 'rejected' then
    insert into public.order_events (order_id, event_type, actor, actor_user_id, metadata)
    values (v_refund.order_id, 'refund_rejected', 'admin', v_actor,
            jsonb_build_object('refund_id', v_refund.id));
  end if;

  perform public.log_admin_action('refund_' || p_status, 'refund_request', v_refund.id::text,
    jsonb_build_object('order_id', v_refund.order_id, 'status', p_status));

  return jsonb_build_object('id', v_refund.id, 'status', v_refund.status, 'already_resolved', false);
end;
$$;

--

CREATE FUNCTION public.admin_revoke_delivery(p_delivery_id uuid, p_reason text DEFAULT 'Revogada por administrador'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_delivery public.deliveries;
begin
  select * into v_delivery from public.deliveries where id = p_delivery_id for update;
  if not found then
    raise exception 'delivery_not_found' using errcode = 'P0002';
  end if;

  if v_delivery.status = 'revoked' then
    return jsonb_build_object('id', v_delivery.id, 'status', 'revoked', 'already_revoked', true);
  end if;

  update public.deliveries
     set status = 'revoked',
         revoked_at = now(),
         revoked_by = v_actor,
         revoke_reason = left(p_reason, 500)
   where id = p_delivery_id
   returning * into v_delivery;

  update public.orders
     set delivery_status = 'revoked'
   where id = v_delivery.order_id;

  insert into public.order_events (order_id, event_type, actor, actor_user_id, metadata)
  values (v_delivery.order_id, 'delivery_revoked', 'admin', v_actor,
          jsonb_build_object('delivery_id', v_delivery.id, 'reason', left(p_reason, 500)));

  perform public.log_admin_action('delivery_revoked', 'delivery', v_delivery.id::text,
    jsonb_build_object('order_id', v_delivery.order_id, 'reason', left(p_reason, 500)));

  return jsonb_build_object('id', v_delivery.id, 'status', 'revoked', 'already_revoked', false);
end;
$$;

--

CREATE FUNCTION public.admin_rotate_delivery_token(p_delivery_id uuid, p_token_hash text, p_token_enc_b64 text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_actor uuid := public.assert_admin();
  v_delivery public.deliveries;
begin
  select * into v_delivery from public.deliveries where id = p_delivery_id for update;
  if not found then
    raise exception 'delivery_not_found' using errcode = 'P0002';
  end if;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_token_hash' using errcode = '22023';
  end if;

  update public.deliveries
     set token_hash = p_token_hash,
         token_enc = decode(p_token_enc_b64, 'base64'),
         status = 'active',
         revoked_at = null,
         revoked_by = null,
         revoke_reason = null
   where id = p_delivery_id
   returning * into v_delivery;

  update public.orders set delivery_status = 'ready' where id = v_delivery.order_id;

  perform public.log_admin_action('delivery_token_rotated', 'delivery', v_delivery.id::text, '{}'::jsonb);

  return jsonb_build_object('id', v_delivery.id, 'status', v_delivery.status);
end;
$_$;

--

CREATE FUNCTION public.admin_set_product_active(p_product_id uuid, p_active boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_product public.products;
begin
  update public.products
     set is_active = p_active, updated_by = v_actor
   where id = p_product_id
   returning * into v_product;

  if not found then
    raise exception 'product_not_found' using errcode = 'P0002';
  end if;

  perform public.log_admin_action(
    case when p_active then 'product_activated' else 'product_deactivated' end,
    'product', v_product.id::text, '{}'::jsonb
  );

  return to_jsonb(v_product);
end;
$$;

--

CREATE FUNCTION public.admin_set_stock_unit_status(p_stock_unit_id uuid, p_status text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_unit public.stock_units;
begin
  if p_status not in ('available', 'disabled') then
    raise exception 'invalid_status_change' using errcode = '22023';
  end if;

  select * into v_unit from public.stock_units where id = p_stock_unit_id for update;
  if not found then
    raise exception 'stock_unit_not_found' using errcode = 'P0002';
  end if;

  if v_unit.status not in ('available', 'disabled') then
    raise exception 'stock_unit_not_toggleable' using errcode = 'P0001';
  end if;

  update public.stock_units set status = p_status::public.stock_unit_status where id = p_stock_unit_id;

  perform public.log_admin_action('stock_unit_status_changed', 'stock_unit', v_unit.id::text,
    jsonb_build_object('from', v_unit.status, 'to', p_status));

  return jsonb_build_object('id', v_unit.id, 'status', p_status);
end;
$$;

--

CREATE FUNCTION public.admin_stock_fingerprints(p_product_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_result jsonb;
begin
  select coalesce(jsonb_agg(credential_fingerprint), '[]'::jsonb)
    into v_result
  from public.stock_units
  where product_id = p_product_id;

  return v_result;
end;
$$;

--

CREATE FUNCTION public.admin_stock_summary() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_result jsonb;
begin
  select jsonb_build_object(
    'available', count(*) filter (where status = 'available'),
    'reserved', count(*) filter (where status = 'reserved'),
    'sold', count(*) filter (where status = 'sold'),
    'disabled', count(*) filter (where status = 'disabled'),
    'total', count(*)
  ) into v_result
  from public.stock_units;

  return v_result;
end;
$$;

--

CREATE FUNCTION public.admin_update_product(p_product_id uuid, p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_product public.products;
begin
  update public.products p
     set slug = coalesce(nullif(btrim(p_payload ->> 'slug'), ''), p.slug),
         name = coalesce(nullif(btrim(p_payload ->> 'name'), ''), p.name),
         short_description = coalesce(p_payload ->> 'short_description', p.short_description),
         description = coalesce(p_payload ->> 'description', p.description),
         image_url = case when p_payload ? 'image_url'
                          then nullif(btrim(coalesce(p_payload ->> 'image_url', '')), '')
                          else p.image_url end,
         category_id = coalesce(nullif(btrim(p_payload ->> 'category_id'), ''), p.category_id),
         price_cents = coalesce((p_payload ->> 'price_cents')::integer, p.price_cents),
         cost_cents = coalesce((p_payload ->> 'cost_cents')::integer, p.cost_cents),
         access_validity_days = case when p_payload ? 'access_validity_days'
                                     then nullif(p_payload ->> 'access_validity_days', '')::integer
                                     else p.access_validity_days end,
         access_validity_label = coalesce(p_payload ->> 'access_validity_label', p.access_validity_label),
         instructions = coalesce(p_payload ->> 'instructions', p.instructions),
         conditions = case when p_payload ? 'conditions'
                           then coalesce((select array_agg(value) from jsonb_array_elements_text(p_payload -> 'conditions') as value), '{}'::text[])
                           else p.conditions end,
         modality = coalesce(p_payload ->> 'modality', p.modality),
         period = coalesce(p_payload ->> 'period', p.period),
         monogram = coalesce(p_payload ->> 'monogram', p.monogram),
         theme = coalesce(p_payload ->> 'theme', p.theme),
         max_quantity_per_order = coalesce((p_payload ->> 'max_quantity_per_order')::integer, p.max_quantity_per_order),
         is_featured = coalesce((p_payload ->> 'is_featured')::boolean, p.is_featured),
         is_active = coalesce((p_payload ->> 'is_active')::boolean, p.is_active),
         updated_by = v_actor
   where p.id = p_product_id
   returning * into v_product;

  if not found then
    raise exception 'product_not_found' using errcode = 'P0002';
  end if;

  perform public.log_admin_action('product_updated', 'product', v_product.id::text,
    jsonb_build_object('fields', (select jsonb_agg(key) from jsonb_object_keys(p_payload) as key)));

  return to_jsonb(v_product);
end;
$$;

--

CREATE FUNCTION public.admin_update_stock_unit(p_stock_unit_id uuid, p_email_enc_b64 text DEFAULT NULL::text, p_password_enc_b64 text DEFAULT NULL::text, p_fingerprint text DEFAULT NULL::text, p_notes text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_unit public.stock_units;
begin
  select * into v_unit from public.stock_units where id = p_stock_unit_id for update;
  if not found then
    raise exception 'stock_unit_not_found' using errcode = 'P0002';
  end if;
  if v_unit.status <> 'available' then
    raise exception 'stock_unit_not_editable' using errcode = 'P0001';
  end if;

  begin
    update public.stock_units
       set account_email_enc = coalesce(decode(p_email_enc_b64, 'base64'), account_email_enc),
           account_password_enc = coalesce(decode(p_password_enc_b64, 'base64'), account_password_enc),
           credential_fingerprint = coalesce(p_fingerprint, credential_fingerprint),
           notes = coalesce(p_notes, notes)
     where id = p_stock_unit_id
     returning * into v_unit;
  exception
    when unique_violation then
      raise exception 'duplicate_credential' using errcode = '23505';
  end;

  perform public.log_admin_action('stock_unit_updated', 'stock_unit', v_unit.id::text, '{}'::jsonb);
  return jsonb_build_object('id', v_unit.id, 'status', v_unit.status);
end;
$$;
