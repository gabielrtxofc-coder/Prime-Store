import { BackendError, invokeFunction } from './backend/http';
import type { OrderStatusPayload } from './orderService';

/**
 * Solicitação de compra SEM pagamento (Edge Function `order-request`) e o
 * comprovante guardado no navegador para reabrir a confirmação e o
 * acompanhamento.
 *
 * Nada aqui calcula preço: o valor oficial é o que o servidor devolve, depois
 * de reler `products.price_cents` e gravar `order_items`.
 */

export interface PurchaseRequestItemInput {
  productId: string;
  quantity: number;
}

export interface RegisteredOrderItem {
  product_id: string;
  product_name: string;
  product_slug: string;
  quantity: number;
  unit_price_cents: number;
  subtotal_cents: number;
}

export interface RegisteredOrder {
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
  items: RegisteredOrderItem[];
}

export interface PurchaseRequestResult {
  order: RegisteredOrder;
  client_token: string;
  idempotent_replay: boolean;
}

export interface PurchaseRequestInput {
  items: PurchaseRequestItemInput[];
  buyerName: string;
  buyerEmail: string;
  /** Identidade da tentativa: reenvios idênticos não duplicam o pedido. */
  idempotencyKey: string;
  clientToken: string;
}

/** Registra a solicitação. O servidor valida produtos, preços e disponibilidade. */
export function createPurchaseRequest(input: PurchaseRequestInput): Promise<PurchaseRequestResult> {
  return invokeFunction<PurchaseRequestResult>('order-request', {
    body: {
      items: input.items.map((item) => ({ product_id: item.productId, quantity: item.quantity })),
      buyer_name: input.buyerName,
      buyer_email: input.buyerEmail,
      idempotency_key: input.idempotencyKey,
      client_token: input.clientToken,
    },
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE_PATTERN = /^PS-[0-9A-Z]{6}$/;

export function isOrderId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isOrderReference(value: string): boolean {
  return REFERENCE_PATTERN.test(value.trim().toUpperCase());
}

/**
 * Consulta o estado da solicitação.
 *
 * Aceita o identificador do pedido (UUID, do link privado) ou o número
 * `PS-XXXXXX` digitado pelo visitante. Em ambos os casos o servidor exige o
 * código de acompanhamento, então o número sozinho não abre nada.
 */
export function getRequestStatus(identifier: string, clientToken: string): Promise<OrderStatusPayload> {
  const body = isOrderId(identifier)
    ? { order_id: identifier, client_token: clientToken }
    : { reference: identifier.trim().toUpperCase(), client_token: clientToken };

  return invokeFunction<OrderStatusPayload>('order-status', { body });
}

/** Diferença entre "registro inexistente/código errado" e falha de conexão. */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof BackendError && (error.status === 404 || error.code === 'not_found');
}

// ---------------------------------------------------------------------------
// Comprovante local da solicitação
// ---------------------------------------------------------------------------
// O token privado é o único jeito de reabrir o pedido. Guardá-lo no navegador
// (localStorage) faz a confirmação sobreviver a recarregar a página e a fechar a
// aba. Nenhum dado pessoal é gravado aqui: só identificadores, data e valores.
// A chave anterior (`...pending-order`) era do fluxo de cobrança e não é lida.

const STORAGE_KEY = 'prime-store.request-receipts.v1';
const MAX_RECEIPTS = 20;

export interface RequestReceipt {
  orderId: string;
  reference: string;
  clientToken: string;
  createdAt: string;
  totalCents?: number;
  itemsCount?: number;
}

type ReceiptMap = Record<string, RequestReceipt>;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readAll(): ReceiptMap {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};

    const result: ReceiptMap = {};
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const candidate = value as Partial<RequestReceipt>;
      if (
        typeof candidate.orderId !== 'string' ||
        typeof candidate.reference !== 'string' ||
        typeof candidate.clientToken !== 'string'
      ) {
        continue;
      }
      result[candidate.orderId] = {
        orderId: candidate.orderId,
        reference: candidate.reference,
        clientToken: candidate.clientToken,
        createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
        totalCents: typeof candidate.totalCents === 'number' ? candidate.totalCents : undefined,
        itemsCount: typeof candidate.itemsCount === 'number' ? candidate.itemsCount : undefined,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function writeAll(receipts: ReceiptMap): void {
  const entries = Object.values(receipts)
    .sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt))
    .slice(0, MAX_RECEIPTS);

  const serialized: ReceiptMap = {};
  for (const receipt of entries) serialized[receipt.orderId] = receipt;

  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(serialized));
  } catch {
    // Sem armazenamento: a confirmação funciona só nesta aba.
  }
}

export function saveRequestReceipt(receipt: RequestReceipt): void {
  const receipts = readAll();
  receipts[receipt.orderId] = receipt;
  writeAll(receipts);
}

/** Busca o comprovante pelo id do pedido ou pelo número `PS-XXXXXX`. */
export function readRequestReceipt(identifier: string): RequestReceipt | null {
  const receipts = readAll();
  if (receipts[identifier]) return receipts[identifier];
  const reference = identifier.trim().toUpperCase();
  return Object.values(receipts).find((receipt) => receipt.reference.toUpperCase() === reference) ?? null;
}

export function readLastRequestReceipt(): RequestReceipt | null {
  const receipts = Object.values(readAll());
  if (receipts.length === 0) return null;
  return receipts.sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt))[0];
}

export function clearRequestReceipts(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignora
  }
}

/** Link compartilhável de acompanhamento (o código vai no fragmento). */
export function buildTrackingLink(receipt: Pick<RequestReceipt, 'orderId' | 'clientToken'>): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/pedido/${receipt.orderId}#codigo=${encodeURIComponent(receipt.clientToken)}`;
}

/** Extrai o código do fragmento (`#codigo=...`) sem enviá-lo ao servidor. */
export function readCodeFromHash(hash: string): string | null {
  const cleaned = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!cleaned) return null;
  const params = new URLSearchParams(cleaned);
  const code = params.get('codigo') ?? params.get('code');
  return code && code.length >= 32 ? code : null;
}
