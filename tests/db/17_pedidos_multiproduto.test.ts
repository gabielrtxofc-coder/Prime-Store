import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  connect,
  fakeCiphertextB64,
  randomToken,
  resetDatabase,
  runAs,
  runSql,
  seedProduct,
  sha256Hex,
  sqlValue,
  type Seed,
} from './helpers';

/**
 * Missão 09 — automação de pedidos multi-produto e entrega digital.
 *
 * Cobre os grupos G2..G10 do registro de execução:
 *  - estrutura do pedido (itens, preço por item, total, limites, duplicidade);
 *  - processamento atômico (reserva por item, nada parcial, concorrência);
 *  - estados e recuperação (sem pagamento, confirmação única, expiração);
 *  - proteção (privilégios, confirmação interna desligada por padrão);
 *  - entrega (uma entrega, grupos por produto, cobertura integral, revogação);
 *  - compatibilidade com o pedido de um produto criado por `create_order`.
 */

interface MultiOrder {
  order_id: string;
  reference: string;
  status: string;
  payment_status: string;
  delivery_status: string;
  items_count: number;
  quantity: number;
  total_cents: number;
  reservation_expires_at: string;
  items: Array<{
    product_id: string;
    product_name: string;
    quantity: number;
    unit_price_cents: number;
    subtotal_cents: number;
  }>;
  idempotent_replay: boolean;
}

interface DeliveryPayload {
  delivery_id: string;
  reference: string;
  items_count: number;
  items: Array<{
    product_id: string;
    product_name: string;
    instructions: string;
    access_validity_label: string;
    quantity: number;
    units: Array<{ stock_unit_id: string; email_enc: string; password_enc: string }>;
  }>;
  product: { id: string; name: string };
  units: Array<{ stock_unit_id: string }>;
}

async function createMulti(
  items: Array<{ product_id: string; quantity: number }>,
  options: { idempotencyKey?: string | null; clientToken?: string } = {},
): Promise<{ order: MultiOrder; clientToken: string; tokenHash: string }> {
  const clientToken = options.clientToken ?? randomToken();
  const tokenHash = sha256Hex(clientToken);
  const rows = await runSql<{ result: MultiOrder }>(
    `select public.create_order_multi($1, $2, $3) as result`,
    [JSON.stringify(items), options.idempotencyKey ?? null, tokenHash],
  );
  return { order: rows[0].result, clientToken, tokenHash };
}

/** Liga a confirmação interna apenas para o teste corrente (nunca em produção). */
async function setInternalConfirmation(enabled: boolean): Promise<void> {
  await runSql(
    `update public.app_settings set value = $1::jsonb where key = 'internal_confirmation_enabled'`,
    [enabled ? 'true' : 'false'],
  );
}

interface ConfirmResult {
  result: string;
  order_status: string;
  payment_status: string;
  delivery_status: string;
  internal?: boolean;
}

async function confirmInternal(
  orderId: string,
  clientTokenHash: string,
  deliveryToken: { hash: string; enc: string } = newDeliveryToken(),
): Promise<{ result: ConfirmResult; hash: string }> {
  const rows = await runSql<{ result: ConfirmResult }>(
    `select public.internal_confirm_payment($1, $2, $3, $4) as result`,
    [orderId, clientTokenHash, deliveryToken.hash, deliveryToken.enc],
  );
  return { result: rows[0].result, hash: deliveryToken.hash };
}

function newDeliveryToken(): { raw: string; hash: string; enc: string } {
  const raw = randomToken(32);
  return { raw, hash: sha256Hex(raw), enc: fakeCiphertextB64('token') };
}

async function stockState(productId: string) {
  return runSql<{ status: string; count: number }>(
    `select status::text as status, count(*)::int as count
       from public.stock_units where product_id = $1 group by status order by status`,
    [productId],
  );
}

async function twoSeeds(quantities = { first: 2, second: 2 }): Promise<{ first: Seed; second: Seed }> {
  const first = await seedProduct({
    priceCents: 4990,
    maxQuantity: 5,
    stockUnits: quantities.first,
  });
  const second = await seedProduct({
    priceCents: 2990,
    maxQuantity: 5,
    stockUnits: quantities.second,
  });
  return { first, second };
}

