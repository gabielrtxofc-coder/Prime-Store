/**
 * Configuração inicial TEMPORÁRIA das duas contas administrativas.
 *
 * Contexto: a loja vai ao ar sem nenhuma conta. O proprietário cria as duas
 * contas previstas pelo painel, protegido por um código que existe apenas em
 * segredo do servidor (`SETUP_ADMIN_CODE`) e por uma trava no banco
 * (`bootstrap_admin_register`), que admite no máximo duas criações e apaga
 * `admin_bootstrap_enabled` na mesma transação quando a segunda acontece.
 *
 * Garantias desta porta:
 *  - sem o segredo no ambiente a função responde como inexistente (404);
 *  - o código é comparado em tempo constante (digest SHA-256 + XOR);
 *  - limite estrito por origem (5 tentativas a cada 5 minutos);
 *  - a permissão é decidida no BANCO, nunca no navegador: o cliente só envia
 *    código, nome, e-mail, senha e papel — qualquer papel diferente de
 *    `owner`/`admin` é recusado aqui e de novo no banco;
 *  - senha nunca entra em log nem no banco: vai só para a Supabase Auth;
 *  - o auth user criado é removido (melhor esforço) se o registro na
 *    allowlist for recusado — nada fica pela metade;
 *  - com duas contas criadas, a função passa a responder 410 para tudo.
 */

import type { Deps } from '../deps.ts';
import { ApiError, errorResponse, json, methodGuard, preflight, readJson } from '../http.ts';
import { enforceRateLimit } from '../rateLimit.ts';
import { isUuid, requireEmail, requireString } from '../validation.ts';

const MAX_ACCOUNTS = 2;

interface BootstrapBody {
  code?: unknown;
  displayName?: unknown;
  email?: unknown;
  password?: unknown;
  role?: unknown;
}

interface BootstrapStatus {
  enabled: boolean;
  created: number;
  remaining: number;
}

const encoder = new TextEncoder();

/** Comparação em tempo constante sobre digests: não vaza tamanho nem conteúdo. */
async function constantTimeEqual(received: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(received)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let index = 0; index < x.length; index += 1) {
    diff |= x[index] ^ y[index];
  }
  return diff === 0;
}

/** Política mínima de senha para as contas iniciais (mensagem orientativa). */
export function validatePassword(password: unknown): string {
  if (typeof password !== 'string') {
    throw new ApiError(422, 'weak_password', 'Informe uma senha válida.');
  }
  if (password.length < 12 || password.length > 128) {
    throw new ApiError(422, 'weak_password', 'A senha precisa ter entre 12 e 128 caracteres.');
  }
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  if (!hasLower || !hasUpper || !hasDigit) {
    throw new ApiError(422, 'weak_password', 'A senha precisa misturar letras maiúsculas, minúsculas e números.');
  }
  return password;
}

function parseRole(value: unknown): 'owner' | 'admin' {
  const role = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (role !== 'owner' && role !== 'admin') {
    throw new ApiError(422, 'invalid_role', 'Papel inválido. Use owner ou admin.');
  }
  return role;
}

async function readStatus(deps: Deps): Promise<BootstrapStatus> {
  const raw = (await deps.rpc('bootstrap_admin_status')) as Partial<BootstrapStatus> | null;
  const created = Number(raw?.created ?? 0);
  const remaining = Number(raw?.remaining ?? MAX_ACCOUNTS);
  return {
    enabled: raw?.enabled === true,
    created: Number.isFinite(created) ? created : 0,
    remaining: Number.isFinite(remaining) ? remaining : 0,
  };
}

async function handleGet(deps: Deps): Promise<Response> {
  const configured = Boolean(deps.config.setupAdminCode);
  if (!configured) {
    return json({ configured: false, available: false, remaining: 0 });
  }
  try {
    const status = await readStatus(deps);
    const available = status.enabled && status.remaining > 0;
    return json({ configured: true, available, remaining: available ? status.remaining : 0 });
  } catch (error) {
    deps.log('admin_bootstrap.status_unavailable', {
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    throw new ApiError(503, 'internal_error', 'Não foi possível verificar a configuração inicial.');
  }
}

async function createAuthUser(
  deps: Deps,
  input: { email: string; password: string; displayName: string },
): Promise<string> {
  const base = deps.config.supabaseUrl.replace(/\/+$/, '');
  let response: Response;
  try {
    response = await deps.fetchImpl(`${base}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: deps.config.serviceRoleKey,
        Authorization: `Bearer ${deps.config.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        email_confirm: true,
        user_metadata: { display_name: input.displayName },
      }),
    });
  } catch (fetchError) {
    deps.log('admin_bootstrap.auth_unavailable', {
      reason: fetchError instanceof Error ? fetchError.message.slice(0, 120) : 'unknown',
    });
    throw new ApiError(503, 'auth_unavailable', 'Serviço de autenticação indisponível. Tente novamente em instantes.');
  }

  const text = await response.text();
  let payload: Record<string, unknown> | null = null;
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    payload = null;
  }

  if (response.status === 409 || response.status === 422) {
    // Já existe conta com este e-mail (ou o Auth recusou o cadastro).
    throw new ApiError(409, 'user_exists', 'Já existe uma conta com este e-mail. Use a recuperação de senha no login.');
  }
  if (!response.ok || !payload || typeof payload.id !== 'string' || !isUuid(payload.id)) {
    deps.log('admin_bootstrap.auth_rejected', { status: response.status });
    throw new ApiError(503, 'auth_unavailable', 'Não foi possível criar a conta no serviço de autenticação.');
  }
  return payload.id;
}

