/**
 * Cliente do Mercado Pago para PIX via Checkout Transparente (API de Payments).
 *
 * Referências oficiais consultadas (docs.mercadopago.com.br/developers):
 *   - Checkout Transparente > API de Payments (POST /v1/payments)
 *   - Notificações > Webhooks (x-signature: ts=...,v1=... + manifest)
 *
 * A API de Orders é a recomendada para integrações novas; a API de Payments
 * continua suportada e é a usada aqui por ser a base estável do PIX com QR
 * Code dinâmico e por permitir migração futura sem alterar o domínio.
 *
 * Nenhum dado pessoal do comprador é persistido por este arquivo: o e-mail só
 * trafega até o provedor.
 */

import { toHex } from './crypto.ts';

export interface MercadoPagoConfig {
  accessToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface CreatePixPaymentInput {
  amountCents: number;
  description: string;
  externalReference: string;
  payerEmail: string;
  payerFirstName?: string;
  notificationUrl?: string | null;
  expirationMinutes: number;
  idempotencyKey: string;
  now?: Date;
}

export interface PaymentSnapshot {
  providerPaymentId: string;
  status: string;
  statusDetail: string | null;
  amountCents: number | null;
  qrCode: string | null;
  qrCodeBase64: string | null;
  ticketUrl: string | null;
  expiresAt: string | null;
  externalReference: string | null;
}

export class MercadoPagoError extends Error {
  readonly httpStatus: number;
  readonly providerMessage: string;

  constructor(httpStatus: number, providerMessage: string) {
    super(`mercado_pago_error:${httpStatus}`);
    this.httpStatus = httpStatus;
    this.providerMessage = providerMessage;
  }
}

/** Validade mínima aceita pelo provedor para PIX. */
export const MIN_PIX_EXPIRATION_MINUTES = 30;

/**
 * Manifesto da assinatura de webhook conforme documentação:
 *   id:{data.id};request-id:{x-request-id};ts:{ts};
 */
export function buildSignatureManifest(params: {
  dataId: string | null;
  requestId: string | null;
  ts: string | null;
}): string {
  return `id:${params.dataId ?? ''};request-id:${params.requestId ?? ''};ts:${params.ts ?? ''};`;
}

export function parseSignatureHeader(header: string | null): { ts: string | null; v1: string | null } {
  if (!header) return { ts: null, v1: null };
  const parts = header.split(',');
  let ts: string | null = null;
  let v1: string | null = null;
  for (const part of parts) {
    const [rawKey, rawValue] = part.split('=');
    const key = rawKey?.trim();
    const value = rawValue?.trim() ?? null;
    if (key === 'ts') ts = value;
    if (key === 'v1') v1 = value;
  }
  return { ts, v1 };
}

/**
 * Verifica a assinatura HMAC do webhook em tempo constante.
 * A notificação nunca é a fonte de verdade do pagamento: mesmo válida, o
 * handler sempre reconfere o pagamento na API.
 */
export async function verifyWebhookSignature(params: {
  signatureHeader: string | null;
  requestId: string | null;
  dataId: string | null;
  secret: string;
}): Promise<boolean> {
  const { ts, v1 } = parseSignatureHeader(params.signatureHeader);
  if (!ts || !v1) return false;

  const manifest = buildSignatureManifest({ dataId: params.dataId, requestId: params.requestId, ts });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(params.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest));
  const expected = toHex(new Uint8Array(signature));
  return timingSafeEqual(expected, v1.toLowerCase());
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function normalizeStatus(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : 'pending';
}

/** Extrai apenas os campos necessários e descarta qualquer dado pessoal. */
export function sanitizePayment(raw: unknown): PaymentSnapshot {
  const payload = (raw ?? {}) as Record<string, unknown>;
  const transactionData = (
    (payload.point_of_interaction as Record<string, unknown> | undefined)?.transaction_data ?? {}
  ) as Record<string, unknown>;

  const amount = typeof payload.transaction_amount === 'number'
    ? Math.round(payload.transaction_amount * 100)
    : null;

  return {
    providerPaymentId: String(payload.id ?? ''),
    status: normalizeStatus(payload.status),
    statusDetail: typeof payload.status_detail === 'string' ? payload.status_detail : null,
    amountCents: amount,
    qrCode: typeof transactionData.qr_code === 'string' ? transactionData.qr_code : null,
    qrCodeBase64: typeof transactionData.qr_code_base64 === 'string' ? transactionData.qr_code_base64 : null,
    ticketUrl: typeof transactionData.ticket_url === 'string' ? transactionData.ticket_url : null,
    expiresAt:
      typeof payload.date_of_expiration === 'string'
        ? payload.date_of_expiration
        : typeof payload.date_approved === 'string'
          ? null
          : null,
    externalReference:
      typeof payload.external_reference === 'string' ? payload.external_reference : null,
  };
}

async function request(
  config: MercadoPagoConfig,
  path: string,
  init: { method: string; body?: unknown; idempotencyKey?: string },
): Promise<unknown> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const base = (config.baseUrl ?? 'https://api.mercadopago.com').replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15000);

  try {
    const response = await fetchImpl(`${base}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
        ...(init.idempotencyKey ? { 'X-Idempotency-Key': init.idempotencyKey } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const message =
        (payload as { message?: string } | null)?.message ?? `HTTP ${response.status}`;
      throw new MercadoPagoError(response.status, String(message).slice(0, 300));
    }

    return payload;
  } catch (error) {
    if (error instanceof MercadoPagoError) throw error;
    throw new MercadoPagoError(503, error instanceof Error ? error.message : 'network_error');
  } finally {
    clearTimeout(timeout);
  }
}

export async function createPixPayment(
  config: MercadoPagoConfig,
  input: CreatePixPaymentInput,
): Promise<PaymentSnapshot> {
  const minutes = Math.max(input.expirationMinutes, MIN_PIX_EXPIRATION_MINUTES);
  const now = input.now ?? new Date();
  const expiration = new Date(now.getTime() + minutes * 60_000);

  const body = {
    transaction_amount: Number((input.amountCents / 100).toFixed(2)),
    description: input.description.slice(0, 250),
    payment_method_id: 'pix',
    external_reference: input.externalReference,
    ...(input.notificationUrl ? { notification_url: input.notificationUrl } : {}),
    date_of_expiration: expiration.toISOString(),
    payer: {
      email: input.payerEmail,
      ...(input.payerFirstName ? { first_name: input.payerFirstName.slice(0, 60) } : {}),
    },
  };

  const payload = await request(config, '/v1/payments', {
    method: 'POST',
    body,
    idempotencyKey: input.idempotencyKey,
  });

  return sanitizePayment(payload);
}

export async function getPayment(
  config: MercadoPagoConfig,
  paymentId: string,
): Promise<PaymentSnapshot> {
  const payload = await request(config, `/v1/payments/${encodeURIComponent(paymentId)}`, {
    method: 'GET',
  });
  return sanitizePayment(payload);
}
