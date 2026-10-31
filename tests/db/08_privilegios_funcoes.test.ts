import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  connect,
  randomToken,
  resetDatabase,
  runSql,
  seedAdmin,
  seedProduct,
  sqlValue,
  type Role,
} from './helpers';
import { createPgRpc } from './pgRpc';
import type { Client } from 'pg';

/**
 * Missão 03 — fase C/D: privilégios e search_path, verificados em 5 contextos.
 *
 *   anon ................... navegador sem sessão
 *   authenticated (não admin) usuário logado comum
 *   admin sem MFA .......... AAL1
 *   admin com MFA .......... AAL2
 *   service_role ........... backend (Edge Functions)
 *
 * A verificação é feita no banco (privilégios efetivos), não por declaração:
 * cada caso tenta a operação e verifica se ela é negada ou permitida.
 */

const INTERNAL_TABLES = [
  'stock_units',
  'orders',
  'payments',
  'payment_events',
  'deliveries',
  'delivery_units',
  'admin_users',
  'admin_audit_log',
  'refund_requests',
  'stock_reservations',
];

const PUBLIC_TABLES = ['public_catalog'];

async function canSelect(role: Role, table: string, sub?: string, aal?: 'aal1' | 'aal2'): Promise<boolean> {
  const client = await connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ role, sub: sub ?? null, aal: aal ?? 'aal1' }),
    ]);
    // `set local role` só vale dentro da transação — é o que torna os
    // privilégios efetivos (o usuário de conexão é superusuário).
    await client.query(`set local role ${role}`);
    try {
      await client.query(`select * from public.${table} limit 1`);
      await client.query('rollback');
      return true;
    } catch {
      await client.query('rollback');
      return false;
    }
  } finally {
    await client.end();
  }
}

interface ExecutionOutcome {
  /** false quando o PostgreSQL nega o privilégio (42501). */
  authorized: boolean;
  ok: boolean;
  message: string;
}

async function executeAs(
  role: Role,
  signature: string,
  args: unknown[] = [],
  claims: Record<string, unknown> = {},
): Promise<ExecutionOutcome> {
  const client = await connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1, $2, true)', ['request.jwt.claims', JSON.stringify(claims)]);
    await client.query(`set local role ${role}`);
    try {
      const placeholders = args.map((_, index) => `$${index + 1}`).join(', ');
      await client.query(`select public.${signature}(${placeholders})`, args);
      await client.query('rollback');
      return { authorized: true, ok: true, message: '' };
    } catch (error) {
      await client.query('rollback');
      const pgError = error as { code?: string; message?: string };
      const message = pgError.message ?? '';
      const denied =
        pgError.code === '42501' ||
        /permission denied|not_admin|mfa_required|not_authenticated/.test(message);
      return { authorized: !denied, ok: false, message };
    }
  } finally {
    await client.end();
  }
}

async function canExecute(
  role: Role,
  signature: string,
  args: unknown[] = [],
  claims: Record<string, unknown> = {},
): Promise<boolean> {
  return (await executeAs(role, signature, args, claims)).authorized;
}

