import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { toBase64 } from '../../supabase/functions/_shared/crypto';
import type { Deps } from '../../supabase/functions/_shared/deps';
import { handleCatalog } from '../../supabase/functions/_shared/handlers/catalog';
import { handleCreateOrder } from '../../supabase/functions/_shared/handlers/createOrder';
import { handleDelivery } from '../../supabase/functions/_shared/handlers/delivery';
import { handleDemoPayment } from '../../supabase/functions/_shared/handlers/demoPayment';
import { handleOrderStatus } from '../../supabase/functions/_shared/handlers/orderStatus';
import { createFakeMercadoPago } from '../unit/fakeMp';
import {
  connect,
  migrationFiles,
  RELAXED_RATE_LIMIT_OVERRIDES,
  resetDatabase,
  runAs,
  runSql,
  seedProduct,
  sha256Hex,
  sqlValue,
} from './helpers';
import { createPgRpc } from './pgRpc';

/**
 * Missão 07 — etapa 05: auditoria de regressão depois do endurecimento.
 *
 * Cada bloco abaixo corresponde a um item do checklist da missão. O objetivo é
 * provar que a assinatura obrigatória do webhook, a expiração agendada e o
 * limite de requisições **não** mudaram nenhum comportamento de negócio:
 * estoque, pedidos, checkout, modo demonstrativo, permissões e migrações.
 *
 * Este arquivo usa o orçamento relaxado de requisições (o limite real, com os
 * valores de produção, é o assunto de `13_limite_requisicoes.test.ts`).
 */

let client: Client;
const mercadoPago = createFakeMercadoPago('/triagem/');
/** Chave-mestra de criptografia sintética (32 bytes) só para o teste. */
const MASTER_KEY = toBase64(new Uint8Array(randomBytes(32)));

