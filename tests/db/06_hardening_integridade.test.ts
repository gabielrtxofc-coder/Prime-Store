import { beforeAll, describe, expect, it } from 'vitest';
import {
  createOrder,
  fakeCiphertextB64,
  randomToken,
  resetDatabase,
  runSql,
  seedAdmin,
  seedProduct,
  sha256Hex,
  sqlValue,
  type Seed,
} from './helpers';
import { createPgRpc } from './pgRpc';
import { connect } from './helpers';
import type { Client } from 'pg';

/**
 * Missão 03 — correções de integridade.
 *
 * Estes testes descrevem o comportamento obrigatório (e não o comportamento
 * antigo) das duas falhas encontradas na auditoria:
 *   A. idempotência não pode transferir um pedido para outra requisição;
 *   B. chargeback não pode ser tratado como reembolso concluído.
 */

interface PgError extends Error {
  code?: string;
}

async function expectConflict(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ message: expect.stringContaining('idempotency_conflict') });
}

async function orderCount(productId: string): Promise<number> {
  const rows = await sqlValue<number>(`select count(*) from public.orders where product_id = $1`, [productId]);
  return Number(rows);
}

async function tokenHashOf(orderId: string): Promise<string> {
  return (await sqlValue<string>(`select client_token_hash from public.orders where id = $1`, [orderId])) as string;
}

