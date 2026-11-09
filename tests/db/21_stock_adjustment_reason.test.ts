import { randomBytes } from 'node:crypto';
import type { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleAdminApi } from '../../supabase/functions/_shared/handlers/adminApi';
import type { Deps } from '../../supabase/functions/_shared/deps';
import { toBase64 } from '../../supabase/functions/_shared/crypto';
import {
  connect,
  resetDatabase,
  runAs,
  runSql,
  seedAdmin,
  seedProduct,
  seedStockUnit,
  sqlValue,
  RELAXED_RATE_LIMIT_OVERRIDES,
} from './helpers';
import { createPgRpc } from './pgRpc';

/**
 * Missão 07 (T037) — motivos categorizados de ajuste de estoque.
 *
 * O que esta suíte comprova:
 *  - desativar uma unidade SEM motivo, com motivo inválido ou com 'other'
 *    sem nota é recusado no banco (fonte de verdade), com erro estável;
 *  - desativar com motivo válido persiste status + motivo + nota e registra
 *    o motivo na auditoria;
 *  - reativar limpa o motivo;
 *  - o gateway (stock.setStatus) exige motivo ANTES de tocar no banco e
 *    recusa notas longas demais;
 *  - admin_list_stock devolve o motivo para o painel.
 */

const MASTER_KEY = toBase64(randomBytes(32));

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function fakeAuth(userId: string | null): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/auth/v1/user')) {
      return userId
        ? new Response(JSON.stringify({ id: userId }), { status: 200 })
        : new Response(JSON.stringify({ message: 'invalid jwt' }), { status: 401 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

function buildDeps(client: Client, adminId: string | null): Deps {
  const userRpc = adminId
    ? createPgRpc(client, {
        role: 'authenticated',
        claims: { sub: adminId, role: 'authenticated', aal: 'aal2' },
      })
    : createPgRpc(client);
  return {
    config: {
      supabaseUrl: 'https://fake-project.supabase.test',
      serviceRoleKey: 'service-role-key',
      anonKey: 'anon-key',
      encryptionKey: MASTER_KEY,
      storeUrl: 'http://localhost:5173',
      rateLimitOverrides: RELAXED_RATE_LIMIT_OVERRIDES,
    },
    rpc: createPgRpc(client),
    rpcForUser: () => userRpc,
    serviceRpc: createPgRpc(client),
    resolveEncryptionKey: async () => MASTER_KEY,
    fetchImpl: fakeAuth(adminId),
    now: () => new Date(),
    log: () => undefined,
  };
}

describe('motivos categorizados de ajuste de estoque (migração 0038)', () => {
  let client: Client;
  let adminId: string;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
    adminId = await seedAdmin('admin');
  }, 60000);

  const asAdmin = (sql: string, values: unknown[] = []) =>
    runAs(sql, values, { role: 'authenticated', claims: { sub: adminId, role: 'authenticated', aal: 'aal2' } });

  it('desativar sem motivo é recusado (adjustment_reason_required)', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    await expect(
      asAdmin(`select public.admin_set_stock_unit_status($1, 'disabled')`, [seed.units[0]]),
    ).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('adjustment_reason_required') });
    // Nada foi alterado.
    expect(await sqlValue<string>(`select status from public.stock_units where id = $1`, [seed.units[0]])).toBe('available');
  });

  it('desativar com motivo desconhecido é recusado (invalid_adjustment_reason)', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    await expect(
      asAdmin(`select public.admin_set_stock_unit_status($1, 'disabled', 'motivo_inventado')`, [seed.units[0]]),
    ).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('invalid_adjustment_reason') });
  });

  it("motivo 'other' exige nota com pelo menos 5 caracteres", async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    await expect(
      asAdmin(`select public.admin_set_stock_unit_status($1, 'disabled', 'other', 'x')`, [seed.units[0]]),
    ).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('adjustment_reason_note_required') });
    const [row] = await asAdmin<{ admin_set_stock_unit_status: { status: string } }>(
      `select public.admin_set_stock_unit_status($1, 'disabled', 'other', 'conta comprometida em vazamento interno')`,
      [seed.units[0]],
    );
    expect(row.admin_set_stock_unit_status.status).toBe('disabled');
  });

  it('desativar com motivo válido persiste motivo + nota e registra na auditoria', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    await asAdmin(
      `select public.admin_set_stock_unit_status($1, 'disabled', 'compromised_credential', 'simulação de suspeita registrada em auditoria')`,
      [seed.units[0]],
    );
    const [row] = await runSql<{ status: string; status_reason: string; status_reason_note: string }>(
      `select status, status_reason, status_reason_note from public.stock_units where id = $1`,
      [seed.units[0]],
    );
    expect(row).toMatchObject({ status: 'disabled', status_reason: 'compromised_credential' });
    expect(row.status_reason_note).toContain('simulação');

    const [audit] = await runSql<{ metadata: Record<string, unknown> }>(
      `select metadata from public.admin_audit_log where action = 'stock_unit_status_changed' and entity_id = $1 order by id desc limit 1`,
      [seed.units[0]],
    );
    expect(audit.metadata).toMatchObject({ reason: 'compromised_credential', to: 'disabled' });
  });

  it('reativar limpa o motivo da unidade', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    await asAdmin(`select public.admin_set_stock_unit_status($1, 'disabled', 'duplicate_import')`, [seed.units[0]]);
    await asAdmin(`select public.admin_set_stock_unit_status($1, 'available')`, [seed.units[0]]);
    const [row] = await runSql<{ status: string; status_reason: string | null; status_reason_note: string }>(
      `select status, status_reason, status_reason_note from public.stock_units where id = $1`,
      [seed.units[0]],
    );
    expect(row).toMatchObject({ status: 'available', status_reason: null, status_reason_note: '' });
  });

  it('nota acima de 300 caracteres é recusada', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    await expect(
      asAdmin(`select public.admin_set_stock_unit_status($1, 'disabled', 'data_correction', $2)`, [seed.units[0], 'n'.repeat(301)]),
    ).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('invalid_reason_note') });
  });

  it('gateway stock.setStatus sem motivo devolve 422 sem tocar no banco', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    const deps = buildDeps(client, adminId);
    const response = await handleAdminApi(
      postJson('https://fn.test/admin-api', { action: 'stock.setStatus', payload: { stockUnitId: seed.units[0], status: 'disabled' } }, { Authorization: 'Bearer jwt-1' }),
      deps,
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('adjustment_reason_required');
    expect(await sqlValue<string>(`select status from public.stock_units where id = $1`, [seed.units[0]])).toBe('available');
  });

  it('gateway stock.setStatus com motivo persiste e audita', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    const deps = buildDeps(client, adminId);
    const response = await handleAdminApi(
      postJson('https://fn.test/admin-api', {
        action: 'stock.setStatus',
        payload: { stockUnitId: seed.units[0], status: 'disabled', reason: 'invalid_credential', note: 'conta suspensa pelo provedor' },
      }, { Authorization: 'Bearer jwt-1' }),
      deps,
    );
    expect(response.status).toBe(200);
    const [row] = await runSql<{ status_reason: string; status_reason_note: string }>(
      `select status_reason, status_reason_note from public.stock_units where id = $1`,
      [seed.units[0]],
    );
    expect(row).toMatchObject({ status_reason: 'invalid_credential' });
    expect(row.status_reason_note).toContain('suspensa');
  });

  it('admin_list_stock expõe o motivo para o painel', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    await asAdmin(`select public.admin_set_stock_unit_status($1, 'disabled', 'inventory_adjustment', 'contagem física')`, [seed.units[0]]);
    const [result] = await asAdmin<{ admin_list_stock: { items: Array<{ id: string; status_reason: string; status_reason_note: string }> } }>(
      `select public.admin_list_stock($1, 'disabled', null, 10, 0, false)`,
      [seed.productId],
    );
    const item = result.admin_list_stock.items.find((candidate) => candidate.id === seed.units[0]);
    expect(item).toBeDefined();
    expect(item?.status_reason).toBe('inventory_adjustment');
    expect(item?.status_reason_note).toContain('contagem');
  });
});
