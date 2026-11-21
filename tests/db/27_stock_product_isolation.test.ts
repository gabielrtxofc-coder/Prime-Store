import { randomBytes } from 'node:crypto';
import type { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleAdminApi } from '../../supabase/functions/_shared/handlers/adminApi';
import type { Deps } from '../../supabase/functions/_shared/deps';
import { toBase64 } from '../../supabase/functions/_shared/crypto';
import {
  connect,
  createOrder,
  fakeCiphertextB64,
  hmacHex,
  randomToken,
  RELAXED_RATE_LIMIT_OVERRIDES,
  resetDatabase,
  runAs,
  runSql,
  seedAdmin,
  seedProduct,
  seedStockUnit,
  sha256Hex,
  sqlValue,
} from './helpers';
import { createPgRpc } from './pgRpc';

/**
 * Missão 13 — isolamento de estoque por produto (migração 20261121225011).
 *
 * O que esta suíte comprova (banco como fonte de verdade):
 *  - `stock_product_matches_order` cobre pedido multiproduto (order_items) e
 *    pedido no formato antigo (orders.product_id);
 *  - o gatilho de `stock_units` rejeita lote de importação de outro produto e
 *    venda (sold_order_id) de pedido que não contém o produto — em INSERT e
 *    em UPDATE;
 *  - o gatilho de `stock_reservation_units` rejeita unidade de outro produto
 *    na reserva;
 *  - o gatilho de `delivery_units` rejeita unidade de outro produto na
 *    entrega;
 *  - casos válidos (mesmo produto) continuam funcionando, inclusive pedido
 *    multiproduto e pedido antigo;
 *  - `admin_stock_summary_by_product` lista todos os produtos (inclusive sem
 *    estoque), com contagens, saúde empty/low/ok e totais coerentes — apenas
 *    para administrador; usuário autenticado comum e anon são recusados;
 *  - o gateway HTTP `stock.summary` expõe o resumo por produto.
 */

