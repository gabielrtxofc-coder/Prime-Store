import { beforeAll, describe, expect, it } from 'vitest';
import {
  createOrder,
  fakeCiphertextB64,
  randomToken,
  resetDatabase,
  runSql,
  seedProduct,
  sha256Hex,
  sqlValue,
  type OrderResult,
} from './helpers';

interface PaymentResult {
  result: string;
  order_status?: string;
  payment_status?: string;
  delivery_status?: string;
}

interface DeliveryToken {
  hash: string;
  enc: string;
}

function newDeliveryToken(): DeliveryToken {
  return { hash: sha256Hex(randomToken()), enc: fakeCiphertextB64('delivery') };
}

async function attachPayment(order: OrderResult, providerId = `MP-${randomToken(6)}`) {
  const rows = await runSql<{ result: Record<string, unknown> }>(
    `select public.attach_payment($1, $2, 'pending', $3, '00020126pix-copia-e-cola', 'iVBORw0KGgo=', null, now() + interval '30 minutes') as result`,
    [order.order_id, providerId, order.total_cents],
  );
  return { providerId, attached: rows[0].result };
}

async function apply(
  order: OrderResult,
  providerId: string,
  status: string,
  options: { amountCents?: number; token?: DeliveryToken; detail?: string } = {},
) {
  const token = options.token ?? null;
  const rows = await runSql<{ result: PaymentResult }>(
    `select public.apply_payment_status($1, $2, $3, $4, $5, $6, $7) as result`,
    [
      order.order_id,
      providerId,
      status,
      options.detail ?? null,
      options.amountCents ?? order.total_cents,
      token?.hash ?? null,
      token?.enc ?? null,
    ],
  );
  return rows[0].result;
}

async function expireReservation(orderId: string) {
  await runSql(
    `update public.orders set reservation_expires_at = now() - interval '1 minute' where id = $1`,
    [orderId],
  );
  await runSql(
    `update public.stock_reservations
        set starts_at = now() - interval '31 minutes', expires_at = now() - interval '1 minute'
      where order_id = $1 and status = 'active'`,
    [orderId],
  );
}

