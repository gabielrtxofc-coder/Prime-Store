import { randomToken, sha256Hex } from '../crypto.ts';
import type { Deps } from '../deps.ts';
import { ApiError, errorResponse, json, methodGuard, preflight, readJson } from '../http.ts';
import { enforceRateLimit } from '../rateLimit.ts';
import { isUuid, optionalClientToken, optionalIdempotencyKey } from '../validation.ts';

/**
 * POST /order-request — solicitação de compra SEM pagamento (missão 08).
 *
 * Diferenças deliberadas em relação a `create-order` (que continua existindo,
 * intacto, para a fase de cobrança):
 *  - aceita o carrinho inteiro (1..10 produtos distintos);
 *  - não cria pagamento, não reserva estoque e não chama o Mercado Pago;
 *  - o pedido nasce em `status = requested` / `payment_status = not_required`;
 *  - não exige `MP_ACCESS_TOKEN` nem `MP_WEBHOOK_SECRET`: a rota funciona em
 *    qualquer ambiente, mesmo sem integração financeira configurada.
 *
 * Toda a decisão (preço, disponibilidade, limites, idempotência) acontece no
 * banco, em `public.create_purchase_request`. O handler só valida formato.
 */

const MAX_ITEMS = 10;

interface OrderRequestBody {
  items?: unknown;
  buyer_name?: unknown;
  buyer_email?: unknown;
  email?: unknown;
  idempotency_key?: unknown;
  client_token?: unknown;
}

interface RequestItem {
  product_id: string;
  quantity: number;
}

interface CreatedRequest {
  order: {
    order_id: string;
    reference: string;
    status: string;
    payment_status: string;
    delivery_status: string;
    items_count: number;
    quantity: number;
    unit_price_cents: number;
    total_cents: number;
    buyer_name: string | null;
    created_at: string;
    items: Array<{
      product_id: string;
      product_name: string;
      product_slug: string;
      quantity: number;
      unit_price_cents: number;
      subtotal_cents: number;
    }>;
  };
  idempotent_replay: boolean;
}

function parseItems(value: unknown): RequestItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) {
    throw new ApiError(422, 'invalid_items', 'Envie de 1 a 10 produtos.');
  }

  const seen = new Set<string>();
  const items: RequestItem[] = [];

  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) {
      throw new ApiError(422, 'invalid_items', 'Item inválido.');
    }
    const entry = raw as { product_id?: unknown; quantity?: unknown };
    if (!isUuid(entry.product_id)) {
      throw new ApiError(422, 'invalid_items', 'Item inválido.');
    }
    const quantity = typeof entry.quantity === 'number' ? entry.quantity : Number(entry.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      throw new ApiError(422, 'invalid_items', 'Quantidade inválida.');
    }
    if (seen.has(entry.product_id)) {
      throw new ApiError(422, 'invalid_items', 'Produto repetido na solicitação.');
    }
    seen.add(entry.product_id);
    items.push({ product_id: entry.product_id, quantity });
  }

  return items;
}

function parseName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError(422, 'invalid_payload', 'Informe seu nome.');
  }
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 120) {
    throw new ApiError(422, 'invalid_payload', 'Informe seu nome completo.');
  }
  return trimmed;
}

function parseEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError(422, 'invalid_payload', 'Informe um e-mail válido.');
  }
  const trimmed = value.trim();
  if (trimmed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
    throw new ApiError(422, 'invalid_payload', 'Informe um e-mail válido.');
  }
  return trimmed;
}

export async function handleOrderRequest(request: Request, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();

  try {
    methodGuard(request, ['POST']);

    const limited = await enforceRateLimit(request, deps, 'order-request');
    if (limited) return limited;

    const body = await readJson<OrderRequestBody>(request);
    const items = parseItems(body.items);
    const buyerName = parseName(body.buyer_name);
    const buyerEmail = parseEmail(body.buyer_email ?? body.email);
    const idempotencyKey = optionalIdempotencyKey(body.idempotency_key);

    // Mesma lógica de identidade do fluxo de cobrança: o cliente pode reenviar o
    // token da sua tentativa para que um retry (reload, falha de rede, duplo
    // clique) não gere uma segunda solicitação.
    const clientToken = optionalClientToken(body.client_token) ?? randomToken(32);
    const clientTokenHash = await sha256Hex(clientToken);

    const created = await deps.rpc<CreatedRequest>('create_purchase_request', {
      p_items: items,
      p_buyer_name: buyerName,
      p_buyer_email: buyerEmail,
      p_client_token_hash: clientTokenHash,
      p_idempotency_key: idempotencyKey,
    });

    deps.log('order_request.created', {
      order_id: created.order.order_id,
      reference: created.order.reference,
      items_count: created.order.items_count,
      replay: created.idempotent_replay,
    });

    return json(
      {
        order: created.order,
        client_token: clientToken,
        idempotent_replay: created.idempotent_replay,
      },
      { status: created.idempotent_replay ? 200 : 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