describe('idempotência segura em create_order', () => {
  let seed: Seed;

  beforeAll(async () => {
    await resetDatabase();
    seed = await seedProduct({ stockUnits: 12 });
  }, 60000);

  it('replay válido: mesma chave, mesmo token, mesmos parâmetros', async () => {
    const product = await seedProduct({ stockUnits: 3 });
    const key = randomToken(24);
    const token = randomToken();

    const first = await createOrder(product.productId, 1, { idempotencyKey: key, clientToken: token });
    const second = await createOrder(product.productId, 1, { idempotencyKey: key, clientToken: token });

    expect(second.order.order_id).toBe(first.order.order_id);
    expect(second.order.idempotent_replay).toBe(true);
    expect(await orderCount(product.productId)).toBe(1);
  });

  it('token diferente com a mesma chave é conflito e o pedido original fica intacto', async () => {
    const product = await seedProduct({ stockUnits: 3 });
    const key = randomToken(24);
    const first = await createOrder(product.productId, 1, { idempotencyKey: key, clientToken: randomToken() });
    const originalHash = await tokenHashOf(first.order.order_id);

    await expectConflict(createOrder(product.productId, 1, { idempotencyKey: key, clientToken: randomToken() }));

    // O hash NUNCA é substituído: o atacante não assume o pedido.
    expect(await tokenHashOf(first.order.order_id)).toBe(originalHash);
    expect(await orderCount(product.productId)).toBe(1);
  });

  it('tentativa de assumir o pedido de outro cliente não vaza dados do pedido', async () => {
    const product = await seedProduct({ stockUnits: 3 });
    const key = randomToken(24);
    const owner = await createOrder(product.productId, 1, { idempotencyKey: key, clientToken: randomToken() });

    try {
      await createOrder(product.productId, 1, { idempotencyKey: key, clientToken: randomToken() });
      throw new Error('esperava conflito');
    } catch (error) {
      const message = (error as PgError).message ?? '';
      expect(message).toContain('idempotency_conflict');
      // Nem referência, nem id, nem valor: apenas o código do conflito.
      expect(message).not.toContain(owner.order.reference);
      expect(message).not.toContain(owner.order.order_id);
      expect(message).not.toContain(String(owner.order.total_cents));
    }

    // E o token de consulta do dono continua funcionando.
    const status = await runSql<{ result: { order_id: string } }>(
      `select public.get_order_status($1, $2) as result`,
      [owner.order.order_id, owner.tokenHash],
    );
    expect(status[0].result.order_id).toBe(owner.order.order_id);
  });

  it('mesma chave com produto diferente é conflito', async () => {
    const productA = await seedProduct({ stockUnits: 2 });
    const productB = await seedProduct({ stockUnits: 2 });
    const key = randomToken(24);
    const token = randomToken();

    await createOrder(productA.productId, 1, { idempotencyKey: key, clientToken: token });
    await expectConflict(createOrder(productB.productId, 1, { idempotencyKey: key, clientToken: token }));

    expect(await orderCount(productB.productId)).toBe(0);
  });

  it('mesma chave com quantidade diferente é conflito', async () => {
    const product = await seedProduct({ stockUnits: 4, maxQuantity: 2 });
    const key = randomToken(24);
    const token = randomToken();

    await createOrder(product.productId, 1, { idempotencyKey: key, clientToken: token });
    await expectConflict(createOrder(product.productId, 2, { idempotencyKey: key, clientToken: token }));

    expect(await orderCount(product.productId)).toBe(1);
  });

  it('exige entropia mínima na chave de idempotência', async () => {
    const product = await seedProduct({ stockUnits: 1 });
    await expect(
      createOrder(product.productId, 1, { idempotencyKey: 'curta', clientToken: randomToken() }),
    ).rejects.toMatchObject({ message: expect.stringContaining('invalid_idempotency_key') });
  });

  it('duas requisições simultâneas com a mesma chave resultam em um único pedido', async () => {
    const product = await seedProduct({ stockUnits: 4 });
    const key = randomToken(24);
    const token = randomToken();

    const results = await Promise.allSettled([
      createOrder(product.productId, 1, { idempotencyKey: key, clientToken: token }),
      createOrder(product.productId, 1, { idempotencyKey: key, clientToken: token }),
      createOrder(product.productId, 1, { idempotencyKey: key, clientToken: token }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(await orderCount(product.productId)).toBe(1);

    const orderIds = new Set(
      fulfilled.map((result) => (result as PromiseFulfilledResult<{ order: { order_id: string } }>).value.order.order_id),
    );
    expect(orderIds.size).toBe(1);
  });

  it('repetição após falha de comunicação não duplica o pedido', async () => {
    const product = await seedProduct({ stockUnits: 4 });
    const key = randomToken(24);
    const token = randomToken();

    // Primeira chamada cria o pedido.
    const first = await createOrder(product.productId, 1, { idempotencyKey: key, clientToken: token });

    // "Falha de comunicação": o cliente repete a mesma requisição três vezes.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replay = await createOrder(product.productId, 1, { idempotencyKey: key, clientToken: token });
      expect(replay.order.order_id).toBe(first.order.order_id);
    }

    expect(await orderCount(product.productId)).toBe(1);
    const reserved = await sqlValue<number>(
      `select count(*) from public.stock_reservations where order_id = $1`,
      [first.order.order_id],
    );
    expect(Number(reserved)).toBe(1);
  });

  it('sem chave de idempotência cada requisição cria seu próprio pedido', async () => {
    const product = await seedProduct({ stockUnits: 3 });
    const tokenA = randomToken();
    const tokenB = randomToken();

    const first = await createOrder(product.productId, 1, { clientToken: tokenA });
    const second = await createOrder(product.productId, 1, { clientToken: tokenB });

    expect(second.order.order_id).not.toBe(first.order.order_id);
    expect(await orderCount(product.productId)).toBe(2);
    // Cada pedido só abre com o próprio token.
    await expect(
      runSql(`select public.get_order_status($1, $2)`, [first.order.order_id, second.tokenHash]),
    ).rejects.toMatchObject({ message: expect.stringContaining('order_not_found') });
  });

  it('token de cliente é exigido em formato de hash SHA-256', async () => {
    await expect(
      runSql(`select public.create_order($1, 1, null, $2)`, [seed.productId, 'token-em-texto-puro']),
    ).rejects.toMatchObject({ message: expect.stringContaining('invalid_client_token') });
  });
});

// ---------------------------------------------------------------------------
// Fase B — chargeback ≠ reembolso
// ---------------------------------------------------------------------------

describe('chargeback e reembolso são fluxos distintos', () => {
  let client: Client;
  let rpc: ReturnType<typeof createPgRpc>;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
    rpc = createPgRpc(client);
  }, 60000);

  interface Applied {
    result: string;
    order_status: string;
    payment_status: string;
    delivery_status: string;
    requires_admin_review?: boolean;
  }

  async function paidOrder(): Promise<{ orderId: string; productId: string; reference: string }> {
    const product = await seedProduct({ stockUnits: 2, priceCents: 4990 });
    const order = await createOrder(product.productId, 1);
    const providerId = `MP-${randomToken(6)}`;
    const tokenHash = sha256Hex(randomToken());

    await rpc('attach_payment', {
      p_order_id: order.order.order_id,
      p_provider_payment_id: providerId,
      p_provider_status: 'pending',
      p_amount_cents: order.order.total_cents,
      p_qr_code: 'FAKEPIX-COPIA-E-COLA',
      p_qr_code_base64: 'FAKEQR',
      p_ticket_url: null,
      p_expires_at: null,
    });

    await rpc<Applied>('apply_payment_status', {
      p_order_id: order.order.order_id,
      p_provider_payment_id: providerId,
      p_provider_status: 'approved',
      p_status_detail: 'accredited',
      p_amount_cents: order.order.total_cents,
      p_delivery_token_hash: tokenHash,
      p_delivery_token_enc_b64: fakeCiphertextB64('delivery-token'),
    });

    return { orderId: order.order.order_id, productId: product.productId, reference: order.order.reference };
  }

  async function apply(orderId: string, status: string) {
    return rpc<Applied>('apply_payment_status', {
      p_order_id: orderId,
      p_provider_payment_id: null,
      p_provider_status: status,
      p_status_detail: status,
      p_amount_cents: null,
      p_delivery_token_hash: null,
      p_delivery_token_enc_b64: null,
    });
  }

  async function deliveryStatus(orderId: string): Promise<string | null> {
    const value = await sqlValue<string | null>(
      `select status::text from public.deliveries where order_id = $1`,
      [orderId],
    );
    return value ?? null;
  }

  async function eventTypes(orderId: string): Promise<string[]> {
    const rows = await runSql<{ event_type: string }>(
      `select event_type from public.order_events where order_id = $1 order by id`,
      [orderId],
    );
    return rows.map((row) => row.event_type);
  }

  it('reembolso confirmado encerra o pedido e revoga a entrega', async () => {
    const { orderId } = await paidOrder();
    expect(await deliveryStatus(orderId)).toBe('active');

    const applied = await apply(orderId, 'refunded');

    expect(applied.result).toBe('refunded');
    expect(applied.order_status).toBe('refunded');
    expect(applied.delivery_status).toBe('revoked');
    expect(await deliveryStatus(orderId)).toBe('revoked');
    expect(await eventTypes(orderId)).toContain('payment_refunded');
  });

  it('chargeback marca disputa, preserva a entrega e não cria reembolso', async () => {
    const { orderId } = await paidOrder();

    const applied = await apply(orderId, 'charged_back');

    expect(applied.result).toBe('charged_back');
    expect(applied.order_status).toBe('disputed');
    expect(applied.payment_status).toBe('charged_back');
    expect(applied.requires_admin_review).toBe(true);

    // Entrega preservada: contestação não é devolução.
    expect(await deliveryStatus(orderId)).toBe('active');

    const events = await eventTypes(orderId);
    expect(events).toContain('payment_charged_back');
    expect(events).not.toContain('payment_refunded');

    const refunds = await sqlValue<number>(
      `select count(*) from public.refund_requests where order_id = $1 and status = 'processed'`,
      [orderId],
    );
    expect(Number(refunds)).toBe(0);

    const status = await sqlValue<string>(`select status::text from public.orders where id = $1`, [orderId]);
    expect(status).toBe('disputed');
  });

  it('notificação duplicada de chargeback é idempotente', async () => {
    const { orderId } = await paidOrder();
    await apply(orderId, 'charged_back');
    const second = await apply(orderId, 'charged_back');

    expect(second.result).toBe('already_applied');
    expect(second.order_status).toBe('disputed');

    const events = await eventTypes(orderId);
    expect(events.filter((event) => event === 'payment_charged_back')).toHaveLength(1);
  });

  it('notificação duplicada de reembolso é idempotente', async () => {
    const { orderId } = await paidOrder();
    await apply(orderId, 'refunded');
    const second = await apply(orderId, 'refunded');

    expect(second.result).toBe('already_applied');
    expect(second.order_status).toBe('refunded');

    const events = await eventTypes(orderId);
    expect(events.filter((event) => event === 'payment_refunded')).toHaveLength(1);
  });

  it('reembolso depois de chargeback encerra o pedido (evento mais recente vence)', async () => {
    const { orderId } = await paidOrder();
    await apply(orderId, 'charged_back');
    const refunded = await apply(orderId, 'refunded');

    expect(refunded.order_status).toBe('refunded');
    expect(refunded.delivery_status).toBe('revoked');
    expect(await deliveryStatus(orderId)).toBe('revoked');
  });

  it('chargeback depois de reembolso registra o evento sem desfazer o reembolso', async () => {
    const { orderId } = await paidOrder();
    await apply(orderId, 'refunded');
    const chargedBack = await apply(orderId, 'charged_back');

    expect(chargedBack.payment_status).toBe('charged_back');
    expect(chargedBack.order_status).toBe('refunded');
    // A entrega permanece revogada: não reativamos nada a partir de uma notificação.
    expect(await deliveryStatus(orderId)).toBe('revoked');

    const events = await eventTypes(orderId);
    expect(events).toContain('payment_refunded');
    expect(events).toContain('payment_charged_back_after_refund');
  });

  it('notificação antiga de aprovação não reverte um reembolso já confirmado', async () => {
    const { orderId } = await paidOrder();
    await apply(orderId, 'refunded');

    const late = await apply(orderId, 'approved');

    expect(late.result).toBe('ignored_late_approval');
    expect(late.order_status).toBe('refunded');
    expect(late.delivery_status).toBe('revoked');
    expect(await deliveryStatus(orderId)).toBe('revoked');
  });

  it('apenas administrador com MFA encerra uma disputa e a decisão é auditada', async () => {
    const { orderId } = await paidOrder();
    await apply(orderId, 'charged_back');

    // Sem sessão administrativa: negado pelo banco.
    await expect(rpc('admin_resolve_dispute', { p_order_id: orderId, p_outcome: 'refund', p_notes: 'x' })).rejects.toBeTruthy();

    const adminId = await seedAdmin();
    const adminRpc = createPgRpc(client, {
      role: 'authenticated',
      claims: { sub: adminId, role: 'authenticated', aal: 'aal2' },
    });

    const resolved = await adminRpc<{ status: string; delivery_status: string; outcome: string }>(
      'admin_resolve_dispute',
      { p_order_id: orderId, p_outcome: 'refund', p_notes: 'Reembolso manual executado no Mercado Pago.' },
    );

    expect(resolved.outcome).toBe('refund');
    expect(resolved.status).toBe('refunded');
    expect(resolved.delivery_status).toBe('revoked');
    expect(await deliveryStatus(orderId)).toBe('revoked');

    const audit = await sqlValue<number>(
      `select count(*) from public.admin_audit_log where action = 'dispute_resolved' and entity_id = $1`,
      [orderId],
    );
    expect(Number(audit)).toBe(1);
  });

  it('disputa pode ser revertida (valor recuperado) sem revogar a entrega', async () => {
    const { orderId } = await paidOrder();
    await apply(orderId, 'charged_back');

    const adminId = await seedAdmin();
    const adminRpc = createPgRpc(client, {
      role: 'authenticated',
      claims: { sub: adminId, role: 'authenticated', aal: 'aal2' },
    });

    const resolved = await adminRpc<{ status: string; delivery_status: string }>('admin_resolve_dispute', {
      p_order_id: orderId,
      p_outcome: 'reinstated',
      p_notes: 'Contestação revertida pelo emissor.',
    });

    expect(resolved.status).toBe('paid');
    expect(resolved.delivery_status).toBe('ready');
    expect(await deliveryStatus(orderId)).toBe('active');
  });

  it('indicadores separam reembolsos de disputas e chargebacks', async () => {
    const adminId = await seedAdmin();
    const adminRpc = createPgRpc(client, {
      role: 'authenticated',
      claims: { sub: adminId, role: 'authenticated', aal: 'aal2' },
    });

    // O teste é independente da ordem de execução: cria suas próprias amostras.
    const refundedOrder = await paidOrder();
    await apply(refundedOrder.orderId, 'refunded');
    const disputedOrder = await paidOrder();
    await apply(disputedOrder.orderId, 'charged_back');

    const indicators = await adminRpc<{
      orders_refunded: number;
      orders_disputed: number;
      payments_charged_back: number;
      orders_refund_pending: number;
    }>('admin_indicators');

    expect(Number(indicators.orders_refunded)).toBeGreaterThanOrEqual(1);
    expect(Number(indicators.payments_charged_back)).toBeGreaterThanOrEqual(1);
    expect(indicators).toHaveProperty('orders_disputed');

    // "Somente problemas" inclui disputas.
    const problems = await adminRpc<{
      items: Array<{ status: string; payment_status: string }>;
    }>('admin_list_orders', {
      p_search: null,
      p_status: null,
      p_payment_status: null,
      p_from: null,
      p_to: null,
      p_problem_only: true,
      p_limit: 100,
      p_offset: 0,
    });
    const statuses = problems.items.map((item) => item.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses).toContain('disputed');

    // "Somente problemas" = pedido em estado problemático OU pagamento anômalo
    // (é o caso de um pedido reembolsado cujo pagamento voltou como chargeback).
    const problemStatuses = ['refund_pending', 'failed', 'disputed'];
    const problemPayments = ['amount_mismatch', 'charged_back'];
    expect(
      problems.items.every(
        (item) => problemStatuses.includes(item.status) || problemPayments.includes(item.payment_status),
      ),
    ).toBe(true);
  });
});