function buildDeps(overrides: Partial<Deps['config']> = {}, fetchImpl: typeof fetch = mercadoPago.fetchImpl): Deps {
  const rpc = createPgRpc(client);
  return {
    config: {
      supabaseUrl: 'https://fake-project.supabase.test',
      serviceRoleKey: 'service-role-key',
      anonKey: 'anon-key',
      mercadoPagoAccessToken: 'TEST-access-token',
      mercadoPagoWebhookSecret: 'webhook-secret',
      mercadoPagoApiBase: 'https://api.mercadopago.test',
      encryptionKey: MASTER_KEY,
      storeUrl: 'http://localhost:5173',
      paymentNotificationUrl: null,
      demoPaymentEnabled: true,
      demoAllowedProjectRefs: ['fake-project'],
      allowedOrigins: ['http://localhost:5173'],
      rateLimitSecret: 'segredo-do-limite',
      rateLimitOverrides: RELAXED_RATE_LIMIT_OVERRIDES,
      ...overrides,
    } as Deps['config'],
    rpc,
    rpcForUser: () => rpc,
    serviceRpc: rpc,
    resolveEncryptionKey: async () => MASTER_KEY,
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

interface CatalogProduct {
  id: string;
  availableUnits: number;
  available: boolean;
  [key: string]: unknown;
}

async function catalogFor(productId: string): Promise<CatalogProduct> {
  const response = await handleCatalog(getCatalog(), buildDeps());
  expect(response.status).toBe(200);
  const body = (await response.json()) as { products: CatalogProduct[] };
  const product = body.products.find((item) => item.id === productId);
  if (!product) throw new Error('produto ausente do catálogo');
  return product;
}

function checkout(productId: string, extra: Record<string, unknown> = {}, deps: Deps = buildDeps()) {
  return handleCreateOrder(
    postJson('create-order', { product_id: productId, quantity: 1, payer_email: 'comprador@teste.com', ...extra }),
    deps,
  );
}

/** Produto e unidades fictícias: condição para a aprovação simulada. */
async function markDemo(productId: string): Promise<void> {
  await runSql(`update public.products set is_demo = true where id = $1`, [productId]);
  await runSql(`update public.stock_units set is_demo = true where product_id = $1`, [productId]);
}

async function markPaid(orderId: string, providerPaymentId: string): Promise<void> {
  const total = await sqlValue<number>(`select total_cents from public.orders where id = $1`, [orderId]);
  await runSql(`select public.apply_payment_status($1, $2, 'approved', 'accredited', $3, $4, $5)`, [
    orderId,
    providerPaymentId,
    total,
    sha256Hex(`token-entrega-${orderId}`),
    Buffer.from(`ciphertext-${orderId}`).toString('base64'),
  ]);
}

describe('estoque continua íntegro', () => {
  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
  }, 60000);

  it('não vende a mesma unidade duas vezes sob concorrência', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });

    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        checkout(seed.productId, {
          idempotency_key: `concorrencia-${index}-000000000000`,
          client_token: `concorrencia-token-${index}-abcdefghijklmnop`,
        }),
      ),
    );

    const created = responses.filter((response) => response.status === 201);
    const refused = responses.filter((response) => response.status === 409 || response.status === 422);
    expect(created).toHaveLength(1);
    expect(created.length + refused.length).toBe(responses.length);

    expect(
      Number(await sqlValue<number>(`select count(*) from public.stock_units where product_id = $1 and status = 'reserved'`, [seed.productId])),
    ).toBe(1);
    expect(
      Number(await sqlValue<number>(`select count(*) from public.stock_reservations where status = 'active'`)),
    ).toBe(1);
  }, 60000);

  it('a entrega consome a unidade e o catálogo deixa de anunciá-la', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });
    const created = await checkout(seed.productId, { client_token: 'consumo-token-abcdefghijklmnopqrstuvwx' });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { order: { order_id: string } };

    await markPaid(body.order.order_id, 'MP-CONSUMO-1');

    const unit = await runSql<{ status: string; sold_order_id: string | null }>(
      `select status, sold_order_id from public.stock_units where product_id = $1`,
      [seed.productId],
    );
    expect(unit[0].status).toBe('sold');
    expect(unit[0].sold_order_id).toBe(body.order.order_id);

    expect((await catalogFor(seed.productId)).availableUnits).toBe(0);
  }, 60000);

  it('a expiração agendada devolve a unidade sem intervenção do cliente', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });
    const created = await checkout(seed.productId, { client_token: 'expiracao-token-abcdefghijklmnopqrs' });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { order: { order_id: string } };

    // Envelhece a reserva e executa a MESMA rotina que o pg_cron chama.
    await runSql(
      `update public.stock_reservations set starts_at = now() - interval '35 minutes',
              expires_at = now() - interval '5 minutes' where order_id = $1`,
      [body.order.order_id],
    );

    const run = await runSql<{ result: Record<string, unknown> }>(`select public.run_reservation_expiry() as result`);
    const first = run[0].result as { result: string; released_units?: number; source?: string };
    expect(first.result).toBe('ok');
    expect(first.released_units).toBe(1);
    expect(first.source).toBe('cron');

    // Idempotência: rodar de novo não "devolve" unidade duas vezes.
    const again = await runSql<{ result: { result: string; released_units?: number } }>(
      `select public.run_reservation_expiry() as result`,
    );
    expect(again[0].result.result).toBe('ok');
    expect(again[0].result.released_units ?? 0).toBe(0);

    expect(await catalogFor(seed.productId)).toMatchObject({ availableUnits: 1, available: true });
  }, 60000);
});

