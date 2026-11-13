import { describe, expect, it, vi } from 'vitest';
import { handleAdminBootstrap } from '../../supabase/functions/_shared/handlers/adminBootstrap';
import type { Deps } from '../../supabase/functions/_shared/deps';

/**
 * Missão 14 — porta TEMPORÁRIA de configuração inicial (handler da Edge Function).
 *
 * Garantias verificadas sem rede:
 *  - sem `SETUP_ADMIN_CODE` no ambiente a porta responde como inexistente (404/GET false);
 *  - código errado nunca chega a criar usuário no Auth;
 *  - configuração encerrada no banco responde 410 antes de tocar no Auth;
 *  - senha fraca é recusada antes de qualquer chamada externa;
 *  - no caminho feliz a senha só vai para o Auth (Admin API), nunca para o banco;
 *  - se o banco recusar o registro (corrida do teto de 2), o usuário do Auth é removido;
 *  - o limite de tentativas por origem bloqueia antes do Auth.
 */

const SECRET = 'codigo-de-configuracao-super-secreto-1234567890';
const NEW_USER_ID = '11111111-1111-4111-8111-111111111111';

type RpcBehavior = (name: string, args?: Record<string, unknown>) => Promise<unknown>;

function postJson(body: unknown): Request {
  return new Request('https://fn.test/admin-bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function buildDeps(rpcBehavior: RpcBehavior, overrides: Partial<Deps> = {}): Deps {
  const fetchImpl = vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
    const method = (init?.method ?? 'POST').toUpperCase();
    if (String(input).endsWith('/auth/v1/admin/users') && method === 'POST') {
      return new Response(JSON.stringify({ id: NEW_USER_ID }), { status: 200 });
    }
    if (String(input).includes('/auth/v1/admin/users/') && method === 'DELETE') {
      return new Response(null, { status: 200 });
    }
    throw new Error(`fetch inesperado: ${method} ${String(input)}`);
  });
  return {
    config: {
      supabaseUrl: 'https://fake-project.supabase.test',
      serviceRoleKey: 'service-role-key',
      anonKey: 'anon-key',
      mercadoPagoAccessToken: null,
      mercadoPagoWebhookSecret: null,
      mercadoPagoApiBase: 'https://api.mercadopago.com',
      encryptionKey: null,
      storeUrl: 'http://localhost:5173',
      paymentNotificationUrl: null,
      demoPaymentEnabled: false,
      demoAllowedProjectRefs: [],
      allowedOrigins: ['http://localhost:5173'],
      rateLimitSecret: 'rate-limit-secret',
      rateLimitOverrides: {},
      setupAdminCode: SECRET,
    },
    rpc: rpcBehavior as Deps['rpc'],
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => new Date(),
    log: () => undefined,
    resolveEncryptionKey: async () => null,
    ...overrides,
  };
}

/** rpc padrão: anti-flood libera; bootstrap aberto com vagas restantes. */
function openRpc(remaining = 2, created = 0): RpcBehavior {
  return async (name) => {
    if (name === 'consume_rate_limit') return { allowed: true, hits: 1, limit: 5, remaining: 4, window_seconds: 300, retry_after_seconds: 300 };
    if (name === 'bootstrap_admin_status') return { enabled: true, created, remaining };
    if (name === 'bootstrap_admin_register') return { ok: true, remaining: remaining - 1 };
    throw new Error(`rpc inesperada: ${name}`);
  };
}

const VALID_BODY = {
  code: SECRET,
  displayName: 'Proprietário da Loja',
  email: 'Dono@Example.com',
  password: 'SenhaForte1234',
  role: 'owner',
};

