-- ============================================================================
-- 0024 — SUPERFÍCIE MÍNIMA DE CIFRAGEM PARA O LINK DE ENTREGA
-- ============================================================================
-- Problema (fase E da missão 03): `get_order_status` devolvia
-- `delivery.token_enc` — o ciphertext do token do link privado. Qualquer
-- consumidor do RPC recebia material de criptografia junto do estado do
-- pedido, e o objetivo declarado é que NENHUM RPC devolva `token_enc`.
--
-- Correção:
--   1. `get_order_status` deixa de devolver o ciphertext. Retorna apenas o
--      estado do link (`status`) e um booleano `link_ready`.
--   2. O acesso ao ciphertext passa a ser uma função dedicada, com superfície
--      mínima: `get_delivery_token_enc(order_id, client_token_hash)`.
--      - Exige o token privado do pedido (quem não tem o token recebe o mesmo
--        erro de "não encontrado", sem oráculo de existência).
--      - Só devolve material de entrega ATIVA; revogada/inexistente → null.
--      - Executável apenas por `service_role` (Edge Function `order-status`).
--   3. A decifragem continua exclusivamente no servidor: o navegador recebe
--      apenas a URL pronta (`store_url/entrega/<token>`), nunca o ciphertext.
--
-- Aplicar uma vez; é idempotente (create or replace + grants explícitos).

-- ---------------------------------------------------------------------------
-- 1. Estado do pedido sem material de criptografia
-- ---------------------------------------------------------------------------
create or replace function public.get_order_status(p_order_id uuid, p_client_token_hash text)
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
    -- Sem `token_enc`: apenas o estado do link. O ciphertext é lido por RPC
    -- dedicado e decifrado somente no servidor.
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
-- 2. RPC dedicado: ciphertext do token do link, sob prova de posse do pedido
-- ---------------------------------------------------------------------------
create or replace function public.get_delivery_token_enc(
  p_order_id uuid,
  p_client_token_hash text
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_delivery public.deliveries;
begin
  if p_order_id is null or coalesce(btrim(p_client_token_hash), '') = '' then
    return null;
  end if;

  -- O vínculo com o token privado é verificado no pedido: sem ele, o chamador
  -- recebe null exatamente como se não existisse (nenhum oráculo).
  if not exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.client_token_hash = p_client_token_hash
  ) then
    return null;
  end if;

  select * into v_delivery
  from public.deliveries
  where order_id = p_order_id and status = 'active';

  if not found or v_delivery.token_enc is null then
    return null;
  end if;

  return encode(v_delivery.token_enc, 'base64');
end;
$$;

comment on function public.get_delivery_token_enc(uuid, text) is
  'Uso interno (service_role). Devolve SOMENTE o ciphertext do token do link ativo, sob prova de posse do token privado do pedido. A decifragem ocorre na Edge Function, nunca no navegador.';

-- ---------------------------------------------------------------------------
-- 3. Privilégios: backend apenas
-- ---------------------------------------------------------------------------
revoke all on function public.get_delivery_token_enc(uuid, text) from public, anon, authenticated;
grant execute on function public.get_delivery_token_enc(uuid, text) to service_role;

revoke all on function public.get_order_status(uuid, text) from public, anon, authenticated;
grant execute on function public.get_order_status(uuid, text) to service_role;
