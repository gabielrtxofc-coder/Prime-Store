import { describe, expect, it, vi } from 'vitest';
import { handleAdminApi } from '../../supabase/functions/_shared/handlers/adminApi';
import type { Deps } from '../../supabase/functions/_shared/deps';
import { toBase64 } from '../../supabase/functions/_shared/crypto';
import { randomBytes } from 'node:crypto';

/**
 * Missão 07 (GRUPO 11 / T049–T052) — resiliência das rotas administrativas.
 *
 * Garante, sem precisar de PostgreSQL vivo:
 *  - queda TOTAL do banco (conexão recusada) não vaza detalhes internos nem
 *    derruba o processo: resposta 500 `internal_error` com mensagem fixa;
 *  - provedor de autenticação fora do ar falha FECHADO com 503
 *    `auth_unavailable` — nunca autoriza, nunca escreve no banco;
 *  - auth recusando a sessão responde 401 (e não 5xx);
 *  - chave de criptografia ausente responde 503 `not_configured` e NADA é
 *    gravado (rpc nunca é chamada);
 *  - a verificação de MFA/admin é fail-closed: falha no rpc `is_admin`
 *    vira `is_admin: false`, não uma exceção;
 *  - rate limit indisponível é fail-open deliberado e registrado em log.
 */

const MASTER_KEY = toBase64(randomBytes(32));
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const UNIT_ID = '22222222-2222-4222-8222-222222222222';

function postJson(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://fn.test/admin-api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function buildDeps(overrides: Partial<Deps> = {}): Deps {
  const userRpc = vi.fn(async () => false) as unknown as Deps['rpc'];
  return {
    config: {
      supabaseUrl: 'https://fake-project.supabase.test',
      serviceRoleKey: 'service-role-key',
      anonKey: 'anon-key',
      encryptionKey: MASTER_KEY,
      storeUrl: 'http://localhost:5173',
      rateLimitOverrides: { 'admin-api': { limit: 10_000, windowSeconds: 60 } },
    },
    rpc: userRpc,
    rpcForUser: () => userRpc,
    serviceRpc: vi.fn(async () => {
      throw new Error('service rpc must not be used in these tests');
    }) as unknown as Deps['rpc'],
    resolveEncryptionKey: async () => MASTER_KEY,
    fetchImpl: (async () => new Response(JSON.stringify({ id: ADMIN_ID }), { status: 200 })) as unknown as typeof fetch,
    now: () => new Date(),
    log: () => undefined,
    ...overrides,
  };
}

const asAdmin = { Authorization: 'Bearer jwt-admin' };

