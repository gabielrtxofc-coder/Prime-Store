import { createHmac } from 'node:crypto';

/**
 * Assinatura fictícia de webhook, no mesmo formato do provedor.
 *
 * Usada apenas pelos testes: monta `ts=...,v1=<hmac>` sobre o manifesto
 * `id:{data.id};request-id:{x-request-id};ts:{ts};` com um segredo controlado
 * pelo próprio teste. Nenhum segredo real, nenhuma rota de bypass: a Edge
 * Function continua exigindo a assinatura e o segredo do ambiente.
 */
export interface SignedNotification {
  headers: Record<string, string>;
  body: string;
}

export function buildSignatureManifest(params: {
  dataId: string;
  requestId: string;
  ts: string;
}): string {
  return `id:${params.dataId};request-id:${params.requestId};ts:${params.ts};`;
}

export function signWebhook(params: {
  dataId: string;
  requestId: string;
  secret: string;
  /** Segundos desde a época; padrão: agora. */
  ts?: number;
  /** Notificação com id próprio (deduplicação por `notification_id`). */
  notificationId?: string;
  type?: string;
  action?: string;
}): SignedNotification {
  const ts = String(params.ts ?? Math.floor(Date.now() / 1000));
  const manifest = buildSignatureManifest({ dataId: params.dataId, requestId: params.requestId, ts });
  const v1 = createHmac('sha256', params.secret).update(manifest).digest('hex');

  return {
    headers: {
      'Content-Type': 'application/json',
      'x-signature': `ts=${ts},v1=${v1}`,
      'x-request-id': params.requestId,
    },
    body: JSON.stringify({
      id: params.notificationId ?? `notif-${params.requestId}`,
      type: params.type ?? 'payment',
      action: params.action ?? 'payment.updated',
      data: { id: params.dataId },
    }),
  };
}

/** Requisição assinada pronta para `handleMpWebhook`, com URL canônica. */
export function signedWebhookRequest(signed: SignedNotification, url = 'https://fn.test/mp-webhook'): Request {
  return new Request(url, { method: 'POST', headers: signed.headers, body: signed.body });
}
