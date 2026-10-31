-- ============================================================================
-- 0028 — APROVAÇÃO DE PAGAMENTO SIMULADA (decidida no banco)
-- ============================================================================
-- `demo_approve_payment` é a única porta de entrada da aprovação simulada.
-- Ela exige: modo ligado, prova de posse (hash do token privado), pedido
-- aguardando pagamento, reserva válida, produto `is_demo` e TODAS as unidades
-- reservadas `is_demo`. Depois chama `apply_payment_status('approved')`, que é
-- o mesmo caminho usado pelo webhook do Mercado Pago.

-- ---------------------------------------------------------------------------
-- 6. get_order_status: expõe `product.is_demo` (sem ciphertext, como na 0024)
-- ---------------------------------------------------------------------------
create or replace function public.get_order_status(
  p_order_id uuid,
  p_client_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
      'access_validity_label', v_product.access_validity_label,
      'is_demo', coalesce(v_product.is_demo, false)
    ),
    'payment', case when v_payment.id is null then null else jsonb_build_object(
      'method', v_payment.method,
      'provider', v_payment.provider,
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
      'link_ready', v_delivery.status = 'active' and v_delivery.token_enc is not null,
      'created_at', v_delivery.created_at,
      'revoked_at', v_delivery.revoked_at
    ) end,
    'availability', jsonb_build_object('available_units', v_units_available)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Aprovação simulada (somente service_role, somente sandbox habilitado)
-- ---------------------------------------------------------------------------
create or replace function public.demo_approve_payment(
  p_order_id uuid,
  p_client_token_hash text,
  p_delivery_token_hash text,
  p_delivery_token_enc_b64 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_product public.products;
  v_units uuid[];
  v_result jsonb;
begin
  if not public.demo_payments_enabled() then
    raise exception 'demo_disabled' using errcode = 'P0001';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;

  -- Prova de posse: sem o hash do token privado, o pedido não existe.
  if not found
     or p_client_token_hash is null
     or v_order.client_token_hash is distinct from p_client_token_hash then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  if v_order.status <> 'pending_payment' then
    raise exception 'demo_order_not_payable'
      using errcode = 'P0001', detail = v_order.status::text;
  end if;

  if v_order.reservation_expires_at <= now() then
    perform public.release_order_reservation(p_order_id, 'expired');
    raise exception 'demo_reservation_expired' using errcode = 'P0001';
  end if;

  select * into v_product from public.products where id = v_order.product_id;

  if not found or not v_product.is_demo then
    raise exception 'demo_not_allowed' using errcode = 'P0001';
  end if;

  select array_agg(su.id) into v_units
  from public.stock_reservation_units sru
  join public.stock_reservations r on r.id = sru.reservation_id
  join public.stock_units su on su.id = sru.stock_unit_id
  where r.order_id = p_order_id
    and r.status = 'active'
    and sru.released_at is null;

  if v_units is null or cardinality(v_units) <> v_order.quantity then
    raise exception 'demo_reservation_missing' using errcode = 'P0001';
  end if;

  -- Nunca entregar credencial real por simulação.
  if exists (select 1 from public.stock_units where id = any (v_units) and not is_demo) then
    raise exception 'demo_real_stock_blocked' using errcode = 'P0001';
  end if;

  if p_delivery_token_hash is null or p_delivery_token_enc_b64 is null then
    raise exception 'demo_delivery_token_required' using errcode = '22023';
  end if;

  v_result := public.apply_payment_status(
    p_order_id,
    'DEMO-' || v_order.reference,
    'approved',
    'demo_approved',
    v_order.total_cents,
    p_delivery_token_hash,
    p_delivery_token_enc_b64
  );

  update public.payments
     set provider = 'demo'
   where order_id = p_order_id
     and provider_payment_id = 'DEMO-' || v_order.reference;

  insert into public.order_events (order_id, event_type, actor, metadata)
  values (
    p_order_id,
    'demo_payment_approved',
    'system',
    jsonb_build_object(
      'provider_payment_id', 'DEMO-' || v_order.reference,
      'result', v_result
    )
  );

  return v_result || jsonb_build_object('demo', true);
end;
$$;

