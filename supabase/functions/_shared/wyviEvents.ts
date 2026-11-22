/**
 * Processamento de eventos da fila `payment_events` (provedor `wyvipay`).
 *
 * O webhook só REGISTRA (dedup por `X-Wyvi-Entrega`) e responde; quem
 * processa é este módulo, chamado por:
 *   - `wyvi-worker` (fila completa, quando a WyviPay nos aciona);
 *   - `order-status` (processa os eventos do pedido consultado — garante
 *     recuperação mesmo sem worker vivo).
 *
 * A fonte da verdade é SEMPRE a reconsulta à API (`GET /cobrancas/:txid`):
 * o conteúdo do evento orienta qual cobrança consultar, nunca é usado como
 * fato. Idempotência: `apply_payment_status` por `(order_id, txid)` — duas
 * execuções do mesmo evento não duplicam nada.
 *
 * Classificação de falha durante o processamento:
 *   - recusa definitiva do provedor (404/400/…) → `ignored` (nada a aplicar);
 *   - rede/5xx/erro transitório → reenfileirado com backoff;
 *   - falha estrutural recorrente → `failed` (fica visível na fila, sem
 *     perder o registro da entrega).
 */

import { encryptText, loadSecretMaterial, randomToken, sha256Hex } from './crypto.ts';
import type { Deps } from './deps.ts';
import {
  createCharge,
  getCharge,
  mapChargeSituacao,
  WyviPayError,
  type WyviPayConfig,
} from './wyvipay.ts';

/** Token de entrega novo (hash persistido; cifrado só em memória). */
async function newDeliveryToken(deps: Deps): Promise<{ hash: string; enc: string }> {
  const masterKey = await deps.resolveEncryptionKey();
  if (!masterKey) throw new Error('encryption_not_configured');
  const material = await loadSecretMaterial(masterKey);
  const token = randomToken(32);
  const encrypted = await encryptText(material.encryptionKey, token);
  let binary = '';
  for (const byte of encrypted) binary += String.fromCharCode(byte);
  return { hash: await sha256Hex(token), enc: btoa(binary) };
}

/** Evento devolvido por `claim_wyvi_events`. */
export interface ClaimedWyviEvent {
  event_id: string;
  notification_id: string | null;
  event_type: string | null;
  data_id: string | null;
  reference: string | null;
  provider_data: Record<string, unknown> | null;
  attempts: number;
  status: string;
}

export type EventOutcome =
  | { disposition: 'processed'; detail?: string }
  | { disposition: 'ignored'; reason: string }
  | { disposition: 'retry'; reason: string; retryAfterSeconds?: number }
  | { disposition: 'failed'; reason: string };

/** Backoff exponencial: 15s, 30s, 1m … até ~8h; 10ª tentativa → failed. */
const MAX_EVENT_ATTEMPTS = 10;

