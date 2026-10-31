import { adminInvoke } from './adminAuth';

/** Contratos do painel administrativo (Edge Function `admin-api`). */

export interface AdminProduct {
  id: string;
  slug: string;
  name: string;
  category_id: string;
  category_label: string;
  price_cents: number;
  cost_cents: number;
  margin_cents: number;
  is_active: boolean;
  is_featured: boolean;
  max_quantity_per_order: number;
  access_validity_days: number | null;
  access_validity_label: string | null;
  short_description: string;
  description: string;
  instructions: string;
  conditions: string[];
  modality: string;
  period: string;
  monogram: string;
  theme: string;
  image_url: string | null;
  available_units: number;
  reserved_units: number;
  sold_units: number;
  created_at: string;
  updated_at: string;
}

export interface AdminStockUnit {
  id: string;
  product_id: string;
  product_name: string;
  status: 'available' | 'reserved' | 'sold' | 'disabled';
  notes: string;
  credential_fingerprint: string;
  import_batch_id: string | null;
  sold_order_id: string | null;
  sold_at: string | null;
  created_at: string;
  updated_at: string;
  reservation_expires_at: string | null;
  reservation_order_id: string | null;
  /** Presentes apenas quando `includeCredentials` é solicitado. */
  email?: string | null;
  password?: string | null;
}

