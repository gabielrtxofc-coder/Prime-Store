import type { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { connect, resetDatabase, runSql } from './helpers';

/**
 * Missão 12 — teste 23 (reconstruído fielmente na Missão 13).
 *
 * PROVENIÊNCIA: o arquivo original `23_*` foi criado na Missão 12 como untracked
 * e perdeu-se com a recriação do workspace em 2026-11-10 (clone shallow a partir
 * do merge da PR #4). Este arquivo recria a cobertura que ele fechava, deduzida
 * das lacunas verificáveis: o teste 08 cobre search_path apenas para funções
 * SECURITY DEFINER (`p.prosecdef`), mas o alerta do Supabase Security Advisor
 * que motivou a migração 0041 era de `public.parse_request_items`, função
 * INVOKER — fora do filtro do 08.
 *
 * O que esta suíte comprova (equivalente às verificações read-only da M12):
 *
 *  1. NENHUMA função pública tem search_path ausente ou mutável — o
 *     equivalente prático do Advisor `function_search_path_mutable`, para
 *     definer E invoker (regressão direta da migração 0041);
 *  2. `parse_request_items` específica: proconfig fixo em `public, pg_temp`
 *     (prova de que a 0041 refletiu no banco);
 *  3. a assinatura e os privilégios de `parse_request_items` não mudaram com o
 *     ALTER FUNCTION: anon continua SEM execute (revoga da 0034 preservada);
 *  4. a função continua legível e operante (chamada de sanidade com payload
 *     válido devolve itens normalizados).
 *
 * Somente leitura: nenhuma escrita fora do reset descartável do próprio setup.
 */

type FnRow = { proname: string; cfg: string | null; secdef: boolean };

describe('23 — search_path total (regressão da migração 0041)', () => {
  let client: Client;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
  });

  it('nenhuma função pública tem search_path ausente ou mutável (Advisor equivalente)', async () => {
    const rows = await runSql<FnRow>(
      `select p.proname,
              array_to_string(p.proconfig, ',') as cfg,
              p.prosecdef as secdef
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'`,
    );
    // Conjunto realista: as 60+ funções de negócio existentes no schema.
    expect(rows.length).toBeGreaterThan(50);
    const mutable = rows.filter(
      (row) => !(row.cfg ?? '').includes('search_path=public, pg_temp'),
    );
    expect(
      mutable.map((row) => `${row.proname}(${row.cfg ?? 'sem proconfig'})`),
    ).toEqual([]);
  });

  it('parse_request_items tem search_path fixo em public, pg_temp (prova da 0041)', async () => {
    const rows = await runSql<FnRow>(
      `select p.proname,
              array_to_string(p.proconfig, ',') as cfg,
              p.prosecdef as secdef
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'parse_request_items'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].secdef).toBe(false); // invoker: por isso o 08 não a cobria
    expect(rows[0].cfg).toContain('search_path=public, pg_temp');
  });

  it('parse_request_items mantém assinatura e continua sem EXECUTE para anon', async () => {
    const rows = await runSql<{ args: string; anon_execute: boolean }>(
      `select pg_get_function_identity_arguments(p.oid) as args,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'parse_request_items'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].args).toBe('p_items jsonb, p_max_items integer');
    expect(rows[0].anon_execute).toBe(false);
  });

  it('parse_request_items opera: payload válido é normalizado e ordenado', async () => {
    const rows = await runSql<{ result: unknown }>(
      `select public.parse_request_items(
              '[{"product_id":"23d8f61c-cd96-44a8-9492-b17086f1d89e","quantity":2},
                {"product_id":"f8c3c8f2-a251-46d6-938b-447858c93b68","quantity":1}]'::jsonb,
              20) as result`,
    );
    const items = rows[0].result as Array<{ product_id: string; quantity: number }>;
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(2);
    // Ordenação global por product_id (ordem de trava do banco).
    expect(items[0].product_id < items[1].product_id).toBe(true);
    expect(items[0].quantity).toBe(2);
    expect(items[1].quantity).toBe(1);
  });
});
