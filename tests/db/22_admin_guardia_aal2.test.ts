import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { connect, randomToken, resetDatabase, runSql, seedAdmin, seedProduct, sha256Hex, type Role } from './helpers';

/**
 * Missão 11 — Grupo D (autenticação/segurança): varredura dinâmica da guarda
 * administrativa.
 *
 * O que esta suíte comprova, para TODA função `admin_*` existente no banco
 * (lista obtida do `pg_proc`, não de uma enumeração manual):
 *
 *  1. a fonte da função chama `public.assert_admin()` — uma função admin nova
 *     que "esqueça" a guarda falha aqui, mesmo que nenhum outro teste a cite;
 *  2. chamador `anon` é recusado por privilégio (nenhuma EXECUTE pública);
 *  3. administrador em AAL1 recebe `mfa_required` (o token de sessão sozinho
 *     não autoriza nada);
 *  4. usuário autenticado fora da allowlist recebe `not_admin` mesmo com AAL2;
 *  5. controle positivo: administrador em AAL2 executa (a varredura não passa
 *     porque tudo está quebrado).
 *
 * Foco de regressão: `admin_list_orders` foi redefinida pela migração 0040 na
 * Missão 11 — CREATE OR REPLACE preserva os privilégios, e este teste prova que
 * a autorização continuou intacta na redefinição.
 */

type AdminFunction = { name: string; identity_args: string; def: string };

async function adminFunctions(): Promise<AdminFunction[]> {
  return runSql<AdminFunction>(
    `select p.proname as name,
            pg_get_function_identity_arguments(p.oid) as identity_args,
            pg_get_functiondef(p.oid) as def
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'admin\\_%'
      order by p.proname`,
  );
}

/** Monta `select public.fn(null::tipo, ...)` a partir da assinatura real. */
function nullCall(fn: AdminFunction): string {
  const types = fn.identity_args
    .split(', ')
    .filter(Boolean)
    .map((decl) => decl.slice(decl.indexOf(' ') + 1));
  const args = types.map((type) => `null::${type}`).join(', ');
  return `select public.${fn.name}(${args})`;
}

interface Outcome {
  ok: boolean;
  message: string;
}

/** Executa o call no papel/claims informados; devolve ok ou a mensagem de erro. */
async function callAs(
  role: Role,
  fn: AdminFunction,
  claims: Record<string, unknown>,
): Promise<Outcome> {
  const client = await connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify(claims),
    ]);
    await client.query(`set local role ${role}`);
    try {
      await client.query(nullCall(fn));
      await client.query('rollback');
      return { ok: true, message: '' };
    } catch (error) {
      await client.query('rollback');
      const pgError = error as { message?: string };
      return { ok: false, message: pgError.message ?? String(error) };
    }
  } finally {
    await client.end();
  }
}