describe('pedido multi-produto — estrutura e validação', () => {
  beforeAll(async () => {
    await resetDatabase();
  }, 60000);

  it('G2 — registra um pedido com vários produtos, preço por item e total somado', async () => {
    const { first, second } = await twoSeeds({ first: 4, second: 3 });

    const { order } = await createMulti([
      { product_id: first.productId, quantity: 2 },
      { product_id: second.productId, quantity: 1 },
    ]);

    expect(order.status).toBe('pending_payment');
    expect(order.payment_status).toBe('pending');
    expect(order.delivery_status).toBe('not_ready');
    expect(order.items_count).toBe(2);
    expect(order.quantity).toBe(3);
    expect(order.total_cents).toBe(4990 * 2 + 2990);
    expect(order.idempotent_replay).toBe(false);

    expect(order.items).toHaveLength(2);
    const firstItem = order.items.find((item) => item.product_id === first.productId)!;
    expect(firstItem.quantity).toBe(2);
    expect(firstItem.unit_price_cents).toBe(4990);
    expect(firstItem.subtotal_cents).toBe(9980);

    const totalOfItems = order.items.reduce((sum, item) => sum + item.subtotal_cents, 0);
    expect(totalOfItems).toBe(order.total_cents);

    // O total gravado no pedido é exatamente a soma dos itens gravados.
    const stored = await sqlValue<number>(
      `select sum(subtotal_cents)::int from public.order_items where order_id = $1`,
      [order.order_id],
    );
    expect(Number(stored)).toBe(order.total_cents);
  });

  it('G2 — recusa produto inexistente, arquivado e inativo', async () => {
    const active = await seedProduct({ stockUnits: 2 });
    const archived = await seedProduct({ stockUnits: 2 });
    const inactive = await seedProduct({ stockUnits: 2, active: false });

    await runSql(`update public.products set archived_at = now() where id = $1`, [archived.productId]);

    await expect(
      createMulti([{ product_id: '00000000-0000-4000-8000-000000000000', quantity: 1 }]),
    ).rejects.toMatchObject({ message: expect.stringContaining('product_not_found') });

    await expect(
      createMulti([
        { product_id: active.productId, quantity: 1 },
        { product_id: archived.productId, quantity: 1 },
      ]),
    ).rejects.toMatchObject({ message: expect.stringContaining('product_archived') });

    await expect(
      createMulti([{ product_id: inactive.productId, quantity: 1 }]),
    ).rejects.toMatchObject({ message: expect.stringContaining('product_unavailable') });

    // Nenhum pedido parcial foi criado.
    const created = await sqlValue<number>(
      `select count(*)::int from public.orders where product_id = any($1::uuid[])`,
      [[active.productId, archived.productId, inactive.productId]],
    );
    expect(Number(created)).toBe(0);
  });

  it('G2 — respeita o limite por produto, o teto total e recusa item repetido', async () => {
    const limited = await seedProduct({ maxQuantity: 2, stockUnits: 5 });
    const other = await seedProduct({ maxQuantity: 5, stockUnits: 5 });

    await expect(
      createMulti([{ product_id: limited.productId, quantity: 3 }]),
    ).rejects.toMatchObject({ message: expect.stringContaining('quantity_above_product_limit') });

    await expect(
      createMulti([
        { product_id: limited.productId, quantity: 1 },
        { product_id: limited.productId, quantity: 1 },
      ]),
    ).rejects.toMatchObject({ message: expect.stringContaining('duplicate_item') });

    // Teto global de 20 unidades somadas (setting `max_quantity_per_order`).
    const big = await seedProduct({ maxQuantity: 20, stockUnits: 30 });
    await expect(
      createMulti([
        { product_id: big.productId, quantity: 11 },
        { product_id: other.productId, quantity: 10 },
      ]),
    ).rejects.toMatchObject({ message: expect.stringContaining('quantity_above_product_limit') });
  });

  it('G2 — recusa lista vazia, acima de 10 produtos e quantidade inválida', async () => {
    await expect(createMulti([])).rejects.toMatchObject({
      message: expect.stringContaining('invalid_items'),
    });

    const seeds = [];
    for (let index = 0; index < 11; index += 1) {
      seeds.push(await seedProduct({ stockUnits: 1 }));
    }
    await expect(
      createMulti(seeds.map((seed) => ({ product_id: seed.productId, quantity: 1 }))),
    ).rejects.toMatchObject({ message: expect.stringContaining('invalid_items') });

    await expect(
      createMulti([{ product_id: seeds[0].productId, quantity: 0 }]),
    ).rejects.toMatchObject({ message: expect.stringContaining('invalid_quantity') });
  });

  it('G2 — ignora preço vindo do cliente (o preço é sempre o do banco)', async () => {
    const seed = await seedProduct({ priceCents: 7990, stockUnits: 2 });
    const rows = await runSql<{ result: MultiOrder }>(
      `select public.create_order_multi($1, null, $2) as result`,
      [
        JSON.stringify([{ product_id: seed.productId, quantity: 1, unit_price_cents: 1, price: 1 }]),
        sha256Hex(randomToken()),
      ],
    );

    expect(rows[0].result.total_cents).toBe(7990);
    expect(rows[0].result.items[0].unit_price_cents).toBe(7990);
  });
});

