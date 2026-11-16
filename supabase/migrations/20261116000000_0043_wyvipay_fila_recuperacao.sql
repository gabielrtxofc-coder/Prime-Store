-- ============================================================================
-- 0043 — WYVIPAY II: fila persistente de eventos, recuperação de cobrança e
--         gate de consultas entre instâncias
-- ============================================================================
-- Três problemas reais corrigidos aqui (nada é removido de comportamento
-- existente; tudo aditivo ou redefinição compatível):
--
--   1. RESULTADO INCERTO na criação da cobrança: quando a resposta da WyviPay
--      não chega (timeout/5xx/rede), ANTES esta migração não existia e o
--      handler liberava a reserva — risco de cliente pagar pedido encerrado.
--      Agora existe `mark_payment_attempt`: grava uma linha "aberta sem txid"
--      em `payments` + evento `payment_creation_uncertain`, preservando a
--      tentativa (mesma Idempotency-Key `order-<uuid>`, mesmos dados) até a
--      recuperação confirmar o que aconteceu.
--
--   2. FILA PERSISTENTE para o webhook: `payment_events` vira fila de
--      trabalho (colunas `available_at`, `locked_until`, `provider_data`,
--      `reference` + `claim_wyvi_events`/`reschedule_payment_event`). O
--      webhook REGISTRA e RESPONDE rápido; o processamento acontece depois,
--      sobrevive a reinício da função e retenta com backoff.
--
--   3. GATE DE API ENTRE INSTÂNCIES: `provider_api_gates` +
--      `try_acquire_provider_slot` — o throttle de reconciliação passa a ser
--      global (banco), não um Map em memória de um isolate.
--
--   Bônus correção de mistura de provedores: `apply_payment_status` ganha
--   `p_provider` explícito — a re-inserção de linha no cenário de corrida
--   (webhook ANTES do vínculo) grava o provedor CERTO ('wyvipay') em vez do
--   default 'mercado_pago'. A versão antiga de 7 parâmetros é removida para
--   não gerar ambiguidade; grants repostos (lição da 0042).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. apply_payment_status com provedor explícito (drop + create + grants)
-- ---------------------------------------------------------------------------
drop function if exists public.apply_payment_status(uuid, text, text, text, integer, text, text);
drop function if exists public.apply_payment_status(uuid, text, text, text, integer, text, text, text);