/** Melhor esforço: remove o usuário do Auth quando o registro na allowlist falha. */
async function deleteAuthUser(deps: Deps, userId: string): Promise<void> {
  const base = deps.config.supabaseUrl.replace(/\/+$/, '');
  try {
    await deps.fetchImpl(`${base}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: {
        apikey: deps.config.serviceRoleKey,
        Authorization: `Bearer ${deps.config.serviceRoleKey}`,
      },
    });
  } catch (error) {
    deps.log('admin_bootstrap.rollback_failed', {
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
  }
}

async function handlePost(request: Request, deps: Deps): Promise<Response> {
  const setupCode = deps.config.setupAdminCode;
  if (!setupCode) {
    // Indistinguível de "não existe": fecha por padrão.
    throw new ApiError(404, 'not_found', 'Registro não encontrado.');
  }

  const rate = await enforceRateLimit(request, deps, 'admin-bootstrap');
  if (rate) return rate;

  const body = await readJson<BootstrapBody>(request);

  const code = typeof body.code === 'string' ? body.code : '';
  if (!code || !(await constantTimeEqual(code, setupCode))) {
    deps.log('admin_bootstrap.invalid_code');
    throw new ApiError(403, 'invalid_code', 'Código de configuração inválido.');
  }

  const displayName = requireString(body.displayName, 'nome de exibição', { min: 2, max: 80 });
  const email = requireEmail(body.email, 'e-mail').toLowerCase();
  const password = validatePassword(body.password);
  const role = parseRole(body.role);

  const status = await readStatus(deps);
  if (!status.enabled || status.remaining <= 0) {
    throw new ApiError(410, 'bootstrap_closed', 'A configuração inicial foi encerrada. As duas contas já foram criadas.');
  }

  // Cria a identidade na Supabase Auth (senha cadastrada pelo proprietário)…
  const userId = await createAuthUser(deps, { email, password, displayName });

  // …e só então a allowlist, atomicamente com o teto de duas contas. Se o
  // banco recusar, o usuário recém-criado é removido: nada fica pela metade.
  let result: { ok?: boolean; reason?: string; remaining?: number } | null;
  try {
    result = (await deps.rpc('bootstrap_admin_register', {
      p_user_id: userId,
      p_display_name: displayName,
      p_role: role,
    })) as { ok?: boolean; reason?: string; remaining?: number } | null;
  } catch (error) {
    await deleteAuthUser(deps, userId);
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('bootstrap_closed')) {
      throw new ApiError(410, 'bootstrap_closed', 'A configuração inicial foi encerrada. As duas contas já foram criadas.');
    }
    if (message.includes('invalid_role') || message.includes('invalid_display_name') || message.includes('invalid_user_id')) {
      throw new ApiError(422, 'invalid_payload', 'Não foi possível usar os dados informados.');
    }
    if (message.includes('duplicate') || message.includes('admin_users_pkey')) {
      throw new ApiError(409, 'user_exists', 'Esta conta já está registrada como administradora.');
    }
    deps.log('admin_bootstrap.register_failed', { reason: message.slice(0, 160) });
    throw new ApiError(500, 'internal_error', 'Não foi possível registrar a conta administrativa.');
  }

  if (result?.ok === false) {
    // Corrida do teto de duas contas: o banco desligou a porta e devolveu
    // ok:false (sem gravar nada na allowlist). Desfaz o usuário do Auth.
    await deleteAuthUser(deps, userId);
    if (result.reason === 'bootstrap_closed') {
      throw new ApiError(410, 'bootstrap_closed', 'A configuração inicial foi encerrada. As duas contas já foram criadas.');
    }
    throw new ApiError(500, 'internal_error', 'Não foi possível registrar a conta administrativa.');
  }

  const remaining = Number(result?.remaining ?? 0);
  deps.log('admin_bootstrap.created', { role, remaining });
  return json({ ok: true, remaining });
}

export async function handleAdminBootstrap(request: Request, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();

  try {
    if (request.method === 'GET') {
      return await handleGet(deps);
    }
    methodGuard(request, ['POST']);
    return await handlePost(request, deps);
  } catch (error) {
    return errorResponse(error);
  }
}
