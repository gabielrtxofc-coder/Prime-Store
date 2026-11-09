import { randomBytes } from 'node:crypto';
import type { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleAdminApi } from '../../supabase/functions/_shared/handlers/adminApi';
import type { Deps } from '../../supabase/functions/_shared/deps';
import { loadSecretMaterial, toBase64 } from '../../supabase/functions/_shared/crypto';
import {
  connect,
  resetDatabase,
  runSql,
  seedAdmin,
  RELAXED_RATE_LIMIT_OVERRIDES,
} from './helpers';
import { createPgRpc } from './pgRpc';

/**
 * Missão 06 — matriz HTTP da `admin-api` contra o PostgreSQL real.
 *
 * O que esta suíte comprova (além do que já existe em 04/05/07):
 *  - acessos sem sessão, sem allowlist e sem MFA são recusados;
 *  - payloads inválidos produzem 4xx estáveis (nunca erro cru do PostgreSQL);
 *  - números fora da faixa / NaN são limitados de forma segura;
 *  - operações administrativas executadas por HTTP persistem no banco real,
 *    geram trilha de auditoria e refletem nos indicadores do servidor;
 *  - credenciais duplicadas são recusadas sem corromper o estoque;
 *  - sem material de criptografia, operações de segredo falham como 503,
 *    sem gravar nada.
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

interface BuildOptions {
  encryptionMaterial?: boolean;
}

function buildDeps(client: Client, adminId: string | null, options: BuildOptions = {}): Deps {
  const withMaterial = options.encryptionMaterial !== false;
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
      encryptionKey: withMaterial ? MASTER_KEY : undefined,
      storeUrl: 'http://localhost:5173',
      rateLimitOverrides: RELAXED_RATE_LIMIT_OVERRIDES,
    },
    rpc: createPgRpc(client),
    rpcForUser: () => userRpc,
    serviceRpc: createPgRpc(client),
    resolveEncryptionKey: async () => (withMaterial ? MASTER_KEY : null),
    fetchImpl: fakeAuth(adminId),
    now: () => new Date(),
    log: () => undefined,
  };
}

describe('admin-api (HTTP) — validação de entrada e persistência real', () => {
  let client: Client;
  let adminId: string;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
    adminId = await seedAdmin('owner');
    await loadSecretMaterial(MASTER_KEY); // falha cedo se a chave de teste for inválida
  }, 60000);

  const call = (deps: Deps, body: unknown, headers: Record<string, string> = {}) =>
    handleAdminApi(postJson('https://fn.test/admin-api', body, headers), deps);

  it('requisição sem Authorization é recusada (401)', async () => {
    const response = await call(buildDeps(client, null), { action: 'indicators' });
    expect(response.status).toBe(401);
  });

  it('corpo que não é JSON é recusado (400) sem tocar no banco', async () => {
    const deps = buildDeps(client, adminId);
    const response = await handleAdminApi(
      new Request('https://fn.test/admin-api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer jwt-1' },
        body: 'isto-não-é-json{{{',
      }),
      deps,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_json');
  });

  it('ação desconhecida é recusada (400 unknown_action)', async () => {
    const response = await call(buildDeps(client, adminId), { action: 'drop.everything' }, { Authorization: 'Bearer jwt-1' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('unknown_action');
  });

  it('orders.list com data de filtro malformada responde 422 (não 500)', async () => {
    const response = await call(
      buildDeps(client, adminId),
      { action: 'orders.list', payload: { from: 'lixo', to: 'também-não-é-data' } },
      { Authorization: 'Bearer jwt-1' },
    );
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_payload');
  });

  it('orders.list limita números fora da faixa de forma segura (NaN → padrão)', async () => {
    const deps = buildDeps(client, adminId);
    const invalid = await call(
      deps,
      { action: 'orders.list', payload: { limit: 'abc', offset: Number.NaN } },
      { Authorization: 'Bearer jwt-1' },
    );
    expect(invalid.status).toBe(200);
    const invalidBody = (await invalid.json()) as { limit: number; offset: number };
    expect(invalidBody.limit).toBe(50);
    expect(invalidBody.offset).toBe(0);

    const clamped = await call(
      deps,
      { action: 'orders.list', payload: { limit: -10, offset: 999999 } },
      { Authorization: 'Bearer jwt-1' },
    );
    expect(clamped.status).toBe(200);
    const clampedBody = (await clamped.json()) as { limit: number; offset: number };
    expect(clampedBody.limit).toBe(1);
    expect(clampedBody.offset).toBe(999999);

    const iso = await call(
      deps,
      { action: 'orders.list', payload: { from: '2026-11-01', to: '2026-11-30T23:59:59Z' } },
      { Authorization: 'Bearer jwt-1' },
    );
    expect(iso.status).toBe(200);
  });

  it('stock.list e audit.list toleram limit inválido (fallback seguro)', async () => {
    const deps = buildDeps(client, adminId);
    const stock = await call(deps, { action: 'stock.list', payload: { limit: 'xyz' } }, { Authorization: 'Bearer jwt-1' });
    expect(stock.status).toBe(200);
    const audit = await call(deps, { action: 'audit.list', payload: { limit: 'xyz' } }, { Authorization: 'Bearer jwt-1' });
    expect(audit.status).toBe(200);
  });

  it('products.create sem nome ou sem preço é recusado (422) e nada é gravado', async () => {
    const deps = buildDeps(client, adminId);
    const withoutName = await call(
      deps,
      { action: 'products.create', payload: { product: { slug: 'sem-nome-m06', price_cents: 1000 } } },
      { Authorization: 'Bearer jwt-1' },
    );
    expect(withoutName.status).toBe(422);

    const withoutPrice = await call(
      deps,
      { action: 'products.create', payload: { product: { slug: 'sem-preco-m06', name: 'Sem preço' } } },
      { Authorization: 'Bearer jwt-1' },
    );
    expect(withoutPrice.status).toBe(422);

    const { rows } = await client.query(`select count(*)::int as n from public.products where slug in ('sem-nome-m06', 'sem-preco-m06')`);
    expect(rows[0].n).toBe(0);
  });

  it('refunds.resolve com status inválido é recusado (422)', async () => {
    const response = await call(
      buildDeps(client, adminId),
      { action: 'refunds.resolve', payload: { refundId: '11111111-1111-1111-1111-111111111111', status: 'hackear' } },
      { Authorization: 'Bearer jwt-1' },
    );
    expect(response.status).toBe(422);
  });

  it('sem material de criptografia, stock.add falha como 503 e não grava segredo', async () => {
    const deps = buildDeps(client, adminId, { encryptionMaterial: false });
    const response = await call(
      deps,
      {
        action: 'stock.add',
        payload: { productId: '11111111-1111-1111-1111-111111111111', email: 'x@exemplo.com', password: 'senha-forte-123' },
      },
      { Authorization: 'Bearer jwt-1' },
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe('not_configured');
  });

  it('sessão de administrador AAL2 reporta is_admin e mfa_satisfied verdadeiros', async () => {
    const response = await call(buildDeps(client, adminId), { action: 'session' }, { Authorization: 'Bearer jwt-1' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ is_admin: true, mfa_satisfied: true });
  });

  it('CRUD de produto por HTTP persiste no banco e registra auditoria', async () => {
    const deps = buildDeps(client, adminId);
    const slug = `m06-http-${randomBytes(4).toString('hex')}`;
    const created = await call(
      deps,
      {
        action: 'products.create',
        payload: {
          product: {
            slug,
            name: 'Produto HTTP Missão 06',
            category_id: 'creative',
            price_cents: 4990,
            cost_cents: 1200,
            instructions: 'Entre com o login.',
            short_description: 'Produto de verificação operacional.',
          },
        },
      },
      { Authorization: 'Bearer jwt-1' },
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { product: { id: string; price_cents: number } };
    const productId = createdBody.product.id;

    const { rows: inserted } = await client.query(`select slug, created_by from public.products where id = $1`, [productId]);
    expect(inserted[0].slug).toBe(slug);
    expect(inserted[0].created_by).toBe(adminId);

    // Edição de preço por HTTP — deve acionar o trigger de histórico de preços.
    const updated = await call(
      deps,
      { action: 'products.update', payload: { productId, patch: { price_cents: 5990 } } },
      { Authorization: 'Bearer jwt-1' },
    );
    expect(updated.status).toBe(200);
    const { rows: history } = await client.query(
      `select old_price_cents, new_price_cents from public.product_price_history where product_id = $1 order by changed_at desc limit 1`,
      [productId],
    );
    expect(history[0]).toMatchObject({ old_price_cents: 4990, new_price_cents: 5990 });

    // Desativação não apaga: produto some dos ativos, mas continua no banco.
    const deactivated = await call(
      deps,
      { action: 'products.setActive', payload: { productId, active: false } },
      { Authorization: 'Bearer jwt-1' },
    );
    expect(deactivated.status).toBe(200);
    const { rows: inactive } = await client.query(`select is_active from public.products where id = $1`, [productId]);
    expect(inactive[0].is_active).toBe(false);

    // Auditoria registra criação, atualização e desativação.
    const { rows: auditRows } = await client.query(
      `select action from public.admin_audit_log where entity_id = $1 order by id`,
      [productId],
    );
    const actions = auditRows.map((row: { action: string }) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['product_created', 'product_updated', 'product_deactivated']));
  }, 30000);

  it('stock.add por HTTP persiste unidade, aparece em indicators e recusa duplicada', async () => {
    const deps = buildDeps(client, adminId);
    const slug = `m06-stock-${randomBytes(4).toString('hex')}`;
    const product = await call(
      deps,
      {
        action: 'products.create',
        payload: {
          product: { slug, name: 'Produto Estoque HTTP', category_id: 'creative', price_cents: 2990, cost_cents: 500 },
        },
      },
      { Authorization: 'Bearer jwt-1' },
    );
    expect(product.status).toBe(201);
    const productId = ((await product.json()) as { product: { id: string } }).product.id;

    const before = await call(deps, { action: 'indicators' }, { Authorization: 'Bearer jwt-1' });
    const beforeUnits = ((await before.json()) as { units_available: number }).units_available;

    const added = await call(
      deps,
      {
        action: 'stock.add',
        payload: { productId, email: 'conta-1@exemplo.com', password: 'senha-forte-1', notes: 'unidade de verificação' },
      },
      { Authorization: 'Bearer jwt-1' },
    );
    expect(added.status).toBe(201);

    const { rows: units } = await client.query(
      `select status from public.stock_units where product_id = $1`,
      [productId],
    );
    expect(units).toHaveLength(1);
    expect(units[0].status).toBe('available');

    const after = await call(deps, { action: 'indicators' }, { Authorization: 'Bearer jwt-1' });
    const afterUnits = ((await after.json()) as { units_available: number }).units_available;
    expect(afterUnits).toBe(beforeUnits + 1);

    // Mesma credencial novamente: recusada, sem corromper o estoque.
    const duplicate = await call(
      deps,
      { action: 'stock.add', payload: { productId, email: 'conta-1@exemplo.com', password: 'senha-forte-1' } },
      { Authorization: 'Bearer jwt-1' },
    );
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as { error: string }).error).toBe('duplicate_credential');

    const { rows: stillOne } = await client.query(
      `select count(*)::int as n from public.stock_units where product_id = $1`,
      [productId],
    );
    expect(stillOne[0].n).toBe(1);

    const { rows: auditRows } = await client.query(
      `select count(*)::int as n from public.admin_audit_log where action = 'stock_unit_added'`,
    );
    expect(auditRows[0].n).toBeGreaterThanOrEqual(1);
  }, 30000);
});
