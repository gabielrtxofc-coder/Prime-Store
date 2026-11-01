import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { createDeps, type Deps } from '../../supabase/functions/_shared/deps';
import { handleCreateOrder } from '../../supabase/functions/_shared/handlers/createOrder';
import { handleAdminApi } from '../../supabase/functions/_shared/handlers/adminApi';
import { createFakeMercadoPago } from '../unit/fakeMp';
import { connect, randomToken, resetDatabase, runSql, seedAdmin, seedProduct, sqlValue } from './helpers';
import { createPgRpc } from './pgRpc';

/**
 * Missão 03 — idempotência ponta a ponta pelo handler HTTP (Edge Function
 * create-order) contra o PostgreSQL real, com o Mercado Pago simulado.
 *
 * Diferente dos testes de banco, aqui a entrada é a requisição HTTP: o que se
 * verifica é o status code e o corpo que o cliente recebe.
 */

describe('create-order (HTTP) — idempotência sem sequestro de pedido', () => {
  let client: Client;
  let mp: ReturnType<typeof createFakeMercadoPago>;
  let deps: Deps;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
    mp = createFakeMercadoPago();
    const rpc = createPgRpc(client);
    deps = createDeps({
      config: {
        supabaseUrl: 'https://fake-project.supabase.test',
        serviceRoleKey: 'service-role-key',
        anonKey: 'anon-key',
        mercadoPagoAccessToken: 'TEST-access-token',
        mercadoPagoWebhookSecret: 'webhook-secret',
        mercadoPagoApiBase: 'https://api.mercadopago.test',
        encryptionKey: 'fake-encryption-key-for-tests-only-32b',
        storeUrl: 'http://localhost:5173',
        paymentNotificationUrl: 'https://fake-project.supabase.test/functions/v1/mp-webhook',
      },
      rpc,
      rpcForUser: () => rpc,
      serviceRpc: rpc,
      fetchImpl: mp.fetchImpl,
      log: () => undefined,
      resolveEncryptionKey: async () => 'fake-encryption-key-for-tests-only-32b',
    });
  }, 60000);

  function post(body: unknown): Request {
    return new Request('https://fn.test/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function create(productId: string, extra: Record<string, unknown> = {}) {
    const response = await handleCreateOrder(
      post({ product_id: productId, quantity: 1, payer_email: 'comprador@teste.com', ...extra }),
      deps,
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('consome a chave de idempotência e devolve PIX com o token do cliente', async () => {
    const product = await seedProduct({ stockUnits: 2 });
    const clientToken = randomToken(32);

    const { status, body } = await create(product.productId, {
      idempotency_key: randomToken(16),
      client_token: clientToken,
    });

    expect(status).toBe(201);
    expect(body.client_token).toBe(clientToken);
    expect(body.replayed).toBeUndefined();
  }, 20000);

  it('repetir a mesma requisição (mesmo token e chave) devolve o mesmo pedido', async () => {
    const product = await seedProduct({ stockUnits: 2 });
    const clientToken = randomToken(32);
    const payload = { idempotency_key: randomToken(16), client_token: clientToken };

    const first = await create(product.productId, payload);
    const second = await create(product.productId, payload);

    expect(first.status).toBe(201);
    expect(second.body.replayed).toBe(true);

    const firstOrder = first.body.order as { order_id: string };
    const secondOrder = second.body.order as { order_id: string };
    expect(secondOrder.order_id).toBe(firstOrder.order_id);
    // O replay devolve o MESMO token: sem rotação, sem novo segredo.
    expect(second.body.client_token).toBe(clientToken);

    const total = await sqlValue<number>(`select count(*) from public.orders where product_id = $1`, [
      product.productId,
    ]);
    expect(Number(total)).toBe(1);
  }, 20000);

  it('mesma chave com outro token responde 409 e não cria pedido nem troca o token', async () => {
    const product = await seedProduct({ stockUnits: 2 });
    const key = randomToken(16);

    const owner = await create(product.productId, { idempotency_key: key, client_token: randomToken(32) });
    expect(owner.status).toBe(201);
    const orderId = (owner.body.order as { order_id: string }).order_id;
    const hashBefore = await sqlValue<string>(`select client_token_hash from public.orders where id = $1`, [orderId]);

    // Terceiro tenta reutilizar a chave com o próprio token (tentativa de takeover).
    const attacker = await create(product.productId, { idempotency_key: key, client_token: randomToken(32) });

    expect(attacker.status).toBe(409);
    expect(attacker.body.error).toBe('idempotency_conflict');
    // Nenhum dado do pedido vaza na resposta de erro.
    expect(JSON.stringify(attacker.body)).not.toContain(orderId);

    expect(await sqlValue<string>(`select client_token_hash from public.orders where id = $1`, [orderId])).toBe(
      hashBefore,
    );
    const total = await sqlValue<number>(`select count(*) from public.orders where product_id = $1`, [
      product.productId,
    ]);
    expect(Number(total)).toBe(1);
  }, 20000);

  it('mesma chave e mesmo token com produto diferente responde 409', async () => {
    const productA = await seedProduct({ stockUnits: 2 });
    const productB = await seedProduct({ stockUnits: 2 });
    const key = randomToken(16);
    const clientToken = randomToken(32);

    expect((await create(productA.productId, { idempotency_key: key, client_token: clientToken })).status).toBe(201);

    const conflict = await create(productB.productId, { idempotency_key: key, client_token: clientToken });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('idempotency_conflict');
  }, 20000);

  it('mesma chave e mesmo token com quantidade diferente responde 409', async () => {
    const product = await seedProduct({ stockUnits: 4, maxQuantity: 2 });
    const key = randomToken(16);
    const clientToken = randomToken(32);

    expect((await create(product.productId, { idempotency_key: key, client_token: clientToken })).status).toBe(201);

    const response = await handleCreateOrder(
      post({ product_id: product.productId, quantity: 2, payer_email: 'comprador@teste.com', idempotency_key: key, client_token: clientToken }),
      deps,
    );
    expect(response.status).toBe(409);
  }, 20000);

  it('chave curta ou token fraco são rejeitados antes de tocar no estoque', async () => {
    const product = await seedProduct({ stockUnits: 1 });

    const shortKey = await create(product.productId, { idempotency_key: 'abc' });
    expect(shortKey.status).toBe(422);

    const weakToken = await create(product.productId, { client_token: 'token-curto', idempotency_key: randomToken(16) });
    expect(weakToken.status).toBe(422);

    const total = await sqlValue<number>(`select count(*) from public.orders where product_id = $1`, [
      product.productId,
    ]);
    expect(Number(total)).toBe(0);
  }, 20000);

  it('unidades reservadas não duplicam em repetição com falha de rede do cliente', async () => {
    const product = await seedProduct({ stockUnits: 3 });
    const payload = { idempotency_key: randomToken(16), client_token: randomToken(32) };

    const first = await create(product.productId, payload);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const replay = await create(product.productId, payload);
      expect((replay.body.order as { order_id: string }).order_id).toBe(
        (first.body.order as { order_id: string }).order_id,
      );
    }

    const reservations = await sqlValue<number>(
      `select count(*) from public.stock_reservations where order_id = $1`,
      [(first.body.order as { order_id: string }).order_id],
    );
    expect(Number(reservations)).toBe(1);

    const units = await sqlValue<number>(
      `select count(*) from public.stock_units where product_id = $1 and status = 'available'`,
      [product.productId],
    );
    expect(Number(units)).toBe(2);
  }, 20000);
});

