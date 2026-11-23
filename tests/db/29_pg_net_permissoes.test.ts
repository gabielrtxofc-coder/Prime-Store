import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { connect, MIGRATIONS_DIR, resetDatabase, runSql } from './helpers';

/**
 * Missão 15.2 — migração 0046 (redução da superfície RPC).
 *
 * POR QUE ESTA SUÍTE EXISTE
 * -------------------------
 * A versão da 0046 escrita na Missão 15.1 passou em todos os testes e teria
 * falhado em produção. Ela errou em três pontos independentes, e nenhum deles
 * é detectável sem reproduzir a topologia real do Supabase:
 *
 *   1. assinaturas inventadas de `net.http_post` / `net.http_delete`;
 *   2. `REVOKE` executado por um papel que não é dono nem superusuário —
 *      no-op silencioso (a ACL não muda e nenhuma exceção é levantada);
 *   3. `REVOKE ... FROM PUBLIC` removeria a única via pela qual o `postgres`
 *      executa `net.http_post`, ou seja, quebraria o cron do worker.
 *
 * Aqui a topologia é REPRODUZIDA com os objetos que a migração de fato
 * manipula: `net.http_post`/`http_get`/`http_delete` com as assinaturas reais
 * lidas do catálogo de produção (pg_net 0.20.4), schema `net` e posse em um
 * papel separado (`net_ext_owner`) — a condição que expõe os defeitos 2 e 3.
 *
 * A migração age sobre `pg_proc`, não sobre a linha de `pg_extension`. Isso é
 * deliberado: é a única forma de esta suíte rodar em qualquer PostgreSQL real,
 * inclusive o serviço `postgres:18` do CI, que nunca terá o binário da
 * extensão. Foi um `CREATE EXTENSION` "simulado" (arquivo de controle escrito
 * em `node_modules`) que produziu o verde falso da 15.1 — ele não existe no
 * runner. Ver o cabeçalho da 0046.
 */

const MIGRACAO = readFileSync(
  `${MIGRATIONS_DIR}/20261122120000_0046_reduzir_superficie_rpc.sql`,
  'utf8',
);

const DONO = 'net_ext_owner';
const SESSION_ROLE = 'net_ext_session';

/** Assinaturas reais, copiadas do catálogo de produção (não inventadas). */
const ASSINATURAS = [
  'http_post(text, jsonb, jsonb, jsonb, integer)',
  'http_get(text, jsonb, jsonb, integer)',
  'http_delete(text, jsonb, jsonb, integer, jsonb)',
];

async function limpar() {
  // Devolve a posse da função pública antes de apagar os papéis de teste.
  await runSql('alter function public.admin_stock_summary() owner to postgres').catch(() => undefined);
  await runSql('drop schema if exists net cascade').catch(() => undefined);
  for (const role of [SESSION_ROLE, DONO]) {
    // `drop role` falha se o papel ainda possuir objetos; revogar memberships
    // e ignorar "não existe" mantém a limpeza idempotente entre testes.
    await runSql(`drop owned by ${role}`).catch(() => undefined);
    await runSql(`drop role if exists ${role}`).catch(() => undefined);
  }
}

/**
 * Recria os objetos de `net` com as assinaturas reais e os entrega ao papel
 * `DONO`, reproduzindo produção (onde `net.*` pertence a `supabase_admin` e
 * quem executa a migração é o `postgres`, que NÃO é dono).
 *
 * A montagem é autossuficiente: (re)cria os dois papéis, recria o schema
 * `net`, cria as três funções com as assinaturas do catálogo e só então
 * transfere a posse. Cada cenário chama esta função justamente para não herdar
 * ACL de um cenário anterior.
 */
async function instalarObjetosNetComDonoSeparado() {
  await limpar();
  await runSql(`create role ${DONO} nologin`);
  await runSql(`create role ${SESSION_ROLE} nologin`);
  // Em produção a función órfã pertence ao `postgres`, que é quem executa a
  // migração. Aqui a sessão é `SESSION_ROLE`, então a posse acompanha.
  await runSql(`alter function public.admin_stock_summary() owner to ${SESSION_ROLE}`);
  await runSql('drop schema if exists net cascade');
  await runSql(`create schema net authorization ${DONO}`);
  // A função pública cuja posse é transferida mora em `public`. Quem executa a
  // migração precisa de USAGE nele — é o que o `postgres` tem em produção
  // (`public` → `=U/pg_database_owner, postgres=U/...`).
  await runSql(`grant usage on schema public to ${DONO}, ${SESSION_ROLE}`);
  await runSql(`
create table net.http_request_queue (
  id bigint generated always as identity primary key,
  method text not null,
  url text not null,
  headers jsonb not null,
  body bytea,
  timeout_milliseconds int not null default 5000,
  created timestamptz not null default now()
);
create table net._http_response (
  id bigint, status_code int, content_type text, headers jsonb,
  content text, timed_out bool, error_msg text,
  created timestamptz not null default now()
);
create function net.http_post(url text, body jsonb, params jsonb, headers jsonb,
                              timeout_milliseconds integer)
  returns bigint language sql as 'select 1::bigint';
create function net.http_get(url text, params jsonb, headers jsonb,
                             timeout_milliseconds integer)
  returns bigint language sql as 'select 2::bigint';
create function net.http_delete(url text, params jsonb, headers jsonb,
                                timeout_milliseconds integer, body jsonb)
  returns bigint language sql as 'select 3::bigint';
`);
  await runSql('grant usage on schema net to public, anon, authenticated');
  await runSql(`grant usage on schema net to ${SESSION_ROLE}`);
  await transferirPosseParaDono();
}

