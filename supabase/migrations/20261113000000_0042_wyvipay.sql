-- ============================================================================
-- 0042 — WYVIPAY (API v2): provedor de cobrança PIX
-- ============================================================================
-- A WyviPay substitui o Mercado Pago como fluxo ATIVO de cobrança; o código do
-- Mercado Pago permanece congelado (nenhuma regra dele é removida aqui).
--
-- O que esta migração faz (todo aditivo, sem tocar em linhas antigas):
--   1. Amplia os CHECKs de `provider` para aceitar 'wyvipay' em `payments` e
--      `payment_events` (os valores existentes continuam válidos).
--   2. `attach_payment` ganha o parâmetro opcional `p_provider`
--      (default 'mercado_pago'): as chamadas existentes, posicionais ou com
--      argumentos nomeados, continuam funcionando sem alteração.
--   3. `record_payment_event` ganha `p_provider` (default 'mercado_pago') e a
--      busca de duplicado passa a filtrar por provedor — o índice único
--      `(provider, notification_id)` já separa as notificações dos dois
--      provedores, então eventos da WyviPay nunca colidem com os do MP.
--   4. `attach_order_buyer`: grava nome/e-mail do comprador em um pedido de
--      cobrança EXIGINDO a prova de posse (hash do token privado). Sem isso o
--      fluxo de cobrança multi-item não teria contato do comprador — e a
--      função é nova, então nenhuma assinatura existente muda.
--   5. `order_summary_multi` passa a devolver o MESMO bloco `product` de
--      `create_order`/`get_order_status` (slug, instruções, rótulo e `is_demo`),
--      para o handler de criação de pedido decidir o modo demonstrativo igual
--      em ambos os caminhos.
--
-- Nenhuma função de segurança, reserva, entrega ou máquina de estados de
-- pagamento é alterada: `apply_payment_status` continua agnóstica de provedor.
-- ============================================================================

-- 1. CHECKs de provedor (aditivo) ------------------------------------------
alter table public.payments
  drop constraint if exists payments_provider_check;
alter table public.payments
  add constraint payments_provider_check
  check (provider in ('mercado_pago', 'demo', 'internal', 'wyvipay'));

alter table public.payment_events
  drop constraint if exists payment_events_provider_check;
alter table public.payment_events
  add constraint payment_events_provider_check
  check (provider in ('mercado_pago', 'demo', 'wyvipay'));

-- 2. attach_payment com provedor explícito ---------------------------------
drop function if exists public.attach_payment(uuid, text, text, integer, text, text, text, timestamptz);

create function public.attach_payment(
  p_order_id uuid,
  p_provider_payment_id text,
  p_provider_status text,
  p_amount_cents integer,
  p_qr_code text,
  p_qr_code_base64 text,
  p_ticket_url text,
  p_expires_at timestamptz,
  p_provider text default 'mercado_pago'
) returns jsonb
    language plpgsql security definer
    set search_path TO 'public', 'pg_temp'
    as $$
declare
  v_order public.orders;
  v_payment public.payments;
  v_mapped public.payment_status;
  v_provider text := coalesce(nullif(btrim(p_provider), ''), 'mercado_pago');
begin
  if v_provider not in ('mercado_pago', 'demo', 'internal', 'wyvipay') then
    raise exception 'unknown_payment_provider' using errcode = '22023';
  end if;

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

  -- Uma única cobrança aberta por pedido (índice `payments_one_open_per_order`):
  -- a linha existente é atualizada — nunca há duas cobranças concorrentes.
  select * into v_payment
  from public.payments
  where order_id = p_order_id and status in ('pending', 'in_process')
  for update;

  if found then
    update public.payments
       set provider_payment_id = coalesce(p_provider_payment_id, provider_payment_id),
           provider = v_provider,
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
      order_id, provider, provider_payment_id, status, amount_cents,
      qr_code, qr_code_base64, ticket_url, expires_at
    )
    values (
      p_order_id, v_provider, p_provider_payment_id, v_mapped, p_amount_cents,
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
      'provider', v_provider,
      'provider_payment_id', p_provider_payment_id,
      'status', v_mapped,
      'amount_cents', p_amount_cents,
      'expires_at', p_expires_at
    )
  );

  return jsonb_build_object(
    'payment_id', v_payment.id,
    'provider', v_payment.provider,
    'status', v_payment.status,
    'qr_code', v_payment.qr_code,
    'qr_code_base64', v_payment.qr_code_base64,
    'ticket_url', v_payment.ticket_url,
    'expires_at', v_payment.expires_at
  );
end;
$$;

-- 3. record_payment_event com provedor explícito ---------------------------
drop function if exists public.record_payment_event(text, text, text, text, boolean, text);

create function public.record_payment_event(
  p_notification_id text,
  p_event_type text,
  p_action text,
  p_data_id text,
  p_signature_valid boolean,
  p_payload_hash text,
  p_provider text default 'mercado_pago'
) returns jsonb
    language plpgsql security definer
    set search_path TO 'public', 'pg_temp'
    as $$
