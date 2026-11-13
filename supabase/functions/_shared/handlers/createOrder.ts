import { isDemoSandboxAllowed, isWyviPayConfigured } from '../config.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import type { Deps } from '../deps.ts';
import { ApiError, errorResponse, json, methodGuard, preflight, readJson } from '../http.ts';
import { createPixPayment, MercadoPagoError } from '../mercadopago.ts';
import { enforceRateLimit } from '../rateLimit.ts';
import {
  isUuid,
  optionalClientToken,
  optionalIdempotencyKey,
  requireEmail,
  requireQuantity,
  requireUuid,
} from '../validation.ts';
import { createCharge, mapChargeSituacao, WyviPayError } from '../wyvipay.ts';

/**
 * POST /create-order — cria o pedido multi-item (reserva de estoque) e a
 * cobrança PIX pela **WyviPay API v2** (fluxo ativo). O Mercado Pago permanece
 * como caminho legado/congelado: só é usado se NÃO houver chave WyviPay e houver
 * `MP_ACCESS_TOKEN` (compatibilidade com ambientes e testes já existentes).
 *
 * Garantias:
 *   - Pedido + itens + reserva numa única transação (`create_order_multi`,
 *     migração 0034): multi-produto nativo, preço e estoque decididos no banco.
 *   - Cobrança com valor em CENTAVOS (`total_cents`) e `Idempotency-Key`
 *     determinística POR PEDIDO (`order-<uuid>`): repetir a requisição devolve
 *     a MESMA cobrança — nunca duas.
 *   - Falha do provedor libera a reserva na hora (nada de estoque preso).
 *   - Sem provedor configurado: modo demonstrativo (sandbox autorizado),
 *     solicitação sem pagamento (quando o cliente pede `fallback_to_request`)
 *     ou `503 payment_not_configured` com reserva liberada.
 *   - Nenhum dado pessoal é enviado à WyviPay (só valor, descrição e
 *     referência); nome/e-mail ficam no pedido, protegidos por RLS.
 */

interface CreateOrderBody {
  product_id?: unknown;
  quantity?: unknown;
  /** Carrinho multi-item: `[{ product_id, quantity }]` (1..10 itens). */
  items?: unknown;
  payer_email?: unknown;
  email?: unknown;
  /** Nome do comprador (opcional; gravado em `orders.buyer_name`). */
  buyer_name?: unknown;
  idempotency_key?: unknown;
  client_token?: unknown;
  /**
   * Sem provedor de pagamento configurado, registra uma SOLICITAÇÃO sem
   * pagamento (o mesmo que `/order-request`) em vez de responder 503 — o
   * checkout não fica sem saída em ambiente sem chave. Nunca contorna a
   * cobrança: só é considerado quando NENHUM provedor está ativo.
   */
  fallback_to_request?: unknown;
}

interface RequestItem {
  product_id: string;
  quantity: number;
}

interface CreatedOrder {
  order_id: string;
  reference: string;
  status: string;
  payment_status: string;
  delivery_status: string;
  items_count?: number;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  reservation_expires_at: string;
  created_at?: string;
  idempotent_replay: boolean;
  buyer_name?: string | null;
  /** Presente quando o catálogo informa a origem do produto. */
  product?: {
    id: string;
    name: string;
    slug?: string;
    instructions?: string;
    access_validity_label?: string;
    is_demo?: boolean;
  } | null;
  items?: Array<{
    product_id: string;
    product_name: string;
    product_slug: string;
    quantity: number;
    unit_price_cents: number;
    subtotal_cents: number;
  }>;
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
 *
 * `requested` entra na lista: é a solicitação sem pagamento (0033) — ela nunca
 * terá cobrança neste fluxo, então tratar a repetição como "tentativa encerrada"
 * evita responder um checkout que não pode ser pago.
 */
const CLOSED_ORDER_STATUSES = ['failed', 'expired', 'cancelled', 'requested'];

interface AttachedPayment {
  payment_id: string;
  status: string;
  qr_code: string | null;
  qr_code_base64: string | null;
  ticket_url: string | null;
  expires_at: string | null;
}

const MAX_ITEMS = 10;
const MAX_ITEM_QUANTITY = 20;

/** Aceita `items[]` (multi-item) OU o formato legado `product_id` + `quantity`. */
function parseItems(body: CreateOrderBody): RequestItem[] {
  if (Array.isArray(body.items)) {
    if (body.items.length === 0 || body.items.length > MAX_ITEMS) {
      throw new ApiError(422, 'invalid_items', 'Envie de 1 a 10 produtos.');
    }
    const seen = new Set<string>();
    const items: RequestItem[] = [];
    for (const raw of body.items) {
      if (typeof raw !== 'object' || raw === null) {
        throw new ApiError(422, 'invalid_items', 'Item inválido.');
      }
      const entry = raw as { product_id?: unknown; quantity?: unknown };
      if (!isUuid(entry.product_id)) {
        throw new ApiError(422, 'invalid_items', 'Item inválido.');
      }
      const quantity = typeof entry.quantity === 'number' ? entry.quantity : Number(entry.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
        throw new ApiError(422, 'invalid_items', 'Quantidade inválida.');
      }
      if (seen.has(entry.product_id)) {
        throw new ApiError(422, 'invalid_items', 'Produto repetido no pedido.');
      }
      seen.add(entry.product_id);
      items.push({ product_id: entry.product_id, quantity });
    }
    return items;
  }

  // Formato legado (produto único): convertido para o MESMO fluxo multi-item.
  if (body.product_id !== undefined) {
    const productId = requireUuid(body.product_id, 'product_id');
    const quantity = requireQuantity(body.quantity);
    return [{ product_id: productId, quantity }];
  }

  throw new ApiError(422, 'invalid_payload', 'Informe os produtos do pedido.');
}

function parseOptionalName(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ApiError(422, 'invalid_payload', 'Campo inválido: buyer_name');
  }
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 120) {
    throw new ApiError(422, 'invalid_payload', 'Informe seu nome completo.');
  }
  return trimmed;
}

