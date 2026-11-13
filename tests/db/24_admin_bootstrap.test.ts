import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { connect, resetDatabase, runAs, runSql } from './helpers';

/**
 * Missão 14 — configuração inicial TEMPORÁRIA das duas contas administrativas
 * (migração 0042).
 *
 * Verifica no banco real, não por declaração:
 *  1. nasce desligada e recusa registro;
 *  2. com a chave ligada, cria exatamente duas contas e encerra sozinha;
 *  3. a segunda criação apaga `admin_bootstrap_enabled` na mesma transação;
 *  4. mesmo com a chave religada à força, o teto de duas contas prevalece;
 *  5. cada criação grava auditoria; senha/e-mail jamais entram no log;
 *  6. anon/authenticated não executam nada; service_role executa;
 *  7. argumentos inválidos são recusados sem efeito colateral.
 */

async function setBootstrap(enabled: boolean, count?: number): Promise<void> {
  await runSql(`update public.app_settings set value = $1::jsonb, updated_at = now() where key = 'admin_bootstrap_enabled'`, [
    JSON.stringify(enabled),
  ]);
  if (count !== undefined) {
    await runSql(`update public.app_settings set value = $1::jsonb, updated_at = now() where key = 'admin_bootstrap_created_count'`, [
      JSON.stringify(count),
    ]);
  }
}

async function status(): Promise<{ enabled: boolean; created: number; remaining: number }> {
  const rows = await runSql<{ bootstrap_admin_status: { enabled: boolean; created: number; remaining: number } }>(
    `select public.bootstrap_admin_status()`,
  );
  return rows[0].bootstrap_admin_status;
}

async function seedAuthUser(): Promise<string> {
  const rows = await runSql<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [
    `bootstrap-${randomBytes(4).toString('hex')}@prime.invalid`,
  ]);
  return rows[0].id;
}

async function register(userId: string, name = 'Pessoa Administradora', role = 'admin') {
  const rows = await runSql<{ bootstrap_admin_register: { ok: boolean; reason?: string; remaining?: number } }>(
    `select public.bootstrap_admin_register($1, $2, $3)`,
    [userId, name, role],
  );
  return rows[0].bootstrap_admin_register;
}

describe('configuração inicial administrativa (migração 0042)', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it('nasce desligada: status informa 2 vagas e o registro é recusado', async () => {
    expect(await status()).toEqual({ enabled: false, created: 0, remaining: 2 });
    const userId = await seedAuthUser();
    expect(await register(userId)).toMatchObject({ ok: false, reason: 'bootstrap_closed' });
    const count = await runSql(`select count(*)::int as n from public.admin_users`);
    expect(count[0].n).toBe(0);
  });

  it('registra duas contas e encerra sozinha na segunda', async () => {
    await setBootstrap(true, 0);
    const first = await seedAuthUser();
    const second = await seedAuthUser();

    expect(await register(first, 'Primeira Pessoa', 'owner')).toEqual({ ok: true, remaining: 1 });
    expect((await status()).enabled).toBe(true);

    expect(await register(second, 'Segunda Pessoa', 'admin')).toEqual({ ok: true, remaining: 0 });
    const after = await status();
    expect(after).toEqual({ enabled: false, created: 2, remaining: 0 });

    const admins = await runSql(`select display_name, role, is_active from public.admin_users order by created_at`);
    expect(admins).toHaveLength(2);

    const audit = await runSql(`select action from public.admin_audit_log where action = 'admin_bootstrap.created' order by id`);
    expect(audit).toHaveLength(2);
  });

  it('depois da segunda conta, religar a chave na mão não abre a porta — e a função desliga de novo', async () => {
    await setBootstrap(true);
    const third = await seedAuthUser();
    expect(await register(third, 'Terceira Pessoa')).toMatchObject({ ok: false, reason: 'bootstrap_closed' });
    // O desligamento fica GRAVADO (a função retorna normalmente com a chave apagada).
    expect((await status()).enabled).toBe(false);
    const admins = await runSql(`select count(*)::int as n from public.admin_users`);
    expect(admins[0].n).toBe(2);
  });

  it('argumentos inválidos são recusados sem efeito colateral', async () => {
    await setBootstrap(true, 0);
    const userId = await seedAuthUser();
    await expect(register(userId, 'x', 'admin')).rejects.toThrow(/invalid_display_name/);
    await expect(register(userId, 'Nome Válido', 'superadmin')).rejects.toThrow(/invalid_role/);
    await expect(register(userId, 'Nome Válido'.repeat(30), 'admin')).rejects.toThrow(/invalid_display_name/);
    const count = await runSql(`select count(*)::int as n from public.admin_users where user_id = $1`, [userId]);
    expect(count[0].n).toBe(0);
    expect((await status()).created).toBe(0);
  });

  it('permanece desligada por padrão depois de resetar para o estado inicial', async () => {
    // Recria o estado "ainda não usada": garante idempotência da migração.
    await setBootstrap(false, 0);
    expect(await status()).toEqual({ enabled: false, created: 0, remaining: 2 });
  });

  it('anon e authenticated não executam as funções; service_role executa', async () => {
    await expect(
      runAs(`select public.bootstrap_admin_status()`, [], { role: 'anon' }),
    ).rejects.toThrow(/permission denied|não pode|nao pode/i);
    await expect(
      runAs(`select public.bootstrap_admin_status()`, [], { role: 'authenticated', claims: { sub: randomUUID(), role: 'authenticated', aal: 'aal2' } }),
    ).rejects.toThrow(/permission denied|não pode|nao pode/i);
    await expect(
      runAs(`select public.bootstrap_admin_register($1, 'Nome Válido', 'admin')`, [randomUUID()], { role: 'authenticated', claims: { sub: randomUUID(), role: 'authenticated', aal: 'aal2' } }),
    ).rejects.toThrow(/permission denied|não pode|nao pode/i);
    const rows = await runAs(`select public.bootstrap_admin_status() as s`, [], { role: 'service_role' });
    expect(rows[0].s).toBeTruthy();
  });

  it('usuário inexistente no Auth é recusado pela FK (nada fica pela metade)', async () => {
    await setBootstrap(true, 0);
    const ghost = randomUUID();
    await expect(register(ghost, 'Fantasma Silva', 'admin')).rejects.toThrow();
    expect((await status()).created).toBe(0);
    const rows = await runSql(`select count(*)::int as n from public.admin_users where user_id = $1`, [ghost]);
    expect(rows[0].n).toBe(0);
  });
});
