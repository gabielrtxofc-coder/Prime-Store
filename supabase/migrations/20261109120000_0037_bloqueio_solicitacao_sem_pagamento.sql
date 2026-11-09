-- ============================================================================
-- 0037 — BLOQUEIO DE CONFIRMAÇÃO DE PAGAMENTO EM SOLICITAÇÃO SEM PAGAMENTO
-- ============================================================================
-- Falha corrigida (auditoria independente): a solicitação pública sem cobrança
-- (`status = 'requested'`, `payment_status = 'not_required'`, migração 0033)
-- podia ser convertida em pedido pago chamando `apply_payment_status` com uma
-- aprovação — o ramo `approved` alocava unidades disponíveis
-- (`allocate_late_units_for_order`), gravava `paid_at`, marcava o pedido como
-- `paid`/`approved` e criava a entrega com token privado.
--
-- Correção: `apply_payment_status` é redefinida pelo mesmo conteúdo da 0035 —
-- nenhuma regra de negócio muda — com uma guarda única, executada depois de
-- localizar e travar o pedido (`for update`) e antes de qualquer alteração.
--
--   * `status = 'requested'`     → rejeita;
--   * `payment_status = 'not_required'` → rejeita;
--   * resultado devolvido: `ignored_no_payment_required`.
--
-- A guarda é anterior à busca/criação de pagamento, à checagem de valor, à
-- alocação de estoque, aos eventos e à entrega: nenhum desses registros é
-- tocado. A proteção vive no banco (fonte de verdade) porque todo caminho de
-- confirmação — `order-status`, `mp-webhook`, `demo-payment`,
-- `internal_confirm_payment` — converge para esta função.
--
-- Vendas legítimas (pedidos com cobrança) seguem exatamente o comportamento da
-- 0035: aprovação, aprovação atrasada, divergência de valor, recusa,
-- reembolso, chargeback e idempotência permanecem inalterados.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_payment_status(p_order_id uuid, p_provider_payment_id text, p_provider_status text, p_status_detail text, p_amount_cents integer, p_delivery_token_hash text DEFAULT NULL::text, p_delivery_token_enc_b64 text DEFAULT NULL::text)
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
  v_result text;
  v_order_status text;
begin
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

revoke all on function public.apply_payment_status(uuid, text, text, text, integer, text, text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.apply_payment_status(uuid, text, text, text, integer, text, text) to service_role';
  end if;
end
$$;