describe('privilégios por contexto', () => {
  let client: Client;
  let adminId: string;
  let productId: string;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
    adminId = await seedAdmin();
    productId = (await seedProduct({ stockUnits: 1 })).productId;
  }, 60000);

  it('anon não lê nenhuma tabela interna e lê apenas o catálogo público', async () => {
    for (const table of INTERNAL_TABLES) {
      expect(await canSelect('anon', table), `anon não deve ler ${table}`).toBe(false);
    }
    for (const table of PUBLIC_TABLES) {
      expect(await canSelect('anon', table), `anon deve ler ${table}`).toBe(true);
    }
  });

  it('authenticated (não admin) também não lê tabelas internas', async () => {
    for (const table of INTERNAL_TABLES) {
      expect(await canSelect('authenticated', table, adminId), `authenticated não deve ler ${table}`).toBe(false);
    }
    expect(await canSelect('authenticated', 'public_catalog', randomUUID(), 'aal1')).toBe(true);
  });

  it('anon não executa nenhuma função do schema public', async () => {
    const functions = await runSql<{ proname: string; args: string }>(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'`,
    );
    const granted = await runSql<{ proname: string }>(
      `select distinct p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`,
    );
    expect(functions.length).toBeGreaterThan(30);
    // Nem `is_admin`: anon não tem nenhuma função. O navegador sem sessão fala
    // apenas com as Edge Functions públicas (catálogo, create-order, etc.).
    expect(granted.map((row) => row.proname)).toEqual([]);
  });

  // is_admin é a única função visível a anon (booleano, sem efeito colateral).

  it('authenticated executa somente funções administrativas e is_admin', async () => {
    const granted = await runSql<{ proname: string }>(
      `select distinct p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
        order by 1`,
    );
    const names = granted.map((row) => row.proname);
    expect(names.every((name) => name.startsWith('admin_') || name === 'is_admin')).toBe(true);
    expect(names).toContain('admin_list_orders');
    // Funções internas do backend nunca são executáveis por usuário.
    for (const internal of [
      'create_order',
      'apply_payment_status',
      'resolve_delivery',
      'get_order_status',
      'get_secret_material',
      'record_payment_event',
    ]) {
      expect(names).not.toContain(internal);
    }
  });

  it('service_role executa tudo e lê tudo (é o backend)', async () => {
    const count = await sqlValue<number>(
      `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('service_role', p.oid, 'execute')`,
    );
    const total = await sqlValue<number>(
      `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
    );
    expect(Number(count)).toBe(Number(total));
    expect(await canSelect('service_role', 'orders')).toBe(true);
    expect(await canSelect('service_role', 'stock_units')).toBe(true);
  });

  it('função administrativa exige allowlist + MFA (AAL2), não apenas JWT', async () => {
    const args = [null, null, null, null, null, false, 5, 0];

    // Sem cadastro na allowlist.
    const stranger = await executeAs('authenticated', 'admin_list_orders', args, {
      sub: randomUUID(),
      role: 'authenticated',
      aal: 'aal2',
    });
    expect(stranger.ok).toBe(false);
    expect(stranger.message).toContain('not_admin');

    // Cadastrado, mas sem segundo fator.
    const semMfa = await executeAs('authenticated', 'admin_list_orders', args, {
      sub: adminId,
      role: 'authenticated',
      aal: 'aal1',
    });
    expect(semMfa.ok).toBe(false);
    expect(semMfa.message).toContain('mfa_required');

    // Cadastrado e com AAL2.
    const admin = await executeAs('authenticated', 'admin_list_orders', args, {
      sub: adminId,
      role: 'authenticated',
      aal: 'aal2',
    });
    expect(admin.ok).toBe(true);
  });

  it('is_admin é consulta booleana e também exige AAL2 para "true"', async () => {
    expect(
      await canExecute('authenticated', 'is_admin', [true], { sub: adminId, role: 'authenticated', aal: 'aal1' }),
    ).toBe(true);

    const client2 = await connect();
    try {
      await client2.query('begin');
      await client2.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: adminId, role: 'authenticated', aal: 'aal1' }),
      ]);
      expect((await client2.query(`select public.is_admin(true) as v`)).rows[0].v).toBe(false);
      await client2.query('commit');

      await client2.query('begin');
      await client2.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: adminId, role: 'authenticated', aal: 'aal2' }),
      ]);
      expect((await client2.query(`select public.is_admin(true) as v`)).rows[0].v).toBe(true);
      await client2.query('commit');
    } finally {
      await client2.end();
    }
  });

  it('fingerprints de credenciais só saem para admin com MFA', async () => {
    const signature = 'admin_stock_fingerprints';
    const semMfa = await executeAs('authenticated', signature, [productId], {
      sub: adminId,
      aal: 'aal1',
      role: 'authenticated',
    });
    expect(semMfa.message).toContain('mfa_required');

    const estranho = await executeAs('authenticated', signature, [productId], {
      sub: randomUUID(),
      aal: 'aal2',
      role: 'authenticated',
    });
    expect(estranho.message).toContain('not_admin');

    // Admin com MFA executa, mas recebe apenas pseudo-hashes (HMAC), nunca credenciais.
    const adminRpc = createPgRpc(client, {
      role: 'authenticated',
      claims: { sub: adminId, role: 'authenticated', aal: 'aal2' },
    });
    const fingerprints = await adminRpc<string[]>('admin_stock_fingerprints', { p_product_id: productId });
    expect(Array.isArray(fingerprints)).toBe(true);
    expect(JSON.stringify(fingerprints)).toMatch(/^\["[0-9a-f]{64}"/);
  });

  it('toda função SECURITY DEFINER tem search_path fixo e seguro', async () => {
    const rows = await runSql<{ proname: string; cfg: string | null }>(
      `select p.proname, array_to_string(p.proconfig, ',') as cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef`,
    );
    expect(rows.length).toBeGreaterThan(30);
    for (const row of rows) {
      expect(row.cfg ?? '', `${row.proname} sem search_path`).toMatch(/search_path=public, pg_temp/);
    }
  });

  it('nenhuma tabela fica fora da RLS e nenhuma tem política permissiva genérica', async () => {
    const withoutRls = await runSql<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(withoutRls).toEqual([]);

    const genericPolicies = await runSql<{ polname: string; qual: string }>(
      `select p.polname, coalesce(pg_get_expr(p.polqual, p.polrelid), '') as qual
         from pg_policy p join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and (p.polroles = '{0}'::oid[] or pg_get_expr(p.polqual, p.polrelid) = 'true')`,
    );
    expect(genericPolicies).toEqual([]);
  });

  it('a view pública não expõe custo, credenciais nem identificadores internos', async () => {
    const columns = await runSql<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'public_catalog' order by column_name`,
    );
    const names = columns.map((column) => column.column_name);
    expect(names).toContain('slug');
    for (const forbidden of [
      'cost_cents',
      'account_email_enc',
      'account_password_enc',
      'credential_fingerprint',
      'client_token_hash',
      'token_hash',
      'token_enc',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('apenas o RPC dedicado devolve o ciphertext do link — e só para o backend', async () => {
    // 1. `get_order_status` não projeta mais `token_enc`.
    const statusSource = await sqlValue<string>(
      `select pg_get_functiondef('public.get_order_status(uuid, text)'::regprocedure)`,
    );
    expect(statusSource).not.toContain("'token_enc',");
    expect(statusSource).toContain('link_ready');

    // 2. O ciphertext sai por uma única função, com prova de posse.
    const materialSource = await sqlValue<string>(
      `select pg_get_functiondef('public.get_delivery_token_enc(uuid, text)'::regprocedure)`,
    );
    expect(materialSource).toContain('client_token_hash');

    // 3. Privilégios: só service_role executa.
    const grants = await runSql<{ grantee: string }>(
      `select grantee
         from unnest(array['anon', 'authenticated', 'service_role']) as g(grantee)
        where has_function_privilege(
          g.grantee,
          'public.get_delivery_token_enc(uuid, text)'::regprocedure,
          'execute'
        )`,
    );
    expect(grants.map((row) => row.grantee)).toEqual(['service_role']);

    // 4. Nenhuma função pública devolve as colunas de credencial.
    const credentialLeaks = await runSql<{ proname: string }>(
      `select p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f'
          and p.proname not like 'admin\_%'
          and pg_get_functiondef(p.oid) ~ '(account_password_enc\s*,|''password_enc'')'
          and pg_get_functiondef(p.oid) !~ 'raise exception'`,
    );
    expect(credentialLeaks).toEqual([]);
  });

  it('nenhum índice é redundante e o índice da FK de importação existe', async () => {
    // Fase F: o índice da FK de import_batch_id precisa existir...
    const importIndex = await sqlValue<number>(
      `select count(*)
         from pg_indexes
        where schemaname = 'public'
          and tablename = 'stock_units'
          and indexname = 'stock_units_import_batch_idx'`,
    );
    expect(Number(importIndex)).toBe(1);

    // ...e nenhum par de índices pode ter exatamente a mesma definição
    // (mesma tabela, colunas, predicado e tipo): isso é custo de escrita sem
    // ganho de leitura. Achado real da 0025, agora protegido por teste.
    const duplicates = await runSql<{ tablename: string; signature: string; nomes: string }>(
      `select tablename, signature, string_agg(indexname, ', ' order by indexname) as nomes
         from (
           select tablename, indexname,
                  regexp_replace(indexdef, '^CREATE (UNIQUE )?INDEX \S+ ON ', '') as signature
             from pg_indexes
            where schemaname = 'public'
         ) x
        group by tablename, signature
       having count(*) > 1`,
    );
    expect(duplicates).toEqual([]);
  });
});