CREATE FUNCTION public.apply_payment_status(p_order_id uuid, p_provider_payment_id text, p_provider_status text, p_status_detail text, p_amount_cents integer, p_delivery_token_hash text DEFAULT NULL::text, p_delivery_token_enc_b64 text DEFAULT NULL::text, p_provider text DEFAULT 'mercado_pago'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order public.orders;
  v_payment public.payments;
  v_units uuid[];
  v_delivery public.deliveries;
  v_delivery_result jsonb;
  v_mapped public.payment_status;
  v_status text := lower(coalesce(p_provider_status, ''));
  v_provider text := coalesce(nullif(btrim(p_provider), ''), 'mercado_pago');
  v_result text;
  v_order_status text;
begin
  if v_provider not in ('mercado_pago', 'demo', 'internal', 'wyvipay') then
    raise exception 'unknown_payment_provider' using errcode = '22023';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  -- ------------------------------------------------------------------------
  -- 0. GUARDA — SOLICITAÇÃO SEM PAGAMENTO NUNCA VIRA VENDA
  -- ------------------------------------------------------------------------
  -- O fluxo público sem cobrança cria o pedido em `requested` /
  -- `not_required` (migração 0033): não existe pagamento, reserva, nem venda.
  -- Sem esta guarda, uma aprovação forjada (ou uma notificação indevida)
  -- percorria o ramo `approved`, alocava estoque disponível, marcava o pedido
  -- como pago e criava a entrega — transformando uma solicitação em venda.
  --
  -- A decisão é tomada aqui, dentro da própria função que confirma pagamento,
  -- depois de travar o pedido e ANTES de qualquer efeito: pagamento, pedido,
  -- estoque, reservas, eventos, entrega e token privado permanecem intactos.
  -- Não há escrita de evento: a tentativa não altera nada do pedido.
  if v_order.status = 'requested' or v_order.payment_status = 'not_required' then
    return jsonb_build_object(
      'result', 'ignored_no_payment_required',
      'order_status', v_order.status,
      'payment_status', v_order.payment_status,
      'delivery_status', v_order.delivery_status
    );
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
      order_id, provider, provider_payment_id, status, status_detail, amount_cents, approved_at
    )
    values (
      p_order_id, v_provider, p_provider_payment_id, v_mapped, p_status_detail,
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
      -- Recuperação: pedido pago sem entrega (interrupção entre a confirmação e
      -- a criação do link). `create_order_delivery` é idempotente e valida a
      -- cobertura de TODOS os itens, então nunca gera entrega parcial.
      if v_order.status = 'paid'
         and p_delivery_token_hash is not null
         and p_delivery_token_enc_b64 is not null
         and not exists (select 1 from public.deliveries where order_id = p_order_id) then
        v_delivery_result := public.create_order_delivery(
          p_order_id, p_delivery_token_hash, p_delivery_token_enc_b64
        );

        insert into public.order_events (order_id, event_type, actor, metadata)
        values (p_order_id, 'delivery_recovered', 'system',
                jsonb_build_object(
                  'recovered', true,
                  'delivery_id', v_delivery_result ->> 'delivery_id',
                  'items', v_delivery_result -> 'items'
                ));
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
      -- Alocação tardia por item: pedido legado usa a função original, pedido
      -- multi-item verifica a cobertura de todos os produtos antes de vender.
      v_units := public.allocate_late_units_for_order(p_order_id);

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
      v_delivery_result := public.create_order_delivery(
        p_order_id, p_delivery_token_hash, p_delivery_token_enc_b64
      );
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
$function$;

revoke all on function public.apply_payment_status(uuid, text, text, text, integer, text, text, text)
  from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.apply_payment_status(uuid, text, text, text, integer, text, text, text) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Fila: colunas de trabalho em payment_events
--    status continua no allowlist existente ('received' = aguardando;
--    'processed'/'ignored'/'failed' = terminal) — nenhum CHECK reescrito.
-- ---------------------------------------------------------------------------
alter table public.payment_events
  add column if not exists provider_data jsonb not null default '{}'::jsonb,
  add column if not exists reference text,
  add column if not exists available_at timestamptz not null default now(),
  add column if not exists locked_until timestamptz;

comment on column public.payment_events.provider_data is
  'Subconjunto APROVADO do envelope do evento (txid, referencia, teste, ambiente, valor_centavos). Nunca pagador/PII.';
comment on column public.payment_events.reference is
  'referencia do evento (order_id UUID) quando presente — permite enfileirar por pedido.';
comment on column public.payment_events.available_at is
  'Fila: hora da PRÓXIMA tentativa de processamento (backoff).';
comment on column public.payment_events.locked_until is
  'Claim do worker: trava curta para duas instancias nao processarem o mesmo evento.';

create index if not exists payment_events_queue_idx
  on public.payment_events (available_at)
  where provider = 'wyvipay' and status = 'received';

create index if not exists payment_events_reference_idx
  on public.payment_events (reference)
  where reference is not null;

-- ---------------------------------------------------------------------------
-- 3. record_payment_event com dados do provedor + referência
--    (mantém os 6 parâmetros posicionais antigos válidos via defaults)
-- ---------------------------------------------------------------------------
drop function if exists public.record_payment_event(text, text, text, text, boolean, text);
drop function if exists public.record_payment_event(text, text, text, text, boolean, text, text);

create function public.record_payment_event(
  p_notification_id text,
  p_event_type text,
  p_action text,
  p_data_id text,
  p_signature_valid boolean,
  p_payload_hash text,
  p_provider text default 'mercado_pago',
  p_provider_data jsonb default null,
  p_reference text default null
) returns jsonb
    language plpgsql security definer
    set search_path TO 'public', 'pg_temp'
    as $$
declare
  v_event public.payment_events;
  v_provider text := coalesce(nullif(btrim(p_provider), ''), 'mercado_pago');
  v_data jsonb := coalesce(p_provider_data, '{}'::jsonb);
begin
  if v_provider not in ('mercado_pago', 'demo', 'wyvipay') then
    raise exception 'unknown_payment_provider' using errcode = '22023';
  end if;
  if p_notification_id is not null then
    -- Dedup por (provider, notification_id): a MESMA entrega nunca gera linha
    -- nova — este é o índice único que protege retentativas do provedor.
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
    provider, notification_id, event_type, action, data_id, signature_valid,
    payload_hash, provider_data, reference
  )
  values (v_provider, p_notification_id, p_event_type, p_action, p_data_id,
          p_signature_valid, p_payload_hash, v_data, nullif(btrim(p_reference), ''))
  returning * into v_event;

  return jsonb_build_object(
    'event_id', v_event.id,
    'duplicate', false,
    'status', v_event.status
  );