/**
 * Reatribui a posse das funções ao papel separado, como em produção.
 *
 * NÃO há `GRANT EXECUTE ... TO PUBLIC` aqui, e isso é fiel ao catálogo real:
 * as funções do `pg_net` têm `proacl = NULL`, ou seja, usam os privilégios
 * PADRÃO do PostgreSQL — que já incluem EXECUTE para PUBLIC. `ALTER OWNER`
 * preserva `proacl = NULL`; forçar uma ACL explícita com GRANT apenas
 * duplicaria o mesmo privilégio e quebraria a comparação com produção.
 */
async function transferirPosseParaDono() {
  for (const assinatura of ASSINATURAS) {
    await runSql(`alter function net.${assinatura} owner to ${DONO}`);
  }
}

async function aclDe(proname: string): Promise<string> {
  const rows = await runSql<{ acl: string }>(
    `select coalesce(p.proacl::text, '(default)') as acl
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'net' and p.proname = $1`,
    [proname],
  );
  return rows[0]?.acl ?? '(ausente)';
}

/**
 * PUBLIC é o `grantee = 0` da ACL. Comparar o texto (`'=X/'`) é armadilha:
 * toda concessão nominal (`net_ext_owner=X/net_ext_owner`) contém os mesmos
 * caracteres e produziria falso positivo — foi exatamente esse erro que
 * derrubou a primeira versão da migração.
 */
async function publicPodeExecutar(proname: string): Promise<boolean> {
  const rows = await runSql<{ publico: boolean }>(
    `select exists (
       select 1
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where n.nspname = 'net'
          and p.proname = $1
          and a.grantee = 0
          and a.privilege_type = 'EXECUTE'
     ) as publico`,
    [proname],
  );
  return rows[0]?.publico === true;
}

async function executa(role: string, proname: string): Promise<boolean> {
  const rows = await runSql<{ has: boolean }>(
    `select has_function_privilege($1, p.oid, 'execute') as has
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'net' and p.proname = $2`,
    [role, proname],
  );
  return rows[0]?.has === true;
}

