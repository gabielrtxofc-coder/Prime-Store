import { randomBytes } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleAdminApi } from '../../supabase/functions/_shared/handlers/adminApi';
import type { Deps } from '../../supabase/functions/_shared/deps';
import { toBase64 } from '../../supabase/functions/_shared/crypto';
import {
  RELAXED_RATE_LIMIT_OVERRIDES,
  connect,
  resetDatabase,
  runSql,
  seedAdmin,
  seedProduct,
  sqlValue,
} from './helpers';
import { createPgRpc } from './pgRpc';

/**
 * Perfil operacional — matriz HTTP da `admin-api` contra o PostgreSQL real.
 *
 * O usuário entra só com e-mail + senha: o JWT tem `aal: 'aal1'` (sem TOTP).
 * Esta suíte comprova, de ponta a ponta (HTTP → handler → RPC → banco):
 *  - `session` informa `is_operator` para o painel escolher a tela;
 *  - operador em AAL1 adiciona/desativa estoque, importa CSV e edita os campos
 *    operacionais de produto;
 *  - campos proibidos, credenciais e ações administrativas são recusados com
 *    403 (o banco é a autoridade; o handler só antecipa a resposta);
 *  - respostas nunca carregam credencial, fingerprint, custo ou pedidos;
 *  - conta autenticada fora da allowlist recebe 403.
 */

const MASTER_KEY = toBase64(randomBytes(32));
const AUTH = { Authorization: 'Bearer jwt-operacional' };

function postJson(body: unknown, headers: Record<string, string> = AUTH): Request {
  return new Request('https://fn.test/admin-api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function fakeAuth(userId: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: userId }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

function buildDeps(client: Client, userId: string, aal: 'aal1' | 'aal2' = 'aal1'): Deps {
  const userRpc = createPgRpc(client, { role: 'authenticated', claims: { sub: userId, role: 'authenticated', aal } });
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
    fetchImpl: fakeAuth(userId),
    now: () => new Date(),
    log: () => undefined,
  };
}

const SENSITIVE = /cost_cents|margin_cents|credential_fingerprint|account_email_enc|account_password_enc|sold_order_id|reservation_order_id|"password"|"email"/;

async function newUser(prefix: string): Promise<string> {
  const rows = await runSql<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [
    `${prefix}-${randomBytes(4).toString('hex')}@prime.invalid`,
  ]);
  return rows[0].id;
}

