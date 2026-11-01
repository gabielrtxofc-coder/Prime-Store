-- ============================================================================
-- 0019 — CHARGEBACK ≠ REEMBOLSO
-- ============================================================================
-- Correção de lógica identificada na auditoria da Missão 03.
--
-- Antes: `refunded` e `charged_back` caíam no mesmo ramo — a contestação era
-- tratada como reembolso concluído (pedido `refunded`, entrega revogada,
-- pendência marcada como processada). Isso executava uma ação irreversível
-- (revogar a entrega) a partir de um evento que não é uma devolução.
--
-- Depois:
--   * `refunded`  → reembolso confirmado pelo provedor: pedido `refunded`,
--                   entrega revogada, pendências de reembolso processadas.
--   * `charged_back` → contestação: pedido `disputed` (pendente de análise
--                   administrativa), evento próprio, entrega PRESERVADA e
--                   nenhuma revogação automática. O painel mostra a pendência.
--   * `admin_resolve_dispute()` é o único caminho para encerrar uma disputa,
--                   sempre auditado e com decisão explícita.
--
-- Todos os ramos são idempotentes e nunca "desfazem" um estado mais avançado
-- informado pelo provedor (reembolso depois de contestação vence, e uma
-- contestação posterior a um reembolso não "des-reembolsa" o pedido).

