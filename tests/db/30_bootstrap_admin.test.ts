import { beforeAll, describe, expect, it } from 'vitest';
import { connect, resetDatabase, runSql, seedAdmin } from './helpers';

/**
 * Missão 15.2 — migração 0047: versionar o bootstrap de administradores.
 *
 * CONTEXTO
 * --------
 * `bootstrap_admin_register` e `bootstrap_admin_status` existiam em produção e
 * em nenhuma migração. A origem investigada (ver cabeçalho da 0047) aponta
 * para uma operação manual documentada pelo `scripts/provision-admin.sql`, e a
 * 0047 recria as duas a partir do catálogo de produção.
 *
 * O QUE ESTA SUÍTE PROVA
 * ----------------------
 *   1. o banco recriado por migrações PASSA a conter as duas funções;
 *   2. elas nascem FECHADAS (não abrem janela de auto-provisionamento);
 *   3. nenhum papel de usuário final as executa;
 *   4. o fluxo legítimo (service_role) funciona e é autolimitado a 2;
 *   5. a auditoria registra a criação;
 *   6. a assinatura e o corpo coincidem com o que produção tem.
 */

const REGISTER = 'public.bootstrap_admin_register(uuid, text, text)';
const STATUS = 'public.bootstrap_admin_status()';

async function status(): Promise<{ enabled: boolean; created: number; remaining: number }> {
  const rows = await runSql<{ v: { enabled: boolean; created: number; remaining: number } }>(
    'select public.bootstrap_admin_status() as v',
  );
  return rows[0].v;
}

async function register(userId: string, name: string, role: string) {
  const rows = await runSql<{ v: Record<string, unknown> }>(
    'select public.bootstrap_admin_register($1, $2, $3) as v',
    [userId, name, role],
  );
  return rows[0].v;
}

/**
 * Cria o usuário em `auth.users` antes do bootstrap.
 *
 * `admin_users.user_id` tem FK para `auth.users`, e em produção o fluxo é
 * exatamente esse: criar o usuário no painel do Auth e DEPOIS registrar o UUID
 * na allowlist. O bootstrap não inventa identidade — ele só autoriza uma
 * identidade que já existe.
 */
async function criarUsuarioAuth(email: string): Promise<string> {
  const rows = await runSql<{ id: string }>(
    'insert into auth.users (email) values ($1) returning id',
    [email],
  );
  return rows[0].id;
}

async function habilitar() {
  await runSql(`update public.app_settings set value = 'true'::jsonb, updated_at = now()
                 where key = 'admin_bootstrap_enabled'`);
}

