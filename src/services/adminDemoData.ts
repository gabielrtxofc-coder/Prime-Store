/**
 * Modo demonstração do painel administrativo.
 *
 * POR QUE EXISTE
 * --------------
 * Ainda não há conta de administrador provisionada (faltam os e-mails oficiais
 * do proprietário e do segundo administrador). Para que o painel possa ser
 * revisado visualmente nesta etapa, ele pode ser aberto com um conjunto de
 * dados FICTÍCIOS, mantido apenas na memória do navegador.
 *
 * GARANTIAS
 * ---------
 * - Nenhuma requisição é feita ao Supabase nesse modo (nem leitura, nem escrita).
 * - Nenhuma regra de segurança é afrouxada: `assert_admin`, MFA e o JWT
 *   continuam valendo para o caminho real. Aqui simplesmente não há servidor.
 * - Toda alteração é simulada e desaparece ao recarregar; a interface sinaliza
 *   "simulado" em cada ação e exibe um aviso permanente no topo.
 * - Para ativar é preciso `VITE_ADMIN_DEMO=true`; o padrão é desligado.
 */

import type {
  AdminAuditEntry,
  AdminIndicators,
  AdminOrderDetail,
  AdminOrderRow,
  AdminProduct,
  AdminRefund,
  AdminStockList,
  AdminStockSummary,
  AdminStockUnit,
  ImportPreview,
  ImportReport,
} from './adminApi';

const FLAG = 'VITE_ADMIN_DEMO';

function readFlag(): string {
  const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  // No build do Vite o valor vem de `import.meta.env`; nos testes, de
  // `process.env` (mesma variável, sem duplicar configuração).
  const nodeEnv =
    typeof globalThis !== 'undefined' && 'process' in globalThis
      ? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[FLAG]
      : undefined;
  return (metaEnv[FLAG] ?? nodeEnv ?? '').trim().toLowerCase();
}

/** O painel demonstrativo está habilitado neste build? */
export function isAdminDemoAvailable(): boolean {
  return readFlag() === 'true' || readFlag() === '1';
}

// ---------------------------------------------------------------------------
// Dados fictícios
// ---------------------------------------------------------------------------

const now = Date.now();
const iso = (offsetMinutes: number): string => new Date(now + offsetMinutes * 60_000).toISOString();

const DEMO_PRODUCT_MENSAL = 'aaaaaaaa-0000-4000-8000-000000000001';
const DEMO_PRODUCT_AVULSO = 'aaaaaaaa-0000-4000-8000-000000000002';

const products: AdminProduct[] = [
  {
    id: DEMO_PRODUCT_MENSAL,
    slug: 'demo-acesso-mensal',
    name: 'Conta streaming — 30 dias (exemplo)',
    category_id: 'streaming',
    category_label: 'Streaming',
    price_cents: 2990,
    cost_cents: 1450,
    margin_cents: 1540,
    is_active: true,
    is_featured: true,
    max_quantity_per_order: 2,
    access_validity_days: 30,
    access_validity_label: '30 dias',
    short_description: 'Conta demonstrativa com acesso mensal.',
    description: 'Registro fictício usado para revisar o painel. Não representa uma oferta real.',
    instructions: 'Acesse com o e-mail e a senha entregues. Troque a senha no primeiro acesso.',
    conditions: ['Somente um aparelho por vez', 'Garantia de 30 dias'],
    modality: 'Conta compartilhada',
    period: '30 dias',
    monogram: 'C',
    theme: 'violet',
    image_url: null,
    available_units: 3,
    reserved_units: 1,
    sold_units: 4,
    created_at: iso(-60 * 24 * 12),
    updated_at: iso(-60 * 6),
  },
  {
    id: DEMO_PRODUCT_AVULSO,
    slug: 'demo-licenca-vitalicia',
    name: 'Licença de software (exemplo)',
    category_id: 'productivity',
    category_label: 'Produtividade',
    price_cents: 4990,
    cost_cents: 2500,
    margin_cents: 2490,
    is_active: true,
    is_featured: false,
    max_quantity_per_order: 5,
    access_validity_days: null,
    access_validity_label: 'Licença permanente',
    short_description: 'Licença fictícia para demonstração do painel.',
    description: 'Registro fictício. Nada é vendido por este item.',
    instructions: 'Ative a licença com o código enviado.',
    conditions: ['Ativação única'],
    modality: 'Licença',
    period: 'Vitalícia',
    monogram: 'L',
    theme: 'blue',
    image_url: null,
    available_units: 0,
    reserved_units: 0,
    sold_units: 2,
    created_at: iso(-60 * 24 * 20),
    updated_at: iso(-60 * 24),
  },
];