end;
$$;

revoke all on function public.record_payment_event(text, text, text, text, boolean, text, text, jsonb, text)
  from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.record_payment_event(text, text, text, text, boolean, text, text, jsonb, text) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. mark_payment_attempt: marca uma tentativa de cobrança de resultado
--    INCERTO sem liberar a reserva. Idempotente: repetir não duplica linha
--    nem evento.
-- ---------------------------------------------------------------------------
create function public.mark_payment_attempt(
  p_order_id uuid,
  p_provider text,
  p_idempotency_key text,
  p_amount_cents integer
) returns jsonb
    language plpgsql security definer
    set search_path TO 'public', 'pg_temp'
    as $$
declare
  v_order public.orders;
  v_payment public.payments;
  v_provider text := coalesce(nullif(btrim(p_provider), ''), 'wyvipay');
begin
  if v_provider not in ('mercado_pago', 'demo', 'internal', 'wyvipay') then
    raise exception 'unknown_payment_provider' using errcode = '22023';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  -- Pedido já encerrado: nada a preservar (o handler decide o desfecho).
  if v_order.status <> 'pending_payment' then
    return jsonb_build_object('state', v_order.status, 'payment_id', null);
  end if;

  if p_amount_cents is distinct from v_order.total_cents then
    raise exception 'amount_mismatch' using errcode = 'P0001';
  end if;

  -- Uma cobrança aberta por pedido: se já existe, devolve como está.
  select * into v_payment
  from public.payments
  where order_id = p_order_id and status in ('pending', 'in_process')
  for update;

  if found then
    return jsonb_build_object(
      'state', 'exists',
      'payment_id', v_payment.id,
      'has_txid', v_payment.provider_payment_id is not null
    );
  end if;

  insert into public.payments (order_id, provider, status, amount_cents)
  values (p_order_id, v_provider, 'pending', p_amount_cents)
  returning * into v_payment;

  insert into public.order_events (order_id, event_type, actor, metadata)
  values (
    p_order_id,
    'payment_creation_uncertain',
    'system',
    jsonb_build_object(
      'provider', v_provider,
      'idempotency_key', left(coalesce(p_idempotency_key, ''), 140),
      'amount_cents', p_amount_cents
    )
  );

  return jsonb_build_object(
    'state', 'marked',
    'payment_id', v_payment.id,
    'has_txid', false
  );
end;
$$;

revoke all on function public.mark_payment_attempt(uuid, text, text, integer) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.mark_payment_attempt(uuid, text, text, integer) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. claim_wyvi_events: reivindica eventos DUE da fila (SKIP LOCKED — duas
--    instâncias nunca processam o mesmo evento ao mesmo tempo). Devolve
--    `[]` quando não há nada a fazer.
-- ---------------------------------------------------------------------------
create function public.claim_wyvi_events(
  p_order_id text default null,
  p_limit integer default 5
) returns jsonb
    language plpgsql security definer
    set search_path TO 'public', 'pg_temp'
    as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 20);
  v_result jsonb;
begin
  with claimed as (
    select e.id
      from public.payment_events e
     where e.provider = 'wyvipay'
       and e.status = 'received'
       and e.available_at <= now()
       and (e.locked_until is null or e.locked_until < now())
       and (p_order_id is null or e.reference = p_order_id)
     order by e.received_at
     limit v_limit
     for update skip locked
  ),
  updated as (
    update public.payment_events e
       set locked_until = now() + interval '60 seconds',
           attempts = e.attempts + 1
      from claimed c
     where e.id = c.id
    returning e.*
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'event_id', e.id,
      'notification_id', e.notification_id,
      'event_type', e.event_type,
      'data_id', e.data_id,
      'reference', e.reference,
      'provider_data', e.provider_data,
      'attempts', e.attempts,
      'status', e.status
    )),
    '[]'::jsonb
  ) into v_result
  from updated e;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