describe('pedido multi-produto — reserva e concorrência', () => {
  beforeAll(async () => {
    await resetDatabase();
  }, 60000);

  it('G3 — reserva exatamente a quantidade pedida de cada item', async () => {
    const { first, second } = await twoSeeds({ first: 5, second: 4 });

    const { order } = await createMulti([
      { product_id: first.productId, quantity: 3 },
      { product_id: second.productId, quantity: 2 },
    ]);

    const reserved = await runSql<{ product_id: string; count: number }>(
      `select su.product_id, count(*)::int as count
         from public.stock_reservation_units sru
         join public.stock_reservations r on r.id = sru.reservation_id
         join public.stock_units su on su.id = sru.stock_unit_id
        where r.order_id = $1 and r.status = 'active' and sru.released_at is null
        group by su.product_id`,
      [order.order_id],
    );
    const byProduct = Object.fromEntries(reserved.map((row) => [row.product_id, row.count]));
    expect(byProduct[first.productId]).toBe(3);
    expect(byProduct[second.productId]).toBe(2);

    // Uma única reserva ativa por pedido (índice parcial).
    const reservations = await sqlValue<number>(
      `select count(*)::int from public.stock_reservations
        where order_id = $1 and status = 'active'`,
      [order.order_id],
    );
    expect(Number(reservations)).toBe(1);

    expect((await stockState(first.productId)).find((row) => row.status === 'reserved')?.count).toBe(3);
    expect((await stockState(second.productId)).find((row) => row.status === 'reserved')?.count).toBe(2);
  });

  it('G3 — falta de estoque em um item não deixa pedido, itens nem reserva parciais', async () => {
    const ok = await seedProduct({ stockUnits: 3, maxQuantity: 5 });
    const scarce = await seedProduct({ stockUnits: 1, maxQuantity: 5 });

    await expect(
      createMulti([
        { product_id: ok.productId, quantity: 2 },
        { product_id: scarce.productId, quantity: 2 },
      ]),
    ).rejects.toMatchObject({ message: expect.stringContaining('insufficient_stock') });

    // Nada foi criado e nenhuma unidade do produto disponível ficou presa.
    const orders = await sqlValue<number>(
      `select count(*)::int from public.orders where product_id = any($1::uuid[])`,
      [[ok.productId, scarce.productId]],
    );
    expect(Number(orders)).toBe(0);

    expect(await stockState(ok.productId)).toEqual([{ status: 'available', count: 3 }]);
    expect(await stockState(scarce.productId)).toEqual([{ status: 'available', count: 1 }]);

    // Reserva só existe se o pedido existir: nada ficou órfão para estes produtos.
    const stranded = await sqlValue<number>(
      `select count(*)::int
         from public.stock_reservations r
        where r.status = 'active'
          and r.order_id in (
            select id from public.orders where product_id = any($1::uuid[])
          )`,
      [[ok.productId, scarce.productId]],
    );
    expect(Number(stranded)).toBe(0);

    const reservations = await sqlValue<number>(
      `select count(*)::int
         from public.stock_reservations r
        where r.order_id in (select id from public.orders where product_id = any($1::uuid[]))`,
      [[ok.productId, scarce.productId]],
    );
    expect(Number(reservations)).toBe(0);
  });

  it('G3 — duas compras simultâneas nunca usam a mesma unidade', async () => {
    const seed = await seedProduct({ stockUnits: 2, maxQuantity: 2 });

    const [first, second] = await Promise.allSettled([
      createMulti([{ product_id: seed.productId, quantity: 2 }]),
      createMulti([{ product_id: seed.productId, quantity: 2 }]),
    ]);

    const fulfilled = [first, second].filter((result) => result.status === 'fulfilled');
    const rejected = [first, second].filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Nenhuma unidade em duas reservas vivas.
    const shared = await sqlValue<number>(
      `select count(*)::int from (
         select stock_unit_id
           from public.stock_reservation_units
          where released_at is null
          group by stock_unit_id
         having count(*) > 1
       ) duplicated`,
    );
    expect(Number(shared)).toBe(0);

    expect(await stockState(seed.productId)).toEqual([{ status: 'reserved', count: 2 }]);
  });

  it('G3 — concorrência em produtos diferentes (ordem invertida) não gera deadlock', async () => {
    const left = await seedProduct({ stockUnits: 3 });
    const right = await seedProduct({ stockUnits: 3 });

    const attempts = await Promise.allSettled([
      createMulti([
        { product_id: right.productId, quantity: 1 },
        { product_id: left.productId, quantity: 1 },
      ]),
      createMulti([
        { product_id: left.productId, quantity: 1 },
        { product_id: right.productId, quantity: 1 },
      ]),
      createMulti([
        { product_id: left.productId, quantity: 1 },
        { product_id: right.productId, quantity: 1 },
      ]),
    ]);

    // Todas cabem no estoque: nenhuma pode falhar por deadlock (40P01).
    for (const attempt of attempts) {
      if (attempt.status === 'rejected') {
        expect(String(attempt.reason?.code)).not.toBe('40P01');
      }
    }
    expect(attempts.every((attempt) => attempt.status === 'fulfilled')).toBe(true);

    const reservedLeft = await sqlValue<number>(
      `select count(*)::int from public.stock_units where product_id = $1 and status = 'reserved'`,
      [left.productId],
    );
    expect(Number(reservedLeft)).toBe(3);
  });

  it('G3 — 10 produtos distintos no mesmo pedido', async () => {
    const seeds: Seed[] = [];
    for (let index = 0; index < 10; index += 1) {
      seeds.push(await seedProduct({ priceCents: 1000 + index, maxQuantity: 2, stockUnits: 2 }));
    }

    // 10 itens × 2 unidades = 20, exatamente o teto global.
    const { order } = await createMulti(
      seeds.map((seed) => ({ product_id: seed.productId, quantity: 2 })),
    );

    expect(order.items_count).toBe(10);
    expect(order.quantity).toBe(20);
    expect(order.items).toHaveLength(10);
    expect(order.total_cents).toBe(
      seeds.reduce((sum, seed, index) => sum + (1000 + index) * 2, 0),
    );
  });
});