describe('pagamentos PIX, notificações e entrega', () => {
  beforeAll(async () => {
    await resetDatabase();
  }, 60000);

  it('registra a cobrança PIX com QR Code e Copia e Cola', async () => {
    const seed = await seedProduct({ priceCents: 3200, stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);
    const { attached } = await attachPayment(order);

    expect(attached.qr_code).toBe('00020126pix-copia-e-cola');
    expect(attached.qr_code_base64).toBe('iVBORw0KGgo=');
    expect(attached.status).toBe('pending');

    const paymentStatus = await sqlValue<string>(
      `select payment_status from public.orders where id = $1`,
      [order.order_id],
    );
    expect(paymentStatus).toBe('pending');
  });

  it('recusa cobrança com valor diferente do pedido', async () => {
    const seed = await seedProduct({ priceCents: 3200, stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);
    await expect(
      runSql(
        `select public.attach_payment($1, 'MP-x', 'pending', 100, 'qr', null, null, null)`,
        [order.order_id],
      ),
    ).rejects.toMatchObject({ code: 'P0001', message: expect.stringContaining('amount_mismatch') });
  });

  it('confirma pagamento: vende unidades, cria entrega e é idempotente', async () => {
    const seed = await seedProduct({ priceCents: 5000, maxQuantity: 2, stockUnits: 2 });
    const { order } = await createOrder(seed.productId, 2);
    const { providerId } = await attachPayment(order);
    const token = newDeliveryToken();

    const first = await apply(order, providerId, 'approved', { token });
    expect(first.result).toBe('approved');

    const status = await sqlValue<string>(`select status from public.orders where id = $1`, [
      order.order_id,
    ]);
    expect(status).toBe('paid');

    const sold = await sqlValue<number>(
      `select count(*) from public.stock_units where sold_order_id = $1 and status = 'sold'`,
      [order.order_id],
    );
    expect(Number(sold)).toBe(2);

    // Webhook repetido: nada é duplicado.
    const token2 = newDeliveryToken();
    const second = await apply(order, providerId, 'approved', { token: token2 });
    expect(second.result).toBe('already_applied');

    const deliveries = await sqlValue<number>(
      `select count(*) from public.deliveries where order_id = $1`,
      [order.order_id],
    );
    expect(Number(deliveries)).toBe(1);

    const deliveryUnits = await sqlValue<number>(
      `select count(*) from public.delivery_units du
         join public.deliveries d on d.id = du.delivery_id
        where d.order_id = $1`,
      [order.order_id],
    );
    expect(Number(deliveryUnits)).toBe(2);

    // A entrega continua acessível pelo token original.
    const resolved = await runSql<{ result: { units: unknown[]; reference: string } }>(
      `select public.resolve_delivery($1) as result`,
      [token.hash],
    );
    expect(resolved[0].result.units).toHaveLength(2);
    expect(resolved[0].result.reference).toBe(order.reference);
  });

  it('notificação fora de ordem não desfaz um pagamento aprovado', async () => {
    const seed = await seedProduct({ priceCents: 2000, stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);
    const { providerId } = await attachPayment(order);

    await apply(order, providerId, 'approved', { token: newDeliveryToken() });
    await apply(order, providerId, 'pending');
    await apply(order, providerId, 'in_process');

    const row = await runSql<{ status: string; payment_status: string; delivery_status: string }>(
      `select status, payment_status, delivery_status from public.orders where id = $1`,
      [order.order_id],
    );
    expect(row[0].status).toBe('paid');
    expect(row[0].payment_status).toBe('approved');
    expect(row[0].delivery_status).toBe('ready');
  });

  it('recusa pagamento e devolve o estoque imediatamente', async () => {
    const seed = await seedProduct({ priceCents: 2000, stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);
    const { providerId } = await attachPayment(order);

    const result = await apply(order, providerId, 'rejected', { detail: 'cc_rejected_other_reason' });
    expect(result.result).toBe('rejected');

    const available = await sqlValue<number>(
      `select count(*) from public.stock_units where product_id = $1 and status = 'available'`,
      [seed.productId],
    );
    expect(Number(available)).toBe(1);

    const status = await sqlValue<string>(`select status from public.orders where id = $1`, [
      order.order_id,
    ]);
    expect(status).toBe('failed');
  });

  it('aprova pagamento próximo do vencimento enquanto a reserva está viva', async () => {
    const seed = await seedProduct({ priceCents: 2000, stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);
    const { providerId } = await attachPayment(order);

    // Faltando 20 segundos para vencer.
    await runSql(
      `update public.orders set reservation_expires_at = now() + interval '20 seconds' where id = $1`,
      [order.order_id],
    );
    await runSql(
      `update public.stock_reservations set expires_at = now() + interval '20 seconds' where order_id = $1`,
      [order.order_id],
    );

    const result = await apply(order, providerId, 'approved', { token: newDeliveryToken() });
    expect(result.result).toBe('approved');
    expect(result.order_status).toBe('paid');

    const sold = await sqlValue<number>(
      `select count(*) from public.stock_units where sold_order_id = $1`,
      [order.order_id],
    );
    expect(Number(sold)).toBe(1);
  });

  it('aprovação após a expiração realoca estoque quando há unidades', async () => {
    const seed = await seedProduct({ priceCents: 2000, stockUnits: 2 });
    const { order } = await createOrder(seed.productId, 1);
    const { providerId } = await attachPayment(order);

    await expireReservation(order.order_id);
    // Força a liberação das unidades (novo sweep explícito).
    await runSql(`select public.expire_overdue_reservations(null)`);

    const result = await apply(order, providerId, 'approved', { token: newDeliveryToken() });
    expect(result.result).toBe('approved');
    expect(result.order_status).toBe('paid');

    const sold = await sqlValue<number>(
      `select count(*) from public.stock_units where sold_order_id = $1`,
      [order.order_id],
    );
    expect(Number(sold)).toBe(1);

    // A unidade liberada original e a nova alocação não se sobrepõem.
    const liveAllocations = await sqlValue<number>(
      `select count(*) from public.stock_reservation_units sru
         join public.stock_units su on su.id = sru.stock_unit_id
        where su.product_id = $1 and sru.released_at is null`,
      [seed.productId],
    );
    expect(Number(liveAllocations)).toBe(1);
  });

  it('pagamento aprovado sem estoque bloqueia entrega e abre reembolso', async () => {
    const seed = await seedProduct({ priceCents: 2000, stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);
    const { providerId } = await attachPayment(order);

    await expireReservation(order.order_id);
    await runSql(`select public.expire_overdue_reservations(null)`);

    // Outro cliente compra a unidade liberada.
    const other = await createOrder(seed.productId, 1);
    expect(other.order.status).toBe('pending_payment');

    const result = await apply(order, providerId, 'approved', { token: newDeliveryToken() });
    expect(result.result).toBe('approved_without_stock');
    expect(result.order_status).toBe('refund_pending');
    expect(result.delivery_status).toBe('blocked');

    const refund = await sqlValue<string>(
      `select status from public.refund_requests where order_id = $1`,
      [order.order_id],
    );
    expect(refund).toBe('pending');

    const reason = await sqlValue<string>(
      `select reason from public.refund_requests where order_id = $1`,
      [order.order_id],
    );
    expect(reason).toBe('paid_without_stock');

    const deliveries = await sqlValue<number>(
      `select count(*) from public.deliveries where order_id = $1`,
      [order.order_id],
    );
    expect(Number(deliveries)).toBe(0);
  });

  it('bloqueia entrega quando o valor recebido difere do pedido', async () => {
    const seed = await seedProduct({ priceCents: 5000, stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);
    const { providerId } = await attachPayment(order);

    const result = await apply(order, providerId, 'approved', {
      amountCents: 100,
      token: newDeliveryToken(),
    });
    expect(result.result).toBe('amount_mismatch');

    const row = await runSql<{ payment_status: string; delivery_status: string }>(
      `select payment_status, delivery_status from public.orders where id = $1`,
      [order.order_id],
    );
    expect(row[0].payment_status).toBe('amount_mismatch');
    expect(row[0].delivery_status).not.toBe('ready');

    const refunds = await sqlValue<number>(
      `select count(*) from public.refund_requests where order_id = $1`,
      [order.order_id],
    );
    expect(Number(refunds)).toBe(1);
  });

  it('estorno revoga o link de entrega e marca o pedido como reembolsado', async () => {
    const seed = await seedProduct({ priceCents: 2000, stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);
    const { providerId } = await attachPayment(order);
    const token = newDeliveryToken();
    await apply(order, providerId, 'approved', { token });

    const result = await apply(order, providerId, 'refunded');
    expect(result.result).toBe('refunded');

    const delivery = await sqlValue<string>(
      `select status from public.deliveries where order_id = $1`,
      [order.order_id],
    );
    expect(delivery).toBe('revoked');

    await expect(
      runSql(`select public.resolve_delivery($1)`, [token.hash]),
    ).rejects.toMatchObject({ code: 'P0002' });
  });

  it('registra notificações de forma idempotente, inclusive em paralelo', async () => {
    const hash = sha256Hex(randomToken());
    const first = await runSql<{ result: { duplicate: boolean; event_id: string } }>(
      `select public.record_payment_event('notif-1', 'payment', 'payment.updated', '123', true, $1) as result`,
      [hash],
    );
    expect(first[0].result.duplicate).toBe(false);

    const second = await runSql<{ result: { duplicate: boolean } }>(
      `select public.record_payment_event('notif-1', 'payment', 'payment.updated', '123', true, $1) as result`,
      [hash],
    );
    expect(second[0].result.duplicate).toBe(true);

    const parallel = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        runSql(
          `select public.record_payment_event($1, 'payment', 'payment.updated', '999', true, $2)`,
          [`notif-parallel-${index % 2}`, hash],
        ),
      ),
    );
    const succeeded = parallel.filter((item) => item.status === 'fulfilled');
    expect(succeeded.length).toBeGreaterThanOrEqual(2);

    const events = await sqlValue<number>(
      `select count(*) from public.payment_events where notification_id like 'notif-parallel-%'`,
    );
    expect(Number(events)).toBe(2);
  });

  it('não permite duas cobranças abertas para o mesmo pedido', async () => {
    const seed = await seedProduct({ priceCents: 2000, stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);
    await attachPayment(order);
    await runSql(
      `insert into public.payments (order_id, status, amount_cents) values ($1, 'pending', 2000)`,
      [order.order_id],
    ).then(
      () => {
        throw new Error('Esperava violação de unicidade');
      },
      (error: { code?: string }) => expect(error.code).toBe('23505'),
    );
  });
});