describe('admin-bootstrap — handler', () => {
  it('GET sem segredo no servidor: porta invisível e rpc nunca chamada', async () => {
    const rpc = vi.fn(async () => ({}));
    const deps = buildDeps(rpc, { config: { ...buildDeps(rpc).config, setupAdminCode: null } });
    const response = await handleAdminBootstrap(new Request('https://fn.test/admin-bootstrap', { method: 'GET' }), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false, available: false, remaining: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('GET com porta aberta informa vagas; com porta fechada informa zero', async () => {
    const open = await handleAdminBootstrap(new Request('https://fn.test/admin-bootstrap', { method: 'GET' }), buildDeps(openRpc(2, 0)));
    expect(await open.json()).toEqual({ configured: true, available: true, remaining: 2 });

    const openRpcOne = openRpc(1, 1);
    const half = await handleAdminBootstrap(new Request('https://fn.test/admin-bootstrap', { method: 'GET' }), buildDeps(openRpcOne));
    expect(await half.json()).toEqual({ configured: true, available: true, remaining: 1 });

    const closedRpc: RpcBehavior = async (name) => {
      if (name === 'bootstrap_admin_status') return { enabled: false, created: 2, remaining: 0 };
      throw new Error(name);
    };
    const closed = await handleAdminBootstrap(new Request('https://fn.test/admin-bootstrap', { method: 'GET' }), buildDeps(closedRpc));
    expect(await closed.json()).toEqual({ configured: true, available: false, remaining: 0 });
  });

  it('POST sem segredo configurado responde 404 como rota inexistente', async () => {
    const deps = buildDeps(openRpc(), { config: { ...buildDeps(openRpc()).config, setupAdminCode: null } });
    const response = await handleAdminBootstrap(postJson(VALID_BODY), deps);
    expect(response.status).toBe(404);
  });

  it('código errado: 403 e nenhum usuário é criado no Auth', async () => {
    const deps = buildDeps(openRpc());
    const response = await handleAdminBootstrap(postJson({ ...VALID_BODY, code: 'errado-errado-errado' }), deps);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('invalid_code');
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it('configuração encerrada no banco: 410 antes de tocar no Auth', async () => {
    const closedRpc: RpcBehavior = async (name) => {
      if (name === 'consume_rate_limit') return { allowed: true };
      if (name === 'bootstrap_admin_status') return { enabled: false, created: 2, remaining: 0 };
      throw new Error(`rpc inesperada: ${name}`);
    };
    const deps = buildDeps(closedRpc);
    const response = await handleAdminBootstrap(postJson(VALID_BODY), deps);
    expect(response.status).toBe(410);
    expect((await response.json()).error).toBe('bootstrap_closed');
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it('senha fraca: 422 weak_password antes de qualquer chamada externa', async () => {
    const deps = buildDeps(openRpc());
    const response = await handleAdminBootstrap(postJson({ ...VALID_BODY, password: 'curta1' }), deps);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe('weak_password');
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it('papel fora de owner/admin: 422 invalid_role', async () => {
    const deps = buildDeps(openRpc());
    const response = await handleAdminBootstrap(postJson({ ...VALID_BODY, role: 'superadmin' }), deps);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe('invalid_role');
  });

  it('caminho feliz: senha só vai para o Auth; allowlist gravada no banco; senha jamais no log', async () => {
    const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
    const logs: unknown[] = [];
    const rpcBehavior: RpcBehavior = async (name, args) => {
      calls.push({ name, args });
      if (name === 'consume_rate_limit') return { allowed: true };
      if (name === 'bootstrap_admin_status') return { enabled: true, created: 0, remaining: 2 };
      if (name === 'bootstrap_admin_register') return { ok: true, remaining: 1 };
      throw new Error(name);
    };
    const deps = buildDeps(rpcBehavior, { log: (event, meta) => logs.push([event, meta]) });
    const response = await handleAdminBootstrap(postJson(VALID_BODY), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, remaining: 1 });

    // A senha aparece apenas na chamada ao endpoint admin do Auth.
    const fetchMock = vi.mocked(deps.fetchImpl);
    const authCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/auth/v1/admin/users'));
    expect(authCall).toBeDefined();
    const authBody = JSON.parse(String(authCall![1]?.body)) as Record<string, unknown>;
    expect(authBody).toMatchObject({ email: 'dono@example.com', password: 'SenhaForte1234', email_confirm: true });

    // O banco nunca recebe a senha.
    const registerCall = calls.find((call) => call.name === 'bootstrap_admin_register');
    expect(registerCall?.args).toEqual({ p_user_id: NEW_USER_ID, p_display_name: 'Proprietário da Loja', p_role: 'owner' });
    expect(JSON.stringify(calls)).not.toContain('SenhaForte1234');
    expect(JSON.stringify(logs)).not.toContain('SenhaForte1234');
    expect(JSON.stringify(logs)).not.toContain('dono@example.com');
  });

  it('banco recusa por corrida do teto: Auth desfeito (rollback) e 410', async () => {
    const calls: string[] = [];
    const rpcBehavior: RpcBehavior = async (name) => {
      calls.push(name);
      if (name === 'consume_rate_limit') return { allowed: true };
      if (name === 'bootstrap_admin_status') return { enabled: true, created: 1, remaining: 1 };
      if (name === 'bootstrap_admin_register') throw new Error('bootstrap_closed');
      throw new Error(name);
    };
    const deps = buildDeps(rpcBehavior);
    const response = await handleAdminBootstrap(postJson(VALID_BODY), deps);
    expect(response.status).toBe(410);
    expect((await response.json()).error).toBe('bootstrap_closed');

    // Rollout: POST cria, DELETE remove o usuário órfão.
    const fetchMock = vi.mocked(deps.fetchImpl);
    const methods = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit | undefined)?.method ?? 'POST').toUpperCase());
    expect(methods).toEqual(['POST', 'DELETE']);
  });

  it('limite de tentativas: 429 antes de qualquer verificação de código', async () => {
    const limitedRpc: RpcBehavior = async (name) => {
      if (name === 'consume_rate_limit') {
        return { allowed: false, hits: 6, limit: 5, remaining: 0, window_seconds: 300, retry_after_seconds: 240 };
      }
      throw new Error(`rpc inesperada: ${name}`);
    };
    const deps = buildDeps(limitedRpc);
    const response = await handleAdminBootstrap(postJson(VALID_BODY), deps);
    expect(response.status).toBe(429);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });
});
