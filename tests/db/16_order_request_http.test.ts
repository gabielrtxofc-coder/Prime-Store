import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { createDeps, type Deps } from '../../supabase/functions/_shared/deps';
import { handleOrderRequest } from '../../supabase/functions/_shared/handlers/orderRequest';
import { handleOrderStatus } from '../../supabase/functions/_shared/handlers/orderStatus';
import { connect, randomToken, resetDatabase, seedProduct, sqlValue, RELAXED_RATE_LIMIT_OVERRIDES } from './helpers';
import { createPgRpc } from './pgRpc';

/**
 * Missão 08 — Edge Function `order-request` (HTTP).
 *
 * Verifica o contrato visto pelo navegador: status codes, corpo e mensagens.
 * Nenhum segredo de pagamento é configurado aqui de propósito: a solicitação
 * sem pagamento precisa funcionar sem `MP_ACCESS_TOKEN`/`MP_WEBHOOK_SECRET`.
 */

const GOOD_BODY = { buyer_name: 'Maria Souza', buyer_email: 'maria@exemplo.com' };

describe('order-request (HTTP) — solicitação sem pagamento', () => {
  let client: Client;
  let deps: Deps;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
    const rpc = createPgRpc(client);
    deps = createDeps({
      config: {
        supabaseUrl: 'https://fake-project.supabase.test',
        serviceRoleKey: 'service-role-key',
        anonKey: 'anon-key',
        // Sem integração de pagamento: exatamente o cenário exigido na missão.
        mercadoPagoAccessToken: null,
        mercadoPagoWebhookSecret: null,
        mercadoPagoApiBase: 'https://api.mercadopago.test',
        encryptionKey: null,
        storeUrl: 'http://localhost:5173',
        paymentNotificationUrl: null,
        rateLimitOverrides: RELAXED_RATE_LIMIT_OVERRIDES,
      },
      rpc,
      rpcForUser: () => rpc,
      serviceRpc: rpc,
      fetchImpl: (async () => {
        throw new Error('nenhuma chamada externa deveria acontecer');
      }) as typeof fetch,
      log: () => undefined,
      resolveEncryptionKey: async () => null,
    });
  }, 60000);

  function post(body: unknown, method = 'POST'): Request {
    return new Request('https://fn.test/order-request', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
  }

  async function call(body: unknown, method = 'POST') {
    const response = await handleOrderRequest(post(body, method), deps);
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
      headers: response.headers,
    };
  }

  it('registra a solicitação com carrinho de vários produtos e devolve o código de acompanhamento', async () => {
    const first = await seedProduct({ priceCents: 4990, maxQuantity: 3, stockUnits: 5 });
    const second = await seedProduct({ priceCents: 2990, stockUnits: 4 });
    const clientToken = randomToken(32);

    const { status, body } = await call({
      ...GOOD_BODY,
      items: [
        { product_id: first.productId, quantity: 2 },
        { product_id: second.productId, quantity: 1 },
      ],
      idempotency_key: randomToken(16),
      client_token: clientToken,
    });

    expect(status).toBe(201);
    expect(body?.client_token).toBe(clientToken);
    expect(body?.idempotent_replay).toBe(false);

    const order = body?.order as Record<string, unknown>;
    expect(order.status).toBe('requested');
    expect(order.payment_status).toBe('not_required');
    expect(order.delivery_status).toBe('not_ready');
    expect(order.total_cents).toBe(4990 * 2 + 2990);
    expect(order.reference).toMatch(/^PS-[0-9A-Z]{6}$/);
    expect((order.items as unknown[]).length).toBe(2);
  }, 20000);

  it('reenvio idêntico (mesma chave e token) não cria segunda solicitação', async () => {
    const product = await seedProduct({ stockUnits: 5 });
    const payload = {
      ...GOOD_BODY,
      items: [{ product_id: product.productId, quantity: 1 }],
      idempotency_key: randomToken(16),
      client_token: randomToken(32),
    };

    const first = await call(payload);
    const second = await call(payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body?.idempotent_replay).toBe(true);
    expect((second.body?.order as Record<string, unknown>).order_id).toBe(
      (first.body?.order as Record<string, unknown>).order_id,
    );
  }, 20000);

  it('recusa dados inválidos com 422 sem vazar detalhes internos', async () => {
    const product = await seedProduct({ stockUnits: 5 });

    const ordersBefore = await sqlValue<number>('select count(*)::int from public.orders');

    const emptyItems = await call({ ...GOOD_BODY, items: [] });
    expect(emptyItems.status).toBe(422);
    expect(emptyItems.body?.error).toBe('invalid_items');

    const noName = await call({ items: [{ product_id: product.productId, quantity: 1 }], buyer_email: 'maria@exemplo.com' });
    expect(noName.status).toBe(422);

    const badEmail = await call({ ...GOOD_BODY, buyer_email: 'sem-arroba', items: [{ product_id: product.productId, quantity: 1 }] });
    expect(badEmail.status).toBe(422);

    const notUuid = await call({ ...GOOD_BODY, items: [{ product_id: 'abc', quantity: 1 }] });
    expect(notUuid.status).toBe(422);

    const zeroQuantity = await call({ ...GOOD_BODY, items: [{ product_id: product.productId, quantity: 0 }] });
    expect(zeroQuantity.status).toBe(422);

    const repeated = await call({
      ...GOOD_BODY,
      items: [
        { product_id: product.productId, quantity: 1 },
        { product_id: product.productId, quantity: 2 },
      ],
    });
    expect(repeated.status).toBe(422);

    // Nenhuma dessas respostas cria pedido.
    expect(await sqlValue<number>('select count(*)::int from public.orders')).toBe(ordersBefore);
  }, 20000);

  it('devolve 409 com as unidades disponíveis quando o estoque acabou', async () => {
    const product = await seedProduct({ stockUnits: 1, maxQuantity: 5 });

    const response = await call({
      ...GOOD_BODY,
      items: [{ product_id: product.productId, quantity: 3 }],
      idempotency_key: randomToken(16),
    });

    expect(response.status).toBe(409);
    expect(response.body?.error).toBe('insufficient_stock');
    expect(response.body?.available_units).toBe(1);
  }, 20000);

  it('devolve 404 quando o produto está inativo', async () => {
    const product = await seedProduct({ stockUnits: 3, active: false });

    const response = await call({
      ...GOOD_BODY,
      items: [{ product_id: product.productId, quantity: 1 }],
    });

    expect(response.status).toBe(404);
    expect(response.body?.error).toBe('product_unavailable');
  }, 20000);

  it('respeita o limite por produto e informa o máximo', async () => {
    const product = await seedProduct({ stockUnits: 10, maxQuantity: 2 });

    const response = await call({
      ...GOOD_BODY,
      items: [{ product_id: product.productId, quantity: 3 }],
    });

    expect(response.status).toBe(422);
    expect(response.body?.error).toBe('quantity_above_product_limit');
    expect(response.body?.max_quantity).toBe(2);
  }, 20000);

  it('aceita preflight e recusa métodos diferentes de POST', async () => {
    const preflight = await handleOrderRequest(post({}, 'OPTIONS'), deps);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Vary')).toContain('Origin');

    const wrong = await handleOrderRequest(post({}, 'GET'), deps);
    expect(wrong.status).toBe(405);
  });

  it('order-status consulta a solicitação pelo id ou pelo número, exigindo o código', async () => {
    const product = await seedProduct({ priceCents: 1990, stockUnits: 3 });
    const clientToken = randomToken(32);

    const created = await call({
      ...GOOD_BODY,
      items: [{ product_id: product.productId, quantity: 1 }],
      idempotency_key: randomToken(16),
      client_token: clientToken,
    });
    const order = created.body?.order as Record<string, unknown>;

    const statusById = await handleOrderStatus(
      new Request('https://fn.test/order-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: order.order_id, client_token: clientToken }),
      }),
      deps,
    );
    expect(statusById.status).toBe(200);
    const statusBody = (await statusById.json()) as Record<string, unknown>;
    expect(statusBody.status).toBe('requested');
    expect(statusBody.reference).toBe(order.reference);
    expect(statusBody.payment).toBeNull();
    expect((statusBody.items as unknown[]).length).toBe(1);

    const statusByReference = await handleOrderStatus(
      new Request('https://fn.test/order-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference: order.reference, client_token: clientToken }),
      }),
      deps,
    );
    expect(statusByReference.status).toBe(200);

    // Código errado: mesmo erro de "não encontrado", sem oráculo de existência.
    const wrongToken = await handleOrderStatus(
      new Request('https://fn.test/order-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference: order.reference, client_token: randomToken(32) }),
      }),
      deps,
    );
    expect(wrongToken.status).toBe(404);

    const missingReference = await handleOrderStatus(
      new Request('https://fn.test/order-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference: 'PS-ZZZZZZ', client_token: clientToken }),
      }),
      deps,
    );
    expect(missingReference.status).toBe(404);
  }, 20000);
});