describe('pedidos continuam com as mesmas regras', () => {
  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
  }, 60000);

  it('replay da mesma chave devolve o mesmo pedido, sem duplicar reserva', async () => {
    const seed = await seedProduct({ stockUnits: 2, maxQuantity: 5 });
    const keys = { idempotency_key: 'regressao-chave-0001', client_token: 'regressao-token-aaaa-abcdefghijkl' };

    const first = await checkout(seed.productId, keys);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { order: { order_id: string }; replayed?: boolean };
    expect(firstBody.replayed ?? false).toBe(false);

    const second = await checkout(seed.productId, keys);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { order: { order_id: string }; replayed: boolean };
    expect(secondBody.order.order_id).toBe(firstBody.order.order_id);
    expect(secondBody.replayed).toBe(true);

    expect(Number(await sqlValue<number>(`select count(*) from public.orders`))).toBe(1);
    expect(Number(await sqlValue<number>(`select count(*) from public.stock_reservations where status = 'active'`))).toBe(1);
  }, 60000);

  it('replay de pedido pago responde 200 com o pedido pago (o comprador precisa do link)', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });
    const keys = { idempotency_key: 'regressao-chave-0002', client_token: 'regressao-token-bbbb-abcdefghijkl' };

    const created = await checkout(seed.productId, keys);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { order: { order_id: string } };
    await markPaid(createdBody.order.order_id, 'MP-REPLAY-PAGO-1');

    const replay = await checkout(seed.productId, keys);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { order: { order_id: string; status: string }; replayed: boolean };
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.order.order_id).toBe(createdBody.order.order_id);
    expect(replayBody.order.status).toBe('paid');
  }, 60000);

  it('pedido encerrado responde 409 e libera o estoque para a nova tentativa', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });
    const keys = { idempotency_key: 'regressao-chave-0003', client_token: 'regressao-token-cccc-abcdefghijkl' };

    const created = await checkout(seed.productId, keys);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { order: { order_id: string } };
    await runSql(`select public.release_order_reservation($1, 'payment_not_configured')`, [createdBody.order.order_id]);

    const closed = await checkout(seed.productId, keys);
    expect(closed.status).toBe(409);
    const closedBody = (await closed.json()) as { error: string; order?: unknown };
    expect(closedBody.error).toBe('previous_attempt_closed');
    expect(closedBody.order).toBeUndefined();
    expect(await catalogFor(seed.productId)).toMatchObject({ availableUnits: 1, available: true });

    const retry = await checkout(seed.productId, {
      idempotency_key: 'regressao-chave-0004',
      client_token: 'regressao-token-dddd-abcdefghijkl',
    });
    expect(retry.status).toBe(201);
  }, 60000);

  it('o status do pedido exige o token privado e não vaza dados internos', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });
    const token = 'regressao-token-status-abcdefghijklmnop';
    const created = await checkout(seed.productId, { client_token: token });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { order: { order_id: string } };

    const wrong = await handleOrderStatus(
      postJson('order-status', { order_id: createdBody.order.order_id, client_token: 'x'.repeat(43) }),
      buildDeps(),
    );
    expect(wrong.status).toBe(404);

    const ok = await handleOrderStatus(
      postJson('order-status', { order_id: createdBody.order.order_id, client_token: token }),
      buildDeps(),
    );
    expect(ok.status).toBe(200);
    const raw = await ok.text();
    expect(raw).not.toContain('client_token_hash');
    expect(raw).not.toContain('account_email_enc');
    expect(raw).not.toContain(sha256Hex(token));
  }, 60000);
});

describe('checkout continua idempotente e sem expor dados internos', () => {
  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
  }, 60000);

  it('a resposta pública do checkout não traz campo interno', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });
    const response = await checkout(seed.productId, { client_token: 'regressao-token-exposicao-abcdefghij' });
    expect(response.status).toBe(201);
    const raw = await response.text();

    for (const leaked of ['client_token_hash', 'cost_cents', 'created_by', 'account_email_enc', 'credential_fingerprint', 'idempotency_key']) {
      expect(raw, `campo interno ${leaked} na resposta pública`).not.toContain(leaked);
    }
  }, 60000);

  it('o catálogo público não expõe custo, credenciais nem campos de auditoria', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });
    const product = await catalogFor(seed.productId);
    for (const leaked of ['cost_cents', 'created_by', 'updated_by', 'account_email_enc', 'account_password_enc']) {
      expect(Object.keys(product), `campo interno ${leaked} no catálogo`).not.toContain(leaked);
    }
  });

  it('a entrega só fica pronta depois do pagamento e o token desconhecido não revela nada', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });
    const created = await checkout(seed.productId, { client_token: 'regressao-token-entrega-abcdefghijklmn' });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { order: { order_id: string } };

    const unknown = await handleDelivery(postJson('delivery', { token: 'z'.repeat(43) }), buildDeps());
    expect(unknown.status).toBe(404);

    const beforePayment = await runSql<{ delivery_status: string }>(
      `select delivery_status from public.orders where id = $1`,
      [body.order.order_id],
    );
    expect(beforePayment[0].delivery_status).toBe('not_ready');
    expect(Number(await sqlValue<number>(`select count(*) from public.deliveries`))).toBe(0);

    await markPaid(body.order.order_id, 'MP-ENTREGA-1');

    const afterPayment = await runSql<{ delivery_status: string }>(
      `select delivery_status from public.orders where id = $1`,
      [body.order.order_id],
    );
    expect(afterPayment[0].delivery_status).toBe('ready');
    // O token de entrega existe apenas como hash (e cifrado); nada em claro.
    const delivery = await runSql<{ token_hash: string }>(`select token_hash from public.deliveries`);
    expect(delivery[0].token_hash).toBe(sha256Hex(`token-entrega-${body.order.order_id}`));
    // O caminho completo de entrega (decifra a credencial) é coberto em
    // `05_end_to_end_flow`, que monta o token cifrado pelo fluxo real.
  }, 60000);
});

