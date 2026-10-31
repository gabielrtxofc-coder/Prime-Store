import { beforeAll, describe, expect, it } from 'vitest';
import {
  createOrder,
  randomToken,
  resetDatabase,
  runAs,
  runSql,
  seedProduct,
  sha256Hex,
  sqlValue,
  type Seed,
} from './helpers';

interface PgError extends Error {
  code?: string;
  detail?: string;
}

async function expectPgError(
  promise: Promise<unknown>,
  expected: { code?: string; message?: RegExp; detail?: string },
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const pgError = error as PgError;
    if (expected.code) expect(pgError.code).toBe(expected.code);
    if (expected.message) expect(pgError.message).toMatch(expected.message);
    if (expected.detail !== undefined) expect(pgError.detail).toBe(expected.detail);
    return;
  }
  throw new Error('Esperava um erro do PostgreSQL, mas a operação foi concluída.');
}

describe('banco, migrações e modelo de dados', () => {
  let seed: Seed;

  beforeAll(async () => {
    await resetDatabase();
    seed = await seedProduct({ stockUnits: 2, priceCents: 4500, costCents: 1200 });
  }, 60000);

  it('aplica todas as migrações e cria as estruturas esperadas', async () => {
    const tables = await runSql<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    const names = tables.map((row) => row.tablename);
    expect(names).toEqual(
      expect.arrayContaining([
        'admin_audit_log',
        'admin_users',
        'app_settings',
        'deliveries',
        'delivery_units',
        'import_batches',
        'order_events',
        'orders',
        'payment_events',
        'payments',
        'product_categories',
        'product_price_history',
        'products',
        'refund_requests',
        'stock_reservation_units',
        'stock_reservations',
        'stock_units',
      ]),
    );

    const enums = await runSql<{ typname: string }>(
      `select typname from pg_type where typtype = 'e' order by typname`,
    );
    expect(enums.map((row) => row.typname)).toEqual([
      'delivery_link_status',
      'delivery_status',
      'order_status',
      'payment_status',
      'reservation_status',
      'stock_unit_status',
    ]);
  });

  it('mantém RLS habilitado em todas as tabelas de public', async () => {
    const rows = await runSql<{ tablename: string; rowsecurity: boolean }>(
      `select c.relname as tablename, c.relrowsecurity as rowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) {
      expect(row.rowsecurity, `RLS desabilitado em ${row.tablename}`).toBe(true);
    }
  });

  it('impede que anon e authenticated leiam tabelas diretamente', async () => {
    for (const table of ['orders', 'stock_units', 'products', 'deliveries', 'payments']) {
      await expectPgError(runAs(`select * from public.${table} limit 1`, [], { role: 'anon' }), {
        code: '42501',
      });
      await expectPgError(
        runAs(`select * from public.${table} limit 1`, [], {
          role: 'authenticated',
          claims: { role: 'authenticated' },
        }),
        { code: '42501' },
      );
    }
  });

  it('impede que anon chame funções internas ou administrativas', async () => {
    await expectPgError(
      runAs(`select public.create_order($1, 1, null, $2)`, [seed.productId, sha256Hex(randomToken())], {
        role: 'anon',
      }),
      { code: '42501' },
    );
    await expectPgError(runAs(`select public.expire_overdue_reservations(null)`, [], { role: 'anon' }), {
      code: '42501',
    });
    await expectPgError(runAs(`select public.admin_indicators()`, [], { role: 'anon' }), {
      code: '42501',
    });
  });

  it('expõe apenas colunas públicas no catálogo e omite produtos inativos', async () => {
    const viewColumns = await runSql<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'public_catalog'`,
    );
    const columns = viewColumns.map((row) => row.column_name);
    expect(columns).not.toContain('cost_cents');
    expect(columns).not.toContain('created_by');
    expect(columns).not.toContain('account_email_enc');
    expect(columns).toContain('available_units');
    expect(columns).toContain('instructions');

    const inactive = await seedProduct({ active: false, stockUnits: 1 });
    const visible = await runSql<{ id: string }>(`select id from public.public_catalog`);
    const ids = visible.map((row) => row.id);
    expect(ids).toContain(seed.productId);
    expect(ids).not.toContain(inactive.productId);

    const availability = await sqlValue<number>(
      `select available_units from public.public_catalog where id = $1`,
      [seed.productId],
    );
    expect(Number(availability)).toBe(2);
  });

  it('garante integridade referencial e unicidade do modelo', async () => {
    // FK: unidade de estoque não pode apontar para produto inexistente.
    await expectPgError(
      runSql(
        `insert into public.stock_units (product_id, account_email_enc, account_password_enc, credential_fingerprint)
         values (gen_random_uuid(), $1, $1, $2)`,
        [Buffer.from('x'.repeat(40)), 'a'.repeat(64)],
      ),
      { code: '23503' },
    );

    // Preço de venda não pode ser zero/negativo.
    await expectPgError(
      runSql(
        `insert into public.products (slug, name, category_id, price_cents)
         values ('slug-invalido-preco', 'Produto', 'music', 0)`,
      ),
      { code: '23514' },
    );

    // Total do pedido precisa ser unitário × quantidade.
    await expectPgError(
      runSql(
        `insert into public.orders (reference, product_id, product_name, quantity,
            unit_price_cents, total_cents, client_token_hash, reservation_expires_at)
         values ('PS-TESTE1', $1, 'Produto', 2, 100, 300, $2, now() + interval '30 minutes')`,
        [seed.productId, 'b'.repeat(64)],
      ),
      { code: '23514' },
    );
  });

  it('não permite criar reserva ativa duplicada para o mesmo pedido', async () => {
    const { order } = await createOrder(seed.productId, 1);
    const second = runSql(
      `insert into public.stock_reservations (order_id, status, quantity, expires_at)
       values ($1, 'active', 1, now() + interval '30 minutes')`,
      [order.order_id],
    );
    await expectPgError(second, { code: '23505' });
  });
});