/** Validade da cobrança em segundos, alinhada à reserva do pedido. */
function chargeExpirationSeconds(reservationExpiresAt: string, now: Date): number {
  const deadline = Date.parse(reservationExpiresAt);
  if (!Number.isFinite(deadline)) return 1800;
  const seconds = Math.round((deadline - now.getTime()) / 1000);
  // Faixa aceita pela API: 60 s … 30 dias.
  return Math.min(Math.max(seconds, 60), 2_592_000);
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

    // Defesa em profundidade (missão 07): limite por origem e rota, antes de
    // qualquer trabalho. Containers persistentes: ver `_shared/rateLimit.ts`.
    const limited = await enforceRateLimit(request, deps, 'create-order');
    if (limited) return limited;

    const body = await readJson<CreateOrderBody>(request);
    const items = parseItems(body);
    const payerEmail = requireEmail(body.payer_email ?? body.email, 'payer_email');
    const buyerName = parseOptionalName(body.buyer_name);
    const idempotencyKey = optionalIdempotencyKey(body.idempotency_key);

    // O cliente pode enviar o token da sua tentativa de checkout: assim um
    // retry (relogar, falha de rede) repete a MESMA identidade e o banco
    // devolve o pedido original. Sem ele, o servidor gera um token novo e a
    // chave de idempotência passa a estar associada a esta requisição.
    const clientToken = optionalClientToken(body.client_token) ?? randomToken(32);
    const clientTokenHash = await sha256Hex(clientToken);

    const useWyvi = isWyviPayConfigured(deps.config);
    const useMp = !useWyvi && Boolean(deps.config.mercadoPagoAccessToken);
    const hasProvider = useWyvi || useMp;

    // ---------------------------------------------------------------
    // Caminho A — SEM provedor + fallback solicitado: registra a
    // solicitação sem pagamento (mesmo contrato de `/order-request`), sem
    // criar reserva e sem deixar pedido pendurado. Só quando o modo
    // demonstrativo não estiver autorizado (ele precisa de pedido pagável).
    // ---------------------------------------------------------------
    if (!hasProvider && body.fallback_to_request === true && !isDemoSandboxAllowed(deps.config)) {
      if (!buyerName) {
        throw new ApiError(422, 'invalid_payload', 'Informe seu nome.');
      }
      const created = await deps.rpc<{
        order: Record<string, unknown>;
        idempotent_replay: boolean;
      }>('create_purchase_request', {
        p_items: items,
        p_buyer_name: buyerName,
        p_buyer_email: payerEmail,
        p_client_token_hash: clientTokenHash,
        p_idempotency_key: idempotencyKey,
      });

      deps.log('create_order.request_fallback', {
        reference: (created.order as { reference?: string }).reference,
        items_count: items.length,
        replay: created.idempotent_replay,
      });

      return json(
        {
          order: created.order,
          client_token: clientToken,
          idempotent_replay: created.idempotent_replay,
          payment: null,
          payment_mode: 'request',
        },
        { status: created.idempotent_replay ? 200 : 201 },
      );
    }

    // ---------------------------------------------------------------
    // Caminho B — pedido multi-item com reserva (transação única).
    // ---------------------------------------------------------------
    let order: CreatedOrder;
    try {
      order = await deps.rpc<CreatedOrder>('create_order_multi', {
        p_items: items,
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
        payment: {
          qr_code: string | null;
          qr_code_base64: string | null;
          ticket_url: string | null;
          status: string;
          expires_at: string | null;
        } | null;
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

    // Contato do comprador: gravado com prova de posse (hash do token do
    // checkout). Nunca vai para a WyviPay; fica em `orders` (RLS, sem GRANT
    // para anon/authenticated) — mesmo modelo do fluxo de solicitação.
    if (buyerName || payerEmail) {
      try {
        await deps.rpc('attach_order_buyer', {
          p_order_id: order.order_id,
          p_client_token_hash: clientTokenHash,
          p_buyer_name: buyerName,
          p_buyer_email: payerEmail,
        });
      } catch (error) {
        deps.log('create_order.buyer_attach_failed', {
          order_id: order.order_id,
          reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
        });
      }
    }

    // Sem credenciais de nenhum provedor: o pedido só continua de pé se o
    // ambiente de demonstração estiver autorizado E o produto for de
    // demonstração. Assim a reserva não fica presa em um pedido que nunca
    // poderá ser pago.
    const demoEligible = isDemoSandboxAllowed(deps.config) && order.product?.is_demo === true;

    if (!hasProvider) {
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
        'Pagamento indisponível: nenhuma chave de pagamento configurada neste ambiente.',
      );
    }

    // ---------------------------------------------------------------
    // Cobrança PIX — WyviPay (ativo) ou Mercado Pago (legado congelado).
    // ---------------------------------------------------------------
    let attached: AttachedPayment;
    try {
      if (useWyvi) {
        const charge = await createCharge(
          {
            apiKey: deps.config.wyviApiKey as string,
            baseUrl: deps.config.wyviApiBase,
            fetchImpl: deps.fetchImpl,
          },
          {
            amountCents: order.total_cents,
            description: `Prime Store ${order.reference}`,
            reference: order.order_id,
            expirationSeconds: chargeExpirationSeconds(order.reservation_expires_at, deps.now()),
            // Idempotência POR PEDIDO: repetir a requisição (retry, duplo
            // clique, replay) devolve a MESMA cobrança — nunca uma segunda.
            idempotencyKey: `order-${order.order_id}`,
          },
        );

        const mapped = mapChargeSituacao(charge.situacao);
        attached = await deps.rpc<AttachedPayment>('attach_payment', {
          p_order_id: order.order_id,
          p_provider_payment_id: charge.txid,
          p_provider_status: mapped.providerStatus,
          p_amount_cents: order.total_cents,
          // `qr_code` = copia-e-cola; `qr_code_base64` = imagem data-URI
          // (pode vir null em ambiente de teste — o front desenha do copia-e-cola).
          p_qr_code: charge.copiaECola,
          p_qr_code_base64: charge.qrcodeDataUri,
          p_ticket_url: null,
          p_expires_at: charge.expiraEm,
          p_provider: 'wyvipay',
        });
      } else {
        const snapshot = await createPixPayment(
          {
            accessToken: deps.config.mercadoPagoAccessToken as string,
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

        attached = await deps.rpc<AttachedPayment>('attach_payment', {
          p_order_id: order.order_id,
          p_provider_payment_id: snapshot.providerPaymentId,
          p_provider_status: snapshot.status,
          p_amount_cents: order.total_cents,
          p_qr_code: snapshot.qrCode,
          p_qr_code_base64: snapshot.qrCodeBase64,
          p_ticket_url: snapshot.ticketUrl,
          p_expires_at: snapshot.expiresAt,
          p_provider: 'mercado_pago',
        });
      }
    } catch (error) {
      // Nunca deixar estoque preso por falha do provedor.
      await deps.rpc('release_order_reservation', {
        p_order_id: order.order_id,
        p_reason: 'payment_creation_failed',
      });
      deps.log('create_order.payment_failed', {
        order_id: order.order_id,
        provider: useWyvi ? 'wyvipay' : 'mercado_pago',
        http_status:
          error instanceof WyviPayError || error instanceof MercadoPagoError ? error.httpStatus : 0,
        provider_code: error instanceof WyviPayError ? error.providerCode : undefined,
      });
      throw new ApiError(
        502,
        'payment_provider_unavailable',
        'Não foi possível gerar o PIX agora. O estoque foi liberado; tente novamente.',
      );
    }

    deps.log('create_order.created', {
      order_id: order.order_id,
      provider: useWyvi ? 'wyvipay' : 'mercado_pago',
      items_count: items.length,
      quantity: order.quantity,
      total_cents: order.total_cents,
    });

    return json(
      {
        order,
        client_token: clientToken,
        payment: {
          status: attached.status,
          qr_code: attached.qr_code,
          qr_code_base64: attached.qr_code_base64,
          ticket_url: attached.ticket_url,
          expires_at: attached.expires_at,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
