import { encryptText, loadSecretMaterial, randomToken, sha256Hex, toBase64 } from '../crypto.ts';
import { isWyviProduction } from '../config.ts';
import type { Deps } from '../deps.ts';
import { errorResponse, json, methodGuard, preflight } from '../http.ts';
import {
  getCharge,
  mapChargeSituacao,
  verifyWebhookSignature,
  WyviPayError,
} from '../wyvipay.ts';
import { isUuid } from '../validation.ts';

/**
 * POST /wyvi-webhook — recebimento de eventos da WyviPay (API v2).
 *
 * GARANTIAS (nesta ordem — nenhuma é opcional):
 *   1. Assinatura conferida sobre o CORPO CRU antes de qualquer parse ou
 *      escrita: `HMAC-SHA256(whsec, "{X-Wyvi-Carimbo}.{corpo}")`, janela ±300 s.
 *      Assinatura ausente/errada/velha → 401 e ZERO linhas em `payment_events`.
 *   2. Deduplicação por `X-Wyvi-Entrega` (id da entrega): a mesma entrega
 *      processada duas vezes não repete efeitos (índice único por provedor).
 *   3. A notificação NUNCA é fonte de verdade: o estado só muda depois de
 *      RECONSULTAR `GET /cobrancas/{txid}` na API e casar o valor com o pedido.
 *   4. Evento de teste (`dados.teste = true`) em ambiente de produção é
 *      recusado — simulação jamais confirma pedido real.
 *   5. Só `apply_payment_status` (banco) altera pedido/estoque/entrega; este
 *      handler apenas traduz a situação consultada para o vocabulário dele.
 *
 * Resposta rápida (2xx) antes do trabalho pesado? Aqui o processamento é
 * curto (uma consulta + uma RPC) e a idempotência protege retentativas — a
 * fila de retentativas do provedor reentra sem duplicar efeito.
 */

interface WebhookEnvelope {
  id?: unknown;
  evento?: unknown;
  criado_em?: unknown;
  dados?: Record<string, unknown>;
}

interface RecordedEvent {
  event_id: string;
  duplicate: boolean;
  status: string;
}

/** Eventos que podem alterar o estado de uma cobrança. */
const CHARGE_EVENTS = new Set([
  'cobranca.paga',
  'cobranca.expirada',
  'cobranca.cancelada',
  'cobranca.estornada',
]);

async function newDeliveryToken(deps: Deps): Promise<{ hash: string; enc: string } | null> {
  const masterKey = await deps.resolveEncryptionKey();
  if (!masterKey) return null;
  const material = await loadSecretMaterial(masterKey);
  const token = randomToken(32);
  const encrypted = await encryptText(material.encryptionKey, token);
  let binary = '';
  for (const byte of encrypted) binary += String.fromCharCode(byte);
  return { hash: await sha256Hex(token), enc: btoa(binary) };
}