describe('chave de criptografia: ambiente primeiro, Vault como fallback', () => {
  it('usa a variável de ambiente quando configurada e não consulta o banco', async () => {
    let calls = 0;
    const deps = createDeps({
      config: { supabaseUrl: 'https://fake.test', encryptionKey: 'chave-do-ambiente' },
      rpc: async () => {
        calls += 1;
        return null;
      },
    });

    expect(await deps.resolveEncryptionKey()).toBe('chave-do-ambiente');
    expect(calls).toBe(0);
  });

  it('cai para o segredo do Vault quando a variável de ambiente não existe', async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    const deps = createDeps({
      config: { supabaseUrl: 'https://fake.test', encryptionKey: '' },
      rpc: (async (name: string, args: Record<string, unknown>) => {
        seen.push({ name, args });
        if (name === 'get_secret_material') return 'chave-vinda-do-vault';
        return null;
      }) as unknown as Deps['rpc'],
    });

    expect(await deps.resolveEncryptionKey()).toBe('chave-vinda-do-vault');
    expect(seen).toEqual([{ name: 'get_secret_material', args: { p_name: 'prime_store_encryption_key' } }]);

    // Consulta memorizada por instância (evita um RPC por requisição).
    expect(await deps.resolveEncryptionKey()).toBe('chave-vinda-do-vault');
    expect(seen).toHaveLength(1);
  });

  it('sem ambiente e sem segredo a entrega falha fechada (nunca em claro)', async () => {
    const deps = createDeps({
      config: { supabaseUrl: 'https://fake.test', encryptionKey: '' },
      rpc: (async () => {
        throw new Error('get_secret_material: not found');
      }) as unknown as Deps['rpc'],
    });

    expect(await deps.resolveEncryptionKey()).toBeNull();
  });
});

describe('admin-api: disputa de chargeback', () => {
  let client: Client;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
  }, 60000);

  it('exige sessão com AAL2 e recusa decisão inválida', async () => {
    const adminId = await seedAdmin();
    const rpc = createPgRpc(client);
    const adminRpc = createPgRpc(client, {
      role: 'authenticated',
      claims: { sub: adminId, role: 'authenticated', aal: 'aal2' },
    });

    const deps = createDeps({
      config: { supabaseUrl: 'https://fake-project.supabase.test', serviceRoleKey: 'k', anonKey: 'a' },
      rpc: adminRpc as unknown as Deps['rpc'],
      rpcForUser: () => adminRpc,
      serviceRpc: rpc,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/auth/v1/user')) {
          return new Response(JSON.stringify({ id: adminId, email: 'admin@teste.invalid' }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      log: () => undefined,
    });

    const call = async (payload: Record<string, unknown>) => {
      const response = await handleAdminApi(
        new Request('https://fn.test/admin-api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake-jwt' },
          body: JSON.stringify({ action: 'orders.resolveDispute', payload }),
        }),
        deps,
      );
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    const invalid = await call({ orderId: '11111111-1111-1111-1111-111111111111', outcome: 'sumiu' });
    expect(invalid.status).toBe(422);

    // Pedido inexistente: o banco recusa e a API não inventa sucesso.
    const missing = await call({ orderId: '22222222-2222-2222-2222-222222222222', outcome: 'refund' });
    expect(missing.status).toBeGreaterThanOrEqual(400);
  }, 30000);

  it('sem token de sessão a ação não é executada', async () => {
    const deps = createDeps({
      config: { supabaseUrl: 'https://fake-project.supabase.test', serviceRoleKey: 'k', anonKey: 'a' },
      log: () => undefined,
    });

    const response = await handleAdminApi(
      new Request('https://fn.test/admin-api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'orders.resolveDispute', payload: {} }),
      }),
      deps,
    );
    expect(response.status).toBe(401);
  });
});
