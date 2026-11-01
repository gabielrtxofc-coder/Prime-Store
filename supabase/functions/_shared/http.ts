/** Utilitários HTTP compartilhados pelas Edge Functions (sem dependências). */

export interface JsonResponseInit {
  status?: number;
  headers?: Record<string, string>;
}

/**
 * Cabeçalhos comuns de resposta.
 *
 * O `Access-Control-Allow-Origin` NÃO fica aqui: ele depende da origem da
 * requisição e é aplicado por `_shared/cors.ts` (`withCors`) no `index.ts` de
 * cada função. Antes era `*`, o que permitia qualquer site chamar a loja.
 */
export const CORS_HEADERS: Record<string, string> = {
  Vary: 'Origin',
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

  if (message.includes('idempotency_conflict')) {
    // Resposta deliberadamente genérica: não confirma se a chave existe, nem
    // revela produto, quantidade ou qualquer dado do pedido original.
    return json(
      {
        error: 'idempotency_conflict',
        message: 'Esta tentativa já foi usada com outros dados. Inicie um novo checkout.',
      },
      { status: 409 },
    );
  }
  if (message.includes('invalid_idempotency_key') || message.includes('invalid_client_token')) {
    return json({ error: 'invalid_payload', message: 'Requisição inválida.' }, { status: 422 });
  }
  if (message.includes('insufficient_stock')) {
    const detail = (error as { detail?: string }).detail;
    return json(
      { error: 'insufficient_stock', message: 'Estoque insuficiente para essa quantidade.', available_units: Number(detail ?? 0) },
      { status: 409 },
    );
  }
  if (message.includes('quantity_above_product_limit')) {
    const detail = (error as { detail?: string }).detail;
    return json(
      {
        error: 'quantity_above_product_limit',
        message: 'Quantidade acima do limite do produto.',
        max_quantity: Number.isFinite(Number(detail)) && Number(detail) > 0 ? Number(detail) : undefined,
      },
      { status: 422 },
    );
  }
  // --- Solicitação sem pagamento (missão 08) -------------------------------
  if (
    message.includes('invalid_items') ||
    message.includes('duplicate_item') ||
    message.includes('invalid_quantity') ||
    message.includes('invalid_buyer_name') ||
    message.includes('invalid_buyer_email')
  ) {
    // Nunca ecoa o valor recebido: só o campo/código estável.
    return json(
      { error: 'invalid_payload', message: 'Não foi possível usar os dados informados. Revise e tente novamente.' },
      { status: 422 },
    );
  }
  if (message.includes('order_total_mismatch')) {
    console.error('[prime-store] total divergente na solicitacao');
    return json(
      { error: 'internal_error', message: 'Não foi possível registrar a solicitação. Tente novamente.' },
      { status: 500 },
    );
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
  if (message.includes('demo_disabled')) {
    return json(
      { error: 'demo_unavailable', message: 'Modo de demonstração desativado neste ambiente.' },
      { status: 404 },
    );
  }
  if (message.includes('demo_order_not_payable')) {
    return json(
      { error: 'demo_order_not_payable', message: 'Este pedido não está mais aguardando pagamento.' },
      { status: 409 },
    );
  }
  if (message.includes('demo_reservation_expired')) {
    return json(
      { error: 'demo_reservation_expired', message: 'A reserva deste pedido expirou. As unidades voltaram ao estoque.' },
      { status: 410 },
    );
  }
  if (message.includes('demo_real_stock_blocked') || message.includes('demo_not_allowed')) {
    return json(
      { error: 'demo_not_allowed', message: 'Este pedido não pode ser aprovado em modo de demonstração.' },
      { status: 403 },
    );
  }
  if (message.includes('demo_reservation_missing') || message.includes('demo_seed_limit')) {
    return json(
      { error: 'demo_unavailable', message: 'Não foi possível concluir a simulação. Tente novamente.' },
      { status: 409 },
    );
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