create or replace function public.apply_payment_status(
  p_order_id uuid,
  p_provider_payment_id text,
  p_provider_status text,
  p_status_detail text,
  p_amount_cents integer,
  p_delivery_token_hash text default null,
  p_delivery_token_enc_b64 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_payment public.payments;
  v_units uuid[];
  v_delivery public.deliveries;
  v_mapped public.payment_status;
  v_status text := lower(coalesce(p_provider_status, ''));
  v_result text;
  v_order_status text;
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

  -- ------------------------------------------------------------------------
  -- 0. EVENTO ATRASADO SOBRE ESTADO ENCERRADO
  -- ------------------------------------------------------------------------
  -- Uma aprovação que chega depois de reembolso/contestação (ou depois de o
  -- pedido ter sido encerrado) é registro de histórico, não transição: o
  -- estado informado mais recente pelo provedor prevalece.
  if v_mapped = 'approved'
     and (v_order.payment_status in ('refunded', 'charged_back')
          or v_order.status in ('refunded', 'cancelled')) then
    insert into public.order_events (order_id, event_type, actor, metadata)
    values (p_order_id, 'payment_approved_ignored_late', 'provider',
            jsonb_build_object(
              'provider_payment_id', p_provider_payment_id,
              'order_status', v_order.status,
              'payment_status', v_order.payment_status
            ));

    return jsonb_build_object(
      'result', 'ignored_late_approval',
      'order_status', v_order.status,
      'payment_status', v_order.payment_status,
      'delivery_status', v_order.delivery_status
    );
  end if;

  -- ------------------------------------------------------------------------
  -- 1. APROVADO
  -- ------------------------------------------------------------------------
  if v_mapped = 'approved' then
    if v_order.payment_status = 'approved'
       and v_order.status in ('paid', 'refund_pending', 'refunded') then
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

  -- ------------------------------------------------------------------------
  -- 2. RECUSADO / CANCELADO — devolve estoque, nunca mexe em pedido pago
  -- ------------------------------------------------------------------------
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

  -- ------------------------------------------------------------------------
  -- 3. REEMBOLSO CONFIRMADO — devolução decidida e concluída no provedor
  -- ------------------------------------------------------------------------
  if v_mapped = 'refunded' then
    if v_order.payment_status = 'refunded' and v_order.status = 'refunded' then
      -- Idempotente, mas garante que o link esteja revogado (auto-recuperação).
      update public.deliveries
         set status = 'revoked',
             revoked_at = coalesce(revoked_at, now()),
             revoke_reason = coalesce(revoke_reason, 'Reembolso confirmado pelo provedor')
       where order_id = p_order_id and status = 'active';

      return jsonb_build_object(
        'result', 'already_applied',
        'order_status', 'refunded',
        'payment_status', 'refunded',
        'delivery_status', (select delivery_status from public.orders where id = p_order_id)
      );
    end if;

    update public.orders
       set payment_status = 'refunded',
           status = 'refunded',
           delivery_status = 'revoked',
           cancelled_at = coalesce(cancelled_at, now())
     where id = p_order_id;

    update public.deliveries
       set status = 'revoked',
           revoked_at = coalesce(revoked_at, now()),
           revoke_reason = coalesce(revoke_reason, 'Reembolso confirmado pelo provedor')
     where order_id = p_order_id and status = 'active';

    update public.refund_requests
       set status = 'processed',
           resolved_at = coalesce(resolved_at, now()),
           notes = case when notes = '' then 'Reembolso confirmado pelo provedor' else notes end
     where order_id = p_order_id and status in ('pending', 'authorized');

    insert into public.order_events (order_id, event_type, actor, metadata)
    values (p_order_id, 'payment_refunded', 'provider',
            jsonb_build_object(
              'provider_payment_id', p_provider_payment_id,
              'previous_payment_status', v_order.payment_status,
              'previous_order_status', v_order.status
            ));

    return jsonb_build_object(
      'result', 'refunded',
      'order_status', 'refunded',
      'payment_status', 'refunded',
      'delivery_status', 'revoked'
    );
  end if;

  -- ------------------------------------------------------------------------
  -- 4. CHARGEBACK / CONTESTAÇÃO — pendência de análise, nada irreversível
  -- ------------------------------------------------------------------------
  if v_mapped = 'charged_back' then
    if v_order.payment_status = 'charged_back' then
      return jsonb_build_object(
        'result', 'already_applied',
        'order_status', v_order.status,
        'payment_status', 'charged_back',
        'delivery_status', v_order.delivery_status,
        'requires_admin_review', v_order.status = 'disputed'
      );
    end if;

    -- Se o pedido já foi reembolsado de fato, a contestação é registrada como
    -- evento posterior: não "des-reembolsamos" nem reativamos a entrega.
    v_order_status := case
                        when v_order.status = 'refunded' then 'refunded'
                        else 'disputed'
                      end;

    update public.orders
       set payment_status = 'charged_back',
           status = v_order_status::public.order_status
     where id = p_order_id;

    insert into public.order_events (order_id, event_type, actor, metadata)
    values (
      p_order_id,
      case when v_order.status = 'refunded'
           then 'payment_charged_back_after_refund'
           else 'payment_charged_back'
      end,
      'provider',
      jsonb_build_object(
        'provider_payment_id', p_provider_payment_id,
        'status_detail', p_status_detail,
        'previous_payment_status', v_order.payment_status,
        'previous_order_status', v_order.status,
        'delivery_preserved', true,
        'requires_admin_review', v_order_status = 'disputed'
      )
    );

    return jsonb_build_object(
      'result', 'charged_back',
      'order_status', v_order_status,
      'payment_status', 'charged_back',
      'delivery_status', v_order.delivery_status,
      'requires_admin_review', v_order_status = 'disputed'
    );
  end if;

  -- ------------------------------------------------------------------------
  -- 5. PENDENTE / EM PROCESSAMENTO
  -- ------------------------------------------------------------------------
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

comment on function public.apply_payment_status(uuid, text, text, text, integer, text, text) is
  'Conciliação idempotente de pagamento. Reembolso confirmado revoga a entrega; chargeback apenas marca o pedido como disputed e exige decisão administrativa explícita.';

-- ---------------------------------------------------------------------------
-- Encerramento de disputa (decisão administrativa explícita e auditada)
-- ---------------------------------------------------------------------------
create or replace function public.admin_resolve_dispute(
  p_order_id uuid,
  p_outcome text,
  p_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_admin();
  v_order public.orders;
  v_outcome text := lower(btrim(coalesce(p_outcome, '')));
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  if v_order.payment_status <> 'charged_back' and v_order.status <> 'disputed' then
    raise exception 'order_not_disputed' using errcode = '22023';
  end if;

  if v_outcome not in ('refund', 'reinstated', 'refund_pending') then
    raise exception 'invalid_outcome' using errcode = '22023';
  end if;

  if v_outcome = 'refund' then
    -- Reembolso manual já executado pelo administrador no Mercado Pago.
    update public.orders
       set status = 'refunded',
           delivery_status = 'revoked',
           cancelled_at = coalesce(cancelled_at, now())
     where id = p_order_id;

    update public.deliveries
       set status = 'revoked',
           revoked_at = coalesce(revoked_at, now()),
           revoke_reason = coalesce(revoke_reason, 'Disputa encerrada com reembolso')
     where order_id = p_order_id and status = 'active';

    update public.refund_requests
       set status = 'processed',
           resolved_at = coalesce(resolved_at, now())
     where order_id = p_order_id and status in ('pending', 'authorized');

    insert into public.order_events (order_id, event_type, actor, metadata)
    values (p_order_id, 'dispute_resolved_refund', 'admin',
            jsonb_build_object('admin_id', v_actor, 'notes', p_notes));

  elsif v_outcome = 'reinstated' then
    -- Contestação revertida: o valor voltou para a loja.
    update public.orders
       set status = 'paid',
           payment_status = 'approved',
           delivery_status = case when delivery_status = 'blocked' then 'ready'::public.delivery_status
                                  else delivery_status end
     where id = p_order_id;

    insert into public.order_events (order_id, event_type, actor, metadata)
    values (p_order_id, 'dispute_resolved_reinstated', 'admin',
            jsonb_build_object('admin_id', v_actor, 'notes', p_notes));

  else
    update public.orders
       set status = 'refund_pending',
           delivery_status = 'blocked'
     where id = p_order_id;

    if not exists (
      select 1 from public.refund_requests
      where order_id = p_order_id and status in ('pending', 'authorized')
    ) then
      insert into public.refund_requests (order_id, reason, provider_payment_id, amount_cents, created_by, notes)
      values (p_order_id, 'chargeback_refund_pending', null, v_order.total_cents, 'admin',
              coalesce(nullif(btrim(p_notes), ''), 'Disputa encerrada: reembolso manual pendente.'));
    end if;

    insert into public.order_events (order_id, event_type, actor, metadata)
    values (p_order_id, 'dispute_resolved_refund_pending', 'admin',
            jsonb_build_object('admin_id', v_actor, 'notes', p_notes));
  end if;

  perform public.log_admin_action(
    'dispute_resolved', 'order', p_order_id::text,
    jsonb_build_object('outcome', v_outcome, 'notes', left(coalesce(p_notes, ''), 500))
  );

  select * into v_order from public.orders where id = p_order_id;

  return jsonb_build_object(
    'order_id', v_order.id,
    'reference', v_order.reference,
    'status', v_order.status,
    'payment_status', v_order.payment_status,
    'delivery_status', v_order.delivery_status,
    'outcome', v_outcome
  );
end;
$$;

comment on function public.admin_resolve_dispute(uuid, text, text) is
  'Encerra uma disputa (chargeback) com decisão explícita: refund (reembolso manual já feito), reinstated (valor recuperado) ou refund_pending. Sempre auditado.';

revoke all on function public.admin_resolve_dispute(uuid, text, text) from public, anon;
grant execute on function public.admin_resolve_dispute(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Filtro "somente problemas" passa a incluir disputas e chargebacks
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_orders(
  p_search text default null,
  p_status text default null,
  p_payment_status text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_problem_only boolean default false,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
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
    and (
      not p_problem_only
      or o.status in ('refund_pending', 'failed', 'disputed')
      or o.payment_status in ('amount_mismatch', 'charged_back')
    )
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
      and (
        not p_problem_only
        or o.status in ('refund_pending', 'failed', 'disputed')
        or o.payment_status in ('amount_mismatch', 'charged_back')
      )
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

-- ---------------------------------------------------------------------------
-- Indicadores: disputas e chargebacks visíveis no painel
-- ---------------------------------------------------------------------------
create or replace function public.admin_indicators()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
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
    'orders_refunded', (select count(*) from public.orders where status = 'refunded'),
    'orders_disputed', (select count(*) from public.orders where status = 'disputed'),
    'orders_failed', (select count(*) from public.orders where status = 'failed'),
    'payments_charged_back', (select count(*) from public.payments where status = 'charged_back'),
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