describe('admin-api (HTTP) — perfil operacional com e-mail + senha (AAL1)', () => {
  let client: Client;
  let operatorId: string;
  let strangerId: string;
  let productId: string;
  let deps: Deps;

  const call = async (body: unknown, useDeps: Deps = deps) => {
    const response = await handleAdminApi(postJson(body), useDeps);
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
    operatorId = await newUser('operador');
    strangerId = await newUser('estranho');
    await runSql(`insert into public.operator_users (user_id, display_name) values ($1, 'Operador Loja')`, [operatorId]);
    productId = (await seedProduct({ stockUnits: 1, costCents: 999 })).productId;
    deps = buildDeps(client, operatorId, 'aal1');
  }, 60000);

  afterAll(async () => {
    await client?.end();
  });

  it('session informa is_operator=true e is_admin=false (sem MFA)', async () => {
    const { status, body } = await call({ action: 'session' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ is_operator: true, is_admin: false, mfa_satisfied: false });
  });

  it('ops.session confirma o perfil operacional', async () => {
    const { status, body } = await call({ action: 'ops.session' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ user_id: operatorId, profile: 'operational' });
  });

  it('lista produtos e estoque sem dados sensíveis', async () => {
    const products = await call({ action: 'ops.products.list' });
    expect(products.status).toBe(200);
    expect(products.text).not.toMatch(SENSITIVE);

    const summary = await call({ action: 'ops.stock.summary' });
    expect(summary.status).toBe(200);
    expect(summary.text).not.toMatch(SENSITIVE);

    const list = await call({ action: 'ops.stock.list', payload: { productId } });
    expect(list.status).toBe(200);
    expect(list.text).not.toMatch(SENSITIVE);
    expect((list.body.items as unknown[]).length).toBe(1);
  });

  it('adiciona estoque (cifrado no servidor) e o banco guarda só ciphertext', async () => {
    const { status, text } = await call({
      action: 'ops.stock.add',
      payload: { productId, email: 'cliente.novo@exemplo.com', password: 'Senha#Forte1', notes: 'lote' },
    });
    expect(status).toBe(201);
    expect(text).not.toContain('Senha#Forte1');
    const plain = await sqlValue<number>(
      `select count(*)::int from public.stock_units
        where product_id = $1
          and (position(convert_to('Senha#Forte1', 'UTF8') in account_password_enc) > 0
               or position(convert_to('cliente.novo@exemplo.com', 'UTF8') in account_email_enc) > 0)`,
      [productId],
    );
    expect(plain).toBe(0);
    const available = await sqlValue<number>(
      `select count(*)::int from public.stock_units where product_id = $1 and status = 'available'`,
      [productId],
    );
    expect(available).toBe(2);
  });

  it('mesma credencial de novo é recusada (409), sem duplicar estoque', async () => {
    const { status } = await call({
      action: 'ops.stock.add',
      payload: { productId, email: 'cliente.novo@exemplo.com', password: 'Senha#Forte1' },
    });
    expect(status).toBe(409);
  });

  it('desativa e reativa unidade com motivo', async () => {
    const list = await call({ action: 'ops.stock.list', payload: { productId, status: 'available' } });
    const unitId = (list.body.items as Array<{ id: string }>)[0].id;
    const off = await call({
      action: 'ops.stock.setStatus',
      payload: { stockUnitId: unitId, status: 'disabled', reason: 'invalid_credential' },
    });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ status: 'disabled' });
    const noReason = await call({ action: 'ops.stock.setStatus', payload: { stockUnitId: unitId, status: 'disabled' } });
    expect(noReason.status).toBe(422);
    const on = await call({ action: 'ops.stock.setStatus', payload: { stockUnitId: unitId, status: 'available' } });
    expect(on.status).toBe(200);
  });

  it('importação CSV: pré-visualização mascarada e gravação com relatório', async () => {
    const csv = 'email,senha\nimport1@exemplo.com,Abc12345\nimport2@exemplo.com,Abc12346\nnao-e-email,xx\n';
    const preview = await call({ action: 'ops.stock.import.preview', payload: { productId, csv } });
    expect(preview.status).toBe(200);
    expect(preview.text).not.toContain('Abc12345');
    expect(preview.body.valid_rows).toBe(2);

    const commit = await call({ action: 'ops.stock.import.commit', payload: { productId, csv, fileName: 'lote.csv' } });
    expect(commit.status).toBe(201);
    expect((commit.body.report as { imported: number }).imported).toBe(2);
    expect(commit.text).not.toMatch(SENSITIVE);
  });

  it('edita campos operacionais do produto', async () => {
    const { status, body, text } = await call({
      action: 'ops.products.update',
      payload: { productId, patch: { name: 'Nome pelo operador', max_quantity_per_order: 2 } },
    });
    expect(status).toBe(200);
    expect((body.product as { name: string }).name).toBe('Nome pelo operador');
    expect(text).not.toMatch(SENSITIVE);
  });

  it('campo proibido (preço/custo/slug) → 403 field_not_allowed, nada é gravado', async () => {
    for (const patch of [{ price_cents: 1 }, { cost_cents: 0 }, { slug: 'x-y' }, { name: 'ok', category_id: 'games' }]) {
      const { status, body } = await call({ action: 'ops.products.update', payload: { productId, patch } });
      expect(status, JSON.stringify(patch)).toBe(403);
      expect(body.error).toBe('field_not_allowed');
    }
    const price = await sqlValue<number>(`select price_cents from public.products where id = $1`, [productId]);
    expect(price).toBe(5000);
  });

  it('pedir credenciais na listagem é recusado (403)', async () => {
    const { status } = await call({ action: 'ops.stock.list', payload: { productId, includeCredentials: true } });
    expect(status).toBe(403);
  });

  it.each([
    'indicators',
    'orders.list',
    'refunds.list',
    'audit.list',
    'products.create',
    'products.get',
    'stock.list',
    'stock.update',
    'deliveries.revoke',
    'reservations.expire',
  ])('ação administrativa %s é recusada para o operador (403)', async (action) => {
    // Payload válido o bastante para chegar ao banco: a recusa vem de
    // assert_admin(), não de validação de entrada.
    const unitId = await sqlValue<string>(`select id::text from public.stock_units where product_id = $1 limit 1`, [
      productId,
    ]);
    const before = await sqlValue<number>(`select count(*)::int from public.products`);
    const { status } = await call({
      action,
      payload: {
        productId,
        orderId: productId,
        deliveryId: productId,
        stockUnitId: unitId,
        notes: 'tentativa',
        product: { name: 'Produto pirata', slug: 'produto-pirata', price_cents: 100, category_id: 'music' },
      },
    });
    expect(status).toBe(403);
    expect(await sqlValue<number>(`select count(*)::int from public.products`)).toBe(before);
  });

  it('conta autenticada fora da allowlist operacional recebe 403 em ops.*', async () => {
    const strangerDeps = buildDeps(client, strangerId, 'aal1');
    for (const action of ['ops.session', 'ops.stock.summary', 'ops.products.list']) {
      const { status } = await call({ action }, strangerDeps);
      expect(status, action).toBe(403);
    }
    const session = await call({ action: 'session' }, strangerDeps);
    expect(session.body).toMatchObject({ is_operator: false, is_admin: false });
  });

  it('não-operador não chega a cifrar nada (ops.stock.add → 403 antes do banco gravar)', async () => {
    const strangerDeps = buildDeps(client, strangerId, 'aal1');
    const before = await sqlValue<number>(`select count(*)::int from public.stock_units`);
    const { status } = await call(
      { action: 'ops.stock.add', payload: { productId, email: 'x@exemplo.com', password: 'Senha123' } },
      strangerDeps,
    );
    expect(status).toBe(403);
    expect(await sqlValue<number>(`select count(*)::int from public.stock_units`)).toBe(before);
  });

  it('administrador em AAL2 continua com o painel completo (controle positivo)', async () => {
    const adminId = await seedAdmin('owner');
    const adminDeps = buildDeps(client, adminId, 'aal2');
    const { status, body } = await call({ action: 'session' }, adminDeps);
    expect(status).toBe(200);
    expect(body).toMatchObject({ is_admin: true, mfa_satisfied: true, is_operator: false });
    const indicators = await call({ action: 'indicators' }, adminDeps);
    expect(indicators.status).toBe(200);
  });

  it('administrador em AAL1 continua bloqueado no perfil administrativo (403 mfa_required)', async () => {
    const adminId = await seedAdmin('admin');
    const adminDeps = buildDeps(client, adminId, 'aal1');
    const { status, body } = await call({ action: 'indicators' }, adminDeps);
    expect(status).toBe(403);
    expect(body.error).toBe('mfa_required');
  });
});