export function eventBackoffSeconds(attempts: number): number {
  if (attempts >= MAX_EVENT_ATTEMPTS) return 0;
  return Math.min(15 * 2 ** Math.max(attempts - 1, 0), 3600);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Processa UM evento já reivindicado da fila. Nunca lança: devolve o
 * desfecho para o chamador gravar (`finish_payment_event` ou
 * `reschedule_payment_event`).
 */
export async function processWyviEvent(
  deps: Deps,
  config: WyviPayConfig,
  event: ClaimedWyviEvent,
): Promise<EventOutcome> {
  const eventType = (event.event_type ?? '').trim();

  if (eventType === 'chave.rotacionada') {
    // A rotação é da chave do webhook (a chave personalizada não gira sozinha).
    return { disposition: 'ignored', reason: 'chave_rotacionada_sem_acao' };
  }
  if (!eventType.startsWith('cobranca.')) {
    return { disposition: 'ignored', reason: 'evento_fora_do_escopo' };
  }

  const data = (event.provider_data ?? {}) as Record<string, unknown>;
  const txid = typeof data.txid === 'string' ? data.txid : null;
  const reference = typeof data.referencia === 'string' ? data.referencia : event.reference;

  if (!txid) {
    return { disposition: 'ignored', reason: 'evento_sem_txid' };
  }
  if (!reference || !isUuid(reference)) {
    // Sem `referencia` (= order_id) não há como casar com segurança.
    return { disposition: 'ignored', reason: 'evento_sem_referencia_de_pedido' };
  }

  // Evento do ambiente errado nunca é aplicado (teste → produção e vice-versa).
  const isTestEnvironment = (config.apiKey ?? '').startsWith('wy_test_');
  if (typeof data.teste === 'boolean' && data.teste !== isTestEnvironment) {
    return { disposition: 'ignored', reason: 'ambiente_divergente' };
  }

  // ---------------------------------------------------------------
  // Fonte da verdade: reconsulta à API. O evento só aponta o txid.
  // ---------------------------------------------------------------
  let charge;
  try {
    charge = await getCharge(config, txid, reference);
  } catch (error) {
    if (error instanceof WyviPayError) {
      if (error.httpStatus === 404 || error.httpStatus === 400) {
        return { disposition: 'ignored', reason: `cobranca_inexistente_${error.httpStatus}` };
      }
      if (error.httpStatus >= 500 || error.httpStatus === 429) {
        return {
          disposition: 'retry',
          reason: `consulta_${error.httpStatus}`,
          retryAfterSeconds: error.retryAfterSeconds ?? undefined,
        };
      }
      // 401/403: chave errada — configuração; nada a aplicar agora.
      return { disposition: 'retry', reason: `consulta_${error.httpStatus}` };
    }
    return { disposition: 'retry', reason: 'consulta_rede' };
  }

  const mapped = mapChargeSituacao(charge.situacao);

  // Token de entrega novo quando o pagamento APROVA (mesma regra do
  // reconciliador): hash persistido, token cifrado só em memória.
  let token: { hash: string; enc: string } | null = null;
  if (mapped.providerStatus === 'approved') token = await newDeliveryToken(deps);

  try {
    await deps.rpc('apply_payment_status', {
      p_order_id: reference,
      p_provider_payment_id: txid,
      p_provider_status: mapped.providerStatus,
      p_status_detail: mapped.statusDetail,
      // Valor VINDO DA FONTE DE VERDADE — `apply_payment_status` confere
      // contra o total do pedido e recusa divergência (`amount_mismatch`).
      p_amount_cents: charge.valorCentavos,
      p_delivery_token_hash: token?.hash ?? null,
      p_delivery_token_enc_b64: token?.enc ?? null,
      p_provider: 'wyvipay',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'apply_failed';
    // `amount_mismatch`/`order_not_found` não se resolvem reprocessando.
    if (/amount_mismatch|order_not_found|unknown_payment_provider/.test(message)) {
      return { disposition: 'failed', reason: message.match(/amount_mismatch|order_not_found|unknown_payment_provider/)![0] };
    }
    return { disposition: 'retry', reason: 'apply_failed' };
  }

  deps.log('wyvi_event.applied', {
    event_id: event.event_id,
    order_id: reference,
    situacao: charge.situacao,
    mapped: mapped.providerStatus,
  });
  return { disposition: 'processed' };
}

/**
 * Reivindica e processa TODOS os eventos vencidos de UM pedido.
 * Retorna `true` se algum evento foi processado (o chamador pode reler o
 * estado do pedido — ele pode ter mudado).
 */
export async function processWyviQueueForOrder(
  deps: Deps,
  config: WyviPayConfig,
  orderId: string,
): Promise<boolean> {
  let touched = false;
  // Limite defensivo: a fila do pedido é pequena; cada volta esvazia o que
  // está vencido (eventos reenfileirados só voltam após o backoff).
  for (let round = 0; round < 20; round += 1) {
    const events = await deps.rpc<ClaimedWyviEvent[]>('claim_wyvi_events', {
      p_order_id: orderId,
      p_limit: 1,
    });
    if (!Array.isArray(events) || events.length === 0) return touched;

    for (const event of events) {
      const outcome = await processWyviEvent(deps, config, event);
      touched = true;
      await settleEvent(deps, event, outcome);
    }
  }
  return touched;
}

/** Grava o desfecho de uma tentativa de processamento na fila. */
export async function settleEvent(
  deps: Deps,
  event: ClaimedWyviEvent,
  outcome: EventOutcome,
): Promise<EventOutcome['disposition'] | 'unsettled'> {
  try {
    if (outcome.disposition === 'processed') {
      await deps.rpc('finish_payment_event', {
        p_event_id: event.event_id,
        p_status: 'processed',
        p_error: null,
      });
      return outcome.disposition;
    }
    if (outcome.disposition === 'ignored') {
      await deps.rpc('finish_payment_event', {
        p_event_id: event.event_id,
        p_status: 'ignored',
        p_error: outcome.reason.slice(0, 300),
      });
      return outcome.disposition;
    }
    if (outcome.disposition === 'failed') {
      await deps.rpc('finish_payment_event', {
        p_event_id: event.event_id,
        p_status: 'failed',
        p_error: outcome.reason.slice(0, 300),
      });
      deps.log('wyvi_event.failed', { event_id: event.event_id, reason: outcome.reason });
      return outcome.disposition;
    }
    // retry → backoff; quando as tentativas acabam, `failed` terminal.
    const base = eventBackoffSeconds(event.attempts);
    const backoff = base === 0 ? 0 : Math.max(base, Math.min(outcome.retryAfterSeconds ?? 0, 86400));
    await deps.rpc('reschedule_payment_event', {
      p_event_id: event.event_id,
      p_error: outcome.reason.slice(0, 300),
      p_backoff_seconds: backoff,
    });
    if (backoff === 0) {
      deps.log('wyvi_event.failed', { event_id: event.event_id, reason: outcome.reason });
    } else {
      deps.log('wyvi_event.retry', {
        event_id: event.event_id,
        attempts: event.attempts,
        backoff_seconds: backoff,
      });
    }
    return backoff === 0 ? 'failed' : 'retry';
  } catch {
    // A trava de 60s do claim se expira sozinha e o evento volta para a
    // fila — nunca perder o registro por falha ao gravar o desfecho.
    deps.log('wyvi_event.settle_failed', {
      event_id: event.event_id,
    });
    return 'unsettled';
  }
}

/**
 * Recuperação da cobrança de uma tentativa INCERTA (linha aberta sem txid).
 *
 * Repete a criação com a MESMA `Idempotency-Key` (`order-<uuid>`) e a MESMA
 * validade determinística do create-order: a API devolve a cobrança
 * original (replay) — nunca uma segunda — e o vínculo é completado aqui.
 * Retorna o estado atual do pedido, ou `null` se ainda não deu para
 * recuperar (o chamador mantém o polling).
 */
export async function recoverWyviCharge(
  deps: Deps,
  config: WyviPayConfig,
  order: {
    order_id: string;
    reference: string;
    total_cents: number;
    created_at: string;
    reservation_expires_at: string;
  },
): Promise<{ status: string; payment_status: string } | null> {
  // MESMA fórmula do create-order: derivada de created_at/reservation,
  // nunca de "agora" — qualquer repetição monta o corpo idêntico.
  const created = Date.parse(order.created_at ?? '');
  const deadline = Date.parse(order.reservation_expires_at);
  const base = Number.isFinite(created) ? created : deps.now().getTime();
  const seconds = Number.isFinite(deadline) ? Math.round((deadline - base) / 1000) : 1800;
  const expirationSeconds = Math.min(Math.max(seconds, 60), 2_592_000);

  const charge = await createCharge(config, {
    amountCents: order.total_cents,
    description: `Prime Store ${order.reference}`,
    reference: order.order_id,
    expirationSeconds,
    idempotencyKey: `order-${order.order_id}`,
  });

  if (!charge.txid) {
    // Replay devolveu cobrança sem txid: dado inesperado da API — tentar
    // de novo no próximo ciclo não resolve, mas também não quebra nada.
    return null;
  }

  const mapped = mapChargeSituacao(charge.situacao);
  await deps.rpc('attach_payment', {
    p_order_id: order.order_id,
    p_provider_payment_id: charge.txid,
    p_provider_status: mapped.providerStatus,
    p_amount_cents: order.total_cents,
    p_qr_code: charge.copiaECola,
    p_qr_code_base64: charge.qrcodeDataUri,
    p_ticket_url: null,
    p_expires_at: charge.expiraEm,
    p_provider: 'wyvipay',
  });

  deps.log('wyvi_recovery.bound', {
    order_id: order.order_id,
    situacao: charge.situacao,
    replayed: charge.replayed,
  });
  return { status: 'pending_payment', payment_status: mapped.providerStatus };
}