describe('pedido multi-produto — idempotência e estados', () => {
  beforeAll(async () => {
    await resetDatabase();
  }, 60000);

  it('G4 — replay da mesma chave devolve o mesmo pedido, sem reservar de novo', async () => {
    const seed = await seedProduct({ stockUnits: 5, maxQuantity: 5 });
    const key = 'chave-de-teste-1234567890';

    const first = await createMulti([{ product_id: seed.productId, quantity: 2 }], {
      idempotencyKey: key,
    });
    const second = await createMulti([{ product_id: seed.productId, quantity: 2 }], {
      idempotencyKey: key,
      clientToken: first.clientToken,
    });

    expect(second.order.idempotent_replay).toBe(true);
    expect(second.order.order_id).toBe(first.order.order_id);

    const orders = await sqlValue<number>(
      `select count(*)::int from public.orders where product_id = $1`,
      [seed.productId],
    );
    expect(Number(orders)).toBe(1);
    expect(await stockState(seed.productId)).toEqual([
      { status: 'available', count: 3 },
      { status: 'reserved', count: 2 },
    ]);
  });

  it('G4 — mesma chave com itens diferentes é conflito', async () => {
    const firstProduct = await seedProduct({ stockUnits: 5 });
    const secondProduct = await seedProduct({ stockUnits: 5 });
    const key = 'chave-de-teste-conflito';

    const created = await createMulti([{ product_id: firstProduct.productId, quantity: 1 }], {
      idempotencyKey: key,
    });

    await expect(
      createMulti(
        [
          { product_id: firstProduct.productId, quantity: 1 },
          { product_id: secondProduct.productId, quantity: 1 },
        ],
        { idempotencyKey: key, clientToken: created.clientToken },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('idempotency_conflict') });
  });

  it('G4 — pedido sem confirmação permanece sem pagamento e sem entrega', async () => {
    const seed = await seedProduct({ stockUnits: 2 });
    const { order } = await createMulti([{ product_id: seed.productId, quantity: 1 }]);

    const row = await runSql<{ status: string; payment_status: string; delivery_status: string }>(
      `select status, payment_status, delivery_status from public.orders where id = $1`,
      [order.order_id],
    );
    expect(row[0]).toMatchObject({
      status: 'pending_payment',
      payment_status: 'pending',
      delivery_status: 'not_ready',
    });

    const deliveries = await sqlValue<number>(
      `select count(*)::int from public.deliveries where order_id = $1`,
      [order.order_id],
    );
    expect(Number(deliveries)).toBe(0);
  });

  it('G4 — confirmação interna desligada por padrão não processa nada', async () => {
    await setInternalConfirmation(false);
    const seed = await seedProduct({ stockUnits: 2 });
    const { order, tokenHash } = await createMulti([{ product_id: seed.productId, quantity: 1 }]);

    await expect(confirmInternal(order.order_id, tokenHash)).rejects.toMatchObject({
      message: expect.stringContaining('internal_confirmation_disabled'),
    });

    const status = await sqlValue<string>(
      `select status from public.orders where id = $1`,
      [order.order_id],
    );
    expect(status).toBe('pending_payment');
  });

  it('G4 — confirmação exige o token privado do pedido', async () => {
    await setInternalConfirmation(true);
    try {
      const seed = await seedProduct({ stockUnits: 2 });
      const { order } = await createMulti([{ product_id: seed.productId, quantity: 1 }]);

      await expect(
        confirmInternal(order.order_id, sha256Hex(randomToken())),
      ).rejects.toMatchObject({ message: expect.stringContaining('order_not_found') });
    } finally {
      await setInternalConfirmation(false);
    }
  });

  it('G4 — confirmação processa uma única vez e a repetição é idempotente', async () => {
    await setInternalConfirmation(true);
    try {
      const seed = await seedProduct({ stockUnits: 3, maxQuantity: 2 });
      const { order, tokenHash } = await createMulti([{ product_id: seed.productId, quantity: 2 }]);

      const token = newDeliveryToken();
      const first = await confirmInternal(order.order_id, tokenHash, token);
      expect(first.result.result).toBe('approved');
      expect(first.result.order_status).toBe('paid');
      expect(first.result.delivery_status).toBe('ready');

      const deliveries = await sqlValue<number>(
        `select count(*)::int from public.deliveries where order_id = $1`,
        [order.order_id],
      );
      expect(Number(deliveries)).toBe(1);

      // Segunda confirmação: o pedido não está mais pendente.
      await expect(confirmInternal(order.order_id, tokenHash, newDeliveryToken())).rejects
        .toMatchObject({ message: expect.stringContaining('order_not_pending') });

      // Reentrega do MESMO evento no núcleo de pagamento não cria outra entrega.
      const replay = await runSql<{ result: { result: string } }>(
        `select public.apply_payment_status(
           $1, 'INTERNAL-' || (select reference from public.orders where id = $1),
           'approved', 'replay', null, null, null
         ) as result`,
        [order.order_id],
      );
      expect(replay[0].result.result).toBe('already_applied');

      const afterReplay = await sqlValue<number>(
        `select count(*)::int from public.deliveries where order_id = $1`,
        [order.order_id],
      );
      expect(Number(afterReplay)).toBe(1);

      // Uma unidade vendida por unidade entregue, nunca duas entregas da mesma.
      const sold = await sqlValue<number>(
        `select count(*)::int from public.stock_units where sold_order_id = $1`,
        [order.order_id],
      );
      expect(Number(sold)).toBe(2);
    } finally {
      await setInternalConfirmation(false);
    }
  });

  it('G4 — expiração libera as unidades de todos os itens do pedido', async () => {
    const { first, second } = await twoSeeds({ first: 3, second: 2 });
    const { order } = await createMulti([
      { product_id: first.productId, quantity: 2 },
      { product_id: second.productId, quantity: 2 },
    ]);

    await runSql(
      `update public.orders set reservation_expires_at = now() - interval '1 minute' where id = $1`,
      [order.order_id],
    );
    await runSql(
      `update public.stock_reservations
          set starts_at = now() - interval '10 minutes', expires_at = now() - interval '1 minute'
        where order_id = $1 and status = 'active'`,
      [order.order_id],
    );

    const released = await sqlValue<number>(`select public.expire_overdue_reservations(null)`);
    expect(Number(released)).toBe(4);

    const row = await runSql<{ status: string }>(`select status from public.orders where id = $1`, [
      order.order_id,
    ]);
    expect(row[0].status).toBe('expired');

    expect(await stockState(first.productId)).toEqual([{ status: 'available', count: 3 }]);
    expect(await stockState(second.productId)).toEqual([{ status: 'available', count: 2 }]);
  });

  it('G4 — tentativa encerrada sem pagamento devolve o estoque de cada item', async () => {
    const { first, second } = await twoSeeds({ first: 2, second: 2 });
    const { order } = await createMulti([
      { product_id: first.productId, quantity: 1 },
      { product_id: second.productId, quantity: 1 },
    ]);

    await runSql(`select public.release_order_reservation($1, 'released')`, [order.order_id]);

    const row = await sqlValue<string>(`select status from public.orders where id = $1`, [
      order.order_id,
    ]);
    expect(row).toBe('failed');

    expect(await stockState(first.productId)).toEqual([{ status: 'available', count: 2 }]);
    expect(await stockState(second.productId)).toEqual([{ status: 'available', count: 2 }]);
  });

  it('G4 — nova tentativa depois de expirar cria pedido novo, sem duplicar o antigo', async () => {
    const seed = await seedProduct({ stockUnits: 2 });
    const first = await createMulti([{ product_id: seed.productId, quantity: 1 }]);
    await runSql(`select public.release_order_reservation($1, 'expired')`, [first.order.order_id]);

    const second = await createMulti([{ product_id: seed.productId, quantity: 1 }]);
    expect(second.order.order_id).not.toBe(first.order.order_id);

    const orders = await sqlValue<number>(
      `select count(*)::int from public.orders where product_id = $1`,
      [seed.productId],
    );
    expect(Number(orders)).toBe(2);

    const active = await sqlValue<number>(
      `select count(*)::int from public.stock_reservations where order_id = $1 and status = 'active'`,
      [second.order.order_id],
    );
    expect(Number(active)).toBe(1);
  });
});

