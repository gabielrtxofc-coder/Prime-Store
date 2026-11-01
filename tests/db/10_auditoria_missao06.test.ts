import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import type { Deps } from '../../supabase/functions/_shared/deps';
import { handleCatalog } from '../../supabase/functions/_shared/handlers/catalog';
import { handleCreateOrder } from '../../supabase/functions/_shared/handlers/createOrder';
import { handleDemoPayment } from '../../supabase/functions/_shared/handlers/demoPayment';
import { createFakeMercadoPago } from '../unit/fakeMp';
import { connect, createOrder, resetDatabase, runSql, seedProduct, sha256Hex, sqlValue, RELAXED_RATE_LIMIT_OVERRIDES } from './helpers';
import { createPgRpc } from './pgRpc';

/**
 * Missão 06 — auditoria independente.
 *
 * Regressões encontradas e corrigidas nesta revisão, verificadas no handler
 * HTTP contra PostgreSQL real (os testes anteriores não cobriam estes casos):
 *
 *  1. o catálogo anunciava disponibilidade ignorando reservas vencidas, e o
 *     botão de compra escondido impedia o cliente de destravar o estoque;
 *  2. o replay idempotente de um pedido ENCERRADO respondia `200`, o que o
 *     navegador interpretava como checkout vivo (carrinho limpo + tela morta);
 *  3. `demo-payment` anunciava `demo_enabled` só pelo segredo do ambiente,
 *     ignorando a chave do banco.
 */

let client: Client;
/** Um único provedor simulado por arquivo: os ids gerados precisam ser únicos. */
const mercadoPago = createFakeMercadoPago();

function buildDeps(fetchImpl: typeof fetch, overrides: Partial<Deps['config']> = {}): Deps {
  const rpc = createPgRpc(client);
  return {
    config: {
      supabaseUrl: 'https://fake-project.supabase.test',
      serviceRoleKey: 'service-role-key',
      anonKey: 'anon-key',
      mercadoPagoAccessToken: 'TEST-access-token',
      mercadoPagoWebhookSecret: 'webhook-secret',
      mercadoPagoApiBase: 'https://api.mercadopago.test',
      encryptionKey: null,
      storeUrl: 'http://localhost:5173',
      paymentNotificationUrl: null,
      demoPaymentEnabled: true,
      demoAllowedProjectRefs: ['fake-project'],
      allowedOrigins: ['http://localhost:5173'],
      rateLimitOverrides: RELAXED_RATE_LIMIT_OVERRIDES,
      ...overrides,
    },
    rpc,
    rpcForUser: () => rpc,
    serviceRpc: rpc,
    resolveEncryptionKey: async () => null,
    fetchImpl,
    now: () => new Date(),
    log: () => undefined,
  };
}

const getCatalog = () => new Request('https://fn.test/catalog', { method: 'GET' });

