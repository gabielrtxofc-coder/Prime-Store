-- ============================================================================
-- 0011 FUNCOES NUCLEO
-- Funções de negócio: reserva, pedido, pagamento, entrega.
-- ============================================================================

--

CREATE FUNCTION public.allocate_late_units(p_order_id uuid, p_product_id uuid, p_quantity integer) RETURNS uuid[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_units uuid[];
  v_reservation_id uuid;
  v_updated integer;
begin
  perform 1 from public.products where id = p_product_id for update;

  select array_agg(id order by id) into v_units
  from (
    select id
    from public.stock_units
    where product_id = p_product_id
      and status = 'available'
    order by created_at, id
    limit p_quantity
    for update skip locked
  ) candidate;

  if v_units is null or array_length(v_units, 1) < p_quantity then
    return null;
  end if;

  -- Reserva já nasce consumida: não há janela de pagamento restante.
  insert into public.stock_reservations (order_id, status, quantity, starts_at, expires_at, ended_at)
  values (p_order_id, 'consumed', p_quantity, now(), now() + interval '30 minutes', now())
  returning id into v_reservation_id;

  insert into public.stock_reservation_units (reservation_id, stock_unit_id)
  select v_reservation_id, unnest(v_units);

  update public.stock_units
     set status = 'sold', sold_order_id = p_order_id, sold_at = now()
   where id = any (v_units)
     and status = 'available';
  get diagnostics v_updated = row_count;

  if v_updated <> p_quantity then
    raise exception 'late_allocation_conflict'
      using errcode = 'P0001',
            detail = format('expected %s units, updated %s', p_quantity, v_updated);
  end if;

  return v_units;
end;
$$;

--

CREATE FUNCTION public.apply_payment_status(p_order_id uuid, p_provider_payment_id text, p_provider_status text, p_status_detail text, p_amount_cents integer, p_delivery_token_hash text DEFAULT NULL::text, p_delivery_token_enc_b64 text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_order public.orders;
  v_payment public.payments;
  v_units uuid[];
  v_delivery public.deliveries;
  v_mapped public.payment_status;
  v_status text := lower(coalesce(p_provider_status, ''));
  v_result text;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  v_mapped := case v_status
                when 'approved' then 'approved'
                when 'in_process' then 'in_process'
                when 'pending' then 'pending'
                when 'rejected' then 'rejected'
                when 'cancelled' then 'cancelled'
                when 'refunded' then 'refunded'
                when 'charged_back' then 'charged_back'
                else 'pending'
              end;

  -- Localiza a cobrança pelo id do provedor; se não existir, usa a cobrança
  -- aberta do pedido ou cria um registro (notificação de pagamento inédito).
  select * into v_payment
  from public.payments
  where (p_provider_payment_id is not null and provider_payment_id = p_provider_payment_id)
     or (order_id = p_order_id and status in ('pending', 'in_process'))
  order by (provider_payment_id is not distinct from p_provider_payment_id) desc, created_at desc
  limit 1
  for update;

  if v_payment.id is null then
    insert into public.payments (
      order_id, provider_payment_id, status, status_detail, amount_cents, approved_at
    )
    values (
      p_order_id, p_provider_payment_id, v_mapped, p_status_detail,
      coalesce(p_amount_cents, v_order.total_cents),
      case when v_mapped = 'approved' then now() else null end
    )
    returning * into v_payment;
  else
    update public.payments
       set provider_payment_id = coalesce(provider_payment_id, p_provider_payment_id),
           status = v_mapped,
           status_detail = p_status_detail,
           approved_at = case when v_mapped = 'approved' then coalesce(approved_at, now()) else approved_at end,
           updated_at = now()
     where id = v_payment.id
     returning * into v_payment;
  end if;

  -- 1) Divergência de valor: nunca entregar; abrir pendência de análise.
  if p_amount_cents is not null and p_amount_cents <> v_order.total_cents then
    update public.payments set status = 'amount_mismatch' where id = v_payment.id;
    update public.orders
       set payment_status = 'amount_mismatch',
           delivery_status = case when delivery_status = 'ready' then 'blocked'::public.delivery_status
                                  else delivery_status end
     where id = p_order_id;

    if not exists (
      select 1 from public.refund_requests
      where order_id = p_order_id and status in ('pending', 'authorized')
    ) then
      insert into public.refund_requests (order_id, reason, provider_payment_id, amount_cents, created_by, notes)
      values (p_order_id, 'payment_amount_mismatch', p_provider_payment_id,
              coalesce(p_amount_cents, v_order.total_cents), 'system',
              'Valor recebido difere do valor do pedido. Entrega bloqueada.');
    end if;

    insert into public.order_events (order_id, event_type, actor, metadata)
    values (p_order_id, 'payment_amount_mismatch', 'system',
            jsonb_build_object('expected', v_order.total_cents, 'received', p_amount_cents));

    return jsonb_build_object(
      'result', 'amount_mismatch',
      'order_status', 'failed',
      'payment_status', 'amount_mismatch'
    );
  end if;

  -- 2) Pagamento confirmado.
  if v_mapped = 'approved' then
    if v_order.payment_status = 'approved'
       and v_order.status in ('paid', 'refund_pending', 'refunded') then
      -- Recuperação: pagamento já confirmado, mas a entrega ainda não existe
      -- (por exemplo, webhook processado sem chave de criptografia). Cria a
      -- entrega a partir das unidades efetivamente vendidas, sem duplicar.
      if v_order.status = 'paid'
         and p_delivery_token_hash is not null
         and p_delivery_token_enc_b64 is not null
         and not exists (select 1 from public.deliveries where order_id = p_order_id) then
        insert into public.deliveries (order_id, token_hash, token_enc)
        values (p_order_id, p_delivery_token_hash, decode(p_delivery_token_enc_b64, 'base64'))
        on conflict (order_id) do nothing;

        select * into v_delivery from public.deliveries where order_id = p_order_id;

        insert into public.delivery_units (delivery_id, stock_unit_id)
        select v_delivery.id, su.id
        from public.stock_units su
        where su.sold_order_id = p_order_id
        on conflict do nothing;

        insert into public.order_events (order_id, event_type, actor, metadata)
        values (p_order_id, 'delivery_created', 'system',
                jsonb_build_object('recovered', true, 'delivery_id', v_delivery.id));
      end if;

      return jsonb_build_object(
        'result', 'already_applied',
        'order_status', v_order.status,
        'payment_status', v_order.payment_status,
        'delivery_status', v_order.delivery_status,
        'delivery_id', (select id from public.deliveries where order_id = p_order_id)
      );
    end if;

    v_result := 'approved';
    v_units := public.consume_reservation(p_order_id, v_order);

    if v_units is null then
      v_units := public.allocate_late_units(p_order_id, v_order.product_id, v_order.quantity);

      if v_units is null then
        update public.orders
           set status = 'refund_pending',
               payment_status = 'approved',
               paid_at = coalesce(paid_at, now()),
               delivery_status = 'blocked'
         where id = p_order_id;

        if not exists (
          select 1 from public.refund_requests
          where order_id = p_order_id and status in ('pending', 'authorized')
        ) then
          insert into public.refund_requests (order_id, reason, provider_payment_id, amount_cents, created_by, notes)
          values (p_order_id, 'paid_without_stock', p_provider_payment_id,
                  coalesce(p_amount_cents, v_order.total_cents), 'system',
                  'PIX aprovado após expiração da reserva e sem estoque disponível. Reembolso manual.');
        end if;

        insert into public.order_events (order_id, event_type, actor, metadata)
        values (p_order_id, 'payment_approved_without_stock', 'provider',
                jsonb_build_object('provider_payment_id', p_provider_payment_id));

        return jsonb_build_object(
          'result', 'approved_without_stock',
          'order_status', 'refund_pending',
          'payment_status', 'approved',
          'delivery_status', 'blocked'
        );
      end if;

      insert into public.order_events (order_id, event_type, actor, metadata)
      values (p_order_id, 'stock_allocated_after_expiry', 'system',
              jsonb_build_object('units', to_jsonb(v_units)));
    end if;

    update public.orders
       set status = 'paid',
           payment_status = 'approved',
           paid_at = coalesce(paid_at, now()),
           delivery_status = 'ready'
     where id = p_order_id;

    if p_delivery_token_hash is not null and p_delivery_token_enc_b64 is not null then
      insert into public.deliveries (order_id, token_hash, token_enc)
      values (p_order_id, p_delivery_token_hash, decode(p_delivery_token_enc_b64, 'base64'))
      on conflict (order_id) do nothing;

      select * into v_delivery from public.deliveries where order_id = p_order_id;

      if v_delivery.id is not null then
        insert into public.delivery_units (delivery_id, stock_unit_id)
        select v_delivery.id, unnest(v_units)
        on conflict do nothing;
      end if;
    end if;

    insert into public.order_events (order_id, event_type, actor, metadata)
    values (p_order_id, 'payment_approved', 'provider',
            jsonb_build_object(
              'provider_payment_id', p_provider_payment_id,
              'status_detail', p_status_detail,
              'units', to_jsonb(v_units)
            ));

    return jsonb_build_object(
      'result', v_result,
      'order_status', 'paid',
      'payment_status', 'approved',
      'delivery_status', 'ready'
    );
  end if;

  -- 3) Pagamento recusado/cancelado/expirado: libera estoque imediatamente.
  if v_mapped in ('rejected', 'cancelled') then
    update public.orders
       set payment_status = v_mapped
     where id = p_order_id
       and status <> 'paid';

    if v_order.status = 'pending_payment' then
      perform public.release_order_reservation(
        p_order_id,
        case when v_status in ('cancelled', 'expired') then 'expired' else 'released' end
      );
    end if;

    insert into public.order_events (order_id, event_type, actor, metadata)
    values (p_order_id, 'payment_' || v_mapped::text, 'provider',
            jsonb_build_object('provider_payment_id', p_provider_payment_id, 'status_detail', p_status_detail));

    return jsonb_build_object(
      'result', v_mapped::text,
      'order_status', (select status from public.orders where id = p_order_id),
      'payment_status', v_mapped,
      'delivery_status', (select delivery_status from public.orders where id = p_order_id)
    );
  end if;

  -- 4) Estorno / chargeback: revoga a entrega e fecha a pendência de reembolso.
  if v_mapped in ('refunded', 'charged_back') then
    update public.orders
       set payment_status = v_mapped,
           status = 'refunded',
           delivery_status = 'revoked'
     where id = p_order_id;

    update public.deliveries
       set status = 'revoked',
           revoked_at = coalesce(revoked_at, now()),
           revoke_reason = coalesce(revoke_reason, 'Estorno confirmado pelo provedor')
     where order_id = p_order_id and status = 'active';

    update public.refund_requests
       set status = 'processed',
           resolved_at = coalesce(resolved_at, now()),
           notes = case when notes = '' then 'Estorno confirmado pelo provedor' else notes end
     where order_id = p_order_id and status in ('pending', 'authorized');

    insert into public.order_events (order_id, event_type, actor, metadata)
    values (p_order_id, 'payment_' || v_mapped::text, 'provider',
            jsonb_build_object('provider_payment_id', p_provider_payment_id));

    return jsonb_build_object(
      'result', v_mapped::text,
      'order_status', 'refunded',
      'payment_status', v_mapped,
      'delivery_status', 'revoked'
    );
  end if;

  -- 5) Pendente / em processamento: apenas reflete o estado real.
  update public.orders
     set payment_status = v_mapped
   where id = p_order_id
     and status = 'pending_payment';

  insert into public.order_events (order_id, event_type, actor, metadata)
  values (p_order_id, 'payment_' || v_mapped::text, 'provider',
          jsonb_build_object('provider_payment_id', p_provider_payment_id, 'status_detail', p_status_detail));

  return jsonb_build_object(
    'result', v_mapped::text,
    'order_status', (select status from public.orders where id = p_order_id),
    'payment_status', v_mapped,
    'delivery_status', (select delivery_status from public.orders where id = p_order_id)
  );