describe('entrega digital multi-produto', () => {
  beforeAll(async () => {
    await resetDatabase();
  }, 60000);

  it('G6/G8 — confirmação gera UMA entrega com todos os itens e todas as unidades', async () => {
    await setInternalConfirmation(true);
    try {
      const { first, second } = await twoSeeds({ first: 3, second: 2 });
      const { order, tokenHash } = await createMulti([
        { product_id: first.productId, quantity: 2 },
        { product_id: second.productId, quantity: 1 },
      ]);

      const token = newDeliveryToken();
      await confirmInternal(order.order_id, tokenHash, token);

      const deliveries = await runSql<{ id: string; status: string }>(
        `select id, status from public.deliveries where order_id = $1`,
        [order.order_id],
      );
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].status).toBe('active');

      const units = await sqlValue<number>(
        `select count(*)::int from public.delivery_units where delivery_id = $1`,
        [deliveries[0].id],
      );
      expect(Number(units)).toBe(3);

      const sold = await sqlValue<number>(
        `select count(*)::int from public.stock_units where sold_order_id = $1 and status = 'sold'`,
        [order.order_id],
      );
      expect(Number(sold)).toBe(3);

      // Toda unidade entregue pertence a um produto do pedido.
      const foreign = await sqlValue<number>(
        `select count(*)::int
           from public.delivery_units du
           join public.stock_units su on su.id = du.stock_unit_id
          where du.delivery_id = $1
            and su.product_id not in (select product_id from public.order_items where order_id = $2)`,
        [deliveries[0].id, order.order_id],
      );
      expect(Number(foreign)).toBe(0);
    } finally {
      await setInternalConfirmation(false);
    }
  });

  it('G6/G9 — acesso privado devolve vários produtos na mesma entrega', async () => {
    await setInternalConfirmation(true);
    try {
      const { first, second } = await twoSeeds({ first: 3, second: 2 });
      const { order, tokenHash } = await createMulti([
        { product_id: first.productId, quantity: 2 },
        { product_id: second.productId, quantity: 1 },
      ]);

      const token = newDeliveryToken();
      await confirmInternal(order.order_id, tokenHash, token);

      const rows = await runSql<{ result: DeliveryPayload }>(
        `select public.resolve_delivery($1) as result`,
        [token.hash],
      );
      const payload = rows[0].result;

      expect(payload.reference).toBe(order.reference);
      expect(payload.items_count).toBe(2);
      expect(payload.items).toHaveLength(2);

      const firstGroup = payload.items.find((item) => item.product_id === first.productId)!;
      const secondGroup = payload.items.find((item) => item.product_id === second.productId)!;
      expect(firstGroup.quantity).toBe(2);
      expect(firstGroup.units).toHaveLength(2);
      expect(secondGroup.quantity).toBe(1);
      expect(secondGroup.units).toHaveLength(1);

      // Cada grupo traz o próprio nome, instruções e validade.
      expect(firstGroup.product_name).toContain('Produto');
      expect(firstGroup.instructions).toBe('Instruções de uso');
      expect(firstGroup.access_validity_label).toBe('30 dias');

      // Compatibilidade: `product` e `units` continuam preenchidos.
      expect(payload.product.id).toBe(payload.items[0].product_id);
      expect(payload.units).toHaveLength(3);

      // Nenhuma credencial em claro no payload.
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain('conta0@exemplo.com');
      expect(serialized).not.toContain('senha-0');
    } finally {
      await setInternalConfirmation(false);
    }
  });

  it('G7 — entrega só existe depois de pagamento aprovado; código inválido não acessa', async () => {
    const seed = await seedProduct({ stockUnits: 2 });
    const { order } = await createMulti([{ product_id: seed.productId, quantity: 1 }]);

    const deliveries = await sqlValue<number>(
      `select count(*)::int from public.deliveries where order_id = $1`,
      [order.order_id],
    );
    expect(Number(deliveries)).toBe(0);

    const token = newDeliveryToken();
    await expect(
      runSql(`select public.create_order_delivery($1, $2, $3)`, [
        order.order_id,
        token.hash,
        token.enc,
      ]),
    ).rejects.toMatchObject({ message: expect.stringContaining('order_not_deliverable') });

    await expect(
      runSql(`select public.resolve_delivery($1)`, [sha256Hex(randomToken())]),
    ).rejects.toMatchObject({ code: 'P0002' });

    await expect(
      runSql(`select public.resolve_delivery($1)`, ['nao-e-um-hash']),
    ).rejects.toMatchObject({ code: 'P0002' });
  });

  it('G8 — falta de estoque para um item bloqueia a entrega inteira', async () => {
    await setInternalConfirmation(true);
    try {
      const first = await seedProduct({ stockUnits: 1 });
      const second = await seedProduct({ stockUnits: 1 });

      const { order, tokenHash } = await createMulti([
        { product_id: first.productId, quantity: 1 },
        { product_id: second.productId, quantity: 1 },
      ]);

      // A reserva vence; outra compra leva a última unidade do segundo produto.
      await runSql(`select public.release_order_reservation($1, 'expired')`, [order.order_id]);

      const other = await createMulti([{ product_id: second.productId, quantity: 1 }]);
      expect(other.order.status).toBe('pending_payment');

      // Pagamento aprovado chega depois: sem estoque do segundo item.
      const result = await runSql<{ result: { result: string; order_status: string } }>(
        `select public.apply_payment_status($1, 'LATE-1', 'approved', 'late', $2, $3, $4) as result`,
        [order.order_id, order.total_cents, newDeliveryToken().hash, fakeCiphertextB64('late')],
      );

      expect(result[0].result.result).toBe('approved_without_stock');
      expect(result[0].result.order_status).toBe('refund_pending');

      // Nenhuma entrega parcial e nenhuma venda do primeiro item.
      const deliveries = await sqlValue<number>(
        `select count(*)::int from public.deliveries where order_id = $1`,
        [order.order_id],
      );
      expect(Number(deliveries)).toBe(0);

      const soldFirst = await sqlValue<number>(
        `select count(*)::int from public.stock_units where product_id = $1 and status <> 'available'`,
        [first.productId],
      );
      expect(Number(soldFirst)).toBe(0);

      // A unidade do primeiro produto continua livre para outra compra.
      expect(await stockState(first.productId)).toEqual([{ status: 'available', count: 1 }]);
      void tokenHash;
    } finally {
      await setInternalConfirmation(false);
    }
  });

  it('G8 — revogação bloqueia todos os produtos do pedido', async () => {
    await setInternalConfirmation(true);
    try {
      const { first, second } = await twoSeeds({ first: 2, second: 2 });
      const { order, tokenHash } = await createMulti([
        { product_id: first.productId, quantity: 1 },
        { product_id: second.productId, quantity: 1 },
      ]);

      const token = newDeliveryToken();
      await confirmInternal(order.order_id, tokenHash, token);

      const deliveryId = await sqlValue<string>(
        `select id from public.deliveries where order_id = $1`,
        [order.order_id],
      );

      await runSql(`update public.deliveries set status = 'revoked', revoked_at = now() where id = $1`, [
        deliveryId,
      ]);
      await runSql(`update public.orders set delivery_status = 'revoked' where id = $1`, [
        order.order_id,
      ]);

      await expect(
        runSql(`select public.resolve_delivery($1)`, [token.hash]),
      ).rejects.toMatchObject({ message: expect.stringContaining('delivery_revoked') });

      // O helper de itens aplica a mesma guarda.
      await expect(
        runSql(`select public.delivery_items_json($1)`, [deliveryId]),
      ).rejects.toMatchObject({ message: expect.stringContaining('delivery_revoked') });
    } finally {
      await setInternalConfirmation(false);
    }
  });

  it('G8 — recuperação depois de interrupção não cria segunda entrega', async () => {
    await setInternalConfirmation(true);
    try {
      const seed = await seedProduct({ stockUnits: 2 });
      const { order, tokenHash } = await createMulti([{ product_id: seed.productId, quantity: 1 }]);

      const token = newDeliveryToken();
      await confirmInternal(order.order_id, tokenHash, token);

      // Simula a interrupção: pedido pago e pronto, mas entrega apagada pelo
      // operador do teste antes do link ser gravado (estado recuperável).
      await runSql(`delete from public.deliveries where order_id = $1`, [order.order_id]);

      const replayToken = newDeliveryToken();
      const replay = await runSql<{ result: { result: string } }>(
        `select public.apply_payment_status($1, 'INTERNAL-REC', 'approved', 'recover', $2, $3, $4) as result`,
        [order.order_id, order.total_cents, replayToken.hash, replayToken.enc],
      );
      expect(replay[0].result.result).toBe('already_applied');

      const deliveries = await sqlValue<number>(
        `select count(*)::int from public.deliveries where order_id = $1`,
        [order.order_id],
      );
      expect(Number(deliveries)).toBe(1);

      const units = await sqlValue<number>(
        `select count(*)::int from public.delivery_units du
           join public.deliveries d on d.id = du.delivery_id
          where d.order_id = $1`,
        [order.order_id],
      );
      expect(Number(units)).toBe(1);

      const events = await sqlValue<number>(
        `select count(*)::int from public.order_events
          where order_id = $1 and event_type in ('delivery_created', 'delivery_recovered')`,
        [order.order_id],
      );
      expect(Number(events)).toBeGreaterThanOrEqual(2);
    } finally {
      await setInternalConfirmation(false);
    }
  });
});

