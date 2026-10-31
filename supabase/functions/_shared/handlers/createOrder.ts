import { randomToken, sha256Hex } from '../crypto.ts';
import type { Deps } from '../deps.ts';
import { ApiError, errorResponse, json, methodGuard, preflight, readJson } from '../http.ts';
import { createPixPayment, MercadoPagoError } from '../mercadopago.ts';
import {
  optionalClientToken,
  optionalIdempotencyKey,
  requireEmail,
  requireQuantity,
  requireUuid,
} from '../validation.ts';

interface CreateOrderBody {
  product_id?: unknown;
  quantity?: unknown;
  payer_email?: unknown;
  email?: unknown;
  idempotency_key?: unknown;
}

interface CreatedOrder {
  order_id: string;
  reference: string;
  status: string;
  payment_status: string;
  delivery_status: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  reservation_expires_at: string;
  idempotent_replay: boolean;
}

interface AttachedPayment {
  payment_id: string;
  status: string;
  qr_code: string | null;
  qr_code_base64: string | null;
  ticket_url: string | null;
  expires_at: string | null;
}

/**
 * POST /create-order
 * Cria pedido + reserva (transação no banco) e em seguida a cobrança PIX.
 * Se a cobrança não puder ser criada, a reserva é liberada imediatamente.
 */
export async function handleCreateOrder(request: Request, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();

  try {
    methodGuard(request, ['POST']);

    const body = await readJson<CreateOrderBody>(request);
    const productId = requireUuid(body.product_id, 'product_id');
    const quantity = requireQuantity(body.quantity);
    const payerEmail = requireEmail(body.payer_email ?? body.email, 'payer_email');
    const idempotencyKey = optionalIdempotencyKey(body.idempotency_key);

    // O cliente pode enviar o token da sua tentativa de checkout: assim um
    // retry (relogar, falha de rede) repete a MESMA identidade e o banco
    // devolve o pedido original. Sem ele, o servidor gera um token novo e a
    // chave de idempotência passa a estar associada a esta requisição.
    const clientToken = optionalClientToken(body.client_token) ?? randomToken(32);
    const clientTokenHash = await sha256Hex(clientToken);

    let order: CreatedOrder;
    try {
      order = await deps.rpc<CreatedOrder>('create_order', {
        p_product_id: productId,
        p_quantity: quantity,
        p_idempotency_key: idempotencyKey,
        p_client_token_hash: clientTokenHash,
      });
    } catch (error) {
      throw error;
    }

    // Replay idempotente: reaproveita a cobrança já existente quando houver.
    if (order.idempotent_replay) {
      const existing = await deps.rpc<{
        payment: { qr_code: string | null; qr_code_base64: string | null; ticket_url: string | null; status: string; expires_at: string | null } | null;
        status: string;
      }>('get_order_status', { p_order_id: order.order_id, p_client_token_hash: clientTokenHash });

      if (existing.payment?.qr_code) {
        return json({
          order,
          client_token: clientToken,
          payment: {
            status: existing.payment.status,
            qr_code: existing.payment.qr_code,
            qr_code_base64: existing.payment.qr_code_base64,
            ticket_url: existing.payment.ticket_url,
            expires_at: existing.payment.expires_at,
          },
          replayed: true,
        });
      }

      if (existing.status !== 'pending_payment') {
        return json({ order, client_token: clientToken, payment: null, replayed: true });
      }
    }

    if (!deps.config.mercadoPagoAccessToken) {
      await deps.rpc('release_order_reservation', {
        p_order_id: order.order_id,
        p_reason: 'payment_not_configured',
      });
      throw new ApiError(
        503,
        'payment_not_configured',
        'Pagamento indisponível: Mercado Pago não configurado neste ambiente.',
      );
    }

    let snapshot;
    try {
      snapshot = await createPixPayment(
        {
          accessToken: deps.config.mercadoPagoAccessToken,
          baseUrl: deps.config.mercadoPagoApiBase,
          fetchImpl: deps.fetchImpl,
        },
        {
          amountCents: order.total_cents,
          description: `Prime Store ${order.reference}`,
          externalReference: order.order_id,
          payerEmail,
          notificationUrl: deps.config.paymentNotificationUrl,
          expirationMinutes: 30,
          idempotencyKey: `order-${order.order_id}`,
          now: deps.now(),
        },
      );
    } catch (error) {
      // Nunca deixar estoque preso por falha do provedor.
      await deps.rpc('release_order_reservation', {
        p_order_id: order.order_id,
        p_reason: 'payment_creation_failed',
      });
      deps.log('create_order.payment_failed', {
        order_id: order.order_id,
        http_status: error instanceof MercadoPagoError ? error.httpStatus : 0,
      });
      throw new ApiError(
        502,
        'payment_provider_unavailable',
        'Não foi possível gerar o PIX agora. O estoque foi liberado; tente novamente.',
      );
    }

    const payment = await deps.rpc<AttachedPayment>('attach_payment', {
      p_order_id: order.order_id,
      p_provider_payment_id: snapshot.providerPaymentId,
      p_provider_status: snapshot.status,
      p_amount_cents: order.total_cents,
      p_qr_code: snapshot.qrCode,
      p_qr_code_base64: snapshot.qrCodeBase64,
      p_ticket_url: snapshot.ticketUrl,
      p_expires_at: snapshot.expiresAt,
    });

    deps.log('create_order.created', {
      order_id: order.order_id,
      quantity: order.quantity,
      total_cents: order.total_cents,
    });

    return json(
      {
        order,
        client_token: clientToken,
        payment: {
          status: payment.status,
          qr_code: payment.qr_code,
          qr_code_base64: payment.qr_code_base64,
          ticket_url: payment.ticket_url,
          expires_at: payment.expires_at,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
