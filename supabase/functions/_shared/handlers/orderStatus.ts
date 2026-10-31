import {
  decryptText,
  encryptText,
  fromBase64,
  loadSecretMaterial,
  randomToken,
  sha256Hex,
} from '../crypto.ts';
import type { Deps } from '../deps.ts';
import { errorResponse, json, methodGuard, preflight, readJson } from '../http.ts';
import { getPayment } from '../mercadopago.ts';
import { requirePrivateToken, requireUuid } from '../validation.ts';

interface OrderStatusBody {
  order_id?: unknown;
  client_token?: unknown;
}

export interface OrderStatusPayload {
  order_id: string;
  reference: string;
  status: string;
  payment_status: string;
  delivery_status: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  created_at: string;
  paid_at: string | null;
  reservation_expires_at: string;
  product: {
    id: string;
    slug: string;
    name: string;
    instructions: string;
    access_validity_label: string;
  };
  payment: {
    status: string;
    provider_payment_id?: string | null;
    status_detail?: string | null;
    amount_cents?: number;
    qr_code: string | null;
    qr_code_base64: string | null;
    ticket_url: string | null;
    expires_at: string | null;
  } | null;
  delivery: { id: string; status: string; token_enc: string; created_at: string } | null;
  availability: { available_units: number };
}

async function newDeliveryToken(deps: Deps): Promise<{ hash: string; enc: string } | null> {
  if (!deps.config.encryptionKey) return null;
  const material = await loadSecretMaterial(deps.config.encryptionKey);
  const token = randomToken(32);
  const encrypted = await encryptText(material.encryptionKey, token);
  let binary = '';
  for (const byte of encrypted) binary += String.fromCharCode(byte);
  return { hash: await sha256Hex(token), enc: btoa(binary) };
}

/**
 * POST /order-status
 * Consulta o pedido pelo token privado e, se necessário, reconcilia o
 * pagamento diretamente com o Mercado Pago (fonte de verdade).
 */
export async function handleOrderStatus(request: Request, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();

  try {
    methodGuard(request, ['POST']);

    const body = await readJson<OrderStatusBody>(request);
    const orderId = requireUuid(body.order_id, 'order_id');
    const clientToken = requirePrivateToken(body.client_token, 'client_token');
    const clientTokenHash = await sha256Hex(clientToken);

    let status = await deps.rpc<OrderStatusPayload>('get_order_status', {
      p_order_id: orderId,
      p_client_token_hash: clientTokenHash,
    });

    const providerPaymentId = status.payment?.provider_payment_id ?? null;
    const shouldReconcile =
      Boolean(deps.config.mercadoPagoAccessToken) &&
      Boolean(providerPaymentId) &&
      (status.status === 'pending_payment' || status.payment?.status === 'in_process');

    if (shouldReconcile && providerPaymentId) {
      try {
        const snapshot = await getPayment(
          {
            accessToken: deps.config.mercadoPagoAccessToken as string,
            baseUrl: deps.config.mercadoPagoApiBase,
            fetchImpl: deps.fetchImpl,
          },
          providerPaymentId,
        );

        if (snapshot.status !== status.payment?.status || snapshot.status === 'approved') {
          const token = snapshot.status === 'approved' ? await newDeliveryToken(deps) : null;
          await deps.rpc('apply_payment_status', {
            p_order_id: orderId,
            p_provider_payment_id: snapshot.providerPaymentId,
            p_provider_status: snapshot.status,
            p_status_detail: snapshot.statusDetail,
            p_amount_cents: snapshot.amountCents,
            p_delivery_token_hash: token?.hash ?? null,
            p_delivery_token_enc_b64: token?.enc ?? null,
          });
          status = await deps.rpc<OrderStatusPayload>('get_order_status', {
            p_order_id: orderId,
            p_client_token_hash: clientTokenHash,
          });
        }
      } catch (error) {
        // Indisponibilidade do provedor não deve quebrar a consulta do pedido.
        deps.log('order_status.reconcile_failed', { order_id: orderId });
      }
    }

    let deliveryUrl: string | null = null;
    if (
      status.delivery &&
      status.delivery.status === 'active' &&
      status.delivery_status === 'ready' &&
      deps.config.encryptionKey
    ) {
      try {
        const material = await loadSecretMaterial(deps.config.encryptionKey);
        const token = await decryptText(
          material.encryptionKey,
          fromBase64(status.delivery.token_enc),
        );
        deliveryUrl = `${deps.config.storeUrl.replace(/\/+$/, '')}/entrega/${encodeURIComponent(token)}`;
      } catch {
        deps.log('order_status.delivery_token_unreadable', { order_id: orderId });
      }
    }

    const { delivery, ...rest } = status;

    return json({
      ...rest,
      payment: status.payment
        ? {
            status: status.payment.status,
            status_detail: status.payment.status_detail ?? null,
            qr_code: status.payment.qr_code,
            qr_code_base64: status.payment.qr_code_base64,
            ticket_url: status.payment.ticket_url,
            expires_at: status.payment.expires_at,
          }
        : null,
      delivery: delivery
        ? { id: delivery.id, status: delivery.status, created_at: delivery.created_at, url: deliveryUrl }
        : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
