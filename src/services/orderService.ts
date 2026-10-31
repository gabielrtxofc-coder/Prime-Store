import { invokeFunction } from './backend/http';

/** Contratos das Edge Functions `create-order`, `order-status` e `delivery`. */

export interface CreatedOrder {
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

export interface PixPayment {
  status: string;
  qr_code: string | null;
  qr_code_base64: string | null;
  ticket_url: string | null;
  expires_at: string | null;
}

export interface CreateOrderResult {
  order: CreatedOrder;
  client_token: string;
  payment: PixPayment | null;
  replayed?: boolean;
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
    status_detail: string | null;
    qr_code: string | null;
    qr_code_base64: string | null;
    ticket_url: string | null;
    expires_at: string | null;
  } | null;
  delivery: { id: string; status: string; created_at: string; url: string | null } | null;
  availability: { available_units: number };
}

export interface DeliveredUnit {
  email: string;
  password: string;
  notes: string;
}

export interface DeliveryPayload {
  reference: string;
  created_at: string;
  product: {
    id: string;
    name: string;
    slug: string;
    instructions: string;
    access_validity_label: string;
    access_validity_days: number | null;
  };
  units: DeliveredUnit[];
}

export interface CreateOrderInput {
  productId: string;
  quantity: number;
  payerEmail: string;
  idempotencyKey?: string;
}

/** Cria pedido + reserva e a cobrança PIX (Checkout Transparente). */
export function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  return invokeFunction<CreateOrderResult>('create-order', {
    body: {
      product_id: input.productId,
      quantity: input.quantity,
      payer_email: input.payerEmail,
      idempotency_key: input.idempotencyKey,
    },
  });
}

/** Consulta o pedido pelo token privado; reconcilia com o Mercado Pago. */
export function getOrderStatus(orderId: string, clientToken: string): Promise<OrderStatusPayload> {
  return invokeFunction<OrderStatusPayload>('order-status', {
    body: { order_id: orderId, client_token: clientToken },
  });
}

/** Lê a entrega privada (credenciais só aparecem em pedidos pagos). */
export function fetchDelivery(token: string): Promise<DeliveryPayload> {
  return invokeFunction<DeliveryPayload>('delivery', { body: { token } });
}

// ---------------------------------------------------------------------------
// Persistência local do pedido pendente (sobrevive a recarregar a página)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'prime-store.pending-order';

export interface PendingOrder {
  orderId: string;
  clientToken: string;
  reference: string;
  createdAt: string;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function savePendingOrder(pending: PendingOrder): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(pending));
  } catch {
    // Armazenamento indisponível (modo privado): o fluxo continua em memória.
  }
}

export function readPendingOrder(): PendingOrder | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingOrder>;
    if (
      typeof parsed.orderId !== 'string' ||
      typeof parsed.clientToken !== 'string' ||
      typeof parsed.reference !== 'string'
    ) {
      return null;
    }
    return {
      orderId: parsed.orderId,
      clientToken: parsed.clientToken,
      reference: parsed.reference,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function clearPendingOrder(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignora
  }
}

/** Chave de idempotência por tentativa (evita pedido duplicado ao recarregar). */
export function newIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Estados que liberam a tela de entrega. */
export function isPaid(orderStatus: string, paymentStatus: string): boolean {
  return (
    paymentStatus === 'approved' &&
    ['paid', 'refund_pending', 'refunded'].includes(orderStatus)
  );
}

export function isTerminalFailure(orderStatus: string): boolean {
  return ['expired', 'cancelled', 'failed'].includes(orderStatus);
}
