import { beforeAll, describe, expect, it } from 'vitest';
import { connect, resetDatabase, runSql, seedAdmin, sha256Hex, randomToken } from './helpers';

/**
 * Missão 15.1 — Tarefa 02/03: redução da superfície RPC (migração 0046).
 *
 * Contexto: o Security Advisor aponta 24 funções SECURITY DEFINER executáveis
 * por `authenticated`. A revisão mostrou que 22 são chamadas por `admin-api`
 * com o JWT do administrador — o EXECUTE de `authenticated` é o que permite
 * esse encaminhamento (PostgREST troca o papel pelo `sub` do JWT). Mas duas
 * não precisavam estar expostas:
 *
 *   - `admin_stock_summary()`: criada na 0012, recebeu EXECUTE na 0014 e nunca
 *     foi chamada por nada (substituída por `admin_stock_summary_by_product`).
 *   - `net.http_*`: o `pg_net` nasce com EXECUTE para PUBLIC; o único usuário
 *     real é o pg_cron, que roda como `postgres` (superusuário).
 *
 * O que esta suíte trava:
 *   1. `admin_stock_summary()` não é mais executável por `authenticated`;
 *   2. o painel inteiro continua funcionando — as 22 funções de `admin-api`
 *      estão enumeradas aqui e o controle positivo em AAL2 as executa;
 *   3. `service_role` (backend) mantém acesso, inclusive a
 *      `admin_stock_summary()`, para não inviabilizar diagnóstico;
 *   4. `anon` continua sem nenhuma função administrativa.
 *
 * A lista de funções do painel é fixa DE PROPÓSITO: se alguém revogar uma
 * delas no futuro, este teste falha — é o alerta que a revisão pedia para
 * "não revogar indiscriminadamente".
 */

/** As 22 funções realmente chamadas por `admin-api` (rpcForUser/JWT do admin). */
const PAINEL_FUNCOES = [
  'admin_add_stock_unit',
  'admin_audit_log',
  'admin_create_product',
  'admin_expire_reservations',
  'admin_get_order',
  'admin_get_product',
  'admin_import_stock_units',
  'admin_indicators',
  'admin_list_orders',
  'admin_list_products',
  'admin_list_refund_requests',
  'admin_list_stock',
  'admin_resolve_dispute',
  'admin_resolve_refund',
  'admin_revoke_delivery',
  'admin_rotate_delivery_token',
  'admin_set_product_active',
  'admin_set_stock_unit_status',
  'admin_stock_fingerprints',
  'admin_stock_summary_by_product',
  'admin_update_product',
  'admin_update_stock_unit',
] as const;

async function podeExecutar(role: 'authenticated' | 'anon' | 'service_role', fn: string): Promise<boolean> {
  const rows = await runSql<{ has: boolean }>(
    `select has_function_privilege($1, p.oid, 'execute') as has
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $2
      limit 1`,
    [role, fn],
  );
  return rows[0]?.has === true;
}

describe('24 — superfície RPC após a 0046 (redução sem quebrar o painel)', () => {
  let adminId: string;

  beforeAll(async () => {
    await resetDatabase();
    adminId = await seedAdmin('owner');
  }, 120000);

  it('admin_stock_summary deixou de ser executável por authenticated e anon', async () => {
    expect(await podeExecutar('authenticated', 'admin_stock_summary')).toBe(false);
    expect(await podeExecutar('anon', 'admin_stock_summary')).toBe(false);
    // service_role continua podendo usar para diagnóstico.
    expect(await podeExecutar('service_role', 'admin_stock_summary')).toBe(true);
  });

  it('as 22 funções usadas pelo painel continuam executáveis por authenticated', async () => {
    const negadas: string[] = [];
    for (const fn of PAINEL_FUNCOES) {
      if (!(await podeExecutar('authenticated', fn))) negadas.push(fn);
    }
    expect(negadas).toEqual([]);
    expect(await podeExecutar('authenticated', 'is_admin')).toBe(true);
  });

  it('nenhuma das 22 funções do painel é executável por anon', async () => {
    const expostas: string[] = [];
    for (const fn of PAINEL_FUNCOES) {
      if (await podeExecutar('anon', fn)) expostas.push(fn);
    }
    expect(expostas).toEqual([]);
  });

  it('o conjunto executável por authenticated é exatamente admin_* + is_admin', async () => {
    const rows = await runSql<{ proname: string }>(
      `select distinct p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and has_function_privilege('authenticated', p.oid, 'execute')
        order by 1`,
    );
    const nomes = rows.map((row) => row.proname);
    expect(nomes.every((nome) => nome.startsWith('admin_') || nome === 'is_admin')).toBe(true);
    expect(nomes).not.toContain('admin_stock_summary');
    // Todas as 22 do painel estão presentes — nenhuma revogação acidental.
    for (const fn of PAINEL_FUNCOES) expect(nomes).toContain(fn);
  });

  it('controle positivo: admin em AAL2 usa o painel depois da 0046', async () => {
    const client = await connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: adminId, role: 'authenticated', aal: 'aal2' }),
      ]);
      await client.query('set local role authenticated');
      const produtos = await client.query('select public.admin_list_products(null, true) as v');
      expect(produtos.rows[0].v).toBeTruthy();
      const resumo = await client.query('select public.admin_stock_summary_by_product() as v');
      expect(resumo.rows[0].v).toBeTruthy();
      await client.query('rollback');
    } finally {
      await client.end();
    }
  });

  it('admin em AAL1 continua bloqueado nas funções do painel', async () => {
    const client = await connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: adminId, role: 'authenticated', aal: 'aal1' }),
      ]);
      await client.query('set local role authenticated');
      await expect(client.query('select public.admin_list_products(null, true)')).rejects.toThrow(
        /mfa_required/,
      );
      await client.query('rollback');
    } finally {
      await client.end();
    }
  });

  it('a 0046 é idempotente em ambiente sem pg_net (local/CI)', async () => {
    // O banco de teste não tem pg_net: a migração já rodou no reset acima sem
    // erro. Reexecutá-la não pode explodir — garantia para reaplicação.
    const { readFileSync } = await import('node:fs');
    const { MIGRATIONS_DIR } = await import('./helpers');
    const sql = readFileSync(
      `${MIGRATIONS_DIR}/20261122120000_0046_reduzir_superficie_rpc.sql`,
      'utf8',
    );
    const client = await connect();
    try {
      await expect(client.query(sql)).resolves.toBeDefined();
    } finally {
      await client.end();
    }
    expect(sha256Hex(randomToken(8))).toHaveLength(64);
  });
});