const stockUnits: AdminStockUnit[] = [
  {
    id: 'bbbbbbbb-0000-4000-8000-000000000001',
    product_id: DEMO_PRODUCT_MENSAL,
    product_name: products[0].name,
    status: 'available',
    notes: 'unidade fictícia 1',
    credential_fingerprint: 'f'.repeat(64),
    import_batch_id: null,
    sold_order_id: null,
    sold_at: null,
    created_at: iso(-60 * 48),
    updated_at: iso(-60 * 48),
    reservation_expires_at: null,
    reservation_order_id: null,
  },
  {
    id: 'bbbbbbbb-0000-4000-8000-000000000002',
    product_id: DEMO_PRODUCT_MENSAL,
    product_name: products[0].name,
    status: 'reserved',
    notes: 'unidade fictícia 2',
    credential_fingerprint: 'e'.repeat(64),
    import_batch_id: null,
    sold_order_id: null,
    sold_at: null,
    created_at: iso(-60 * 30),
    updated_at: iso(-60 * 2),
    reservation_expires_at: iso(28),
    reservation_order_id: 'cccccccc-0000-4000-8000-000000000003',
  },
  {
    id: 'bbbbbbbb-0000-4000-8000-000000000003',
    product_id: DEMO_PRODUCT_MENSAL,
    product_name: products[0].name,
    status: 'sold',
    notes: 'unidade fictícia 3',
    credential_fingerprint: 'd'.repeat(64),
    import_batch_id: null,
    sold_order_id: 'cccccccc-0000-4000-8000-000000000001',
    sold_at: iso(-60 * 5),
    created_at: iso(-60 * 60),
    updated_at: iso(-60 * 5),
    reservation_expires_at: null,
    reservation_order_id: null,
  },
];

const orders: AdminOrderRow[] = [
  {
    id: 'cccccccc-0000-4000-8000-000000000001',
    reference: 'PS-DEMO01',
    product_id: DEMO_PRODUCT_MENSAL,
    product_name: products[0].name,
    quantity: 1,
    unit_price_cents: 2990,
    total_cents: 2990,
    status: 'paid',
    payment_status: 'approved',
    delivery_status: 'ready',
    created_at: iso(-60 * 6),
    paid_at: iso(-60 * 5),
    reservation_expires_at: iso(-60 * 5 + 30),
    delivery_id: 'dddddddd-0000-4000-8000-000000000001',
    delivery_link_status: 'active',
    open_refund_requests: 0,
  },
  {
    id: 'cccccccc-0000-4000-8000-000000000002',
    reference: 'PS-DEMO02',
    product_id: DEMO_PRODUCT_AVULSO,
    product_name: products[1].name,
    quantity: 1,
    unit_price_cents: 4990,
    total_cents: 4990,
    status: 'disputed',
    payment_status: 'charged_back',
    delivery_status: 'ready',
    created_at: iso(-60 * 30),
    paid_at: iso(-60 * 29),
    reservation_expires_at: iso(-60 * 29 + 30),
    delivery_id: 'dddddddd-0000-4000-8000-000000000002',
    delivery_link_status: 'active',
    open_refund_requests: 0,
  },
  {
    id: 'cccccccc-0000-4000-8000-000000000003',
    reference: 'PS-DEMO03',
    product_id: DEMO_PRODUCT_MENSAL,
    product_name: products[0].name,
    quantity: 1,
    unit_price_cents: 2990,
    total_cents: 2990,
    status: 'pending_payment',
    payment_status: 'pending',
    delivery_status: 'not_ready',
    created_at: iso(-2),
    paid_at: null,
    reservation_expires_at: iso(28),
    delivery_id: null,
    delivery_link_status: null,
    open_refund_requests: 0,
  },
];

