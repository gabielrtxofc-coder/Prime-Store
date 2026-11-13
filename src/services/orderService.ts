import { BackendError, invokeFunction } from './backend/http';

/** Contratos das Edge Functions `create-order`, `order-status` e `delivery`. */

export interface CreatedOrder {
  order_id: string;
  reference: string;
  status: string;
  payment_status: string;
  delivery_status: string;
  /** Presente no fluxo multi-item (create_order_multi / solicitação). */
  items_count?: number;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  reservation_expires_at: string;
  created_at?: string;
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
  /**
   * Replay idempotente no modo solicitação (`payment_mode: 'request'`):
   * o servidor devolveu um pedido já registrado para a MESMA tentativa.
   */
  idempotent_replay?: boolean;
  /**
   * `demo` quando o pedido foi criado no modo demonstrativo do sandbox: não há
   * cobrança e a aprovação pode ser simulada na tela de pagamento.
   * `request` quando NENHUM provedor está configurado e o servidor registrou
   * uma solicitação sem pagamento (o mesmo contrato de `order-request`).
   */
  payment_mode?: 'demo' | 'request' | null;
  demo_notice?: string;
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
  /** Solicitação sem pagamento (missão 08): ausentes nos pedidos de cobrança. */
  items_count?: number;
  buyer_name?: string | null;
  items?: Array<{
    product_id: string;
    product_name: string;
    product_slug: string;
    quantity: number;
    unit_price_cents: number;
    subtotal_cents: number;
  }>;
  product: {
    id: string;
    slug: string;
    name: string;
    instructions: string;
    access_validity_label: string;
    /** Produto de demonstração (somente sandbox). */
    is_demo?: boolean;
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

/** Grupo de entrega de um produto do pedido (entrega multi-item). */
export interface DeliveryItemGroup {
  product_id: string;
  product_name: string;
  product_slug: string;
  instructions: string;
  access_validity_label: string;
  access_validity_days: number | null;
  quantity: number;
  units: DeliveredUnit[];
}

export interface DeliveryPayload {
  reference: string;
  created_at: string;
  items_count?: number;
  /** Um grupo por produto do pedido. */
  items?: DeliveryItemGroup[];
  /**
   * Primeiro produto e lista plana de unidades: campos do formato anterior,
   * mantidos para navegadores que já estão com a versão antiga aberta.
   */
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

export interface CreateOrderItemInput {
  productId: string;
  quantity: number;
}

export interface CreateOrderInput {
  /** Formato legado (produto único) — convertido para item único no servidor. */
  productId?: string;
  quantity?: number;
  /** Carrinho multi-item: 1 a 10 produtos distintos (fluxo principal). */
  items?: CreateOrderItemInput[];
  payerEmail: string;
  /** Nome do comprador (gravado no pedido; nunca enviado ao provedor). */
  buyerName?: string;
  idempotencyKey?: string;
  /** Token privado da tentativa de checkout: mantém o retry idempotente. */
  clientToken?: string;
  /**
   * Sem provedor de pagamento configurado, o servidor registra uma
   * solicitação sem pagamento (`payment_mode: 'request'`) em vez de 503 —
   * o checkout nunca fica sem saída em ambiente sem chave.
   */
  fallbackToRequest?: boolean;
}

/**
 * A tentativa anterior deste checkout foi encerrada sem cobrança
 * (pedido `failed`, `expired` ou `cancelled`).
 *
 * Nesse caso a mesma identidade de checkout nunca vai gerar um pedido pagável:
 * o formulário precisa de uma chave de idempotência e de um token novos. É
 * seguro trocar, porque o pedido anterior não foi cobrado.
 */
export function isClosedAttemptError(error: unknown): boolean {
  return error instanceof BackendError && error.code === 'previous_attempt_closed';
}

/**
 * Cria pedido multi-item + reserva e a cobrança PIX (WyviPay API v2).
 *
 * Aceita o formato multi (`items`) ou o legado (`productId`/`quantity`).
 * `fallbackToRequest` faz o servidor cair para a solicitação sem pagamento
 * quando não há chave configurada — a cobrança nunca é contornada.
 */
export function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  const body: Record<string, unknown> = {
    payer_email: input.payerEmail,
  };
  if (input.items && input.items.length > 0) {
    body.items = input.items.map((item) => ({
      product_id: item.productId,
      quantity: item.quantity,
    }));
  } else if (input.productId) {
    body.product_id = input.productId;
    body.quantity = input.quantity;
  }
  if (input.buyerName) body.buyer_name = input.buyerName;
  if (input.idempotencyKey) body.idempotency_key = input.idempotencyKey;
  if (input.clientToken) body.client_token = input.clientToken;
  if (input.fallbackToRequest) body.fallback_to_request = true;

  return invokeFunction<CreateOrderResult>('create-order', { body });
}

/** Consulta o pedido pelo token privado; reconcilia a cobrança com a API. */
export function getOrderStatus(orderId: string, clientToken: string): Promise<OrderStatusPayload> {
  return invokeFunction<OrderStatusPayload>('order-status', {
    body: { order_id: orderId, client_token: clientToken },
  });
}

// ---------------------------------------------------------------------------
// Pagamento demonstrativo (exclusivo do sandbox)
// ---------------------------------------------------------------------------

export interface DemoCapabilities {
  demo_enabled: boolean;
  mode: 'demo' | 'disabled';
}

/** Pergunta ao backend se a aprovação simulada está disponível neste ambiente. */
export async function getDemoCapabilities(): Promise<DemoCapabilities> {
  return invokeFunction<DemoCapabilities>('demo-payment', {
    method: 'GET',
  });
}

export interface DemoApprovalResult {
  demo: true;
  result: string;
  order_status: string | null;
  payment_status: string | null;
  delivery_status: string | null;
}

/**
 * Pede ao backend para simular a aprovação do pagamento.
 *
 * A decisão é do servidor: o navegador só envia a prova de posse do pedido
 * (id + token privado). Nada aqui altera estado localmente.
 */
export function approveDemoPayment(orderId: string, clientToken: string): Promise<DemoApprovalResult> {
  return invokeFunction<DemoApprovalResult>('demo-payment', {
    body: { action: 'approve', order_id: orderId, client_token: clientToken },
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

/**
 * Token privado da tentativa de checkout (32 bytes aleatórios).
 *
 * Enviado ao backend junto da chave de idempotência: um retry da MESMA
 * tentativa devolve o pedido original em vez de criar um segundo pedido.
 */
export function newClientToken(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(32));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return `ct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}-${Math.random().toString(36).slice(2, 14)}`;
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
