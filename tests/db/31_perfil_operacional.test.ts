import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fakeCiphertextB64,
  hmacHex,
  resetDatabase,
  runAs,
  runSql,
  seedAdmin,
  seedProduct,
  sqlValue,
} from './helpers';

/**
 * Missão — simplificação da autenticação operacional.
 *
 * Perfil OPERACIONAL: e-mail + senha (sessão AAL1, sem TOTP) e acesso apenas
 * às funções `ops_*`. Estes testes provam, no próprio PostgreSQL:
 *  - o operador altera estoque e informações autorizadas de produto em AAL1;
 *  - campos/ações não autorizados são recusados (não descartados);
 *  - funções administrativas continuam exigindo allowlist admin + AAL2;
 *  - nenhuma saída operacional contém credenciais, fingerprint, custo,
 *    pedidos ou dados de cliente;
 *  - ninguém se autopromove a operador; tabelas seguem fechadas.
 */

async function seedUser(prefix = 'op'): Promise<string> {
  const rows = await runSql<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [
    `${prefix}-${randomBytes(4).toString('hex')}@prime.invalid`,
  ]);
  return rows[0].id;
}

async function seedOperator(active = true): Promise<string> {
  const userId = await seedUser('operador');
  await runSql(`insert into public.operator_users (user_id, display_name, is_active) values ($1, 'Operador Loja', $2)`, [
    userId,
    active,
  ]);
  return userId;
}

function asUser(userId: string, aal: 'aal1' | 'aal2' = 'aal1') {
  return { role: 'authenticated', claims: { sub: userId, role: 'authenticated', aal } } as const;
}

async function opsCall<T = unknown>(userId: string, sql: string, values: unknown[] = [], aal: 'aal1' | 'aal2' = 'aal1') {
  const rows = await runAs<{ r: T }>(sql, values, asUser(userId, aal));
  return rows[0]?.r as T;
}

const FORBIDDEN_OUTPUT_KEYS = [
  'cost_cents',
  'margin_cents',
  'account_email_enc',
  'account_password_enc',
  'credential_fingerprint',
  'email',
  'password',
  'sold_order_id',
  'reservation_order_id',
  'customer_email',
  'customer_name',
  'created_by',
  'updated_by',
];

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, keys));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      keys.add(key);
      collectKeys(inner, keys);
    }
  }
  return keys;
}

function expectNoSensitiveKeys(value: unknown) {
  const keys = collectKeys(value);
  for (const forbidden of FORBIDDEN_OUTPUT_KEYS) {
    expect(keys.has(forbidden), `saída operacional expôs "${forbidden}"`).toBe(false);
  }
}

beforeAll(async () => {
  await resetDatabase();
});