end;
$$;

--

CREATE FUNCTION public.assert_admin() RETURNS uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_aal text := coalesce(auth.jwt() ->> 'aal', 'aal1');
  v_admin public.admin_users;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_admin from public.admin_users where user_id = v_uid and is_active;
  if not found then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  if v_admin.mfa_required and v_aal <> 'aal2' then
    raise exception 'mfa_required' using errcode = '42501';
  end if;

  return v_uid;
end;
$$;

--

CREATE FUNCTION public.attach_payment(p_order_id uuid, p_provider_payment_id text, p_provider_status text, p_amount_cents integer, p_qr_code text, p_qr_code_base64 text, p_ticket_url text, p_expires_at timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_order public.orders;
  v_payment public.payments;
  v_mapped public.payment_status;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  if v_order.status <> 'pending_payment' then
    raise exception 'order_not_pending' using errcode = 'P0001';
  end if;

  if p_amount_cents is distinct from v_order.total_cents then
    raise exception 'amount_mismatch' using errcode = 'P0001';
  end if;

  v_mapped := case lower(coalesce(p_provider_status, 'pending'))
                when 'approved' then 'approved'
                when 'in_process' then 'in_process'
                when 'pending' then 'pending'
                when 'rejected' then 'rejected'
                when 'cancelled' then 'cancelled'
                when 'refunded' then 'refunded'
                when 'charged_back' then 'charged_back'
                else 'pending'
              end;

  select * into v_payment
  from public.payments
  where order_id = p_order_id and status in ('pending', 'in_process')
  for update;

  if found then
    update public.payments
       set provider_payment_id = coalesce(p_provider_payment_id, provider_payment_id),
           status = v_mapped,
           amount_cents = p_amount_cents,
           qr_code = coalesce(p_qr_code, qr_code),
           qr_code_base64 = coalesce(p_qr_code_base64, qr_code_base64),
           ticket_url = coalesce(p_ticket_url, ticket_url),
           expires_at = coalesce(p_expires_at, expires_at),
           updated_at = now()
     where id = v_payment.id
     returning * into v_payment;
  else
    insert into public.payments (
      order_id, provider_payment_id, status, amount_cents,
      qr_code, qr_code_base64, ticket_url, expires_at
    )
    values (
      p_order_id, p_provider_payment_id, v_mapped, p_amount_cents,
      p_qr_code, p_qr_code_base64, p_ticket_url, p_expires_at
    )
    returning * into v_payment;
  end if;

  update public.orders
     set payment_status = v_mapped
   where id = p_order_id
     and payment_status not in ('approved', 'amount_mismatch');

  insert into public.order_events (order_id, event_type, actor, metadata)
  values (
    p_order_id,
    'payment_created',
    'provider',
    jsonb_build_object(
      'payment_id', v_payment.id,
      'provider_payment_id', p_provider_payment_id,
      'status', v_mapped,
      'amount_cents', p_amount_cents,
      'expires_at', p_expires_at
    )
  );

  return jsonb_build_object(
    'payment_id', v_payment.id,
    'status', v_payment.status,
    'qr_code', v_payment.qr_code,
    'qr_code_base64', v_payment.qr_code_base64,
    'ticket_url', v_payment.ticket_url,
    'expires_at', v_payment.expires_at
  );
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--

CREATE FUNCTION public.consume_reservation(p_order_id uuid, p_order public.orders) RETURNS uuid[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_reservation public.stock_reservations;
  v_units uuid[];
begin
  select * into v_reservation
  from public.stock_reservations
  where order_id = p_order_id and status = 'active'
  for update;

  if not found then
    return null;
  end if;

  select array_agg(stock_unit_id order by stock_unit_id) into v_units
  from public.stock_reservation_units
  where reservation_id = v_reservation.id and released_at is null;

  update public.stock_units
     set status = 'sold', sold_order_id = p_order_id, sold_at = now()
   where id = any (v_units)
     and status = 'reserved';

  update public.stock_reservations
     set status = 'consumed', ended_at = now()
   where id = v_reservation.id;

  return v_units;
end;
$$;

--

CREATE FUNCTION public.create_order(p_product_id uuid, p_quantity integer, p_idempotency_key text, p_client_token_hash text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_product public.products;
  v_order public.orders;
  v_reservation_id uuid;
  v_available integer;
  v_reference text;
  v_attempt integer := 0;
  v_reservation_minutes integer := public.setting_int('reservation_minutes', 30);
  v_max_quantity integer := public.setting_int('max_quantity_per_order', 20);
  v_qty integer := p_quantity;
begin
  if p_client_token_hash is null or p_client_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_client_token' using errcode = '22023';
  end if;

  if v_qty is null or v_qty < 1 or v_qty > v_max_quantity then
    raise exception 'invalid_quantity' using errcode = '22023';
  end if;

  -- Serializa a criação de pedidos do mesmo produto.
  select * into v_product from public.products where id = p_product_id for update;

  if not found or v_product.archived_at is not null or not v_product.is_active then
    raise exception 'product_unavailable' using errcode = 'P0002';
  end if;

  if v_qty > v_product.max_quantity_per_order then
    raise exception 'quantity_above_product_limit'
      using errcode = '22023',
            detail = v_product.max_quantity_per_order::text;
  end if;

  -- Replay idempotente: a mesma chave devolve o mesmo pedido, rotacionando o
  -- token de consulta (quem possui a chave já podia consultar o pedido).
  if p_idempotency_key is not null then
    select * into v_order from public.orders where idempotency_key = p_idempotency_key;
    if found then
      if v_order.client_token_hash <> p_client_token_hash then
        update public.orders
           set client_token_hash = p_client_token_hash
         where id = v_order.id
         returning * into v_order;
      end if;

      return jsonb_build_object(
        'order_id', v_order.id,
        'reference', v_order.reference,
        'status', v_order.status,
        'payment_status', v_order.payment_status,
        'delivery_status', v_order.delivery_status,
        'quantity', v_order.quantity,
        'unit_price_cents', v_order.unit_price_cents,
        'total_cents', v_order.total_cents,
        'reservation_expires_at', v_order.reservation_expires_at,
        'idempotent_replay', true
      );
    end if;
  end if;

  -- Toda tentativa de reserva trata reservas vencidas antes de contar estoque.
  perform public.expire_overdue_reservations(p_product_id);

  select count(*) into v_available
  from public.stock_units
  where product_id = p_product_id and status = 'available';

  if v_available < v_qty then
    raise exception 'insufficient_stock'
      using errcode = 'P0001',
            detail = v_available::text;
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_reference := public.generate_order_reference();
    begin
      insert into public.orders (
        reference, product_id, product_name, quantity,
        unit_price_cents, total_cents, status, payment_status, delivery_status,
        client_token_hash, idempotency_key, reservation_expires_at
      )
      values (
        v_reference, v_product.id, v_product.name, v_qty,
        v_product.price_cents, v_product.price_cents * v_qty,
        'pending_payment', 'pending', 'not_ready',
        p_client_token_hash, p_idempotency_key,
        now() + make_interval(mins => v_reservation_minutes)
      )
      returning * into v_order;
      exit;
    exception
      when unique_violation then
        if v_attempt >= 5 then
          raise;
        end if;
    end;
  end loop;

  v_reservation_id := public.reserve_stock_units(
    v_order.id, v_product.id, v_qty, v_order.reservation_expires_at
  );

  insert into public.order_events (order_id, event_type, actor, metadata)
  values (
    v_order.id,
    'order_created',
    'customer',
    jsonb_build_object(
      'reservation_id', v_reservation_id,
      'quantity', v_qty,
      'reservation_expires_at', v_order.reservation_expires_at
    )
  );

  return jsonb_build_object(
    'order_id', v_order.id,
    'reference', v_order.reference,
    'status', v_order.status,
    'payment_status', v_order.payment_status,
    'delivery_status', v_order.delivery_status,
    'quantity', v_order.quantity,
    'unit_price_cents', v_order.unit_price_cents,
    'total_cents', v_order.total_cents,
    'reservation_expires_at', v_order.reservation_expires_at,
    'product', jsonb_build_object(
      'id', v_product.id,
      'name', v_product.name,
      'slug', v_product.slug,
      'instructions', v_product.instructions,
      'access_validity_label', v_product.access_validity_label
    ),
    'idempotent_replay', false
  );
end;
$_$;

--

CREATE FUNCTION public.expire_overdue_reservations(p_product_id uuid DEFAULT NULL::uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_reservation record;
  v_released integer := 0;
  v_count integer;
begin
  for v_reservation in
    select r.id, r.order_id, r.quantity
    from public.stock_reservations r
    join public.orders o on o.id = r.order_id
    where r.status = 'active'
      and r.expires_at <= now()
      and o.status = 'pending_payment'
      and (p_product_id is null or o.product_id = p_product_id)
    order by r.expires_at
    for update of r skip locked
  loop
    -- Marca as alocações como liberadas antes de devolver as unidades.
    update public.stock_reservation_units
       set released_at = now()
     where reservation_id = v_reservation.id
       and released_at is null;

    update public.stock_units su
       set status = 'available'
     where su.id in (
             select sru.stock_unit_id
               from public.stock_reservation_units sru
              where sru.reservation_id = v_reservation.id
           )
       and su.status = 'reserved';
    get diagnostics v_count = row_count;
    v_released := v_released + v_count;

    update public.stock_reservations
       set status = 'expired', ended_at = now()
     where id = v_reservation.id;

    update public.orders
       set status = 'expired'
     where id = v_reservation.order_id
       and status = 'pending_payment';

    insert into public.order_events (order_id, event_type, actor, metadata)
    values (
      v_reservation.order_id,
      'reservation_expired',
      'system',
      jsonb_build_object('reservation_id', v_reservation.id, 'released_units', v_count)
    );
  end loop;

  return v_released;
end;
$$;

--

CREATE FUNCTION public.finish_payment_event(p_event_id uuid, p_status text, p_error text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if p_status not in ('processed', 'ignored', 'failed') then
    raise exception 'invalid_event_status' using errcode = '22023';
  end if;

  update public.payment_events
     set status = p_status,
         last_error = p_error,
         processed_at = case when p_status in ('processed', 'ignored') then now() else processed_at end
   where id = p_event_id;
end;
$$;

--

CREATE FUNCTION public.generate_order_reference() RETURNS text
    LANGUAGE plpgsql
    AS $$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_result text := '';
  v_index integer;
begin
  for i in 1..6 loop
    v_index := 1 + floor(random() * length(v_alphabet))::integer;
    v_result := v_result || substr(v_alphabet, v_index, 1);
  end loop;
  return 'PS-' || v_result;
end;
$$;

--

CREATE FUNCTION public.get_catalog(p_search text DEFAULT NULL::text, p_category text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_result jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(v)::jsonb order by v.is_featured desc, v.name), '[]'::jsonb)
    into v_result
  from public.public_catalog v
  where (p_category is null or p_category = '' or v.category_id = p_category)
    and (
      p_search is null or btrim(p_search) = ''
      or v.name ilike '%' || btrim(p_search) || '%'
      or v.short_description ilike '%' || btrim(p_search) || '%'
      or v.description ilike '%' || btrim(p_search) || '%'
    );

  return jsonb_build_object('products', v_result, 'generated_at', now());
end;
$$;

--

CREATE FUNCTION public.get_order_status(p_order_id uuid, p_client_token_hash text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_order public.orders;
  v_payment public.payments;
  v_delivery public.deliveries;
  v_product public.products;
  v_units_available integer;
begin
  if p_order_id is null or p_client_token_hash is null then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and client_token_hash = p_client_token_hash;

  if not found then
    -- Mensagem uniforme: não permite descobrir se o pedido existe.
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  perform public.expire_overdue_reservations(v_order.product_id);

  select * into v_order from public.orders where id = p_order_id;

  select * into v_payment
  from public.payments
  where order_id = v_order.id
  order by created_at desc
  limit 1;

  select * into v_delivery from public.deliveries where order_id = v_order.id;

  select * into v_product from public.products where id = v_order.product_id;

  select count(*) into v_units_available
  from public.stock_units
  where product_id = v_order.product_id and status = 'available';

  return jsonb_build_object(
    'order_id', v_order.id,
    'reference', v_order.reference,
    'status', v_order.status,
    'payment_status', v_order.payment_status,
    'delivery_status', v_order.delivery_status,
    'quantity', v_order.quantity,
    'unit_price_cents', v_order.unit_price_cents,
    'total_cents', v_order.total_cents,
    'created_at', v_order.created_at,
    'paid_at', v_order.paid_at,
    'reservation_expires_at', v_order.reservation_expires_at,
    'product', jsonb_build_object(
      'id', v_product.id,
      'slug', v_product.slug,
      'name', v_product.name,
      'instructions', v_product.instructions,
      'access_validity_label', v_product.access_validity_label
    ),
    'payment', case when v_payment.id is null then null else jsonb_build_object(
      'method', v_payment.method,
      'provider_payment_id', v_payment.provider_payment_id,
      'status', v_payment.status,
      'status_detail', v_payment.status_detail,
      'amount_cents', v_payment.amount_cents,
      'qr_code', case when v_order.payment_status in ('pending', 'in_process') then v_payment.qr_code else null end,
      'qr_code_base64', case when v_order.payment_status in ('pending', 'in_process') then v_payment.qr_code_base64 else null end,
      'ticket_url', case when v_order.payment_status in ('pending', 'in_process') then v_payment.ticket_url else null end,
      'expires_at', v_payment.expires_at
    ) end,
    'delivery', case when v_delivery.id is null then null else jsonb_build_object(
      'id', v_delivery.id,
      'status', v_delivery.status,
      'token_enc', encode(v_delivery.token_enc, 'base64'),
      'created_at', v_delivery.created_at,
      'revoked_at', v_delivery.revoked_at
    ) end,
    'availability', jsonb_build_object('available_units', v_units_available)
  );
end;
$$;

--

CREATE FUNCTION public.is_admin(p_require_mfa boolean DEFAULT true) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_aal text := coalesce(auth.jwt() ->> 'aal', 'aal1');
  v_exists boolean;
begin
  if v_uid is null then
    return false;
  end if;

  select true into v_exists
  from public.admin_users
  where user_id = v_uid
    and is_active;

  if not coalesce(v_exists, false) then
    return false;
  end if;

  if p_require_mfa and v_aal <> 'aal2' then
    return false;
  end if;

  return true;
end;
$$;

--

CREATE FUNCTION public.log_admin_action(p_action text, p_entity_type text DEFAULT NULL::text, p_entity_id text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_label text;
begin
  select display_name into v_label from public.admin_users where user_id = v_uid;

  insert into public.admin_audit_log (actor_user_id, actor_label, action, entity_type, entity_id, metadata)
  values (v_uid, v_label, p_action, p_entity_type, p_entity_id, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

--

CREATE FUNCTION public.products_record_price_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if (new.price_cents is distinct from old.price_cents)
     or (new.cost_cents is distinct from old.cost_cents) then
    insert into public.product_price_history (
      product_id, old_price_cents, new_price_cents, old_cost_cents, new_cost_cents, changed_by
    ) values (
      new.id, old.price_cents, new.price_cents, old.cost_cents, new.cost_cents, auth.uid()
    );
  end if;
  return new;
end;
$$;

--

CREATE FUNCTION public.record_payment_event(p_notification_id text, p_event_type text, p_action text, p_data_id text, p_signature_valid boolean, p_payload_hash text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_event public.payment_events;
begin
  if p_notification_id is not null then
    select * into v_event
    from public.payment_events
    where provider = 'mercado_pago' and notification_id = p_notification_id;

    if found then
      update public.payment_events
         set attempts = attempts + 1
       where id = v_event.id
       returning * into v_event;

      return jsonb_build_object(
        'event_id', v_event.id,
        'duplicate', true,
        'status', v_event.status
      );
    end if;
  end if;

  insert into public.payment_events (
    notification_id, event_type, action, data_id, signature_valid, payload_hash
  )
  values (p_notification_id, p_event_type, p_action, p_data_id, p_signature_valid, p_payload_hash)
  returning * into v_event;

  return jsonb_build_object(
    'event_id', v_event.id,
    'duplicate', false,
    'status', v_event.status
  );
end;
$$;

--

CREATE FUNCTION public.release_order_reservation(p_order_id uuid, p_reason text DEFAULT 'released'::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_order public.orders;
  v_released integer;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return;
  end if;

  if v_order.status <> 'pending_payment' then
    return;
  end if;

  update public.stock_reservation_units sru
     set released_at = now()
    from public.stock_reservations r
   where sru.reservation_id = r.id
     and r.order_id = p_order_id
     and r.status = 'active'
     and sru.released_at is null;

  update public.stock_units su
     set status = 'available'
   where su.id in (
           select sru.stock_unit_id
             from public.stock_reservation_units sru
             join public.stock_reservations r on r.id = sru.reservation_id
            where r.order_id = p_order_id
              and r.status = 'active'
         )
     and su.status = 'reserved';
  get diagnostics v_released = row_count;

  update public.stock_reservations
     set status = case when p_reason = 'expired' then 'expired'::public.reservation_status
                       else 'released'::public.reservation_status end,
         ended_at = now()
   where order_id = p_order_id and status = 'active';

  update public.orders
     set status = case when p_reason = 'expired' then 'expired'::public.order_status
                       else 'failed'::public.order_status end,
         cancelled_at = now()
   where id = p_order_id and status = 'pending_payment';

  insert into public.order_events (order_id, event_type, actor, metadata)
  values (p_order_id, 'reservation_released', 'system',
          jsonb_build_object('reason', p_reason, 'released_units', v_released));
end;
$$;

--

CREATE FUNCTION public.reserve_stock_units(p_order_id uuid, p_product_id uuid, p_quantity integer, p_expires_at timestamp with time zone) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_units uuid[];
  v_reservation_id uuid;
  v_updated integer;
begin
  -- Trava por produto: serializa a seleção de unidades do mesmo produto entre
  -- transações concorrentes. Em V1 (baixo volume) o ganho de simplicidade e
  -- previsibilidade supera o custo de contenção.
  perform 1 from public.products where id = p_product_id for update;

  select array_agg(id order by id) into v_units
  from (
    select id
    from public.stock_units
    where product_id = p_product_id
      and status = 'available'
    order by created_at, id
    limit p_quantity
    for update skip locked
  ) candidate;

  if v_units is null or array_length(v_units, 1) < p_quantity then
    raise exception 'insufficient_stock'
      using errcode = 'P0001',
            detail = coalesce(array_length(v_units, 1), 0)::text;
  end if;

  insert into public.stock_reservations (order_id, status, quantity, starts_at, expires_at)
  values (p_order_id, 'active', p_quantity, now(), p_expires_at)
  returning id into v_reservation_id;

  insert into public.stock_reservation_units (reservation_id, stock_unit_id)
  select v_reservation_id, unnest(v_units);

  update public.stock_units
     set status = 'reserved'
   where id = any (v_units)
     and status = 'available';
  get diagnostics v_updated = row_count;

  if v_updated <> p_quantity then
    raise exception 'reservation_conflict'
      using errcode = 'P0001',
            detail = format('expected %s units, updated %s', p_quantity, v_updated);
  end if;

  return v_reservation_id;
end;
$$;

--

CREATE FUNCTION public.resolve_delivery(p_token_hash text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_delivery public.deliveries;
  v_order public.orders;
  v_product public.products;
  v_units jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'delivery_not_found' using errcode = 'P0002';
  end if;

  select * into v_delivery from public.deliveries where token_hash = p_token_hash;
  if not found then
    raise exception 'delivery_not_found' using errcode = 'P0002';
  end if;

  if v_delivery.status = 'revoked' then
    raise exception 'delivery_revoked' using errcode = 'P0002';
  end if;

  select * into v_order from public.orders where id = v_delivery.order_id;

  if v_order.status <> 'paid'
     or v_order.payment_status <> 'approved'
     or v_order.delivery_status <> 'ready' then
    raise exception 'delivery_unavailable' using errcode = 'P0002';
  end if;

  select * into v_product from public.products where id = v_order.product_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'stock_unit_id', su.id,
           'email_enc', encode(su.account_email_enc, 'base64'),
           'password_enc', encode(su.account_password_enc, 'base64'),
           'notes', su.notes
         ) order by su.created_at, su.id), '[]'::jsonb)
    into v_units
  from public.delivery_units du
  join public.stock_units su on su.id = du.stock_unit_id
  where du.delivery_id = v_delivery.id;

  if jsonb_array_length(v_units) = 0 then
    raise exception 'delivery_unavailable' using errcode = 'P0002';
  end if;

  update public.deliveries
     set view_count = view_count + 1,
         last_viewed_at = now()
   where id = v_delivery.id;

  return jsonb_build_object(
    'delivery_id', v_delivery.id,
    'order_id', v_order.id,
    'reference', v_order.reference,
    'created_at', v_delivery.created_at,
    'product', jsonb_build_object(
      'id', v_product.id,
      'name', v_product.name,
      'slug', v_product.slug,
      'instructions', v_product.instructions,
      'access_validity_label', v_product.access_validity_label,
      'access_validity_days', v_product.access_validity_days
    ),
    'units', v_units
  );
end;
$_$;

--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;

--

CREATE FUNCTION public.setting_int(p_key text, p_default integer) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select coalesce(
    (select (value #>> '{}')::integer from public.app_settings where key = p_key),
    p_default
  );
$$;
