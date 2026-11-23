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

  /**
   * Missão 15.1 — a migração 0046 revogou EXECUTE de `authenticated` em
   * `admin_stock_summary()` (órfã, sem chamador). A recusa dela deixou de ser
   * `mfa_required`/`not_admin` e passou a ser `permission denied`, que é uma
   * barreira MAIS forte (não chega a entrar no corpo da função). O conjunto
   * abaixo é a fonte única dessa exceção — qualquer outro nome aqui seria
   * uma função do painel cuja autorização deixou de ser exercitada.
   */
  const SEM_EXECUTE_APOS_0046 = new Set(['admin_stock_summary']);

  it('administrador em AAL1 recebe mfa_required em todas as funções admin_*', async () => {
    for (const fn of functions) {
      const outcome = await callAs('authenticated', fn, {
        sub: adminId,
        role: 'authenticated',
        aal: 'aal1',
      });
      expect(outcome.ok, `${fn.name} executou em AAL1`).toBe(false);
      if (SEM_EXECUTE_APOS_0046.has(fn.name)) {
        expect(outcome.message, fn.name).toMatch(/permission denied/i);
      } else {
        expect(outcome.message, fn.name).toContain('mfa_required');
      }
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
      if (SEM_EXECUTE_APOS_0046.has(fn.name)) {
        expect(outcome.message, fn.name).toMatch(/permission denied/i);
      } else {
        expect(outcome.message, fn.name).toContain('not_admin');
      }
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

  /**
   * Missão 15.1 — cobertura da 24ª função executável por `authenticated`.
   *
   * A varredura acima usa `proname like 'admin\_%'`, então `is_admin` fica de
   * fora. Ela não é uma função de operação: é o booleano que o painel usa para
   * decidir se mostra a tela. Mesmo assim é SECURITY DEFINER e executável por
   * `authenticated`, ou seja, alcançável por qualquer JWT pelo PostgREST — por
   * isso precisa da mesma varredura de papéis, com uma sutileza: ela **não
   * levanta exceção**, devolve `false`. O critério aqui é o valor, não o erro.
   */
  it('is_admin (24ª função) não vaza privilégio: false para anon/estranho/AAL1', async () => {
    const consultar = async (
      sub: string | null,
      aal: 'aal1' | 'aal2',
      papel: 'anon' | 'authenticated',
      exigirMfa: boolean,
    ): Promise<boolean> => {
      const client = await connect();
      try {
        await client.query('begin');
        await client.query('select set_config($1, $2, true)', [
          'request.jwt.claims',
          JSON.stringify({ sub, role: papel, aal }),
        ]);
        await client.query(`set local role ${papel}`);
        const result = await client.query<{ v: boolean }>(
          `select public.is_admin($1) as v`,
          [exigirMfa],
        );
        await client.query('rollback');
        return result.rows[0]?.v === true;
      } finally {
        await client.end();
      }
    };

    // Cenário A — visitante: `anon` nem chega a executar. A recusa é de
    // PRIVILÉGIO (a 0014 nunca concedeu EXECUTE a anon), o que é mais forte
    // do que devolver `false`: a função não é alcançável pelo PostgREST.
    await expect(consultar(null, 'aal1', 'anon', false)).rejects.toThrow(/permission denied/i);

    // Cenário B — autenticado comum (com AAL2): ainda não é admin.
    expect(await consultar(randomUUID(), 'aal2', 'authenticated', false)).toBe(false);

    // Cenário C — admin sem MFA: só "true" quando o MFA não é exigido.
    expect(await consultar(adminId, 'aal1', 'authenticated', true)).toBe(false);
    expect(await consultar(adminId, 'aal1', 'authenticated', false)).toBe(true);

    // Cenário D — admin em AAL2: "true" nos dois modos.
    expect(await consultar(adminId, 'aal2', 'authenticated', true)).toBe(true);
    expect(await consultar(adminId, 'aal2', 'authenticated', false)).toBe(true);
  });

  /**
   * Missão 15.1 — tentativa de escalada pelo próprio perfil.
   *
   * A allowlist vive em `public.admin_users`, e `auth.users` é a tabela que o
   * usuário consegue tocar indiretamente (metadados do signup). Se QUALQUER
   * trigger em `auth.users` inserisse em `admin_users`, um cadastro comum
   * viraria administrador. Este teste prova que esse caminho não existe no
   * schema, em vez de assumir que ninguém o criou.
   */
  it('nenhum gatilho em auth.users promove usuário a administrador', async () => {
    const triggers = await runSql<{ tgname: string; def: string }>(
      `select t.tgname, pg_get_triggerdef(t.oid) as def
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where not t.tgisinternal
          and n.nspname = 'auth'
        order by t.tgname`,
    );
    const suspeitos = triggers.filter((t) => /admin_users/i.test(t.def));
    expect(suspeitos.map((t) => t.tgname)).toEqual([]);
  });

  it('usuário comum não escreve na allowlist nem por RPC nem por tabela', async () => {
    const stranger = randomUUID();

    // (a) A tabela não é alcançável: RLS ligada, zero políticas, sem GRANT.
    const client = await connect();
    try {
      await client.query('begin');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ sub: stranger, role: 'authenticated', aal: 'aal2' }),
      ]);
      await client.query('set local role authenticated');
      await expect(
        client.query(`insert into public.admin_users (user_id, display_name) values ($1, 'x')`, [
          stranger,
        ]),
      ).rejects.toThrow(/permission denied/i);
      await client.query('rollback');
    } finally {
      await client.end();
    }

    // (b) Nenhuma função executável por `authenticated` ESCREVE na allowlist.
    //     A consulta por regex sozinha daria falso positivo: `assert_admin`
    //     também menciona `admin_users` (no SELECT). Aqui a prova é por
    //     privilégio: entre as funções que tocam a tabela, nenhuma escrita
    //     pode estar ao alcance de `authenticated`.
    const escritoras = await runSql<{ proname: string }>(
      `select distinct p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and has_function_privilege('authenticated', p.oid, 'execute')
          and p.prosrc ~* '(insert\\s+into|update|delete\\s+from)\\s+public\\.admin_users'`,
    );
    expect(escritoras.map((row) => row.proname)).toEqual([]);

    // (c) Nenhum caminho de bootstrap existe para papel de usuário final.
    //     `bootstrap_admin_register`/`bootstrap_admin_status` são funções de
    //     provisionamento que existem em PRODUÇÃO mas não são criadas por
    //     nenhuma migração versionada (lacuna registrada na Missão 15.1). A
    //     consulta abaixo é tolerante à ausência: o que importa é que, se
    //     existirem, NÃO são executáveis por `authenticated`.
    const bootstrap = await runSql<{ sig: string; has: boolean }>(
      `select p.oid::regprocedure::text as sig,
              has_function_privilege('authenticated', p.oid, 'execute') as has
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'bootstrap_admin%'`,
    );
    expect(bootstrap.filter((row) => row.has).map((row) => row.sig)).toEqual([]);
  });
});