describe('resiliência — falhas de infraestrutura no admin-api', () => {
  it('queda total do banco: 500 internal_error genérico, sem vazar ECONNREFUSED', async () => {
    const deadRpc = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
    }) as unknown as Deps['rpc'];
    const deps = buildDeps({
      rpc: deadRpc,
      rpcForUser: () => deadRpc,
      // anti-flood também falha; fail-open deliberado não deve esconder o erro do banco
    });

    const response = await handleAdminApi(postJson({ action: 'indicators' }, asAdmin), deps);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('internal_error');
    expect(body.message).toBe('Não foi possível concluir a operação.');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('objeto de erro do PostgREST desconhecido: 500 genérico, sem vazar mensagem do banco', async () => {
    const pgError = Object.assign(new Error('relation "admin_users" does not exist'), { code: '42P01' });
    const deadRpc = vi.fn(async () => {
      throw pgError;
    }) as unknown as Deps['rpc'];
    const deps = buildDeps({ rpc: deadRpc, rpcForUser: () => deadRpc });

    const response = await handleAdminApi(postJson({ action: 'products.list' }, asAdmin), deps);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('internal_error');
    expect(JSON.stringify(body)).not.toContain('admin_users');
    expect(JSON.stringify(body)).not.toContain('42P01');
  });

  it('provedor de auth fora do ar: 503 auth_unavailable, nada é gravado', async () => {
    const userRpc = vi.fn(async () => ({})) as unknown as Deps['rpc'];
    const deps = buildDeps({
      rpc: userRpc,
      rpcForUser: () => userRpc,
      fetchImpl: (async () => {
        throw new Error('fetch failed');
      }) as unknown as typeof fetch,
    });

    const response = await handleAdminApi(postJson({ action: 'indicators' }, asAdmin), deps);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('auth_unavailable');
    // Falha fechada: nenhuma AÇÃO de negócio chegou ao banco (só o anti-flood,
    // que é fail-open e nunca concede acesso).
    const businessCalls = userRpc.mock.calls.filter(([name]) => name !== 'consume_rate_limit');
    expect(businessCalls).toHaveLength(0);
  });

  it('auth recusando o token responde 401 (não 5xx)', async () => {
    const deps = buildDeps({
      fetchImpl: (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch,
    });
    const response = await handleAdminApi(postJson({ action: 'indicators' }, asAdmin), deps);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe('unauthorized');
  });

  it('chave de criptografia ausente: 503 not_configured e rpc nunca é chamada', async () => {
    const userRpc = vi.fn(async () => ({})) as unknown as Deps['rpc'];
    const deps = buildDeps({
      rpc: userRpc,
      rpcForUser: () => userRpc,
      resolveEncryptionKey: async () => null,
    });

    const response = await handleAdminApi(
      postJson(
        { action: 'stock.add', payload: { productId: UNIT_ID, email: 'conta@exemplo.com', password: 'senha123' } },
        asAdmin,
      ),
      deps,
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('not_configured');
    const businessCalls = userRpc.mock.calls.filter(([name]) => name !== 'consume_rate_limit');
    expect(businessCalls).toHaveLength(0);
  });

  it('verificação admin/MFA falha fechada: rpc is_admin lança → is_admin:false', async () => {
    const flakyRpc = vi.fn(async () => {
      throw new Error('connection reset');
    }) as unknown as Deps['rpc'];
    const deps = buildDeps({ rpc: flakyRpc, rpcForUser: () => flakyRpc });

    const response = await handleAdminApi(postJson({ action: 'session' }, asAdmin), deps);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { is_admin: boolean; mfa_satisfied: boolean };
    expect(body.is_admin).toBe(false);
    expect(body.mfa_satisfied).toBe(false);
  });

  it('rate limit indisponível é fail-open e registrado (login não cai com o contador)', async () => {
    const log = vi.fn();
    const failingLimitRpc = vi.fn(async (name: string) => {
      if (name === 'consume_rate_limit') throw new Error('rate table missing');
      return true; // is_admin → admin
    });
    const deps = buildDeps({
      rpc: failingLimitRpc as unknown as Deps['rpc'],
      rpcForUser: () => failingLimitRpc as unknown as Deps['rpc'],
      log,
    });

    const response = await handleAdminApi(postJson({ action: 'session' }, asAdmin), deps);
    expect(response.status).toBe(200); // liberou a requisição
    expect(log).toHaveBeenCalledWith('rate_limit.unavailable', expect.objectContaining({ route: 'admin-api' }));
  });

  it('falha de banco no anti-flood NÃO impede a resposta (fail-open) nem autoriza indevidamente', async () => {
    // Mesmo cenário acima, mas verificando que o banco continua decidindo is_admin.
    const failingLimitRpc = vi.fn(async (name: string) => {
      if (name === 'consume_rate_limit') throw new Error('timeout');
      return false; // is_admin → NÃO é admin
    });
    const deps = buildDeps({
      rpc: failingLimitRpc as unknown as Deps['rpc'],
      rpcForUser: () => failingLimitRpc as unknown as Deps['rpc'],
    });

    const response = await handleAdminApi(postJson({ action: 'session' }, asAdmin), deps);
    const body = (await response.json()) as { is_admin: boolean };
    expect(body.is_admin).toBe(false);
  });
});