const postJson = (path: string, body: unknown) =>
  new Request(`https://fn.test/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

interface CatalogBody {
  products: Array<{ id: string; availableUnits: number; available: boolean }>;
}

async function catalogAvailability(productId: string): Promise<{ units: number; available: boolean }> {
  const response = await handleCatalog(getCatalog(), buildDeps(mercadoPago.fetchImpl));
  expect(response.status).toBe(200);
  const body = (await response.json()) as CatalogBody;
  const product = body.products.find((item) => item.id === productId);
  if (!product) throw new Error('produto ausente do catálogo');
  return { units: product.availableUnits, available: product.available };
}

/** Simula a passagem do tempo: a reserva e o pedido ficam vencidos. */
async function expireReservation(orderId: string): Promise<void> {
  await runSql(
    `update public.stock_reservations
        set starts_at = now() - interval '35 minutes',
            expires_at = now() - interval '5 minutes'
      where order_id = $1`,
    [orderId],
  );
  await runSql(
    `update public.orders set reservation_expires_at = now() - interval '5 minutes' where id = $1`,
    [orderId],
  );
}

describe('catálogo anuncia apenas disponibilidade real', () => {
  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
  }, 60000);

  it('libera unidades de reservas vencidas antes de responder', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });
    const { order } = await createOrder(seed.productId, 1);

    expect(await catalogAvailability(seed.productId)).toEqual({ units: 0, available: false });

    await expireReservation(order.order_id);

    // Sem nenhuma outra ação (nem novo pedido, nem consulta de status), abrir o
    // catálogo precisa devolver a unidade que a reserva vencida segurava.
    expect(await catalogAvailability(seed.productId)).toEqual({ units: 1, available: true });

    const unit = await sqlValue<string>(`select status from public.stock_units where product_id = $1`, [
      seed.productId,
    ]);
    expect(unit).toBe('available');

    const expiredOrder = await runSql<{ status: string }>(`select status from public.orders where id = $1`, [
      order.order_id,
    ]);
    expect(expiredOrder[0].status).toBe('expired');
  });

  it('não mexe em reservas ainda válidas', async () => {
    const seed = await seedProduct({ stockUnits: 2, maxQuantity: 5 });
    const { order } = await createOrder(seed.productId, 1);

    expect(await catalogAvailability(seed.productId)).toEqual({ units: 1, available: true });

    const reservation = await runSql<{ status: string }>(
      `select status from public.stock_reservations where order_id = $1`,
      [order.order_id],
    );
    expect(reservation[0].status).toBe('active');
  });

  it('continua respondendo quando a limpeza de reservas falha', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    const deps = buildDeps(mercadoPago.fetchImpl);
    const failing: Deps = {
      ...deps,
      rpc: (async (name: string, args: Record<string, unknown>) => {
        if (name === 'expire_overdue_reservations') throw new Error('rpc_indisponivel');
        return deps.rpc(name, args);
      }) as Deps['rpc'],
    };

    const response = await handleCatalog(getCatalog(), failing);
    expect(response.status).toBe(200);
    const body = (await response.json()) as CatalogBody;
    expect(body.products.some((product) => product.id === seed.productId)).toBe(true);
  });
});

describe('replay idempotente de um checkout encerrado', () => {
  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
  }, 60000);

  const replay = (productId: string, keys: { key: string; token: string }) =>
    handleCreateOrder(
      postJson('create-order', {
        product_id: productId,
        quantity: 1,
        payer_email: 'comprador@teste.com',
        idempotency_key: keys.key,
        client_token: keys.token,
      }),
      buildDeps(mercadoPago.fetchImpl),
    );

  it('responder 409 em vez de 200 quando o pedido original falhou', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });
    const keys = { key: 'auditoria06-chave-0001', token: 'auditoria06-token-AAAAAAAAAAAAAAAAAAAAAAAA' };

    const created = await replay(seed.productId, keys);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { order: { order_id: string } };

    // Estado produzido pelo próprio fluxo quando a cobrança não pôde ser criada.
    await runSql(`select public.release_order_reservation($1, 'payment_not_configured')`, [
      createdBody.order.order_id,
    ]);

    const closed = await replay(seed.productId, keys);
    expect(closed.status).toBe(409);
    const closedBody = (await closed.json()) as { error: string; order?: unknown };
    expect(closedBody.error).toBe('previous_attempt_closed');
    // Sem dados do pedido encerrado na resposta de erro.
    expect(closedBody.order).toBeUndefined();

    const orders = await sqlValue<number>(`select count(*) from public.orders where product_id = $1`, [
      seed.productId,
    ]);
    expect(Number(orders)).toBe(1);
  });

  it('também recusa o replay de um pedido expirado', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });
    const keys = { key: 'auditoria06-chave-0002', token: 'auditoria06-token-BBBBBBBBBBBBBBBBBBBBBBBB' };

    const created = await replay(seed.productId, keys);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { order: { order_id: string } };
    await expireReservation(createdBody.order.order_id);
    await runSql(`select public.expire_overdue_reservations($1)`, [seed.productId]);

    const replayResponse = await replay(seed.productId, keys);
    expect(replayResponse.status).toBe(409);
    expect(((await replayResponse.json()) as { error: string }).error).toBe('previous_attempt_closed');
  });

  it('mantém 200 quando o pedido original foi pago (o comprador precisa do link)', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });
    const keys = { key: 'auditoria06-chave-0003', token: 'auditoria06-token-CCCCCCCCCCCCCCCCCCCCCCCC' };

    const created = await replay(seed.productId, keys);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { order: { order_id: string } };

    await runSql(
      `select public.apply_payment_status($1, 'MP-TEST-1', 'approved', 'accredited', $2, $3, $4)`,
      [
        createdBody.order.order_id,
        (await runSql<{ total_cents: number }>(`select total_cents from public.orders where id = $1`, [
          createdBody.order.order_id,
        ]))[0].total_cents,
        sha256Hex('token-de-entrega-do-teste'),
        Buffer.from('ciphertext-do-token-de-entrega').toString('base64'),
      ],
    );

    const paid = await replay(seed.productId, keys);
    expect(paid.status).toBe(200);
    const paidBody = (await paid.json()) as { order: { status: string }; replayed: boolean };
    expect(paidBody.order.status).toBe('paid');
    expect(paidBody.replayed).toBe(true);
  });

  it('depois do 409 o navegador consegue concluir com uma identidade nova', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });
    const first = { key: 'auditoria06-chave-0004', token: 'auditoria06-token-DDDDDDDDDDDDDDDDDDDDDDDD' };

    const created = await replay(seed.productId, first);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { order: { order_id: string } };
    await runSql(`select public.release_order_reservation($1, 'payment_provider_down')`, [
      createdBody.order.order_id,
    ]);

    expect((await replay(seed.productId, first)).status).toBe(409);

    const second = { key: 'auditoria06-chave-0005', token: 'auditoria06-token-EEEEEEEEEEEEEEEEEEEEEEEE' };
    const retried = await replay(seed.productId, second);
    expect(retried.status).toBe(201);
    const retriedBody = (await retried.json()) as { order: { order_id: string; status: string } };
    expect(retriedBody.order.status).toBe('pending_payment');
    expect(retriedBody.order.order_id).not.toBe(createdBody.order.order_id);
    expect(
      Number(await sqlValue<number>(`select count(*) from public.orders where product_id = $1`, [seed.productId])),
    ).toBe(2);
  });
});

describe('capacidades do modo demonstrativo', () => {
  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
  }, 60000);

  const capabilities = async (): Promise<{ demo_enabled: boolean; mode: string }> => {
    const response = await handleDemoPayment(new Request('https://fn.test/demo-payment', { method: 'GET' }), buildDeps(fetch));
    expect(response.status).toBe(200);
    return (await response.json()) as { demo_enabled: boolean; mode: string };
  };

  it('só anuncia o modo quando a chave do banco também está ligada', async () => {
    await runSql(`update public.app_settings set value = 'false'::jsonb where key = 'demo_payments_enabled'`);
    expect(await capabilities()).toEqual({ demo_enabled: false, mode: 'disabled' });

    await runSql(`update public.app_settings set value = 'true'::jsonb where key = 'demo_payments_enabled'`);
    expect(await capabilities()).toEqual({ demo_enabled: true, mode: 'demo' });
  });

  it('não anuncia o modo quando o ambiente não autoriza a simulação', async () => {
    const response = await handleDemoPayment(
      new Request('https://fn.test/demo-payment', { method: 'GET' }),
      buildDeps(fetch, { demoPaymentEnabled: false }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { demo_enabled: boolean }).demo_enabled).toBe(false);
  });
});