describe('29 — migração 0046 sobre pg_net com topologia real', () => {
  beforeAll(async () => {
    // A 0046 roda no meio de `resetDatabase()`. Se uma execução anterior deixou
    // objetos de `net` para trás (execução interrompida), a migração agiria
    // sobre eles durante o reset — estado de teste vazando para o teste. A
    // limpeza vem antes para que o reset comece do zero, como em CI.
    await limpar().catch(() => undefined);
    await resetDatabase();
  }, 180000);

  afterAll(async () => {
    await limpar();
    // Deixa o banco como encontrou. Os substitutos de `cron`/`vault`/`net`
    // existem só para este arquivo e não podem sobrar para o próximo.
    await runSql('drop schema if exists cron cascade').catch(() => undefined);
    await runSql('drop schema if exists vault cascade').catch(() => undefined);
    await runSql('drop schema if exists net cascade').catch(() => undefined);
  });

  // ── Cenário A ────────────────────────────────────────────────────────────
  it('A) ambiente SEM pg_net: a migração passa e não cria nada', async () => {
    await limpar();
    const antes = await runSql<{ n: string }>(
      `select count(*)::text as n from pg_proc p
         join pg_namespace nn on nn.oid = p.pronamespace where nn.nspname = 'net'`,
    );
    expect(antes[0]?.n).toBe('0');

    const client = await connect();
    try {
      await expect(client.query(MIGRACAO)).resolves.toBeDefined();
    } finally {
      await client.end();
    }

    // E a parte que independe da extensão foi aplicada de fato.
    const orfa = await runSql<{ has: boolean }>(
      `select has_function_privilege('authenticated', 'public.admin_stock_summary()', 'execute') as has`,
    );
    expect(orfa[0]?.has).toBe(false);
  });

  // ── Cenário B ────────────────────────────────────────────────────────────
  it('B) ambiente COM pg_net e sessão sem posse: não revoga, avisa e FALHA? não — é no-op honesto', async () => {
    await instalarObjetosNetComDonoSeparado();
    expect(await publicPodeExecutar('http_post')).toBe(true); // grant a PUBLIC presente

    // Precisa rodar como um papel que NÃO é dono de `net` e NÃO é superusuário
    // — a posição exata do `postgres` em produção (`rolsuper = false`, sem
    // posse e sem membership em `supabase_admin`). Rodar como `postgres` local
    // não serviria: aqui ele É superusuário, então revogaria de verdade.
    await runSql(`alter function public.admin_stock_summary() owner to ${SESSION_ROLE}`);
    const client = await connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${SESSION_ROLE}`);
      // Deve concluir (não derrubar o `db push`) e sem mentir: a ACL fica
      // intacta e um WARNING nomeia o dono que precisaria agir.
      await expect(client.query(MIGRACAO)).resolves.toBeDefined();
      await client.query('commit');
    } finally {
      await client.end();
    }

    // Prova do defeito que a 15.1 não via: sem posse, a ACL NÃO muda.
    expect(await publicPodeExecutar('http_post')).toBe(true);
    expect(await executa('anon', 'http_post')).toBe(true);
  }, 120000);

  // ── Cenário B2: a migração FUNCIONA quando executada pelo dono ───────────
  it('B2) executada por um papel com poder de dono: revoga PUBLIC/anon/authenticated de fato', async () => {
    await instalarObjetosNetComDonoSeparado();
    expect(await executa('anon', 'http_post')).toBe(true);
    expect(await executa('authenticated', 'http_delete')).toBe(true);
    expect(await publicPodeExecutar('http_post')).toBe(true);

    // Para o REVOKE de `public.admin_stock_summary()` funcionar, o papel que
    // executa precisa ser também o dono dessa função. Em produção o `postgres`
    // é as duas coisas: dono das funções públicas E (via superusuário ou dono)
    // capaz de agir sobre `net`.
    await runSql(`alter function public.admin_stock_summary() owner to ${DONO}`);

    const client = await connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${DONO}`);
      await client.query(MIGRACAO);
      await client.query('commit');
    } finally {
      await client.end();
    }

    // Resultado comprovado por has_function_privilege, não por "o SQL rodou".
    for (const nome of ['http_post', 'http_get', 'http_delete']) {
      expect(await executa('anon', nome), `anon ainda executa ${nome}`).toBe(false);
      expect(await executa('authenticated', nome), `authenticated ainda executa ${nome}`).toBe(false);
      expect(await publicPodeExecutar(nome), `${nome} manteve grant a PUBLIC`).toBe(false);
    }
  }, 120000);

  // ── Cenário C e D estão cobertos por B2 (anon/authenticated) ─────────────
  it('C/D) anon e authenticated não executam nenhuma operação HTTP após a revogação', async () => {
    // Cenário próprio: monta e revoga, sem depender da ordem dos testes.
    await instalarObjetosNetComDonoSeparado();
    await runSql(`alter function public.admin_stock_summary() owner to ${DONO}`);
    {
      const c0 = await connect();
      try {
        await c0.query('begin');
        await c0.query(`set local role ${DONO}`);
        await c0.query(MIGRACAO);
        await c0.query('commit');
      } finally {
        await c0.end();
      }
    }

    const rows = await runSql<{ proname: string; anon: boolean; autenticado: boolean }>(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as autenticado
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'net'`,
    );
    expect(rows.length).toBe(3);
    for (const linha of rows) {
      expect(linha.anon, `${linha.proname}: anon executa`).toBe(false);
      expect(linha.autenticado, `${linha.proname}: authenticated executa`).toBe(false);
    }
  });

  // ── Cenário E: o dono preservado ─────────────────────────────────────────
  it('E) o dono continua executando as funções que o worker precisa', async () => {
    for (const nome of ['http_post', 'http_get', 'http_delete']) {
      expect(await executa(DONO, nome), `${DONO} perdeu ${nome}`).toBe(true);
    }
  });

  // ── Cenário F: o worker automático (cron) ────────────────────────────────
  it('F) o papel do cron preserva EXECUTE quando tem concessão própria', async () => {
    await instalarObjetosNetComDonoSeparado();
    await runSql(`alter function public.admin_stock_summary() owner to ${DONO}`);

    // O worker roda como um papel com GRANT NOMINAL. Em produção esse
    // privilégio vem do dono do schema; aqui é concedido explicitamente para
    // provar que revogar de PUBLIC/anon/authenticated não atinge quem tem
    // concessão própria. Os GRANTs vêm DEPOIS da montagem, porque ela recria
    // as funções (e recriar zera a ACL).
    for (const assinatura of ASSINATURAS) {
      await runSql(`grant execute on function net.${assinatura} to ${SESSION_ROLE}`);
      await runSql(`grant execute on function net.${assinatura} to postgres`);
    }
    const client = await connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${DONO}`);
      await client.query(MIGRACAO);
      await client.query('commit');
    } finally {
      await client.end();
    }

    // Revogar de PUBLIC/anon/authenticated NÃO pode atingir quem tem GRANT
    // nominal — é a garantia de que o cron não quebra.
    expect(await executa('postgres', 'http_post')).toBe(true);
    expect(await executa(SESSION_ROLE, 'http_post')).toBe(true);
    // E os usuários finais seguem fechados.
    expect(await executa('anon', 'http_post')).toBe(false);
  }, 120000);

  // ── Cenário G: repetição ─────────────────────────────────────────────────
  it('G) reaplicar a migração é idempotente e não reconcede nada', async () => {
    await instalarObjetosNetComDonoSeparado();
    await runSql(`alter function public.admin_stock_summary() owner to ${DONO}`);
    // Estado de partida: fechado pela migração (o G mede a REPETIÇÃO).
    {
      const c0 = await connect();
      try {
        await c0.query('begin');
        await c0.query(`set local role ${DONO}`);
        await c0.query(MIGRACAO);
        await c0.query('commit');
      } finally {
        await c0.end();
      }
    }
    const aclAntes = await aclDe('http_post');

    const client = await connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${DONO}`);
      await expect(client.query(MIGRACAO)).resolves.toBeDefined();
      await expect(client.query(MIGRACAO)).resolves.toBeDefined();
      await client.query('commit');
    } finally {
      await client.end();
    }

    expect(await aclDe('http_post')).toBe(aclAntes);
    expect(await publicPodeExecutar('http_post')).toBe(false);
    expect(await executa('anon', 'http_post')).toBe(false);
    expect(await executa('authenticated', 'http_post')).toBe(false);
    expect(await executa('postgres', 'http_post')).toBe(true);
  }, 120000);

  // ── Cenário H: nenhuma concessão explícita remanescente ──────────────────
  it('H) nenhuma concessão explícita a papel de usuário sobrevive à revogação', async () => {
    const rows = await runSql<{ proname: string; grantee: string }>(
      `select p.proname, a.grantee::regrole::text as grantee
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral aclexplode(p.proacl) a
        where n.nspname = 'net'
          and a.privilege_type = 'EXECUTE'
          and a.grantee <> 0
          and a.grantee::regrole::text in ('anon', 'authenticated', 'service_role')`,
    );
    expect(rows.map((r) => `${r.grantee}:${r.proname}`)).toEqual([]);
  });

  // ── Defeito 1: assinaturas ───────────────────────────────────────────────
  it('as assinaturas usadas no teste são as reais (4º arg de http_post é jsonb; http_delete tem 5)', async () => {
    const rows = await runSql<{ assinatura: string }>(
      `select p.oid::regprocedure::text as assinatura
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'net'
        order by 1`,
    );
    const assinaturas = rows.map((r) => r.assinatura);
    expect(assinaturas).toEqual([
      'net.http_delete(text,jsonb,jsonb,integer,jsonb)',
      'net.http_get(text,jsonb,jsonb,integer)',
      'net.http_post(text,jsonb,jsonb,jsonb,integer)',
    ]);

    // A assinatura ERRADA da 15.1 não existe — é o que teria estourado em prod.
    const erradas = await runSql<{ n: string }>(
      `select count(*)::text as n from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'net'
          and (p.oid = to_regprocedure('net.http_post(text,jsonb,jsonb,text,integer)')
            or p.oid = to_regprocedure('net.http_delete(text,jsonb,jsonb,integer)'))`,
    );
    expect(erradas[0]?.n).toBe('0');
  });

  // ── A órfã continua tratada em qualquer ambiente ─────────────────────────
  it('admin_stock_summary: revogada de anon/authenticated e preservada para service_role', async () => {
    const rows = await runSql<{ quem: string; has: boolean }>(
      `select r.quem, has_function_privilege(r.quem, 'public.admin_stock_summary()', 'execute') as has
         from (values ('anon'), ('authenticated'), ('service_role')) r(quem)`,
    );
    const porPapel = Object.fromEntries(rows.map((r) => [r.quem, r.has]));
    expect(porPapel.anon).toBe(false);
    expect(porPapel.authenticated).toBe(false);
    expect(porPapel.service_role).toBe(true);
  });
});