describe('modo demonstrativo mantém as três travas', () => {
  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
  }, 60000);

  it('sem autorização do ambiente a rota não existe, mesmo com o banco ligado', async () => {
    const response = await handleDemoPayment(
      new Request('https://fn.test/demo-payment', { method: 'GET' }),
      buildDeps({ demoPaymentEnabled: false }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { demo_enabled: boolean }).demo_enabled).toBe(false);

    const approve = await handleDemoPayment(
      postJson('demo-payment', { action: 'approve', order_id: '00000000-0000-4000-8000-000000000000', client_token: 'x'.repeat(43) }),
      buildDeps({ demoPaymentEnabled: false }),
    );
    expect(approve.status).toBe(404);
  });

  it('com a chave do banco desligada, a aprovação simulada é recusada', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });
    await markDemo(seed.productId);
    const token = 'demo-token-abcdefghijklmnopqrstuvwx';
    const created = await checkout(seed.productId, { client_token: token });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { order: { order_id: string } };

    await runSql(`update public.app_settings set value = 'false'::jsonb where key = 'demo_payments_enabled'`);
    try {
      const response = await handleDemoPayment(
        postJson('demo-payment', { action: 'approve', order_id: body.order.order_id, client_token: token }),
        buildDeps(),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
        // O banco recusa a simulação; a rota responde como indisponível (404).
      expect(((await response.json()) as { error: string }).error).toBe('demo_unavailable');

      const order = await runSql<{ status: string; payment_status: string }>(
        `select status, payment_status from public.orders where id = $1`,
        [body.order.order_id],
      );
      expect(order[0]).toEqual({ status: 'pending_payment', payment_status: 'pending' });
    } finally {
      await runSql(`update public.app_settings set value = 'true'::jsonb where key = 'demo_payments_enabled'`);
    }
  }, 60000);

  it('a aprovação simulada não faz nenhuma chamada ao provedor', async () => {
    const seed = await seedProduct({ stockUnits: 1, maxQuantity: 5 });
    await markDemo(seed.productId);
    const token = 'demo-token-sem-provedor-abcdefghijkl';
    const calls: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      calls.push(String(input));
      return mercadoPago.fetchImpl(input as RequestInfo, init);
    };

    const created = await checkout(seed.productId, { client_token: token }, buildDeps({}, spy));
    expect(created.status).toBe(201);
    const body = (await created.json()) as { order: { order_id: string }; payment: { status: string } };
    expect(body.payment.status).toBe('pending');
    const callsAfterCheckout = calls.length;

    const approved = await handleDemoPayment(
      postJson('demo-payment', { action: 'approve', order_id: body.order.order_id, client_token: token }),
      buildDeps({}, spy),
    );
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as { demo: boolean; payment_status: string };
    expect(approvedBody.demo).toBe(true);
    expect(approvedBody.payment_status).toBe('approved');
    // Nenhuma requisição nova ao provedor: a aprovação foi simulada no banco.
    expect(calls.length).toBe(callsAfterCheckout);
  }, 60000);

  it('a semeadura exige o token de preparação do Vault', async () => {
    const seed = await seedProduct({ stockUnits: 0, maxQuantity: 5 });
    await runSql(`update public.products set is_demo = true where id = $1`, [seed.productId]);

    // Só a leitura do segredo é simulada: o resto continua indo ao PostgreSQL.
    const base = buildDeps();
    const deps: Deps = {
      ...base,
      serviceRpc: (async (name: string, args?: Record<string, unknown>) =>
        name === 'get_secret_material' ? 'token-de-preparacao-do-teste' : base.serviceRpc!(name, args)) as Deps['serviceRpc'],
    };
    const seedRequest = (headers: Record<string, string> = {}) => {
      const body = JSON.stringify({ action: 'seed', product_id: seed.productId, units: 2 });
      return new Request('https://fn.test/demo-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
    };

    expect((await handleDemoPayment(seedRequest(), deps)).status).toBe(403);
    expect((await handleDemoPayment(seedRequest({ 'x-demo-setup-token': 'errado' }), deps)).status).toBe(403);
    const unitsFor = () =>
      sqlValue<number>(`select count(*) from public.stock_units where product_id = $1`, [seed.productId]);
    expect(Number(await unitsFor())).toBe(0);

    const authorized = await handleDemoPayment(seedRequest({ 'x-demo-setup-token': 'token-de-preparacao-do-teste' }), deps);
    expect(authorized.status).toBe(200);
    expect(((await authorized.json()) as { created: number }).created).toBe(2);
    // Unidades fictícias nascem marcadas como demonstração.
    expect(
      Number(await sqlValue<number>(`select count(*) from public.stock_units where product_id = $1 and is_demo and status = 'available'`, [seed.productId])),
    ).toBe(2);
  }, 60000);
});