revoke all on function public.claim_wyvi_events(text, integer) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.claim_wyvi_events(text, integer) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. reschedule_payment_event: resultado de UMA tentativa de processamento.
--    - backoff > 0  → volta para a fila com available_at futuro;
--    - backoff <= 0 → terminal ('failed'): sinaliza necessidade de
--      intervenção sem perder o registro (a entrega pode ser reenviada à
--      mão pelo painel ou reconciliada por consulta).
-- ---------------------------------------------------------------------------
create function public.reschedule_payment_event(
  p_event_id uuid,
  p_error text,
  p_backoff_seconds integer
) returns void
    language plpgsql security definer
    set search_path TO 'public', 'pg_temp'
    as $$
begin
  if p_backoff_seconds > 0 then
    update public.payment_events
       set status = 'received',
           last_error = left(coalesce(p_error, 'erro'), 300),
           available_at = now() + make_interval(secs => least(p_backoff_seconds, 86400)),
           locked_until = null,
           processed_at = null
     where id = p_event_id and status = 'received';
  else
    update public.payment_events
       set status = 'failed',
           last_error = left(coalesce(p_error, 'erro'), 300),
           locked_until = null,
           processed_at = null
     where id = p_event_id and status = 'received';
  end if;
end;
$$;

revoke all on function public.reschedule_payment_event(uuid, text, integer) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.reschedule_payment_event(uuid, text, integer) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. provider_api_gates: throttle GLOBAL de consultas ao provedor (por
--    pedido e por rota). Substitui o Map em memória do isolado: funciona
--    com N instâncias da Edge Function. Respeita `Retry-After` via
--    `not_before` (setado quando a API responde 429/503 com o cabeçalho).
-- ---------------------------------------------------------------------------
create table if not exists public.provider_api_gates (
  key text primary key,
  last_used_at timestamptz not null default now(),
  not_before timestamptz not null default now(),
  constraint provider_api_gates_key_length check (length(key) between 3 and 160)
);

comment on table public.provider_api_gates is
  'Gate de intervalo entre consultas a API do provedor por chave (pedido/rota). Tabela interna: RLS ligada, sem politicas, apenas service_role.';

alter table public.provider_api_gates enable row level security;
revoke all on public.provider_api_gates from public;
do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on public.provider_api_gates from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.provider_api_gates to service_role';
  end if;
end $$;

create function public.try_acquire_provider_slot(
  p_key text,
  p_interval_seconds integer
) returns boolean
    language plpgsql security definer
    set search_path TO 'public', 'pg_temp'
    as $$
declare
  v_interval integer := greatest(coalesce(p_interval_seconds, 15), 1);
  v_now timestamptz := now();
  v_gate public.provider_api_gates;
begin
  if p_key is null or length(p_key) not between 3 and 160 then
    return false;
  end if;

  select * into v_gate
  from public.provider_api_gates where key = p_key for update;

  if not found then
    -- Linha nova nasce "já fora da janela" (last_used_at no passado):
    -- o PRIMEIRO chamador adquire o slot; quem chamar em seguida respeita
    -- o intervalo a partir do uso real gravado abaixo.
    insert into public.provider_api_gates (key, last_used_at, not_before)
    values (p_key, v_now - make_interval(secs => v_interval), v_now)
    on conflict (key) do nothing
    returning * into v_gate;
    if v_gate.key is null then
      select * into v_gate from public.provider_api_gates where key = p_key for update;
    end if;
  end if;

  if v_gate.not_before > v_now then
    return false; -- janela de Retry-After ainda ativa
  end if;
  if v_gate.last_used_at > v_now - make_interval(secs => v_interval) then
    return false; -- intervalo mínimo entre consultas
  end if;

  update public.provider_api_gates
     set last_used_at = v_now
   where key = p_key;
  return true;
end;
$$;

create function public.record_provider_rate_limit(
  p_key text,
  p_retry_after_seconds integer
) returns void
    language plpgsql security definer
    set search_path TO 'public', 'pg_temp'
    as $$
begin
  if p_key is null or length(p_key) not between 3 and 160 then
    return;
  end if;
  insert into public.provider_api_gates (key, last_used_at, not_before)
  values (p_key, now(), now() + make_interval(secs => least(greatest(coalesce(p_retry_after_seconds, 30), 1), 3600)))
  on conflict (key) do update
    set not_before = excluded.not_before;
end;
$$;

revoke all on function public.try_acquire_provider_slot(text, integer) from public, anon, authenticated;
revoke all on function public.record_provider_rate_limit(text, integer) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.try_acquire_provider_slot(text, integer) to service_role';
    execute 'grant execute on function public.record_provider_rate_limit(text, integer) to service_role';
  end if;
end $$;