describe('garantias estruturais da entrega', () => {
  beforeAll(async () => {
    await resetDatabase();
  }, 60000);

  it('G7 — o mesmo pedido nunca recebe uma segunda entrega', async () => {
    await setInternalConfirmation(true);
    try {
      const seed = await seedProduct({ stockUnits: 2 });
      const { order, tokenHash } = await createMulti([{ product_id: seed.productId, quantity: 1 }]);

      const first = newDeliveryToken();
      await confirmInternal(order.order_id, tokenHash, first);

      // Chamada direta ao criador de entrega para o pedido já entregue devolve
      // a entrega existente em vez de criar outra.
      const second = newDeliveryToken();
      const again = await runSql<{ result: { delivery_id: string; created: boolean } }>(
        `select public.create_order_delivery($1, $2, $3) as result`,
        [order.order_id, second.hash, second.enc],
      );
      expect(again[0].result.created).toBe(false);

      const count = await sqlValue<number>(
        `select count(*)::int from public.deliveries where order_id = $1`,
        [order.order_id],
      );
      expect(Number(count)).toBe(1);
    } finally {
      await setInternalConfirmation(false);
    }
  });

  it('G6 — a mesma unidade física não entra em duas entregas', async () => {
    await setInternalConfirmation(true);
    try {
      const first = await seedProduct({ stockUnits: 1 });
      const second = await seedProduct({ stockUnits: 1 });

      const orderA = await createMulti([{ product_id: first.productId, quantity: 1 }]);
      const orderB = await createMulti([{ product_id: second.productId, quantity: 1 }]);

      const tokenA = newDeliveryToken();
      const tokenB = newDeliveryToken();
      await confirmInternal(orderA.order.order_id, orderA.tokenHash, tokenA);
      await confirmInternal(orderB.order.order_id, orderB.tokenHash, tokenB);

      const deliveryA = await sqlValue<string>(
        `select id from public.deliveries where order_id = $1`,
        [orderA.order.order_id],
      );
      const unitA = await sqlValue<string>(
        `select stock_unit_id from public.delivery_units where delivery_id = $1`,
        [deliveryA],
      );

      // Tentar entregar a unidade do pedido A no pedido B é recusado pelo banco.
      await expect(
        runSql(
          `insert into public.delivery_units (delivery_id, stock_unit_id)
           select d.id, $2 from public.deliveries d where d.order_id = $1`,
          [orderB.order.order_id, unitA],
        ),
      ).rejects.toMatchObject({ code: '23505' });

      const duplicated = await sqlValue<number>(
        `select count(*)::int from (
           select stock_unit_id from public.delivery_units
            group by stock_unit_id having count(*) > 1
         ) duplicated`,
      );
      expect(Number(duplicated)).toBe(0);
    } finally {
      await setInternalConfirmation(false);
    }
  });

  it('G10 — pedido de um produto e uma unidade percorre a jornada inteira', async () => {
    await setInternalConfirmation(true);
    try {
      const seed = await seedProduct({ stockUnits: 1 });
      const { order, tokenHash } = await createMulti([{ product_id: seed.productId, quantity: 1 }]);

      expect(order.items_count).toBe(1);
      expect(order.quantity).toBe(1);

      const token = newDeliveryToken();
      const confirmed = await confirmInternal(order.order_id, tokenHash, token);
      expect(confirmed.result.result).toBe('approved');

      const payload = await runSql<{ result: DeliveryPayload }>(
        `select public.resolve_delivery($1) as result`,
        [token.hash],
      );
      expect(payload[0].result.items).toHaveLength(1);
      expect(payload[0].result.items[0].units).toHaveLength(1);
      expect(payload[0].result.items[0].quantity).toBe(1);
      expect(payload[0].result.items_count).toBe(1);

      const stock = await stockState(seed.productId);
      expect(stock).toEqual([{ status: 'sold', count: 1 }]);
    } finally {
      await setInternalConfirmation(false);
    }
  });
});