describe('Grupo D — varredura da guarda administrativa (assert_admin + AAL2)', () => {
  let client: Client;
  let adminId: string;
  let functions: AdminFunction[];

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
    adminId = await seedAdmin('owner');
    functions = await adminFunctions();
  }, 120000);

  it('enumera todas as funções admin_* do banco (lista dinâmica, ≥ 20)', () => {
    expect(functions.length).toBeGreaterThanOrEqual(20);
    const names = functions.map((fn) => fn.name);
    // Âncoras conhecidas — garante que a enumeração não está vazia por engano.
    expect(names).toContain('admin_list_orders');
    expect(names).toContain('admin_indicators');
    expect(names).toContain('admin_set_stock_unit_status');
    expect(new Set(names).size).toBe(names.length);
  });

  it('toda função admin_* chama public.assert_admin() na fonte', () => {
    const missing = functions
      .filter((fn) => !fn.def.includes('public.assert_admin()'))
      .map((fn) => fn.name);
    expect(missing).toEqual([]);
  });

  it('anon não tem EXECUTE em nenhuma função admin_*', async () => {
    const granted = await runSql<{ proname: string }>(
      `select distinct p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname like 'admin\\_%'
          and has_function_privilege('anon', p.oid, 'execute')`,
    );
    expect(granted.map((row) => row.proname)).toEqual([]);

    // E a tentativa real de chamada como anon é recusada por privilégio.
    for (const fn of functions) {
      const outcome = await callAs('anon', fn, { role: 'anon' });
      expect(outcome.ok, `${fn.name} executou como anon`).toBe(false);
      expect(outcome.message, fn.name).toMatch(/permission denied/i);
    }
  }, 60000);

  it('administrador em AAL1 recebe mfa_required em todas as funções admin_*', async () => {
    for (const fn of functions) {
      const outcome = await callAs('authenticated', fn, {
        sub: adminId,
        role: 'authenticated',
        aal: 'aal1',
      });
      expect(outcome.ok, `${fn.name} executou em AAL1`).toBe(false);
      expect(outcome.message, fn.name).toContain('mfa_required');
    }
  }, 60000);

  it('usuário autenticado fora da allowlist recebe not_admin mesmo com AAL2', async () => {
    const stranger = randomUUID();
    for (const fn of functions) {
      const outcome = await callAs('authenticated', fn, {
        sub: stranger,
        role: 'authenticated',
        aal: 'aal2',
      });
      expect(outcome.ok, `${fn.name} executou para estranho`).toBe(false);
      expect(outcome.message, fn.name).toContain('not_admin');
    }
  }, 60000);

  it('controle positivo: administrador AAL2 executa as funções de leitura', async () => {
    const indicators = functions.find((fn) => fn.name === 'admin_indicators');
    const list = functions.find((fn) => fn.name === 'admin_list_orders');
    expect(indicators && list).toBeTruthy();

    const okIndicators = await callAs('authenticated', indicators!, {
      sub: adminId,
      role: 'authenticated',
      aal: 'aal2',
    });
    expect(okIndicators.ok, okIndicators.message).toBe(true);

    const okList = await callAs('authenticated', list!, {
      sub: adminId,
      role: 'authenticated',
      aal: 'aal2',
    });
    expect(okList.ok, okList.message).toBe(true);
  });

  it('admin_list_orders (migração 0040) manteve guarda e privilégios na redefinição', async () => {
    const fn = functions.find((f) => f.name === 'admin_list_orders');
    expect(fn).toBeTruthy();

    // Recusa em AAL1…
    const aal1 = await callAs('authenticated', fn!, {
      sub: adminId,
      role: 'authenticated',
      aal: 'aal1',
    });
    expect(aal1.ok).toBe(false);
    expect(aal1.message).toContain('mfa_required');

    // …e retorno com a coluna nova para o admin em AAL2: semeia um pedido
    // multiproduto e confere que `items_count` chega na lista (objeto da 0040).
    const first = await seedProduct({ stockUnits: 3, maxQuantity: 3 });
    const second = await seedProduct({ stockUnits: 3, maxQuantity: 3 });
    const rows = await runSql<{ result: { order: { order_id: string } } }>(
      `select public.create_purchase_request($1, $2, $3, $4, $5) as result`,
      [
        JSON.stringify([
          { product_id: first.productId, quantity: 1 },
          { product_id: second.productId, quantity: 2 },
        ]),
        'Compradora Grupo D',
        'grupo-d@exemplo.com',
        sha256Hex(randomToken(32)),
        null,
      ],
    );
    const orderId = rows[0].result.order.order_id;

    const client2 = await connect();
    try {
      await client2.query('begin');
      await client2.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ sub: adminId, role: 'authenticated', aal: 'aal2' }),
      ]);
      await client2.query('set local role authenticated');
      const result = await client2.query<{ result: { items: Array<{ id: string; items_count?: number }> } }>(
        `select public.admin_list_orders(null, null, null, null, null, false, 50, 0) as result`,
      );
      await client2.query('rollback');
      const row = result.rows[0]?.result.items.find((item) => item.id === orderId);
      expect(row).toBeDefined();
      // Antes da 0040 a coluna não era selecionada e o campo chegava indefinido.
      expect(row?.items_count).toBe(2);
    } finally {
      await client2.end();
    }
    void client;
  });
});
