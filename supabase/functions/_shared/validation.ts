import { ApiError } from './http.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new ApiError(422, 'invalid_payload', `Campo inválido: ${field}`);
  }
  return value;
}

export function requireString(value: unknown, field: string, options: { min?: number; max?: number } = {}): string {
  if (typeof value !== 'string') {
    throw new ApiError(422, 'invalid_payload', `Campo inválido: ${field}`);
  }
  const trimmed = value.trim();
  if (trimmed.length < (options.min ?? 1) || trimmed.length > (options.max ?? 500)) {
    throw new ApiError(422, 'invalid_payload', `Campo inválido: ${field}`);
  }
  return trimmed;
}

export function optionalString(value: unknown, field: string, options: { max?: number } = {}): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, field, { max: options.max });
}

export function requireEmail(value: unknown, field = 'email'): string {
  if (typeof value !== 'string' || !EMAIL_PATTERN.test(value.trim()) || value.length > 254) {
    throw new ApiError(422, 'invalid_payload', `Campo inválido: ${field}`);
  }
  return value.trim();
}

export function requireQuantity(value: unknown, max = 20): number {
  const quantity = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) {
    throw new ApiError(422, 'invalid_payload', 'Quantidade inválida.');
  }
  return quantity;
}

/**
 * Chave de idempotência enviada pelo cliente.
 *
 * A chave sozinha não identifica nada: no banco ela é sempre comparada junto do
 * hash do token privado do checkout, do produto e da quantidade. Assim, uma
 * chave vazada/reenviada por terceiros não abre nem sequestra o pedido.
 */
export function optionalIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new ApiError(422, 'invalid_payload', 'Chave de idempotência inválida.');
  }
  return value;
}

/**
 * Token privado do checkout enviado pelo cliente.
 *
 * Permite que a mesma tentativa de compra seja repetida (reload, retry de
 * rede) sem gerar um segundo pedido: o servidor reaproveita o token e a chave
 * de idempotência identifica a requisição. Sem ele, cada requisição é uma nova
 * sessão de compra.
 */
export function optionalClientToken(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new ApiError(422, 'invalid_payload', 'Token de checkout inválido.');
  }
  return value;
}

/** Token privado (consulta de pedido ou entrega). */
export function requirePrivateToken(value: unknown, field = 'token'): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 128) {
    throw new ApiError(404, 'not_found', 'Registro não encontrado.');
  }
  return value;
}

/** Aceita apenas campos conhecidos: evita mass assignment. */
export function pickKnownFields(
  payload: Record<string, unknown>,
  allowed: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (payload[key] !== undefined) result[key] = payload[key];
  }
  return result;
}
