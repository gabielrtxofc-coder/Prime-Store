import { isDemoSandboxAllowed } from '../config.ts';
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
  /** Presente quando o catálogo informa a origem do produto. */
  product?: { id: string; name: string; slug: string; is_demo?: boolean } | null;
}

/**
 * Estados em que o pedido original não pode mais ser pago nem reaproveitado.
 *
 * Auditoria da missão 06: no replay idempotente de um pedido nesse estado o
 * handler devolvia `200 { order, payment: null, replayed: true }`. O navegador
 * interpretava a resposta como um checkout vivo, limpava o carrinho e abria a
 * tela de pagamento de um pedido morto — sem caminho de volta. Agora o cliente
 * recebe um erro explícito e pode iniciar uma nova tentativa (novo token e nova
 * chave), sem risco de cobrança dupla: nada foi cobrado neste pedido.
 */
const CLOSED_ORDER_STATUSES = ['failed', 'expired', 'cancelled'];

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
      // Antes de qualquer outra coisa: se o pedido original já foi encerrado,
      // nada foi cobrado e esta identidade nunca vai gerar um pedido pagável.
      // Devolver 200 (com a cobrança antiga ou sem cobrança) faria o navegador
      // tratar a resposta como checkout vivo, limpar o carrinho e abrir uma
      // tela sem saída. O cliente recebe um erro explícito e reinicia o
      // checkout com uma identidade nova.
      if (CLOSED_ORDER_STATUSES.includes(order.status)) {
        throw new ApiError(
          409,
          'previous_attempt_closed',
          'A tentativa anterior deste checkout foi encerrada sem cobrança. Inicie um novo checkout.',
        );
      }

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
        // Pedido pago/reembolsado: devolve o estado atual (sem nova cobrança)
        // para que o comprador chegue ao link de entrega.
        return json({ order, client_token: clientToken, payment: null, replayed: true });
      }

      if (isDemoSandboxAllowed(deps.config) && order.product?.is_demo === true) {
        return json({
          order,
          client_token: clientToken,
          payment: null,
          payment_mode: 'demo',
          replayed: true,
        });
      }
    }

    // Sem credenciais do provedor: o pedido só continua de pé se o ambiente de
    // demonstração estiver autorizado E o produto for de demonstração. Assim a
    // reserva não fica presa em um pedido que nunca poderá ser pago.
    const demoEligible = isDemoSandboxAllowed(deps.config) && order.product?.is_demo === true;

    if (!deps.config.mercadoPagoAccessToken) {
      if (demoEligible) {
        deps.log('create_order.demo_pending', { order_id: order.order_id });
        return json(
          {
            order,
            client_token: clientToken,
            payment: null,
            payment_mode: 'demo',
            demo_notice:
              'Modo de demonstração: nenhuma cobrança foi gerada. A aprovação pode ser simulada nesta tela.',
          },
          { status: 201 },
        );
      }

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
