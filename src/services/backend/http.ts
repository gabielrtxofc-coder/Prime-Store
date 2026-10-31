import { assertBackendConfigured } from './config';

/** Erro estável devolvido pelas Edge Functions (`{ error, message }`). */
export class BackendError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface InvokeOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** JWT do usuário (painel administrativo). Ausente = chamada pública. */
  accessToken?: string | null;
  signal?: AbortSignal;
}

interface FunctionErrorPayload {
  error?: string;
  message?: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Chama uma Edge Function (`POST` por padrão) com a chave anon e devolve JSON.
 * Timeouts são responsabilidade do chamador (via `signal`).
 */
export async function invokeFunction<T>(name: string, options: InvokeOptions = {}): Promise<T> {
  const { anonKey, functionsUrl } = assertBackendConfigured();
  const headers: Record<string, string> = {
    apikey: anonKey,
    'Content-Type': 'application/json',
  };
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

  const method = options.method ?? 'POST';
  const response = await fetch(`${functionsUrl}/${name}`, {
    method,
    headers,
    body: options.body === undefined || method === 'GET' ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const errorPayload = isRecord(payload) ? (payload as FunctionErrorPayload) : {};
    const code = typeof errorPayload.error === 'string' ? errorPayload.error : `http_${response.status}`;
    const message =
      typeof errorPayload.message === 'string'
        ? errorPayload.message
        : 'Não foi possível concluir a operação. Tente novamente.';
    const details = { ...errorPayload } as Record<string, unknown>;
    delete details.error;
    delete details.message;
    throw new BackendError(response.status, code, message, details);
  }

  if (!isRecord(payload)) {
    throw new BackendError(response.status, 'invalid_response', 'Resposta inesperada do servidor.');
  }

  return payload as T;
}

/** Mensagem amigável para qualquer falha de backend. */
export function describeBackendError(error: unknown): string {
  if (error instanceof BackendError) {
    switch (error.code) {
      case 'insufficient_stock':
        return 'Outro cliente finalizou a compra desta unidade. Nenhum valor foi cobrado.';
      case 'product_unavailable':
        return 'Este produto não está mais disponível.';
      case 'payment_not_configured':
        return 'O pagamento PIX ainda não está configurado neste ambiente.';
      case 'payment_provider_unavailable':
        return 'O Mercado Pago está indisponível agora. O estoque foi liberado; tente novamente.';
      case 'delivery_unavailable':
        return 'Este link de entrega foi revogado ou não está disponível.';
      case 'mfa_required':
        return 'É necessário concluir a verificação em duas etapas (TOTP).';
      case 'forbidden':
        return 'Acesso administrativo negado.';
      case 'not_found':
        return 'Registro não encontrado.';
      case 'backend_not_configured':
        return 'Backend não configurado neste ambiente.';
      default:
        return error.message;
    }
  }
  if (error instanceof Error && error.message === 'backend_not_configured') {
    return 'Backend não configurado: defina VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY e VITE_BACKEND_ENABLED=true.';
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'A operação demorou mais que o esperado. Tente novamente.';
  }
  return 'Falha de conexão com o backend. Verifique sua internet e tente novamente.';
}