declare
  v_event public.payment_events;
  v_provider text := coalesce(nullif(btrim(p_provider), ''), 'mercado_pago');
begin
  if v_provider not in ('mercado_pago', 'demo', 'wyvipay') then
    raise exception 'unknown_payment_provider' using errcode = '22023';
  end if;

  if p_notification_id is not null then
    -- Dedup por (provider, notification_id): a mesma entrega da WyviPay e a
    -- mesma notificação do Mercado Pago nunca compartilham linha.
    select * into v_event
    from public.payment_events
    where provider = v_provider and notification_id = p_notification_id;

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
    provider, notification_id, event_type, action, data_id, signature_valid, payload_hash
  )
  values (v_provider, p_notification_id, p_event_type, p_action, p_data_id, p_signature_valid, p_payload_hash)
  returning * into v_event;

  return jsonb_build_object(
    'event_id', v_event.id,
    'duplicate', false,
    'status', v_event.status
  );
end;
$$;

-- 4. attach_order_buyer: contato do comprador com prova de posse -----------
-- O fluxo de cobrança multi-item (`create_order_multi`) não recebe nome/e-mail
-- (assinatura congelada pela auditoria G5). Este gravador é chamado pelo
-- handler DEPOIS da criação, com o hash do token privado do checkout: sem o
-- token certo, nada é gravado. Nome/e-mail passam pelas mesmas checagens de
-- `create_purchase_request`.
create or replace function public.attach_order_buyer(
  p_order_id uuid,
  p_client_token_hash text,
  p_buyer_name text,
  p_buyer_email text
) returns void
    language plpgsql security definer
    set search_path TO 'public', 'pg_temp'
    as $$
declare
  v_order public.orders;
  v_name text := case when p_buyer_name is null then null else btrim(p_buyer_name) end;
  v_email text := case when p_buyer_email is null then null else btrim(p_buyer_email) end;
begin
  if p_client_token_hash is null or p_client_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_client_token' using errcode = '22023';
  end if;

  if v_name is not null and (length(v_name) < 2 or length(v_name) > 120) then
    raise exception 'invalid_buyer_name' using errcode = '22023';
  end if;

  if v_email is not null and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_buyer_email' using errcode = '22023';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and client_token_hash = p_client_token_hash
  for update;

  -- Prova de posse obrigatória: sem o token do checkout, a chamada é um no-op
  -- silencioso (não revela se o pedido existe).
  if not found then
    return;
  end if;

  update public.orders
     set buyer_name = coalesce(v_name, buyer_name),
         buyer_email = coalesce(v_email, buyer_email)
   where id = p_order_id;
end;
$$;

comment on function public.attach_order_buyer(uuid, text, text, text) is
  'Grava contato do comprador num pedido de cobranca exigindo o hash do token privado do checkout.';

-- 6. Privilégios: o DROP FUNCTION da seção 2/3 APAGOU os grants antigos de
-- `attach_payment` e `record_payment_event` (a 0014 tinha concedido
-- `execute` a `service_role` via `grant ... on all functions`). Sem repor aqui,
-- a Edge Function falharia em produção com "permission denied" — invisível nos
-- testes, que executam como dono das funções. `attach_order_buyer` é nova e
-- segue o mesmo contrato: só o servidor (service_role) executa.
grant execute on function public.attach_payment(uuid, text, text, integer, text, text, text, timestamptz, text)
  to service_role;
grant execute on function public.record_payment_event(text, text, text, text, boolean, text, text)
  to service_role;
grant execute on function public.attach_order_buyer(uuid, text, text, text)
  to service_role;

revoke execute on function public.attach_payment(uuid, text, text, integer, text, text, text, timestamptz, text)
  from public, anon, authenticated;
revoke execute on function public.record_payment_event(text, text, text, text, boolean, text, text)
  from public, anon, authenticated;
revoke execute on function public.attach_order_buyer(uuid, text, text, text)
  from public, anon, authenticated;

-- 5. order_summary_multi com o mesmo bloco de produto dos demais fluxos ----
create or replace function public.order_summary_multi(p_order public.orders)
returns jsonb
language sql
stable
security definer
set search_path = 'public', 'pg_temp'
as $$
  select jsonb_build_object(
    'order_id', p_order.id,
    'reference', p_order.reference,
    'status', p_order.status,
    'payment_status', p_order.payment_status,
    'delivery_status', p_order.delivery_status,
    'items_count', p_order.items_count,
    'quantity', p_order.quantity,
    'unit_price_cents', p_order.unit_price_cents,
    'total_cents', p_order.total_cents,
    'reservation_expires_at', p_order.reservation_expires_at,
    'created_at', p_order.created_at,
    'buyer_name', p_order.buyer_name,
    'product', (
      select jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'slug', p.slug,
        'instructions', p.instructions,
        'access_validity_label', p.access_validity_label,
        'is_demo', coalesce(p.is_demo, false)
      )
      from public.products p
      where p.id = p_order.product_id
    ),
    'items', public.order_items_json(p_order.id)
  );
$$;
