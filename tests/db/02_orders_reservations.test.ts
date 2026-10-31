import { beforeAll, describe, expect, it } from 'vitest';
import {
  connect,
  createOrder,
  randomToken,
  resetDatabase,
  runSql,
  seedProduct,
  sha256Hex,
  sqlValue,
} from './helpers';

interface PgError extends Error {
  code?: string;
  detail?: string;
}

describe('pedidos e reservas de estoque', () => {
  beforeAll(async () => {
    await resetDatabase();
  }, 60000);

  it('cria pedido, reserva unidades e define vencimento de 30 minutos', async () => {
    const seed = await seedProduct({ priceCents: 4500, maxQuantity: 3, stockUnits: 3 });
    const { order } = await createOrder(seed.productId, 2);

    expect(order.status).toBe('pending_payment');
    expect(order.payment_status).toBe('pending');
    expect(order.delivery_status).toBe('not_ready');
    expect(order.quantity).toBe(2);
    expect(order.total_cents).toBe(9000);
    expect(order.reference).toMatch(/^PS-[A-Z0-9]{6}$/);

    const minutes = (new Date(order.reservation_expires_at).getTime() - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(28.5);
    expect(minutes).toBeLessThan(30.5);

    const reserved = await sqlValue<number>(
      `select count(*) from public.stock_units where product_id = $1 and status = 'reserved'`,
      [seed.productId],
    );
    expect(Number(reserved)).toBe(2);

    const available = await sqlValue<number>(
      `select count(*) from public.stock_units where product_id = $1 and status = 'available'`,
      [seed.productId],
    );
    expect(Number(available)).toBe(1);
  });

  it('rejeita quantidade indisponível informando o estoque real', async () => {
    const seed = await seedProduct({ maxQuantity: 5, stockUnits: 1 });
    await expect(createOrder(seed.productId, 2)).rejects.toMatchObject({
      code: 'P0001',
      detail: '1',
    });
  });

  it('rejeita quantidade acima do limite do produto', async () => {
    const seed = await seedProduct({ maxQuantity: 2, stockUnits: 5 });
    await expect(createOrder(seed.productId, 3)).rejects.toMatchObject({
      code: '22023',
      detail: '2',
    });
  });

  it('rejeita produto inexistente ou inativo', async () => {
    const inactive = await seedProduct({ active: false, stockUnits: 1 });
    await expect(createOrder(inactive.productId, 1)).rejects.toMatchObject({ code: 'P0002' });
    await expect(createOrder('00000000-0000-0000-0000-000000000000', 1)).rejects.toMatchObject({
      code: 'P0002',
    });
  });

  it('ignora totalmente qualquer preço vindo do cliente', async () => {
    const seed = await seedProduct({ priceCents: 7000, stockUnits: 1 });
    // A função pública não aceita preço: apenas produto, quantidade, chave e hash.
    const rows = await runSql<{ result: { total_cents: number } }>(
      `select public.create_order($1, 1, null, $2) as result`,
      [seed.productId, sha256Hex(randomToken())],
    );
    expect(rows[0].result.total_cents).toBe(7000);

    // Alterar o preço depois não altera o pedido já criado.
    await runSql(`update public.products set price_cents = 99999 where id = $1`, [seed.productId]);
    const total = await sqlValue<number>(
      `select total_cents from public.orders where product_id = $1`,
      [seed.productId],
    );
    expect(Number(total)).toBe(7000);
  });

  it('é idempotente para a mesma requisição e nunca troca o token do pedido', async () => {
    const seed = await seedProduct({ stockUnits: 3 });
    const key = randomToken(24);
    const token = randomToken();
    const first = await createOrder(seed.productId, 1, { idempotencyKey: key, clientToken: token });
    const second = await createOrder(seed.productId, 1, { idempotencyKey: key, clientToken: token });

    expect(second.order.order_id).toBe(first.order.order_id);
    expect(second.order.idempotent_replay).toBe(true);

    const total = await sqlValue<number>(
      `select count(*) from public.orders where product_id = $1`,
      [seed.productId],
    );
    expect(Number(total)).toBe(1);

    // O token original continua sendo o único que abre o pedido.
    const rows = await runSql<{ result: { order_id: string } }>(
      `select public.get_order_status($1, $2) as result`,
      [first.order.order_id, first.tokenHash],
    );
    expect(rows[0].result.order_id).toBe(first.order.order_id);
  });

  it('libera unidades e expira o pedido quando a reserva vence', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    const { order, tokenHash } = await createOrder(seed.productId, 1);

    // Simula o vencimento sem esperar 30 minutos.
    await runSql(
      `update public.orders set reservation_expires_at = now() - interval '1 minute' where id = $1`,
      [order.order_id],
    );
    await runSql(
      `update public.stock_reservations
          set starts_at = now() - interval '31 minutes', expires_at = now() - interval '1 minute'
        where order_id = $1`,
      [order.order_id],
    );

    // Qualquer nova tentativa de reserva trata a reserva vencida.
    const next = await createOrder(seed.productId, 1);
    expect(next.order.order_id).not.toBe(order.order_id);

    const status = await sqlValue<string>(
      `select status from public.orders where id = $1`,
      [order.order_id],
    );
    expect(status).toBe('expired');

    const reservation = await sqlValue<string>(
      `select status from public.stock_reservations where order_id = $1`,
      [order.order_id],
    );
    expect(reservation).toBe('expired');

    const available = await sqlValue<number>(
      `select count(*) from public.stock_units where product_id = $1 and status = 'available'`,
      [seed.productId],
    );
    expect(Number(available)).toBe(0);

    // O pedido expirado continua consultável pelo comprador (sem entrega).
    const rows = await runSql<{ result: { status: string; delivery: unknown } }>(
      `select public.get_order_status($1, $2) as result`,
      [order.order_id, tokenHash],
    );
    expect(rows[0].result.status).toBe('expired');
    expect(rows[0].result.delivery).toBeNull();
  });

  it('não expira reservas ainda válidas', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);
    await createOrder(seed.productId, 1).catch(() => undefined);

    const status = await sqlValue<string>(
      `select status from public.orders where id = $1`,
      [order.order_id],
    );
    expect(status).toBe('pending_payment');
  });

  it('impede venda dupla da última unidade sob concorrência', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    const attempts = 12;

    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () => createOrder(seed.productId, 1)),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(attempts - 1);
    for (const failure of rejected) {
      expect((failure.reason as PgError).code).toBe('P0001');
    }

    const sold = await sqlValue<number>(
      `select count(*) from public.orders where product_id = $1`,
      [seed.productId],
    );
    expect(Number(sold)).toBe(1);

    const liveAllocations = await sqlValue<number>(
      `select count(*) from public.stock_reservation_units sru
         join public.stock_units su on su.id = sru.stock_unit_id
        where su.product_id = $1 and sru.released_at is null`,
      [seed.productId],
    );
    expect(Number(liveAllocations)).toBe(1);
  });

  it('distribui corretamente várias unidades sob concorrência', async () => {
    const seed = await seedProduct({ maxQuantity: 2, stockUnits: 6 });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => createOrder(seed.productId, 2)),
    );
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(3);

    const reserved = await sqlValue<number>(
      `select count(*) from public.stock_units where product_id = $1 and status = 'reserved'`,
      [seed.productId],
    );
    expect(Number(reserved)).toBe(6);
  });

  it('mantém o estoque correto quando uma transação falha no meio', async () => {
    const seed = await seedProduct({ stockUnits: 2 });

    // Simula falha depois da criação do pedido (violação de unicidade no
    // índice de alocações vivas). A transação inteira precisa ser desfeita.
    const client = await connect();
    try {
      await client.query('begin');
      const orderRows = await client.query(
        `select (public.create_order($1, 2, null, $2)).*`,
        [seed.productId, sha256Hex(randomToken())],
      );
      expect(orderRows.rowCount).toBe(1);
      // Provoca erro explícito na mesma transação.
      await client.query(`select 1/0`);
    } catch {
      await client.query('rollback');
    } finally {
      await client.end();
    }

    const orders = await sqlValue<number>(
      `select count(*) from public.orders where product_id = $1`,
      [seed.productId],
    );
    expect(Number(orders)).toBe(0);
    const available = await sqlValue<number>(
      `select count(*) from public.stock_units where product_id = $1 and status = 'available'`,
      [seed.productId],
    );
    expect(Number(available)).toBe(2);
  });

  it('não deixa o comprador consultar pedido de terceiros', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);
    const otherHash = sha256Hex(randomToken());
    await expect(
      runSql(`select public.get_order_status($1, $2)`, [order.order_id, otherHash]),
    ).rejects.toMatchObject({ code: 'P0002' });
  });
});
