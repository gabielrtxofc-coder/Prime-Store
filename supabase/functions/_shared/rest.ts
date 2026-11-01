/**
 * Cliente mínimo de PostgREST para chamar funções do banco.
 *
 * Sem SDK: mantém as Edge Functions sem dependências npm e permite injetar
 * `fetch` nos testes.
 */

export interface RestErrorBody {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export class DatabaseError extends Error {
  readonly code: string;
  readonly detail?: string;
  readonly status: number;

  constructor(status: number, code: string, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export interface RpcClientOptions {
  url: string;
  apiKey: string;
  /** JWT do usuário (obrigatório para funções administrativas). */
  authorization?: string;
  fetchImpl?: typeof fetch;
}

export type RpcFn = <T = unknown>(name: string, args?: Record<string, unknown>) => Promise<T>;

export function createRpcClient(options: RpcClientOptions): RpcFn {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.url.replace(/\/+$/, '');

  return async function rpc<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: options.apiKey,
        Authorization: options.authorization ?? `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(args),
    });

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const body = (payload ?? {}) as RestErrorBody;
      throw new DatabaseError(
        response.status,
        body.code ?? 'rpc_failed',
        body.message ?? `Falha ao executar ${name}`,
        body.details ?? body.hint,
      );
    }

    return payload as T;
  };
}
