import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { createDeps, type Deps } from '../../supabase/functions/_shared/deps';
import { handleCatalog } from '../../supabase/functions/_shared/handlers/catalog';
import { handleCreateOrder } from '../../supabase/functions/_shared/handlers/createOrder';
import { handleDelivery } from '../../supabase/functions/_shared/handlers/delivery';
import { handleOrderStatus } from '../../supabase/functions/_shared/handlers/orderStatus';
import { ROUTE_LIMITS, normalizeAddress, clientAddress } from '../../supabase/functions/_shared/rateLimit';
import { createFakeMercadoPago } from '../unit/fakeMp';
import { connect, resetDatabase, runSql, runAs, seedProduct, sqlValue } from './helpers';
import { createPgRpc } from './pgRpc';

/**
 * Missão 07 — etapa 03: limite de requisições por origem e por rota.
 *
 * Usa a configuração **padrão** (nenhum override): é o comportamento que vai
 * para o sandbox. Os testes falam com os handlers HTTP reais contra PostgreSQL
 * real, então o contador é o mesmo que a Edge Function usa em produção —
 * persistente e compartilhado entre instâncias.
 */

let client: Client;
/**
 * Um único provedor simulado por arquivo: ids de pagamento são sequenciais e o
 * banco tem índice único em `payments.provider_payment_id`.
 */
const mercadoPago = createFakeMercadoPago();

function depsFor(fetchImpl: typeof fetch, overrides: Partial<Deps['config']> = {}): Deps {
  const rpc = createPgRpc(client);
  return {
    config: {
      supabaseUrl: 'https://fake-project.supabase.test',
      serviceRoleKey: 'service-role-key-do-teste',
      anonKey: 'anon-key',
      mercadoPagoAccessToken: null,
      mercadoPagoWebhookSecret: 'segredo-do-webhook-do-teste',
      mercadoPagoApiBase: 'https://api.mercadopago.test',
      encryptionKey: null,
      storeUrl: 'http://localhost:5173',
      paymentNotificationUrl: null,
      demoPaymentEnabled: false,
      demoAllowedProjectRefs: ['fake-project'],
      allowedOrigins: ['http://localhost:5173'],
      rateLimitSecret: 'segredo-do-limite-do-teste',
      rateLimitOverrides: {},
      ...overrides,
    } as Deps['config'],
    rpc,
    rpcForUser: () => rpc,
    serviceRpc: rpc,
    resolveEncryptionKey: async () => null,
    fetchImpl,
    now: () => new Date(),
    log: () => undefined,
  };
}

/** Requisição com origem explícita (o gateway entrega o IP no x-forwarded-for). */
function withOrigin(request: Request, address: string): Request {
  const headers = new Headers(request.headers);
  headers.set('x-forwarded-for', address);
  return new Request(request, { headers });
}

function catalogRequest(address: string): Request {
  return withOrigin(new Request('https://fn.test/catalog', { method: 'GET' }), address);
}

function createOrderRequest(address: string, productId: string, extra: Record<string, unknown> = {}): Request {
  return withOrigin(
    new Request('https://fn.test/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: productId, quantity: 1, payer_email: 'comprador@teste.com', ...extra }),
    }),
    address,
  );
}

async function hitsLeft(address: string, route = 'catalog'): Promise<number> {
  const rows = await runSql<{ total: string }>(
    `select coalesce(sum(hits), 0)::text as total from public.rate_limit_counters
      where route = $1 and subject_hash <> '' and window_start > now() - interval '2 minutes'`,
    [route],
  );
  // O total agregado não identifica o sujeito; o teste usa apenas para garantir
  // que a contagem é finita e persistente.
  return Number(rows[0].total);
}