describe('permissões não foram enfraquecidas', () => {
  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
  }, 60000);

  it('anon não lê nenhuma tabela nem view e não executa nenhuma função', async () => {
    for (const table of ['orders', 'stock_units', 'deliveries', 'public_catalog', 'payment_events', 'rate_limit_counters']) {
      await expect(runAs(`select * from public.${table} limit 1`, [], { role: 'anon' })).rejects.toMatchObject({
        code: '42501',
      });
    }
    for (const fn of ['get_catalog()', `consume_rate_limit('catalog', repeat('a', 32), 1, 60)`, 'get_order_status(gen_random_uuid(), repeat(\'a\', 64))']) {
      await expect(runAs(`select public.${fn}`, [], { role: 'anon' })).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('authenticated não lê tabela direta e as funções admin exigem admin', async () => {
    await expect(runAs(`select * from public.orders limit 1`, [], { role: 'authenticated' })).rejects.toMatchObject({
      code: '42501',
    });

    const nonAdmin = { role: 'authenticated', claims: { sub: '00000000-0000-4000-8000-000000000001', role: 'authenticated' } };
    await expect(runAs(`select public.admin_list_orders()`, [], nonAdmin)).rejects.toMatchObject({
      code: expect.stringMatching(/42501|P0001/),
    });
  });

  it('service_role mantém acesso ao conjunto completo de objetos (nada de novo ficou exposto a anon)', async () => {
    // 20 -> 21 objetos legíveis pela service_role na missão 08: `order_items`
    // entrou com RLS ligada e privilégios só para o backend (mesma regra de
    // `stock_units`). O número de tabelas com RLS sobe de 19 para 20 junto.
    expect(
      Number(
        await sqlValue<number>(
          `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r','v') and has_table_privilege('service_role', c.oid, 'SELECT')`,
        ),
      ),
    ).toBe(21);
    expect(
      Number(
        await sqlValue<number>(
          `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`,
        ),
      ),
    ).toBe(20);
  });
});

describe('histórico de migrações do repositório continua coerente', () => {
  it('todos os arquivos aplicam do zero, na ordem, sem erro', async () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(32);
    // Ordem lexicográfica = ordem cronológica (prefixo de carimbo de tempo).
    expect([...files].sort()).toEqual(files);
    // Carimbos únicos: duas migrações não podem competir pela mesma posição.
    const stamps = files.map((file) => file.slice(0, 14));
    expect(new Set(stamps).size).toBe(stamps.length);
    // A suíte inteira recria o banco do zero; aqui o schema já está aplicado.
    expect(Number(await sqlValue<number>(`select count(*) from public.rate_limit_counters`))).toBe(0);
  });
});