describe('compatibilidade e proteção', () => {
  beforeAll(async () => {
    await resetDatabase();
  }, 60000);

  it('G8 — pedido de um produto (fluxo antigo) continua entregando como antes', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    const clientToken = randomToken();
    const tokenHash = sha256Hex(clientToken);
    const created = await runSql<{ result: { order_id: string; total_cents: number } }>(
      `select public.create_order($1, 1, null, $2) as result`,
      [seed.productId, tokenHash],
    );
    const orderId = created[0].result.order_id;

    const token = newDeliveryToken();
    await runSql(`select public.apply_payment_status($1, 'MP-1', 'approved', 'ok', $2, $3, $4)`, [
      orderId,
      created[0].result.total_cents,
      token.hash,
      token.enc,
    ]);

    const rows = await runSql<{ result: DeliveryPayload }>(
      `select public.resolve_delivery($1) as result`,
      [token.hash],
    );
    expect(rows[0].result.items).toHaveLength(1);
    expect(rows[0].result.items[0].units).toHaveLength(1);
    expect(rows[0].result.units).toHaveLength(1);
    expect(rows[0].result.product.name).toContain('Produto');
  });

  it('G8 — pedido sem itens (legado) também usa a alocação tardia por item', async () => {
    const seed = await seedProduct({ stockUnits: 2 });
    const tokenHash = sha256Hex(randomToken());
    const created = await runSql<{ result: { order_id: string; total_cents: number } }>(
      `select public.create_order($1, 1, null, $2) as result`,
      [seed.productId, tokenHash],
    );

    // Reserva vence, unidade volta para disponível, pagamento chega depois.
    await runSql(`update public.stock_reservations
                     set starts_at = now() - interval '10 minutes',
                         expires_at = now() - interval '1 minute'
                   where order_id = $1 and status = 'active'`, [created[0].result.order_id]);

    const token = newDeliveryToken();
    const applied = await runSql<{ result: { result: string } }>(
      `select public.apply_payment_status($1, 'MP-LATE', 'approved', 'late', $2, $3, $4) as result`,
      [created[0].result.order_id, created[0].result.total_cents, token.hash, token.enc],
    );
    expect(applied[0].result.result).toBe('approved');

    const sold = await sqlValue<number>(
      `select count(*)::int from public.stock_units where sold_order_id = $1`,
      [created[0].result.order_id],
    );
    expect(Number(sold)).toBe(1);
  });

  it('G5 — funções novas não são executáveis por anon nem por authenticated', async () => {
    const signatures = [
      'public.create_order_multi(jsonb, text, text)',
      'public.reserve_stock_units_multi(uuid, jsonb, timestamptz)',
      'public.create_order_delivery(uuid, text, text)',
      'public.internal_confirm_payment(uuid, text, text, text)',
      'public.allocate_late_units_multi(uuid, jsonb)',
      'public.allocate_late_units_for_order(uuid)',
      'public.delivery_items_json(uuid)',
      'public.order_items_json(uuid)',
      'public.order_required_units(public.orders)',
      'public.order_summary_multi(public.orders)',
      'public.order_stored_items_json(uuid)',
      'public.parse_request_items(jsonb, integer)',
      'public.resolve_delivery(text)',
    ];

    for (const signature of signatures) {
      const grants = await runSql<{ grantee: string }>(
        `select grantee
           from unnest(array['anon', 'authenticated']) as g(grantee)
          where has_function_privilege(g.grantee, $1::regprocedure, 'execute')`,
        [signature],
      );
      expect(grants, `${signature} não pode ser executável por visitante`).toEqual([]);
    }
  });

  it('G5 — anon não executa a confirmação interna nem cria pedido multi-item', async () => {
    const seed = await seedProduct({ stockUnits: 1 });

    await expect(
      runAs(`select public.create_order_multi($1, null, $2)`, [
        JSON.stringify([{ product_id: seed.productId, quantity: 1 }]),
        sha256Hex(randomToken()),
      ], { role: 'anon' }),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      runAs(`select public.internal_confirm_payment($1, $2, $3, $4)`, [
        '00000000-0000-4000-8000-000000000000',
        sha256Hex(randomToken()),
        sha256Hex(randomToken()),
        fakeCiphertextB64('x'),
      ], { role: 'anon' }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('G5 — pedidos com pagamento not_required nunca geram entrega', async () => {
    const seed = await seedProduct({ stockUnits: 2 });
    const rows = await runSql<{ result: { order: { order_id: string } } }>(
      `select public.create_purchase_request($1, 'Maria Souza', 'maria@exemplo.com', $2, null) as result`,
      [JSON.stringify([{ product_id: seed.productId, quantity: 1 }]), sha256Hex(randomToken())],
    );
    const orderId = rows[0].result.order.order_id;

    // Nem a expiração automática, nem a confirmação interna, nem o núcleo de
    // pagamento transformam uma solicitação em venda.
    await runSql(`select public.expire_overdue_reservations(null)`);
    await runSql(`update public.app_settings set value = 'true'::jsonb
                   where key = 'internal_confirmation_enabled'`);
    try {
      await expect(
        runSql(`select public.internal_confirm_payment($1, $2, $3, $4)`, [
          orderId,
          sha256Hex(randomToken()),
          sha256Hex(randomToken()),
          fakeCiphertextB64('x'),
        ]),
      ).rejects.toMatchObject({ message: expect.stringContaining('order_not_found') });
    } finally {
      await runSql(`update public.app_settings set value = 'false'::jsonb
                     where key = 'internal_confirmation_enabled'`);
    }

    const state = await runSql<{ status: string; payment_status: string; delivery_status: string }>(
      `select status, payment_status, delivery_status from public.orders where id = $1`,
      [orderId],
    );
    expect(state[0]).toMatchObject({
      status: 'requested',
      payment_status: 'not_required',
      delivery_status: 'not_ready',
    });

    const deliveries = await sqlValue<number>(
      `select count(*)::int from public.deliveries where order_id = $1`,
      [orderId],
    );
    expect(Number(deliveries)).toBe(0);

    const reservations = await sqlValue<number>(
      `select count(*)::int from public.stock_reservations where order_id = $1`,
      [orderId],
    );
    expect(Number(reservations)).toBe(0);
  });

  it('G5 — eventos registram o processamento automatizado', async () => {
    await setInternalConfirmation(true);
    try {
      const { first, second } = await twoSeeds({ first: 2, second: 2 });
      const { order, tokenHash } = await createMulti([
        { product_id: first.productId, quantity: 1 },
        { product_id: second.productId, quantity: 1 },
      ]);
      await confirmInternal(order.order_id, tokenHash);

      const events = await runSql<{ event_type: string }>(
        `select event_type from public.order_events where order_id = $1 order by id`,
        [order.order_id],
      );
      const types = events.map((row) => row.event_type);
      expect(types).toContain('order_created');
      expect(types).toContain('payment_approved');
      expect(types).toContain('delivery_created');
    } finally {
      await setInternalConfirmation(false);
    }
  });

  it('G5 — nenhuma mensagem de erro carrega credencial ou ciphertext', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    const { order } = await createMulti([{ product_id: seed.productId, quantity: 1 }]);

    try {
      await runSql(`select public.create_order_delivery($1, $2, $3)`, [
        order.order_id,
        sha256Hex(randomToken()),
        fakeCiphertextB64('token'),
      ]);
      throw new Error('deveria ter falhado');
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).toContain('order_not_deliverable');
      expect(message).not.toContain('conta0');
      expect(message).not.toContain('senha');
    }
  });
});