export interface AdminStockList {
  items: AdminStockUnit[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminStockSummary {
  total: number;
  available: number;
  reserved: number;
  sold: number;
  disabled: number;
}

export interface AdminOrderRow {
  id: string;
  reference: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  status: string;
  payment_status: string;
  delivery_status: string;
  created_at: string;
  paid_at: string | null;
  reservation_expires_at: string;
  delivery_id: string | null;
  delivery_link_status: string | null;
  open_refund_requests: number;
}

export interface AdminOrderList {
  items: AdminOrderRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminOrderDetail {
  order: Omit<AdminOrderRow, 'delivery_id' | 'delivery_link_status' | 'open_refund_requests'>;
  payments: Array<Record<string, unknown>>;
  delivery: {
    id: string;
    status: string;
    created_at: string;
    revoked_at: string | null;
    revoke_reason: string | null;
    view_count: number;
    last_viewed_at: string | null;
  } | null;
  delivery_units: Array<{ stock_unit_id: string; status: string; sold_at: string | null; notes: string }>;
  events: Array<{ id: number; event_type: string; actor: string; created_at: string; metadata: Record<string, unknown> }>;
  refund_requests: Array<{
    id: string;
    status: string;
    reason: string;
    amount_cents: number;
    created_at: string;
    notes: string | null;
    resolved_at: string | null;
  }>;
}

export interface AdminRefund {
  id: string;
  order_id: string;
  reference: string;
  product_name: string;
  status: 'pending' | 'authorized' | 'processed' | 'rejected';
  reason: string;
  amount_cents: number;
  created_at: string;
  resolved_at: string | null;
  notes: string | null;
  order_status: string;
  payment_status: string;
  delivery_status: string;
}

export interface AdminIndicators {
  orders_total: number;
  orders_pending_payment: number;
  orders_paid: number;
  orders_expired: number;
  orders_refund_pending: number;
  orders_failed: number;
  revenue_total_cents: number;
  revenue_30d_cents: number;
  units_sold: number;
  units_available: number;
  units_reserved: number;
  active_reservations: number;
  open_refund_requests: number;
  deliveries_active: number;
  deliveries_revoked: number;
  products_active: number;
  products_inactive: number;
  low_stock_products: Array<{ id: string; name: string; available_units: number }>;
  generated_at: string;
}

export interface AdminAuditEntry {
  id: number;
  actor_user_id: string | null;
  actor_label: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ImportPreview {
  total_rows: number;
  valid_rows: number;
  rejected_rows: number;
  duplicated_in_file: number;
  preview: Array<{ row_number: number; email: string; password: string; notes: string }>;
  rejected: Array<{ row_number: number; reason: string }>;
}

export interface ImportReport {
  imported: number;
  duplicates: number;
  invalid: number;
  failures: Array<{ row_number: number; reason: string }>;
  batch_id?: string | null;
}

/** Campos editáveis de produto aceitos pela API. */
export interface ProductInput {
  slug?: string;
  name?: string;
  category_id?: string;
  short_description?: string;
  description?: string;
  instructions?: string;
  conditions?: string[];
  modality?: string;
  period?: string;
  monogram?: string;
  theme?: string;
  image_url?: string | null;
  price_cents?: number;
  cost_cents?: number;
  access_validity_days?: number | null;
  access_validity_label?: string | null;
  max_quantity_per_order?: number;
  is_featured?: boolean;
}

export const adminApi = {
  session: () => adminInvoke<{ user: { id: string }; is_admin: boolean; mfa_satisfied: boolean }>('session'),

  listProducts: (search = '', includeInactive = true) =>
    adminInvoke<{ products: AdminProduct[] }>('products.list', { search, includeInactive }),

  getProduct: (productId: string) =>
    adminInvoke<{ product: AdminProduct; price_history: Array<Record<string, unknown>> }>('products.get', { productId }),

  createProduct: (product: ProductInput) =>
    adminInvoke<{ product: AdminProduct }>('products.create', { product }),

  updateProduct: (productId: string, patch: ProductInput) =>
    adminInvoke<{ product: AdminProduct }>('products.update', { productId, patch }),

  setProductActive: (productId: string, active: boolean) =>
    adminInvoke<{ product: AdminProduct }>('products.setActive', { productId, active }),

  stockSummary: () => adminInvoke<AdminStockSummary>('stock.summary'),

  listStock: (params: {
    productId?: string | null;
    status?: string | null;
    search?: string;
    includeCredentials?: boolean;
    limit?: number;
    offset?: number;
  }) => adminInvoke<AdminStockList>('stock.list', params),

  addStock: (params: { productId: string; email: string; password: string; notes?: string }) =>
    adminInvoke<{ unit: { id: string; status: string } }>('stock.add', params),

  updateStock: (params: {
    stockUnitId: string;
    email?: string;
    password?: string;
    notes?: string;
  }) => adminInvoke<{ stock_unit: AdminStockUnit }>('stock.update', params),

  setStockStatus: (stockUnitId: string, status: 'available' | 'disabled') =>
    adminInvoke<{ stock_unit: AdminStockUnit }>('stock.setStatus', { stockUnitId, status }),

  previewImport: (productId: string, csv: string) =>
    adminInvoke<ImportPreview>('stock.import.preview', { productId, csv }),

  commitImport: (productId: string, csv: string, fileName: string) =>
    adminInvoke<{ report: ImportReport }>('stock.import.commit', { productId, csv, fileName }),

  listOrders: (params: {
    search?: string;
    status?: string | null;
    paymentStatus?: string | null;
    problemOnly?: boolean;
    limit?: number;
    offset?: number;
  }) => adminInvoke<AdminOrderList>('orders.list', params),

  getOrder: (orderId: string) => adminInvoke<AdminOrderDetail>('orders.get', { orderId }),

  indicators: () => adminInvoke<AdminIndicators>('indicators'),

  listRefunds: (status?: string | null) =>
    adminInvoke<{ refunds: AdminRefund[] }>('refunds.list', { status: status ?? null }),

  resolveRefund: (refundId: string, status: 'authorized' | 'processed' | 'rejected', notes = '') =>
    adminInvoke<Record<string, unknown>>('refunds.resolve', { refundId, status, notes }),

  revokeDelivery: (deliveryId: string, reason: string) =>
    adminInvoke<Record<string, unknown>>('deliveries.revoke', { deliveryId, reason }),

  rotateDelivery: (deliveryId: string) =>
    adminInvoke<{ delivery_url?: string }>('deliveries.rotate', { deliveryId }),

  auditLog: (limit = 50) => adminInvoke<{ entries: AdminAuditEntry[] }>('audit.list', { limit }),

  expireReservations: () => adminInvoke<Record<string, unknown>>('reservations.expire'),
};