const refunds: AdminRefund[] = [
  {
    id: 'eeeeeeee-0000-4000-8000-000000000001',
    order_id: 'cccccccc-0000-4000-8000-000000000002',
    reference: 'PS-DEMO02',
    product_name: products[1].name,
    status: 'pending',
    reason: 'payment_charged_back',
    amount_cents: 4990,
    created_at: iso(-60 * 20),
    resolved_at: null,
    notes: 'Pendência fictícia de demonstração.',
    order_status: 'disputed',
    payment_status: 'charged_back',
    delivery_status: 'ready',
  },
];

const audit: AdminAuditEntry[] = [
  {
    id: 3,
    actor_user_id: null,
    actor_label: 'admin@exemplo.test',
    action: 'product.created',
    entity_type: 'product',
    entity_id: DEMO_PRODUCT_AVULSO,
    metadata: { name: products[1].name },
    created_at: iso(-60 * 24),
  },
  {
    id: 2,
    actor_user_id: null,
    actor_label: 'admin@exemplo.test',
    action: 'stock.imported',
    entity_type: 'import_batch',
    entity_id: null,
    metadata: { imported: 6, duplicates: 1 },
    created_at: iso(-60 * 30),
  },
  {
    id: 1,
    actor_user_id: null,
    actor_label: 'admin@exemplo.test',
    action: 'delivery.revoked',
    entity_type: 'delivery',
    entity_id: 'dddddddd-0000-4000-8000-000000000002',
    metadata: { reason: 'revisão de disputa' },
    created_at: iso(-60 * 2),
  },
];

// ---------------------------------------------------------------------------
// Estado simulável (some ao recarregar a página)
// ---------------------------------------------------------------------------

let sequence = 100;
const nextId = (prefix: string): string => `${prefix}-simulado-${(sequence += 1)}`;

function indicators(): AdminIndicators {
  const paidOrders = orders.filter((order) => order.payment_status === 'approved');
  return {
    orders_total: orders.length,
    orders_pending_payment: orders.filter((order) => order.status === 'pending_payment').length,
    orders_paid: paidOrders.length,
    orders_expired: 0,
    orders_refund_pending: 0,
    orders_refunded: 0,
    orders_disputed: orders.filter((order) => order.status === 'disputed').length,
    orders_failed: 0,
    payments_charged_back: orders.filter((order) => order.payment_status === 'charged_back').length,
    revenue_total_cents: paidOrders.reduce((total, order) => total + order.total_cents, 0),
    revenue_30d_cents: paidOrders.reduce((total, order) => total + order.total_cents, 0),
    units_sold: stockUnits.filter((unit) => unit.status === 'sold').length,
    units_available: stockUnits.filter((unit) => unit.status === 'available').length,
    units_reserved: stockUnits.filter((unit) => unit.status === 'reserved').length,
    active_reservations: orders.filter((order) => order.status === 'pending_payment').length,
    open_refund_requests: refunds.filter((refund) => refund.status === 'pending').length,
    deliveries_active: 1,
    deliveries_revoked: 0,
    products_active: products.filter((product) => product.is_active).length,
    products_inactive: products.filter((product) => !product.is_active).length,
    low_stock_products: products
      .filter((product) => product.available_units <= 2)
      .map((product) => ({ id: product.id, name: product.name, available_units: product.available_units })),
    generated_at: new Date().toISOString(),
  };
}

function stockSummary(): AdminStockSummary {
  const count = (status: AdminStockUnit['status']) => stockUnits.filter((unit) => unit.status === status).length;
  return {
    total: stockUnits.length,
    available: count('available'),
    reserved: count('reserved'),
    sold: count('sold'),
    disabled: count('disabled'),
  };
}

function listStock(payload: Record<string, unknown>): AdminStockList {
  const status = typeof payload.status === 'string' ? payload.status : null;
  const productId = typeof payload.productId === 'string' ? payload.productId : null;
  const limit = typeof payload.limit === 'number' ? payload.limit : 20;
  const offset = typeof payload.offset === 'number' ? payload.offset : 0;
  const items = stockUnits.filter(
    (unit) => (!status || unit.status === status) && (!productId || unit.product_id === productId),
  );
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
}