describe('limite de requisições das rotas públicas', () => {
  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
  }, 60000);

  it('aceita requisições dentro do limite do catálogo', async () => {
    const deps = depsFor(mercadoPago.fetchImpl);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => handleCatalog(catalogRequest('198.51.100.10'), deps)),
    );

    for (const response of responses) expect(response.status).toBe(200);
    expect(await hitsLeft('198.51.100.10')).toBeGreaterThanOrEqual(5);
  });

  it('responde 429 com Retry-After ao ultrapassar o limite do catálogo', async () => {
    const deps = depsFor(mercadoPago.fetchImpl);
    const limit = ROUTE_LIMITS.catalog.limit;
    const address = '198.51.100.20';

    for (let index = 0; index < limit; index += 1) {
      const response = await handleCatalog(catalogRequest(address), deps);
      expect(response.status, `requisição ${index + 1}`).toBe(200);
    }

    const blocked = await handleCatalog(catalogRequest(address), deps);
    expect(blocked.status).toBe(429);

    const retryAfter = Number(blocked.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    const body = (await blocked.json()) as { error: string; retry_after_seconds: number };
    expect(body.error).toBe('rate_limited');
    expect(body.retry_after_seconds).toBe(retryAfter);
    // A resposta mantém os cabeçalhos comuns (CORS é aplicado no index.ts).
    expect(blocked.headers.get('content-type')).toContain('application/json');
  }, 60000);

  it('o controle sobrevive ao "reinício" da instância (fica no banco)', async () => {
    const address = '198.51.100.20'; // já no limite pelo teste anterior
    // Objeto de dependências novo = nova instância da função, memória zerada.
    const freshDeps = depsFor(mercadoPago.fetchImpl);
    const response = await handleCatalog(catalogRequest(address), freshDeps);
    expect(response.status).toBe(429);
  });

  it('origens diferentes têm orçamentos independentes', async () => {
    const deps = depsFor(mercadoPago.fetchImpl);
    const response = await handleCatalog(catalogRequest('198.51.100.30'), deps);
    expect(response.status).toBe(200);
  });

  it('rotas diferentes têm limites independentes', async () => {
    const mp = mercadoPago;
    const deps = depsFor(mp.fetchImpl, { mercadoPagoAccessToken: 'TEST-access-token' });
    const product = await seedProduct({ stockUnits: 20, maxQuantity: 20 });
    const address = '198.51.100.40';

    // Gasta todo o orçamento do checkout.
    for (let index = 0; index < ROUTE_LIMITS['create-order'].limit; index += 1) {
      const response = await handleCreateOrder(createOrderRequest(address, product.productId), deps);
      expect([201, 409, 422]).toContain(response.status);
    }
    expect((await handleCreateOrder(createOrderRequest(address, product.productId), deps)).status).toBe(429);

    // O catálogo continua liberado para o mesmo cliente: o limite é por rota.
    expect((await handleCatalog(catalogRequest(address), deps)).status).toBe(200);
  }, 60000);

  it('requisições simultâneas não estouram o orçamento', async () => {
    const deps = depsFor(mercadoPago.fetchImpl);
    const address = '198.51.100.50';
    // A janela do teste anterior pode ter virado; usa o limite do catálogo.
    const limit = ROUTE_LIMITS.catalog.limit;

    const responses = await Promise.all(
      Array.from({ length: limit + 20 }, () => handleCatalog(catalogRequest(address), deps)),
    );
    const allowed = responses.filter((response) => response.status === 200).length;
    const blocked = responses.filter((response) => response.status === 429).length;

    expect(allowed).toBe(limit);
    expect(blocked).toBe(20);
  }, 60000);

  it('a janela expira e o cliente volta a ser atendido', async () => {
    // Janela de 1 segundo direto na RPC: prova o mecanismo sem esperar 60s.
    const subject = 'a'.repeat(32);
    const first = await runSql<{ result: { allowed: boolean } }>(
      `select public.consume_rate_limit('janela-teste', $1, 1, 1) as result`,
      [subject],
    );
    expect(first[0].result.allowed).toBe(true);

    const blocked = await runSql<{ result: { allowed: boolean; retry_after_seconds: number } }>(
      `select public.consume_rate_limit('janela-teste', $1, 1, 1) as result`,
      [subject],
    );
    expect(blocked[0].result.allowed).toBe(false);
    expect(blocked[0].result.retry_after_seconds).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const afterWindow = await runSql<{ result: { allowed: boolean } }>(
      `select public.consume_rate_limit('janela-teste', $1, 1, 1) as result`,
      [subject],
    );
    expect(afterWindow[0].result.allowed).toBe(true);
  }, 20000);

  it('cliente legítimo consulta o catálogo e conclui o checkout', async () => {
    const mp = mercadoPago;
    const deps = depsFor(mp.fetchImpl, { mercadoPagoAccessToken: 'TEST-access-token' });
    const product = await seedProduct({ stockUnits: 1 });
    const address = '198.51.100.60';

    for (let index = 0; index < 10; index += 1) {
      expect((await handleCatalog(catalogRequest(address), deps)).status).toBe(200);
    }

    const created = await handleCreateOrder(createOrderRequest(address, product.productId), deps);
    expect(created.status).toBe(201);
    const body = (await created.json()) as { order: { order_id: string }; client_token: string };

    const status = await handleOrderStatus(
      withOrigin(
        new Request('https://fn.test/order-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_id: body.order.order_id, client_token: body.client_token }),
        }),
        address,
      ),
      deps,
    );
    expect(status.status).toBe(200);
  }, 60000);

  it('idempotência do checkout continua valendo dentro do limite', async () => {
    const mp = mercadoPago;
    const deps = depsFor(mp.fetchImpl, { mercadoPagoAccessToken: 'TEST-access-token' });
    const product = await seedProduct({ stockUnits: 1 });
    const address = '198.51.100.70';
    const keys = { idempotency_key: 'limite-idempotencia-0001', client_token: 'limite-idempotencia-token-0001-abcdefghij' };

    const first = await handleCreateOrder(createOrderRequest(address, product.productId, keys), deps);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { order: { order_id: string; reference: string } };

    const replay = await handleCreateOrder(createOrderRequest(address, product.productId, keys), deps);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { order: { order_id: string }; replayed: boolean };
    expect(replayBody.order.order_id).toBe(firstBody.order.order_id);
    expect(replayBody.replayed).toBe(true);

    // Um único pedido criado, um único estoque reservado.
    expect(
      Number(await sqlValue<number>(`select count(*) from public.orders where product_id = $1`, [product.productId])),
    ).toBe(1);
  }, 60000);

  it('a entrega por token também tem orçamento próprio', async () => {
    const deps = depsFor(mercadoPago.fetchImpl);
    const address = '198.51.100.80';
    const limit = ROUTE_LIMITS.delivery.limit;

    for (let index = 0; index < limit; index += 1) {
      const response = await handleDelivery(
        withOrigin(new Request(`https://fn.test/delivery?token=${'x'.repeat(43)}`, { method: 'GET' }), address),
        deps,
      );
      // Token inexistente/chave ausente: importa apenas que o limite não bloqueou.
      expect([404, 410, 503, 400]).toContain(response.status);
    }

    const blocked = await handleDelivery(
      withOrigin(new Request(`https://fn.test/delivery?token=${'x'.repeat(43)}`, { method: 'GET' }), address),
      deps,
    );
    expect(blocked.status).toBe(429);
  }, 60000);

  it('o limite não depende de campos enviados pelo navegador', async () => {
    const deps = depsFor(mercadoPago.fetchImpl);
    const address = '198.51.100.90';

    // Primeiro esgota o orçamento do catálogo desse IP.
    for (let index = 0; index < ROUTE_LIMITS.catalog.limit; index += 1) {
      await handleCatalog(catalogRequest(address), deps);
    }
    expect((await handleCatalog(catalogRequest(address), deps)).status).toBe(429);

    // Corpo/query diferentes não criam um orçamento novo: o sujeito é a origem.
    const withQuery = withOrigin(new Request('https://fn.test/catalog?q=outro&category=music', { method: 'GET' }), address);
    expect((await handleCatalog(withQuery, deps)).status).toBe(429);

    const postBody = withOrigin(
      new Request('https://fn.test/catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: 'tentativa-de-contorno' }),
      }),
      address,
    );
    expect((await handleCatalog(postBody, deps)).status).toBe(429);
  }, 60000);

  it('contadores e funções são internos: anon/authenticated não acessam', async () => {
    await expect(runAs(`select * from public.rate_limit_counters`, [], { role: 'anon' })).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      runAs(`select public.consume_rate_limit('catalog', repeat('a', 32), 1, 60)`, [], { role: 'anon' }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runAs(`select * from public.rate_limit_counters`, [], {
        role: 'authenticated',
        claims: { role: 'authenticated' },
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('o webhook do provedor não consome orçamento de rota pública', async () => {
    const before = await sqlValue<number>(
      `select coalesce(sum(hits), 0) from public.rate_limit_counters where route = 'mp-webhook'`,
    );
    expect(Number(before)).toBe(0);
    // A rota não está no mapa de limites: a proteção dela é assinatura + dedupe.
    expect(ROUTE_LIMITS['mp-webhook']).toBeUndefined();
  });
});

describe('derivação do endereço de origem', () => {
  it('usa a última entrada do x-forwarded-for (escrita pelo proxy)', () => {
    const request = new Request('https://fn.test/catalog', {
      headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.7' },
    });
    // O primeiro valor é o que o cliente pode escrever; o último é o real.
    expect(clientAddress(request)).toBe('198.51.100.7');
  });

  it('normaliza IPv4 com porta, IPv6 e IPv4 mapeado', () => {
    expect(normalizeAddress('203.0.113.7:51234')).toBe('203.0.113.7');
    expect(normalizeAddress('[2001:db8::1]:443')).toBe('v6:2001:db8:0:0');
    // Mesmo /64, endereços diferentes: mesmo balde.
    expect(normalizeAddress('2001:db8:0:0:aaaa::1')).toBe('v6:2001:db8:0:0');
    expect(normalizeAddress('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeAddress('nao-e-ip')).toBeNull();
    expect(normalizeAddress('')).toBeNull();
  });

  it('cai para cabeçalhos alternativos e, no fim, para "unknown"', () => {
    const cf = new Request('https://fn.test/catalog', { headers: { 'cf-connecting-ip': '198.51.100.9' } });
    expect(clientAddress(cf)).toBe('198.51.100.9');

    const none = new Request('https://fn.test/catalog');
    expect(clientAddress(none)).toBeNull();
  });
});