export async function handleWyviWebhook(request: Request, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();

  try {
    methodGuard(request, ['POST']);

    // Corpo CRU primeiro: a assinatura cobre os bytes recebidos, não um
    // objeto re-serializado (a ordem das chaves mudaria a conta).
    const rawBody = await request.text();

    const secret = deps.config.wyviWebhookSecret;
    if (!secret) {
      // Fail-closed: sem `whsec_` não existe prova de origem. O provedor
      // reenvia as entregas pendentes depois que o segredo for configurado.
      deps.log('wyvi_webhook.not_configured', {});
      return json({ error: 'webhook_not_configured' }, { status: 503 });
    }

    const signatureHeader = request.headers.get('x-wyvi-assinatura');
    const carimboHeader = request.headers.get('x-wyvi-carimbo');
    const entregaHeader = request.headers.get('x-wyvi-entrega');
    const eventoHeader = request.headers.get('x-wyvi-evento');

    const signatureValid = await verifyWebhookSignature({
      rawBody,
      signatureHeader,
      carimboHeader,
      secret,
      now: deps.now(),
    });

    if (!signatureValid) {
      // Nada é gravado nem consultado: notificação não autenticada não deixa
      // rastro no banco nem pode alterar estado de pedido algum.
      deps.log('wyvi_webhook.invalid_signature', {
        has_signature: Boolean(signatureHeader),
        has_carimbo: Boolean(carimboHeader),
      });
      return json({ error: 'invalid_signature' }, { status: 401 });
    }

    let body: WebhookEnvelope = {};
    try {
      body = rawBody ? (JSON.parse(rawBody) as WebhookEnvelope) : {};
    } catch {
      body = {};
    }

    const deliveryId =
      (entregaHeader && entregaHeader.trim()) ||
      (typeof body.id === 'string' && body.id.trim()) ||
      null;
    if (!deliveryId) {
      // Sem id de entrega não há como deduplicar: recusa explícita.
      return json({ error: 'missing_delivery_id' }, { status: 400 });
    }

    const evento =
      (eventoHeader && eventoHeader.trim()) ||
      (typeof body.evento === 'string' && body.evento) ||
      'desconhecido';
    const dados = (body.dados ?? {}) as Record<string, unknown>;
    const txid = typeof dados.txid === 'string' ? dados.txid : null;
    const payloadHash = await sha256Hex(rawBody || deliveryId);

    const recorded = await deps.rpc<RecordedEvent>('record_payment_event', {
      p_notification_id: deliveryId,
      p_event_type: evento,
      p_action: null,
      p_data_id: txid,
      p_signature_valid: true,
      p_payload_hash: payloadHash,
      p_provider: 'wyvipay',
    });

    if (recorded.duplicate && (recorded.status === 'processed' || recorded.status === 'ignored')) {
      return json({ received: true, duplicate: true });
    }

    // Eventos fora da família de cobrança (ex.: `webhook.teste`,
    // `chave.rotacionada`) ou sem txid: respondemos 200 para não gerar
    // retentativa, sem efeito nenhum no pedido. O UUID do pedido NÃO vem do
    // corpo — vem da reconsulta (`charge.referencia`), que é a fonte de verdade.
    if (!CHARGE_EVENTS.has(evento) || !txid) {
      await deps.rpc('finish_payment_event', {
        p_event_id: recorded.event_id,
        p_status: 'ignored',
        p_error: 'evento_sem_efeito',
      });
      return json({ received: true, ignored: true });
    }

    // ------------------------------------------------------------------
    // Ambiente de teste nunca confirma pedido real (controle R4).
    // ------------------------------------------------------------------
    const isTestEvent = dados.teste === true || dados.ambiente === 'homologacao';
    if (isTestEvent && isWyviProduction(deps.config)) {
      deps.log('wyvi_webhook.test_event_in_production', { delivery_id: deliveryId });
      await deps.rpc('finish_payment_event', {
        p_event_id: recorded.event_id,
        p_status: 'ignored',
        p_error: 'evento_de_teste_em_producao',
      });
      return json({ received: true, ignored: true, reason: 'test_event_in_production' });
    }

    if (!deps.config.wyviApiKey) {
      await deps.rpc('finish_payment_event', {
        p_event_id: recorded.event_id,
        p_status: 'failed',
        p_error: 'payment_not_configured',
      });
      return json({ error: 'payment_not_configured' }, { status: 503 });
    }

    // ------------------------------------------------------------------
    // FONTE DE VERDADE: reconsulta a cobrança. O corpo do evento é apenas
    // o aviso de que vale a pena consultar — valores e situação vêm da API.
    // ------------------------------------------------------------------
    try {
      const charge = await getCharge(
        { apiKey: deps.config.wyviApiKey, baseUrl: deps.config.wyviApiBase, fetchImpl: deps.fetchImpl },
        txid,
      );

      const orderId = charge.referencia;
      if (!orderId || !isUuid(orderId)) {
        await deps.rpc('finish_payment_event', {
          p_event_id: recorded.event_id,
          p_status: 'ignored',
          p_error: 'referencia_ausente',
        });
        return json({ received: true, ignored: true });
      }

      const mapped = mapChargeSituacao(charge.situacao);

      let token: { hash: string; enc: string } | null = null;
      if (mapped.providerStatus === 'approved') {
        token = await newDeliveryToken(deps);
      }

      const applied = await deps.rpc<{
        result: string;
        order_status?: string;
        requires_admin_review?: boolean;
      }>('apply_payment_status', {
        p_order_id: orderId,
        p_provider_payment_id: charge.txid,
        p_provider_status: mapped.providerStatus,
        p_status_detail: mapped.statusDetail,
        // Valor em centavos, direto da reconsulta: divergência → o banco
        // bloqueia a entrega (`amount_mismatch`) em vez de liberar.
        p_amount_cents: charge.valorCentavos,
        p_delivery_token_hash: token?.hash ?? null,
        p_delivery_token_enc_b64: token?.enc ?? null,
      });

      await deps.rpc('finish_payment_event', {
        p_event_id: recorded.event_id,
        p_status: 'processed',
        p_error: null,
      });

      deps.log('wyvi_webhook.processed', {
        delivery_id: deliveryId,
        order_id: orderId,
        situacao: charge.situacao,
        result: applied?.result,
      });

      if (applied?.result === 'ignored_late_approval') {
        deps.log('wyvi_webhook.late_approval_ignored', {
          delivery_id: deliveryId,
          order_id: orderId,
        });
      }
      if (applied?.result === 'amount_mismatch') {
        deps.log('wyvi_webhook.amount_mismatch', {
          delivery_id: deliveryId,
          order_id: orderId,
          expected_cents: charge.valorCentavos,
        });
      }
      if (applied?.result === 'charged_back' || applied?.requires_admin_review) {
        deps.log('wyvi_webhook.dispute_flagged', {
          delivery_id: deliveryId,
          order_id: orderId,
          order_status: applied?.order_status,
        });
      }

      return json({
        received: true,
        result: applied?.result ?? 'processed',
        requires_admin_review: applied?.requires_admin_review === true,
      });
    } catch (error) {
      await deps.rpc('finish_payment_event', {
        p_event_id: recorded.event_id,
        p_status: 'failed',
        p_error: error instanceof Error ? error.message.slice(0, 300) : 'unexpected_error',
      });
      // 5xx faz o provedor reenviar (retentativas até ~1 h); a dedup por
      // entrega garante que o reenvio não repita efeitos já aplicados.
      const providerStatus = error instanceof WyviPayError ? error.httpStatus : 0;
      deps.log('wyvi_webhook.failed', { delivery_id: deliveryId, http_status: providerStatus });
      return json({ error: 'processing_failed' }, { status: 500 });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
