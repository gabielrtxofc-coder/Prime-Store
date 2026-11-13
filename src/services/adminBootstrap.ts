import { invokeFunction, BackendError } from './backend/http';

/**
 * Configuração inicial TEMPORÁRIA do painel administrativo.
 *
 * Usada apenas pela rota `/admin/setup`, disponível enquanto as duas contas
 * previstas não foram criadas. O código de configuração existe somente no
 * servidor (`SETUP_ADMIN_CODE`); o navegador apenas o transporta, uma vez,
 * pelo HTTPS da Edge Function `admin-bootstrap`.
 */

export interface BootstrapStatus {
  /** false quando o servidor não tem `SETUP_ADMIN_CODE` configurado. */
  configured: boolean;
  /** true somente quando o servidor permite criar agora (código + vagas). */
  available: boolean;
  /** Quantas contas ainda podem ser criadas (0 a 2). */
  remaining: number;
}

export interface CreateAccountInput {
  code: string;
  displayName: string;
  email: string;
  password: string;
  role: 'owner' | 'admin';
}

export interface CreateAccountResult {
  remaining: number;
}

export async function getAdminBootstrapStatus(): Promise<BootstrapStatus> {
  const payload = await invokeFunction<Partial<BootstrapStatus>>('admin-bootstrap', { method: 'GET' });
  return {
    configured: payload.configured === true,
    available: payload.available === true,
    remaining: typeof payload.remaining === 'number' && Number.isFinite(payload.remaining) ? payload.remaining : 0,
  };
}

export async function createInitialAdmin(input: CreateAccountInput): Promise<CreateAccountResult> {
  const payload = await invokeFunction<{ ok?: boolean; remaining?: number }>('admin-bootstrap', {
    method: 'POST',
    body: {
      code: input.code,
      displayName: input.displayName,
      email: input.email,
      password: input.password,
      role: input.role,
    },
  });
  return { remaining: typeof payload.remaining === 'number' ? payload.remaining : 0 };
}

/** Mensagem estável para cada código de erro da porta de configuração. */
export function describeBootstrapError(error: unknown): string {
  if (error instanceof BackendError) {
    switch (error.code) {
      case 'invalid_code':
        return 'Código de configuração incorreto. Confira com quem opera a loja.';
      case 'bootstrap_closed':
        return 'A configuração inicial foi encerrada: as duas contas já foram criadas.';
      case 'user_exists':
        return 'Já existe uma conta com este e-mail. Use "Esqueci minha senha" no login do painel.';
      case 'weak_password':
        return 'A senha precisa de pelo menos 12 caracteres, com maiúsculas, minúsculas e números.';
      case 'rate_limited':
        return 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.';
      case 'invalid_payload':
      case 'invalid_role':
        return 'Revise os dados informados e tente novamente.';
      case 'auth_unavailable':
        return 'O serviço de autenticação está indisponível agora. Tente novamente em instantes.';
      default:
        return error.message;
    }
  }
  return 'Não foi possível concluir agora. Verifique sua conexão e tente novamente.';
}
