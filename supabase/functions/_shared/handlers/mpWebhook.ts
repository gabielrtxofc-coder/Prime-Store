import { encryptText, loadSecretMaterial, randomToken, sha256Hex, toBase64 } from '../crypto.ts';
import type { Deps } from '../deps.ts';
import { errorResponse, json, methodGuard, preflight } from '../http.ts';
import { getPayment, verifyWebhookSignature } from '../mercadopago.ts';
import { isUuid } from '../validation.ts';

interface WebhookBody {
  id?: unknown;
  type?: unknown;
  action?: unknown;
  data?: { id?: unknown };
}

interface RecordedEvent {
  event_id: string;
  duplicate: boolean;
  status: string;
}

/**
 * POST /mp-webhook
 * Idempotente e nunca confia no conteúdo da notificação: sempre reconfere o
 * pagamento na API do Mercado Pago antes de mudar qualquer estado.
 */
export async function handleMpWebhook(request: Request, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();

  try {
    methodGuard(request, ['POST']);

    const rawBody = await request.text();
    let body: WebhookBody = {};
    try {
      body = rawBody ? (JSON.parse(rawBody) as WebhookBody) : {};
    } catch {
      body = {};
    }

    const url = new URL(request.url);
    const dataId =
      (body.data?.id !== undefined && body.data?.id !== null ? String(body.data.id) : null) ??
      url.searchParams.get('data.id') ??
      url.searchParams.get('id');
    const typeParam = (typeof body.type === 'string' ? body.type : url.searchParams.get('type')) ?? null;
    const action = typeof body.action === 'string' ? body.action : url.searchParams.get('action');
    const requestId = request.headers.get('x-request-id');
    const notificationId =
      body.id !== undefined && body.id !== null
        ? String(body.id)
        : `${typeParam ?? 'unknown'}:${dataId ?? 'none'}:${requestId ?? 'no-request-id'}`;

    const payloadHash = await sha256Hex(rawBody || notificationId);
    const signatureHeader = request.headers.get('x-signature');

    let signatureValid: boolean | null = null;
    if (deps.config.mercadoPagoWebhookSecret) {
      signatureValid = await verifyWebhookSignature({
        signatureHeader,
        requestId,
        dataId,
        secret: deps.config.mercadoPagoWebhookSecret,
      });

      if (!signatureValid) {
        deps.log('mp_webhook.invalid_signature', { notification_id: notificationId });
        return json({ error: 'invalid_signature' }, { status: 401 });
      }
    }

    const recorded = await deps.rpc<RecordedEvent>('record_payment_event', {
      p_notification_id: notificationId,
      p_event_type: typeParam,
      p_action: action ?? null,
      p_data_id: dataId,
      p_signature_valid: signatureValid,
      p_payload_hash: payloadHash,
    });

    if (recorded.duplicate && (recorded.status === 'processed' || recorded.status === 'ignored')) {
      return json({ received: true, duplicate: true });
    }

    const isPaymentTopic =
      (typeParam ?? '').startsWith('payment') || (action ?? '').includes('payment') || !typeParam;

    if (!dataId || !isPaymentTopic) {
      await deps.rpc('finish_payment_event', {
        p_event_id: recorded.event_id,
        p_status: 'ignored',
        p_error: 'tipo_de_notificacao_sem_efeito',
      });
      return json({ received: true, ignored: true });
    }

    if (!deps.config.mercadoPagoAccessToken) {
      await deps.rpc('finish_payment_event', {
        p_event_id: recorded.event_id,
        p_status: 'failed',
        p_error: 'payment_not_configured',
      });
      return json({ error: 'payment_not_configured' }, { status: 503 });
    }

    try {
      const snapshot = await getPayment(
        {
          accessToken: deps.config.mercadoPagoAccessToken,
          baseUrl: deps.config.mercadoPagoApiBase,
          fetchImpl: deps.fetchImpl,
        },
        dataId,
      );

      const orderId = snapshot.externalReference;
      if (!orderId || !isUuid(orderId)) {
        await deps.rpc('finish_payment_event', {
          p_event_id: recorded.event_id,
          p_status: 'ignored',
          p_error: 'external_reference_ausente',
        });
        return json({ received: true, ignored: true });
      }

      let token: { hash: string; enc: string } | null = null;
      const masterKey = snapshot.status === 'approved' ? await deps.resolveEncryptionKey() : null;
      if (snapshot.status === 'approved' && masterKey) {
        const material = await loadSecretMaterial(masterKey);
        const rawToken = randomToken(32);
        token = {
          hash: await sha256Hex(rawToken),
          enc: toBase64(await encryptText(material.encryptionKey, rawToken)),
        };
      }

      const applied = await deps.rpc<{
        result: string;
        order_status?: string;
        requires_admin_review?: boolean;
      }>('apply_payment_status', {
        p_order_id: orderId,
        p_provider_payment_id: snapshot.providerPaymentId,
        p_provider_status: snapshot.status,
        p_status_detail: snapshot.statusDetail,
        p_amount_cents: snapshot.amountCents,
        p_delivery_token_hash: token?.hash ?? null,
        p_delivery_token_enc_b64: token?.enc ?? null,
      });

      await deps.rpc('finish_payment_event', {
        p_event_id: recorded.event_id,
        p_status: 'processed',
        p_error: null,
      });

      deps.log('mp_webhook.processed', {
        notification_id: notificationId,
        order_id: orderId,
        provider_status: snapshot.status,
        result: applied?.result,
      });

      // Contestações (chargeback) NÃO são reembolsos: o pedido fica em disputa,
      // a entrega é preservada e o caso vai para revisão manual no painel.
      if (applied?.result === 'charged_back' || applied?.requires_admin_review) {
        deps.log('mp_webhook.dispute_flagged', {
          notification_id: notificationId,
          order_id: orderId,
          order_status: applied?.order_status,
        });
      }

      // Aprovação que chega depois de um encerramento (reembolso/expiração)
      // não reabre o pedido nem libera unidades: só é registrada.
      if (applied?.result === 'ignored_late_approval') {
        deps.log('mp_webhook.late_approval_ignored', {
          notification_id: notificationId,
          order_id: orderId,
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
      deps.log('mp_webhook.failed', { notification_id: notificationId });
      // 500 faz o Mercado Pago reenviar a notificação (idempotência protege).
      return json({ error: 'processing_failed' }, { status: 500 });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