function listOrders(payload: Record<string, unknown>): { items: AdminOrderRow[]; total: number; limit: number; offset: number } {
  const status = typeof payload.status === 'string' ? payload.status : null;
  const problemOnly = payload.problemOnly === true;
  const search = typeof payload.search === 'string' ? payload.search.toLowerCase() : '';
  const limit = typeof payload.limit === 'number' ? payload.limit : 20;
  const offset = typeof payload.offset === 'number' ? payload.offset : 0;
  const items = orders.filter((order) => {
    if (status && order.status !== status) return false;
    if (problemOnly && !['disputed', 'refund_pending', 'failed'].includes(order.status)) return false;
    if (search && !`${order.reference} ${order.product_name}`.toLowerCase().includes(search)) return false;
    return true;
  });
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
}

function orderDetail(orderId: string): AdminOrderDetail {
  const order = orders.find((item) => item.id === orderId) ?? orders[0];
  return {
    order: {
      id: order.id,
      reference: order.reference,
      product_id: order.product_id,
      product_name: order.product_name,
      quantity: order.quantity,
      unit_price_cents: order.unit_price_cents,
      total_cents: order.total_cents,
      status: order.status,
      payment_status: order.payment_status,
      delivery_status: order.delivery_status,
      created_at: order.created_at,
      paid_at: order.paid_at,
      reservation_expires_at: order.reservation_expires_at,
    },
    payments: [
      {
        provider: 'demo',
        status: order.payment_status,
        amount_cents: order.total_cents,
        created_at: order.created_at,
      },
    ],
    delivery: order.delivery_id
      ? {
          id: order.delivery_id,
          status: 'active',
          created_at: order.paid_at ?? order.created_at,
          revoked_at: null,
          revoke_reason: null,
          view_count: 2,
          last_viewed_at: iso(-60),
        }
      : null,
    delivery_units: stockUnits
      .filter((unit) => unit.sold_order_id === order.id)
      .map((unit) => ({ stock_unit_id: unit.id, status: unit.status, sold_at: unit.sold_at, notes: unit.notes })),
    events: [
      { id: 3, event_type: 'order_created', actor: 'customer', created_at: order.created_at, metadata: {} },
      ...(order.paid_at
        ? [{ id: 2, event_type: 'demo_payment_approved', actor: 'system', created_at: order.paid_at, metadata: {} }]
        : []),
      ...(order.delivery_id
        ? [{ id: 1, event_type: 'delivery_created', actor: 'system', created_at: order.paid_at ?? order.created_at, metadata: {} }]
        : []),
    ],
    refund_requests: refunds
      .filter((refund) => refund.order_id === order.id)
      .map((refund) => ({
        id: refund.id,
        status: refund.status,
        reason: refund.reason,
        amount_cents: refund.amount_cents,
        created_at: refund.created_at,
        notes: refund.notes,
        resolved_at: refund.resolved_at,
      })),
  };
}

// ---------------------------------------------------------------------------
// Despacho
// ---------------------------------------------------------------------------

/**
 * Responde a uma ação administrativa com dados fictícios.
 * Nunca lança erro de rede: é um simulador local, não uma API.
 */