describe('perfil operacional — estrutura e isolamento', () => {
  it('operator_users tem RLS, nenhuma política e nenhum grant para anon/authenticated', async () => {
    const rls = await sqlValue<boolean>(
      `select relrowsecurity from pg_class where oid = 'public.operator_users'::regclass`,
    );
    expect(rls).toBe(true);
    const policies = await sqlValue<number>(
      `select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'operator_users'`,
    );
    expect(policies).toBe(0);
    for (const role of ['anon', 'authenticated']) {
      for (const privilege of ['select', 'insert', 'update', 'delete']) {
        const allowed = await sqlValue<boolean>(
          `select has_table_privilege($1, 'public.operator_users', $2)`,
          [role, privilege],
        );
        expect(allowed, `${role} ${privilege}`).toBe(false);
      }
    }
  });

  it('anon não executa nenhuma função ops_* nem is_operator', async () => {
    const rows = await runSql<{ proname: string; allowed: boolean }>(
      `select p.proname, has_function_privilege('anon', p.oid, 'execute') as allowed
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and (p.proname like 'ops\\_%' or p.proname like '%operator%')`,
    );
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect(row.allowed, row.proname).toBe(false);
  });

  it('funções internas (assert/log/projeção) não são executáveis pelo cliente', async () => {
    for (const fn of ['assert_operator', 'log_operator_action', 'ops_product_projection']) {
      const allowed = await sqlValue<boolean>(
        `select bool_or(has_function_privilege('authenticated', p.oid, 'execute'))
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [fn],
      );
      expect(allowed, fn).toBe(false);
    }
  });

  it('toda função ops_* exposta começa por assert_operator() e é SECURITY DEFINER com search_path fixo', async () => {
    const rows = await runSql<{ proname: string; src: string; secdef: boolean; config: string[] | null }>(
      `select p.proname, p.prosrc as src, p.prosecdef as secdef, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'ops\\_%' and p.proname <> 'ops_product_projection'`,
    );
    expect(rows.length).toBe(9);
    for (const row of rows) {
      expect(row.src, row.proname).toContain('assert_operator()');
      expect(row.secdef, row.proname).toBe(true);
      expect((row.config ?? []).join(','), row.proname).toContain('search_path=public, pg_temp');
    }
  });

  it('ninguém se autopromove a operador (insert direto negado)', async () => {
    const userId = await seedUser('intruso');
    await expect(
      runAs(
        `insert into public.operator_users (user_id, display_name) values ($1, 'Eu mesmo')`,
        [userId],
        asUser(userId),
      ),
    ).rejects.toThrow(/permission denied/);
    const count = await sqlValue<number>(
      `select count(*)::int from public.operator_users where user_id = $1`,
      [userId],
    );
    expect(count).toBe(0);
  });

  it('operador não lê tabelas diretamente (produtos, estoque, pedidos, admin_users)', async () => {
    const operator = await seedOperator();
    for (const table of ['products', 'stock_units', 'orders', 'payments', 'admin_users', 'operator_users', 'admin_audit_log']) {
      await expect(runAs(`select * from public.${table} limit 1`, [], asUser(operator)), table).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});

describe('perfil operacional — sessão (e-mail + senha, AAL1)', () => {
  it('operador ativo em AAL1 abre a sessão operacional', async () => {
    const operator = await seedOperator();
    const session = await opsCall<{ user_id: string; profile: string; display_name: string }>(
      operator,
      `select public.ops_session() as r`,
    );
    expect(session.user_id).toBe(operator);
    expect(session.profile).toBe('operational');
    expect(await opsCall<boolean>(operator, `select public.is_operator() as r`)).toBe(true);
  });

  it('usuário autenticado fora da allowlist recebe not_operator', async () => {
    const stranger = await seedUser('estranho');
    await expect(runAs(`select public.ops_session()`, [], asUser(stranger))).rejects.toThrow(/not_operator/);
    expect(await opsCall<boolean>(stranger, `select public.is_operator() as r`)).toBe(false);
  });

  it('operador desativado perde o acesso imediatamente', async () => {
    const operator = await seedOperator(false);
    await expect(runAs(`select public.ops_session()`, [], asUser(operator))).rejects.toThrow(/not_operator/);
  });

  it('sem JWT (sub ausente) a chamada é recusada', async () => {
    await expect(
      runAs(`select public.ops_session()`, [], { role: 'authenticated', claims: { role: 'authenticated' } as never }),
    ).rejects.toThrow(/not_authenticated|not_operator/);
  });

  it('operador NÃO é administrador: admin_* recusam em AAL1 e também em AAL2', async () => {
    const operator = await seedOperator();
    for (const aal of ['aal1', 'aal2'] as const) {
      await expect(runAs(`select public.admin_list_products(null, true)`, [], asUser(operator, aal))).rejects.toThrow(
        /not_admin/,
      );
      await expect(runAs(`select public.admin_indicators()`, [], asUser(operator, aal))).rejects.toThrow(/not_admin/);
      await expect(
        runAs(`select public.admin_list_stock(null, null, null, 10, 0, true)`, [], asUser(operator, aal)),
      ).rejects.toThrow(/not_admin/);
    }
  });

  it('administrador em AAL1 continua bloqueado no perfil administrativo (proteção preservada)', async () => {
    const admin = await seedAdmin('owner');
    await expect(runAs(`select public.admin_indicators()`, [], asUser(admin, 'aal1'))).rejects.toThrow(
      /mfa_required/,
    );
  });
});

describe('perfil operacional — produtos', () => {
  let operator: string;
  let productId: string;

  beforeEach(async () => {
    operator = await seedOperator();
    productId = (await seedProduct({ costCents: 1234, priceCents: 5000, stockUnits: 1 })).productId;
  });

  it('lista produtos sem custo, margem ou autoria', async () => {
    const products = await opsCall<Array<Record<string, unknown>>>(
      operator,
      `select public.ops_list_products(null, true) as r`,
    );
    const found = products.find((item) => item.id === productId);
    expect(found).toBeTruthy();
    expect(found?.available_units).toBe(1);
    expectNoSensitiveKeys(products);
  });

  it('atualiza campos operacionais autorizados em AAL1 e registra auditoria com perfil operacional', async () => {
    const product = await opsCall<Record<string, unknown>>(
      operator,
      `select public.ops_update_product($1, $2::jsonb) as r`,
      [
        productId,
        JSON.stringify({
          name: 'Nome Operacional',
          short_description: 'Resumo novo',
          instructions: 'Novas instruções',
          conditions: ['Uso individual'],
          access_validity_label: '60 dias',
          max_quantity_per_order: 3,
          is_featured: true,
        }),
      ],
    );
    expect(product.name).toBe('Nome Operacional');
    expect(product.max_quantity_per_order).toBe(3);
    expectNoSensitiveKeys(product);

    const stored = await runSql<{ name: string; cost_cents: number; price_cents: number }>(
      `select name, cost_cents, price_cents from public.products where id = $1`,
      [productId],
    );
    expect(stored[0]).toMatchObject({ name: 'Nome Operacional', cost_cents: 1234, price_cents: 5000 });

    const audit = await runSql<{ metadata: Record<string, unknown> }>(
      `select metadata from public.admin_audit_log
        where actor_user_id = $1 and action = 'product_updated' and entity_id = $2::text`,
      [operator, productId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata.profile).toBe('operational');
  });

  it.each([
    ['price_cents', 1],
    ['cost_cents', 0],
    ['slug', 'slug-roubado'],
    ['category_id', 'games'],
    ['archived_at', '2026-01-01T00:00:00Z'],
    ['created_by', '00000000-0000-0000-0000-000000000001'],
  ])('recusa alteração de campo não autorizado: %s', async (field, value) => {
    await expect(
      runAs(
        `select public.ops_update_product($1, $2::jsonb)`,
        [productId, JSON.stringify({ name: 'Ok', [field]: value })],
        asUser(operator),
      ),
    ).rejects.toThrow(/operator_field_not_allowed/);
    const stored = await runSql<{ name: string; price_cents: number; cost_cents: number; slug: string }>(
      `select name, price_cents, cost_cents, slug from public.products where id = $1`,
      [productId],
    );
    expect(stored[0].name).not.toBe('Ok');
    expect(stored[0].price_cents).toBe(5000);
    expect(stored[0].cost_cents).toBe(1234);
  });

  it('respeita as restrições do produto (quantidade máxima válida)', async () => {
    await expect(
      runAs(
        `select public.ops_update_product($1, $2::jsonb)`,
        [productId, JSON.stringify({ max_quantity_per_order: 0 })],
        asUser(operator),
      ),
    ).rejects.toThrow();
  });

  it('ativa e desativa produto', async () => {
    const off = await opsCall<Record<string, unknown>>(
      operator,
      `select public.ops_set_product_active($1, false) as r`,
      [productId],
    );
    expect(off.is_active).toBe(false);
    const on = await opsCall<Record<string, unknown>>(
      operator,
      `select public.ops_set_product_active($1, true) as r`,
      [productId],
    );
    expect(on.is_active).toBe(true);
  });

  it('não existe função operacional para criar produto, alterar preço ou ver histórico', async () => {
    const names = await runSql<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'ops\\_%'`,
    );
    const list = names.map((row) => row.proname);
    for (const missing of ['ops_create_product', 'ops_get_product', 'ops_list_orders', 'ops_indicators', 'ops_audit_log']) {
      expect(list).not.toContain(missing);
    }
  });
});

describe('perfil operacional — estoque', () => {
  let operator: string;
  let productId: string;
  let unitId: string;

  beforeEach(async () => {
    operator = await seedOperator();
    const seed = await seedProduct({ stockUnits: 2 });
    productId = seed.productId;
    unitId = seed.units[0];
  });

  it('resumo e listagem não expõem credencial, fingerprint ou vínculo com pedidos', async () => {
    const summary = await opsCall<{ products: Array<Record<string, unknown>> }>(
      operator,
      `select public.ops_stock_summary() as r`,
    );
    const row = summary.products.find((item) => item.product_id === productId);
    expect(row?.available_units).toBe(2);
    expectNoSensitiveKeys(summary);

    const list = await opsCall<{ items: Array<Record<string, unknown>>; total: number }>(
      operator,
      `select public.ops_list_stock($1, null, null, 50, 0) as r`,
      [productId],
    );
    expect(list.total).toBe(2);
    expectNoSensitiveKeys(list);
  });

  it('adiciona unidade de estoque em AAL1 (dados já cifrados pelo servidor)', async () => {
    const result = await opsCall<{ id: string; status: string }>(
      operator,
      `select public.ops_add_stock_unit($1, $2, $3, $4, $5) as r`,
      [
        productId,
        fakeCiphertextB64('nova@exemplo.com'),
        fakeCiphertextB64('senha-nova'),
        hmacHex('test-fingerprint-key', 'nova@exemplo.com:senha-nova'),
        'lote do dia',
      ],
    );
    expect(result.status).toBe('available');
    const available = await sqlValue<number>(
      `select count(*)::int from public.stock_units where product_id = $1 and status = 'available'`,
      [productId],
    );
    expect(available).toBe(3);
    const audit = await sqlValue<number>(
      `select count(*)::int from public.admin_audit_log
        where actor_user_id = $1 and action = 'stock_unit_added' and metadata->>'profile' = 'operational'`,
      [operator],
    );
    expect(audit).toBe(1);
  });

  it('credencial duplicada é recusada', async () => {
    const fingerprint = hmacHex('test-fingerprint-key', 'dup@exemplo.com:x');
    const call = () =>
      runAs(
        `select public.ops_add_stock_unit($1, $2, $3, $4, '')`,
        [productId, fakeCiphertextB64('dup@exemplo.com'), fakeCiphertextB64('x'), fingerprint],
        asUser(operator),
      );
    await call();
    await expect(call()).rejects.toThrow(/duplicate|unique/);
  });

  it('fingerprint fora do formato é recusada', async () => {
    await expect(
      runAs(
        `select public.ops_add_stock_unit($1, $2, $3, 'abc', '')`,
        [productId, fakeCiphertextB64('a@b.com'), fakeCiphertextB64('x')],
        asUser(operator),
      ),
    ).rejects.toThrow(/invalid_fingerprint/);
  });

  it('desativa e reativa unidade com motivo categorizado', async () => {
    const off = await opsCall<{ status: string; reason: string }>(
      operator,
      `select public.ops_set_stock_unit_status($1, 'disabled', 'invalid_credential', '') as r`,
      [unitId],
    );
    expect(off).toMatchObject({ status: 'disabled', reason: 'invalid_credential' });
    const on = await opsCall<{ status: string }>(
      operator,
      `select public.ops_set_stock_unit_status($1, 'available', null, '') as r`,
      [unitId],
    );
    expect(on.status).toBe('available');
  });

  it('desativar sem motivo, ou "other" sem nota, é recusado', async () => {
    await expect(
      runAs(`select public.ops_set_stock_unit_status($1, 'disabled', null, '')`, [unitId], asUser(operator)),
    ).rejects.toThrow(/adjustment_reason_required/);
    await expect(
      runAs(`select public.ops_set_stock_unit_status($1, 'disabled', 'other', 'oi')`, [unitId], asUser(operator)),
    ).rejects.toThrow(/adjustment_reason_note_required/);
  });

  it('unidade reservada (em compra) não pode ser alterada pelo operador', async () => {
    await runSql(`update public.stock_units set status = 'reserved' where id = $1`, [unitId]);
    await expect(
      runAs(
        `select public.ops_set_stock_unit_status($1, 'disabled', 'inventory_adjustment', '')`,
        [unitId],
        asUser(operator),
      ),
    ).rejects.toThrow(/stock_unit_not_toggleable/);
  });

  it('importação em lote grava unidades válidas e reporta duplicadas', async () => {
    const fp = (n: number) => hmacHex('test-fingerprint-key', `lote${n}@exemplo.com:s${n}`);
    const rows = [1, 2, 2].map((n, index) => ({
      row_number: index + 2,
      email_enc: fakeCiphertextB64(`lote${n}@exemplo.com`),
      password_enc: fakeCiphertextB64(`s${n}`),
      fingerprint: fp(n),
      notes: '',
    }));
    const report = await opsCall<{ imported: number; duplicates: number; invalid: number }>(
      operator,
      `select public.ops_import_stock_units($1, $2::jsonb, $3::jsonb, 'lote.csv') as r`,
      [productId, JSON.stringify(rows), JSON.stringify([{ row_number: 9, reason: 'invalid_email' }])],
    );
    expect(report.imported).toBe(2);
    expect(report.duplicates).toBe(1);
    expect(report.invalid).toBe(1);
    expectNoSensitiveKeys(report);
  });

  it('não existe função operacional que revele ou edite credenciais', async () => {
    const names = await runSql<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'ops\\_%'`,
    );
    const list = names.map((row) => row.proname);
    expect(list).not.toContain('ops_update_stock_unit');
    expect(list).not.toContain('ops_stock_fingerprints');
  });

  it('usuário não-operador não altera estoque', async () => {
    const stranger = await seedUser('estranho');
    await expect(
      runAs(
        `select public.ops_set_stock_unit_status($1, 'disabled', 'inventory_adjustment', '')`,
        [unitId],
        asUser(stranger),
      ),
    ).rejects.toThrow(/not_operator/);
    const status = await sqlValue<string>(`select status::text from public.stock_units where id = $1`, [unitId]);
    expect(status).toBe('available');
  });
});