const MASTER_KEY = toBase64(randomBytes(32));

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function fakeAuth(userId: string | null): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/auth/v1/user')) {
      return userId
        ? new Response(JSON.stringify({ id: userId }), { status: 200 })
        : new Response(JSON.stringify({ message: 'invalid jwt' }), { status: 401 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

function buildDeps(client: Client, adminId: string | null): Deps {
  const userRpc = adminId
    ? createPgRpc(client, {
        role: 'authenticated',
        claims: { sub: adminId, role: 'authenticated', aal: 'aal2' },
      })
    : createPgRpc(client);
  return {
    config: {
      supabaseUrl: 'https://fake-project.supabase.test',
      serviceRoleKey: 'service-role-key',
      anonKey: 'anon-key',
      encryptionKey: MASTER_KEY,
      storeUrl: 'http://localhost:5173',
      rateLimitOverrides: RELAXED_RATE_LIMIT_OVERRIDES,
    },
    rpc: createPgRpc(client),
    rpcForUser: () => userRpc,
    serviceRpc: createPgRpc(client),
    resolveEncryptionKey: async () => MASTER_KEY,
    fetchImpl: fakeAuth(adminId),
    now: () => new Date(),
    log: () => undefined,
  };
}

async function insertUnit(productId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const email = `conta-${randomToken(6)}@exemplo.com`;
  const rows = await runSql<{ id: string }>(
    `insert into public.stock_units (product_id, account_email_enc, account_password_enc, credential_fingerprint, status, sold_order_id, sold_at, import_batch_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      productId,
      fakeCiphertextB64(email),
      fakeCiphertextB64('senha'),
      hmacHex('test-fingerprint-key', email),
      overrides.status ?? 'available',
      overrides.sold_order_id ?? null,
      overrides.sold_at ?? null,
      overrides.import_batch_id ?? null,
    ],
  );
  return rows[0].id;
}

async function createBatch(productId: string): Promise<string> {
  return sqlValue<string>(
    `insert into public.import_batches (product_id, file_name) values ($1, 'lote.csv') returning id`,
    [productId],
  );
}

describe('Missão 13 — isolamento de estoque por produto (migração 20261121225011)', () => {
  let client: Client;
  let adminId: string;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
    adminId = await seedAdmin('admin');
  }, 60000);

  const asAdmin = (sql: string, values: unknown[] = []) =>
    runAs(sql, values, { role: 'authenticated', claims: { sub: adminId, role: 'authenticated', aal: 'aal2' } });

  const asPlainUser = async (): Promise<string> => {
    const userId = (
      await runSql<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [
        `user-${randomToken(6)}@prime.invalid`,
      ])
    )[0].id;
    return userId;
  };

  // -------------------------------------------------------------------------
  // stock_product_matches_order: multiproduto e formato antigo
  // -------------------------------------------------------------------------
  it('stock_product_matches_order cobre pedido multiproduto e pedido antigo', async () => {
    const productA = await seedProduct({ stockUnits: 2 });
    const productB = await seedProduct({ stockUnits: 1 });
    const productC = await seedProduct();

    // Pedido antigo (orders.product_id)
    const legacy = await createOrder(productA.productId, 1);
    expect(await sqlValue<boolean>(`select public.stock_product_matches_order($1, $2)`, [legacy.order.order_id, productA.productId])).toBe(true);
    expect(await sqlValue<boolean>(`select public.stock_product_matches_order($1, $2)`, [legacy.order.order_id, productB.productId])).toBe(false);

    // Pedido multiproduto com A e B
    const multi = await runSql<{ result: { order_id: string } }>(
      `select public.create_order_multi($1, null, $2) as result`,
      [
        JSON.stringify([
          { product_id: productA.productId, quantity: 1 },
          { product_id: productB.productId, quantity: 1 },
        ]),
        sha256Hex(randomToken()),
      ],
    );
    const multiId = multi[0].result.order_id;
    expect(await sqlValue<boolean>(`select public.stock_product_matches_order($1, $2)`, [multiId, productA.productId])).toBe(true);
    expect(await sqlValue<boolean>(`select public.stock_product_matches_order($1, $2)`, [multiId, productB.productId])).toBe(true);
    expect(await sqlValue<boolean>(`select public.stock_product_matches_order($1, $2)`, [multiId, productC.productId])).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Gatilho de stock_units: lote de importação e pedido de venda
  // -------------------------------------------------------------------------
  it('rejeita unidade vinculada a lote de outro produto (INSERT e UPDATE)', async () => {
    const productA = await seedProduct();
    const productB = await seedProduct();
    const batchA = await createBatch(productA.productId);

    await expect(insertUnit(productB.productId, { import_batch_id: batchA })).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('stock_import_product_mismatch'),
    });

    // Caso válido: lote e unidade do mesmo produto.
    const unitId = await insertUnit(productA.productId, { import_batch_id: batchA });
    expect(await sqlValue<string>(`select import_batch_id::text from public.stock_units where id = $1`, [unitId])).toBe(batchA);

    // UPDATE para trocar o produto com o lote antigo também é rejeitado.
    const batchB = await createBatch(productB.productId);
    await expect(
      runSql(`update public.stock_units set product_id = $1 where id = $2`, [productB.productId, unitId]),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('stock_import_product_mismatch') });
    expect(await sqlValue<string>(`select product_id::text from public.stock_units where id = $1`, [unitId])).toBe(productA.productId);
    expect(batchB).toBeTruthy();
  });

  it('rejeita venda (sold_order_id) de pedido que não contém o produto (INSERT e UPDATE)', async () => {
    const productA = await seedProduct({ stockUnits: 1 });
    const productB = await seedProduct();
    const orderA = await createOrder(productA.productId, 1);

    // INSERT: unidade do produto B marcada como vendida no pedido de A.
    await expect(
      insertUnit(productB.productId, {
        status: 'sold',
        sold_order_id: orderA.order.order_id,
        sold_at: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('stock_unit_order_product_mismatch') });

    // INSERT válido: unidade do produto A vendida no pedido de A.
    const soldUnit = await insertUnit(productA.productId, {
      status: 'sold',
      sold_order_id: orderA.order.order_id,
      sold_at: new Date().toISOString(),
    });
    expect(soldUnit).toBeTruthy();

    // UPDATE: trocar o produto da unidade vendida também é rejeitado.
    await expect(
      runSql(`update public.stock_units set product_id = $1 where id = $2`, [productB.productId, soldUnit]),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('stock_unit_order_product_mismatch') });
  });

  // -------------------------------------------------------------------------
  // Gatilho de stock_reservation_units
  // -------------------------------------------------------------------------
  it('rejeita reserva com unidade de outro produto (INSERT e UPDATE)', async () => {
    const productA = await seedProduct({ stockUnits: 2 });
    const productB = await seedProduct({ stockUnits: 1 });
    const orderA = await createOrder(productA.productId, 1);

    const reservationId = await sqlValue<string>(
      `select id from public.stock_reservations where order_id = $1 and status = 'active'`,
      [orderA.order.order_id],
    );
    expect(reservationId).toBeTruthy();

    const unitB = productB.units[0];
    await expect(
      runSql(`insert into public.stock_reservation_units (reservation_id, stock_unit_id) values ($1, $2)`, [
        reservationId,
        unitB,
      ]),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('stock_reservation_product_mismatch') });

    // UPDATE trocando a unidade da reserva também é rejeitado.
    const ownUnit = await sqlValue<string>(
      `select stock_unit_id from public.stock_reservation_units where reservation_id = $1`,
      [reservationId],
    );
    await expect(
      runSql(`update public.stock_reservation_units set stock_unit_id = $1 where reservation_id = $2`, [
        unitB,
        reservationId,
      ]),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('stock_reservation_product_mismatch') });
    expect(
      await sqlValue<string>(`select stock_unit_id::text from public.stock_reservation_units where reservation_id = $1`, [
        reservationId,
      ]),
    ).toBe(ownUnit);
  });

  it('pedido multiproduto reserva unidades dos produtos corretos', async () => {
    const productA = await seedProduct({ stockUnits: 1 });
    const productB = await seedProduct({ stockUnits: 1 });
    const multi = await runSql<{ result: { order_id: string } }>(
      `select public.create_order_multi($1, null, $2) as result`,
      [
        JSON.stringify([
          { product_id: productA.productId, quantity: 1 },
          { product_id: productB.productId, quantity: 1 },
        ]),
        sha256Hex(randomToken()),
      ],
    );
    const orderId = multi[0].result.order_id;
    const rows = await runSql<{ product_id: string }>(
      `select su.product_id
         from public.stock_reservation_units sru
         join public.stock_units su on su.id = sru.stock_unit_id
        where sru.reservation_id = (select id from public.stock_reservations where order_id = $1)`,
      [orderId],
    );
    expect(rows.map((row) => row.product_id).sort()).toEqual([productA.productId, productB.productId].sort());
  });

  // -------------------------------------------------------------------------
  // Gatilho de delivery_units
  // -------------------------------------------------------------------------
  it('rejeita entrega com unidade de outro produto (INSERT e UPDATE)', async () => {
    await runSql(`update public.app_settings set value = 'true'::jsonb where key = 'internal_confirmation_enabled'`);
    const productA = await seedProduct({ stockUnits: 1 });
    const productB = await seedProduct({ stockUnits: 1 });
    const orderA = await createOrder(productA.productId, 1);

    const deliveryToken = randomToken(32);
    await runSql(`select public.internal_confirm_payment($1, $2, $3, $4)`, [
      orderA.order.order_id,
      orderA.tokenHash,
      sha256Hex(deliveryToken),
      fakeCiphertextB64('token'),
    ]);

    const deliveryId = await sqlValue<string>(`select id from public.deliveries where order_id = $1`, [
      orderA.order.order_id,
    ]);
    expect(deliveryId).toBeTruthy();

    const unitB = productB.units[0];
    await expect(
      runSql(`insert into public.delivery_units (delivery_id, stock_unit_id) values ($1, $2)`, [deliveryId, unitB]),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('delivery_unit_product_mismatch') });

    // UPDATE trocando a unidade entregue também é rejeitado.
    await expect(
      runSql(`update public.delivery_units set stock_unit_id = $1 where delivery_id = $2`, [unitB, deliveryId]),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('delivery_unit_product_mismatch') });

    // A entrega válida (produto do pedido) continua intacta.
    const linked = await sqlValue<string>(
      `select stock_unit_id::text from public.delivery_units where delivery_id = $1`,
      [deliveryId],
    );
    expect(linked).toBe(productA.units[0]);
  });

  // -------------------------------------------------------------------------
  // admin_stock_summary_by_product
  // -------------------------------------------------------------------------
  it('resumo por produto: todos os produtos, contagens, saúde e totais (admin)', async () => {
    const empty = await seedProduct(); // sem estoque
    const low = await seedProduct({ stockUnits: 2 });
    const ok = await seedProduct({ stockUnits: 3 });
    const disabled = await seedProduct({ stockUnits: 1 });
    await runSql(`update public.stock_units set status = 'disabled', status_reason = 'data_correction', status_reason_note = 'teste' where product_id = $1`, [disabled.productId]);

    const summary = JSON.parse(
      (await asAdmin(`select public.admin_stock_summary_by_product()::text as result`))[0].result as string,
    ) as {
      products: Array<Record<string, unknown>>;
      totals: Record<string, number>;
    };

    // Todos os produtos aparecem, inclusive os sem nenhuma credencial.
    const ids = summary.products.map((p) => p.product_id);
    expect(ids).toEqual(expect.arrayContaining([empty.productId, low.productId, ok.productId, disabled.productId]));

    const byId = Object.fromEntries(summary.products.map((p) => [p.product_id, p]));
    expect(byId[empty.productId]).toMatchObject({
      total_units: 0, available_units: 0, reserved_units: 0, sold_units: 0, disabled_units: 0,
      stock_health: 'empty', last_restocked_at: null,
    });
    expect(byId[low.productId]).toMatchObject({ available_units: 2, stock_health: 'low' });
    expect(byId[ok.productId]).toMatchObject({ available_units: 3, stock_health: 'ok' });
    expect(byId[disabled.productId]).toMatchObject({ disabled_units: 1, available_units: 0, stock_health: 'empty' });

    // Totais gerais = soma dos produtos.
    const sumAvailable = summary.products.reduce((acc, p) => acc + (p.available_units as number), 0);
    const sumTotal = summary.products.reduce((acc, p) => acc + (p.total_units as number), 0);
    expect(summary.totals.available_units).toBe(sumAvailable);
    expect(summary.totals.total_units).toBe(sumTotal);
    expect(summary.totals.disabled_units).toBe(
      summary.products.reduce((acc, p) => acc + (p.disabled_units as number), 0),
    );
  });

  it('resumo por produto é recusado para usuário autenticado sem permissão e para anon', async () => {
    const plainUserId = await asPlainUser();

    await expect(
      runAs(`select public.admin_stock_summary_by_product()`, [], {
        role: 'authenticated',
        claims: { sub: plainUserId, role: 'authenticated', aal: 'aal2' },
      }),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('not_admin') });

    await expect(runAs(`select public.admin_stock_summary_by_product()`, [], { role: 'anon' })).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('gateway HTTP stock.summary devolve o resumo por produto para o admin', async () => {
    const product = await seedProduct({ stockUnits: 1 });
    const deps = buildDeps(client, adminId);
    const response = await handleAdminApi(
      postJson('https://fake-project.supabase.test/functions/v1/admin-api', {
        action: 'stock.summary',
        payload: {},
      }, { Authorization: `Bearer token-${adminId}` }),
      deps,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      products: Array<Record<string, unknown>>;
      totals: Record<string, number>;
    };
    expect(Array.isArray(body.products)).toBe(true);
    expect(body.products.find((p) => p.product_id === product.productId)).toMatchObject({
      available_units: 1,
      stock_health: 'low',
    });
    expect(body.totals.total_units).toBeGreaterThanOrEqual(1);
  });
});