export async function demoAdminInvoke<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  switch (action) {
    case 'session':
      return { user: { id: 'demo-user' }, is_admin: true, mfa_satisfied: true } as T;
    case 'products.list': {
      const search = typeof payload.search === 'string' ? payload.search.toLowerCase() : '';
      const includeInactive = payload.includeInactive !== false;
      const items = products.filter((product) => {
        if (!includeInactive && !product.is_active) return false;
        if (!search) return true;
        return `${product.name} ${product.slug}`.toLowerCase().includes(search);
      });
      return { products: items } as T;
    }
    case 'products.get': {
      const product = products.find((item) => item.id === payload.productId) ?? products[0];
      return { product, price_history: [] } as T;
    }
    case 'products.create': {
      const input = (payload.product ?? {}) as Record<string, unknown>;
      const created: AdminProduct = {
        ...products[0],
        id: nextId('produto'),
        slug: String(input.slug ?? 'produto-simulado'),
        name: String(input.name ?? 'Produto simulado'),
        price_cents: Number(input.price_cents ?? 1000),
        is_active: true,
        available_units: 0,
        reserved_units: 0,
        sold_units: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      products.push(created);
      return { product: created } as T;
    }
    case 'products.update': {
      const index = products.findIndex((item) => item.id === payload.productId);
      if (index >= 0) {
        products[index] = { ...products[index], ...(payload.patch as Record<string, unknown>), updated_at: new Date().toISOString() } as AdminProduct;
        return { product: products[index] } as T;
      }
      return { product: products[0] } as T;
    }
    case 'products.setActive': {
      const index = products.findIndex((item) => item.id === payload.productId);
      if (index >= 0) products[index] = { ...products[index], is_active: payload.active === true };
      return { product: products[index] ?? products[0] } as T;
    }
    case 'stock.summary':
      return stockSummary() as T;
    case 'stock.list':
      return listStock(payload) as T;
    case 'stock.add': {
      const product = products.find((item) => item.id === payload.productId) ?? products[0];
      const unit: AdminStockUnit = {
        id: nextId('unidade'),
        product_id: product.id,
        product_name: product.name,
        status: 'available',
        notes: String(payload.notes ?? 'unidade simulada'),
        credential_fingerprint: 'a'.repeat(64),
        import_batch_id: null,
        sold_order_id: null,
        sold_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        reservation_expires_at: null,
        reservation_order_id: null,
      };
      stockUnits.push(unit);
      return { unit: { id: unit.id, status: unit.status } } as T;
    }
    case 'stock.update': {
      const unit = stockUnits.find((item) => item.id === payload.stockUnitId) ?? stockUnits[0];
      return { stock_unit: unit } as T;
    }
    case 'stock.setStatus': {
      const index = stockUnits.findIndex((item) => item.id === payload.stockUnitId);
      if (index >= 0) stockUnits[index] = { ...stockUnits[index], status: payload.status as AdminStockUnit['status'] };
      return { stock_unit: stockUnits[index] ?? stockUnits[0] } as T;
    }
    case 'stock.import.preview': {
      const csv = typeof payload.csv === 'string' ? payload.csv : '';
      const rows = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const preview: ImportPreview = {
        total_rows: rows.length,
        valid_rows: rows.length,
        rejected_rows: 0,
        duplicated_in_file: 0,
        preview: rows.slice(0, 5).map((line, index) => {
          const [email = '', password = '', notes = ''] = line.split(/[;,]/);
          return { row_number: index + 1, email: email.trim(), password: password.trim(), notes: notes.trim() };
        }),
        rejected: [],
      };
      return preview as T;
    }
    case 'stock.import.commit': {
      const report: ImportReport = { imported: 3, duplicates: 0, invalid: 0, failures: [], batch_id: nextId('lote') };
      return { report } as T;
    }
    case 'orders.list':
      return listOrders(payload) as T;
    case 'orders.get':
      return orderDetail(String(payload.orderId ?? orders[0].id)) as T;
    case 'indicators':
      return indicators() as T;
    case 'refunds.list': {
      const status = typeof payload.status === 'string' ? payload.status : null;
      return { refunds: refunds.filter((refund) => !status || refund.status === status) } as T;
    }
    case 'refunds.resolve': {
      const refund = refunds.find((item) => item.id === payload.refundId);
      if (refund) refund.status = payload.status as AdminRefund['status'];
      return { resolved: true, simulated: true } as T;
    }
    case 'orders.resolveDispute': {
      const order = orders.find((item) => item.id === payload.orderId);
      if (order) {
        if (payload.outcome === 'refund') {
          order.status = 'refunded';
          order.payment_status = 'refunded';
          order.delivery_status = 'revoked';
          order.delivery_link_status = 'revoked';
        }
        if (payload.outcome === 'reinstated') order.status = 'paid';
      }
      return { resolved: true, simulated: true } as T;
    }
    case 'deliveries.revoke': {
      const order = orders.find((item) => item.delivery_id === payload.deliveryId);
      if (order) {
        order.delivery_status = 'revoked';
        order.delivery_link_status = 'revoked';
      }
      return { revoked: true, simulated: true } as T;
    }
    case 'deliveries.rotate':
      return { delivery_url: 'http://localhost:5173/entrega/link-simulado', simulated: true } as T;
    case 'audit.list':
      return { entries: audit } as T;
    case 'reservations.expire':
      return { expired: 1, simulated: true } as T;
    default:
      return { simulated: true } as T;
  }
}
