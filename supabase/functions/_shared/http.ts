/** Utilitários HTTP compartilhados pelas Edge Functions (sem dependências). */

export interface JsonResponseInit {
  status?: number;
  headers?: Record<string, string>;
}

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

export function json(body: unknown, init: JsonResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Converte erros conhecidos em respostas estáveis (nunca vaza stack/SQL). */
export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json(
      { error: error.code, message: error.message, ...(error.details ?? {}) },
      { status: error.status },
    );
  }

  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('insufficient_stock')) {
    const detail = (error as { detail?: string }).detail;
    return json(
      { error: 'insufficient_stock', message: 'Estoque insuficiente para essa quantidade.', available_units: Number(detail ?? 0) },
      { status: 409 },
    );
  }
  if (message.includes('quantity_above_product_limit')) {
    return json({ error: 'quantity_above_product_limit', message: 'Quantidade acima do limite do produto.' }, { status: 422 });
  }
  if (message.includes('product_unavailable') || message.includes('product_not_found')) {
    return json({ error: 'product_unavailable', message: 'Produto indisponível.' }, { status: 404 });
  }
  if (message.includes('order_not_found') || message.includes('delivery_not_found')) {
    return json({ error: 'not_found', message: 'Registro não encontrado.' }, { status: 404 });
  }
  if (message.includes('delivery_revoked') || message.includes('delivery_unavailable')) {
    return json({ error: 'delivery_unavailable', message: 'Esta entrega não está disponível.' }, { status: 410 });
  }
  if (message.includes('mfa_required')) {
    return json({ error: 'mfa_required', message: 'Verificação em duas etapas obrigatória.' }, { status: 403 });
  }
  if (message.includes('not_admin') || message.includes('not_authenticated')) {
    return json({ error: 'forbidden', message: 'Acesso administrativo negado.' }, { status: 403 });
  }
  if (message.includes('duplicate_credential')) {
    return json({ error: 'duplicate_credential', message: 'Credencial duplicada.' }, { status: 409 });
  }

  console.error('[prime-store] erro não tratado:', message);
  return json({ error: 'internal_error', message: 'Não foi possível concluir a operação.' }, { status: 500 });
}

export function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) {
    throw new ApiError(503, 'not_configured', `Variável de ambiente ausente: ${key}`);
  }
  return value;
}

export function methodGuard(request: Request, methods: string[]): void {
  if (request.method === 'OPTIONS') return;
  if (!methods.includes(request.method)) {
    throw new ApiError(405, 'method_not_allowed', `Método ${request.method} não permitido.`);
  }
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError(400, 'invalid_json', 'Corpo da requisição inválido.');
  }
}

/** Resposta imediata para requisições de preflight CORS. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