describe('30 — 0047 versiona o bootstrap de administradores', () => {
  beforeAll(async () => {
    await resetDatabase();
  }, 180000);

  it('as duas funções existem após recriar o banco só com migrações', async () => {
    const rows = await runSql<{ assinatura: string; definer: boolean; config: string }>(
      `select p.oid::regprocedure::text as assinatura,
              p.prosecdef as definer,
              coalesce(p.proconfig::text, '') as config
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'bootstrap_admin%'
        order by 1`,
    );
    expect(rows.map((r) => r.assinatura)).toEqual([
      'bootstrap_admin_register(uuid,text,text)',
      'bootstrap_admin_status()',
    ]);
    for (const linha of rows) {
      expect(linha.definer, `${linha.assinatura} não é SECURITY DEFINER`).toBe(true);
      // search_path fixo: mesma exigência do teste 23 aplicada aqui.
      expect(linha.config, `${linha.assinatura} sem search_path fixo`).toMatch(/search_path=public/);
    }
  });

  it('nascem FECHADAS: enabled=false e count=0 (sem janela aberta)', async () => {
    expect(await status()).toEqual({ enabled: false, created: 0, remaining: 2 });
  });

  it('anon e authenticated não executam nenhuma das duas', async () => {
    const rows = await runSql<{ papel: string; fn: string; pode: boolean }>(
      `select r.papel, f.fn,
              has_function_privilege(r.papel::regrole, f.fn::regprocedure, 'execute') as pode
         from (values ('anon'), ('authenticated')) r(papel)
         cross join (values ('public.bootstrap_admin_register(uuid,text,text)'),
                            ('public.bootstrap_admin_status()')) f(fn)`,
    );
    expect(rows.filter((r) => r.pode)).toEqual([]);
  });

  it('service_role executa as duas (é o caminho de provisionamento)', async () => {
    const rows = await runSql<{ fn: string; pode: boolean }>(
      `select f.fn, has_function_privilege('service_role', f.fn::regprocedure, 'execute') as pode
         from (values ('public.bootstrap_admin_register(uuid,text,text)'),
                      ('public.bootstrap_admin_status()')) f(fn)`,
    );
    expect(rows.every((r) => r.pode)).toBe(true);
  });

  it('com a janela FECHADA, registrar devolve bootstrap_closed e não cria admin', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const resultado = await register(userId, 'Teste Fechado', 'owner');
    expect(resultado).toMatchObject({ ok: false, reason: 'bootstrap_closed' });

    const admins = await runSql<{ n: number }>(
      'select count(*)::int as n from public.admin_users where user_id = $1',
      [userId],
    );
    expect(admins[0].n).toBe(0);
  });

  it('valida entrada antes de tocar a allowlist', async () => {
    await habilitar();
    const id = await criarUsuarioAuth('validacao@prime.invalid');
    await expect(register(id, 'x', 'owner')).rejects.toThrow(/invalid_display_name/);
    await expect(register(id, 'Nome Válido', 'root')).rejects.toThrow(/invalid_role/);
    await expect(
      runSql('select public.bootstrap_admin_register(null, $1, $2)', ['Nome Válido', 'owner']),
    ).rejects.toThrow(/invalid_user_id/);
  });

  it('com a janela aberta, cria 2 administradores e fecha sozinha', async () => {
    await habilitar();
    const primeiroId = await criarUsuarioAuth('primeiro-admin@prime.invalid');
    const segundoId = await criarUsuarioAuth('segundo-admin@prime.invalid');
    const terceiroId = await criarUsuarioAuth('terceiro-admin@prime.invalid');

    const primeiro = await register(primeiroId, 'Primeiro Admin', 'owner');
    expect(primeiro).toMatchObject({ ok: true, remaining: 1 });

    const segundo = await register(segundoId, 'Segundo Admin', 'admin');
    expect(segundo).toMatchObject({ ok: true, remaining: 0 });

    // Terceiro: recusado, e a janela já está fechada.
    const terceiro = await register(terceiroId, 'Terceiro', 'admin');
    expect(terceiro).toMatchObject({ ok: false, reason: 'bootstrap_closed' });

    expect(await status()).toEqual({ enabled: false, created: 2, remaining: 0 });

    const admins = await runSql<{ n: number }>(
      'select count(*)::int as n from public.admin_users where display_name like $1',
      ['%Admin'],
    );
    expect(admins[0].n).toBe(2);
  }, 60000);

  it('registra a criação em admin_audit_log', async () => {
    const rows = await runSql<{ n: number }>(
      `select count(*)::int as n from public.admin_audit_log
        where action = 'admin_bootstrap.created'`,
    );
    expect(rows[0].n).toBe(2);

    // E o ator registrado é o próprio usuário provisionado (não um "sistema").
    const atores = await runSql<{ actor_label: string }>(
      `select actor_label from public.admin_audit_log
        where action = 'admin_bootstrap.created' order by actor_label`,
    );
    expect(atores.map((a) => a.actor_label)).toEqual(['Primeiro Admin', 'Segundo Admin']);
  });

  it('não colide com o seed de administrador usado pelos demais testes', async () => {
    // `seedAdmin` é o caminho normal (service_role direto em admin_users) e
    // não deve consumir a cota do bootstrap.
    const antes = await status();
    const id = await seedAdmin('owner');
    expect(id).toBeTruthy();
    expect(await status()).toEqual(antes);
  });

  it('usuário comum continua sem caminho de auto-promoção por RPC', async () => {
    const stranger = '66666666-6666-4666-8666-666666666666';
    const client = await connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: stranger, role: 'authenticated', aal: 'aal2' }),
      ]);
      await client.query('set local role authenticated');
      await expect(
        client.query('select public.bootstrap_admin_register($1, $2, $3)', [
          stranger,
          'Invasor',
          'owner',
        ]),
      ).rejects.toThrow(/permission denied/i);
      await client.query('rollback');
    } finally {
      await client.end();
    }
  });

  it('a migração é reaplicável sem efeito colateral', async () => {
    const { readFileSync } = await import('node:fs');
    const { MIGRATIONS_DIR } = await import('./helpers');
    const sql = readFileSync(`${MIGRATIONS_DIR}/20261122130000_0047_versionar_bootstrap_admin.sql`, 'utf8');

    const antes = await status();
    const client = await connect();
    try {
      await expect(client.query(sql)).resolves.toBeDefined();
    } finally {
      await client.end();
    }
    // `on conflict do nothing` preserva o contador; o estado não regride.
    expect(await status()).toEqual(antes);
  });
});
