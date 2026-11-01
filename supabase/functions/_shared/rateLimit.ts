/**
 * Limite de requisições por origem e por rota (missão 07, etapa 03).
 *
 * Por que no banco: as Edge Functions rodam em várias instâncias e o isolate
 * pode ser recriado a qualquer momento. Um contador em memória seria reiniciado
 * a cada *cold start* e não somaria requisições atendidas por outras instâncias.
 * `public.consume_rate_limit` incrementa a janela em uma única instrução
 * atômica (`insert ... on conflict do update`), então a contagem é exata mesmo
 * com execuções simultâneas.
 *
 * Privacidade: o sujeito do limite é `HMAC(segredo, ip)` truncado. O IP em si
 * nunca é gravado nem devolvido; rotacionar o IP muda o sujeito, mas o banco não
 * permite reidentificar ninguém sem o segredo do servidor.
 *
 * Limites por rota (não são iguais de propósito):
 *   catalog        consulta de vitrine, o cliente legítimo abre várias vezes
 *   create-order   cada requisição reserva estoque e (quando configurado) cria
 *                  cobrança — o limite é o mais apertado da loja
 *   order-request  registra a solicitação sem pagamento (grava pedido + itens)
 *   order-status   polling da tela de pagamento
 *   delivery       tentativa de leitura por token: limitar reduz força bruta
 *   demo-payment   simulação de aprovação e semeadura de estoque fictício
 *   admin-api      já exige JWT + allowlist + AAL2; o limite é só anti-flood
 *
 * O webhook do provedor NÃO usa este módulo: bloquear por IP poderia descartar
 * uma aprovação legítima reenviada pelo Mercado Pago. A proteção dele é a
 * assinatura HMAC + deduplicação (ver `handlers/mpWebhook.ts`).
 *
 * Falha do banco: a rota libera a requisição (`fail-open`) e registra
 * `rate_limit.unavailable`. Limitar é uma defesa em profundidade; derrubar a
 * vitrine porque o contador não respondeu seria pior para o cliente.
 */

import { json, preflight } from './http.ts';
import type { Deps } from './deps.ts';

export interface RouteLimit {
  /** Requisições permitidas por janela. */
  limit: number;
  /** Janela em segundos (alinhada ao relógio). */
  windowSeconds: number;
}

export const ROUTE_LIMITS: Record<string, RouteLimit> = {
  catalog: { limit: 120, windowSeconds: 60 },
  'create-order': { limit: 10, windowSeconds: 60 },
  // Solicitação sem pagamento: mesmo peso de uma finalização de compra.
  'order-request': { limit: 10, windowSeconds: 60 },
  'order-status': { limit: 60, windowSeconds: 60 },
  delivery: { limit: 30, windowSeconds: 60 },
  'demo-payment': { limit: 30, windowSeconds: 60 },
  'admin-api': { limit: 120, windowSeconds: 60 },
};

export interface RateLimitDecision {
  allowed: boolean;
  hits: number;
  limit: number;
  remaining: number;
  window_seconds: number;
  retry_after_seconds: number;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidIpv4(value: string): boolean {
  const match = IPV4.exec(value);
  if (!match) return false;
  return match.slice(1).every((part) => Number(part) <= 255);
}

/**
 * Normaliza o endereço para uma chave estável.
 *
 * IPv4: usa o endereço completo.
 * IPv6: usa o prefixo /64 — o menor bloco que um provedor entrega a um cliente
 *       residencial; usar o endereço inteiro permitiria rotação trivial dentro
 *       do mesmo bloco.
 */
/**
 * Expande um endereço IPv6 (com `::` opcional, sem zona) para 8 grupos.
 * Devolve `null` quando o formato não é reconhecível.
 */
function expandIpv6(value: string): string[] | null {
  const [head, tail] = value.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail !== undefined && tail ? tail.split(':').filter(Boolean) : [];

  if (headGroups.length + tailGroups.length > 8) return null;
  if (value.includes('::')) {
    const fill = 8 - headGroups.length - tailGroups.length;
    if (fill < 1) return null;
    return [...headGroups, ...Array.from({ length: fill }, () => '0'), ...tailGroups];
  }
  return headGroups.length === 8 ? headGroups : null;
}

export function normalizeAddress(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  // `[2001:db8::1]:443` ou `2001:db8::1`
  const withoutBrackets = trimmed.startsWith('[')
    ? trimmed.slice(1, trimmed.indexOf(']') > 0 ? trimmed.indexOf(']') : undefined)
    : trimmed;

  // IPv4 com porta (`203.0.113.7:51234`)
  const ipv4WithPort = /^([0-9.]+):\d+$/.exec(withoutBrackets);
  const candidate = ipv4WithPort ? ipv4WithPort[1] : withoutBrackets;

  if (isValidIpv4(candidate)) return candidate;

  // Mapeamento IPv4-em-IPv6 (`::ffff:198.51.100.7`): usa o IPv4 equivalente,
  // senão o mesmo cliente teria dois baldes dependendo da pilha de rede.
  const mapped = /^::ffff:([0-9.]+)$/.exec(candidate);
  if (mapped && isValidIpv4(mapped[1])) return mapped[1];

  if (/^[0-9a-f:]+$/.test(candidate) && candidate.includes(':')) {
    const expanded = expandIpv6(candidate);
    if (!expanded) return null;
    // Prefixo /64: os quatro primeiros grupos (bytes 0–7).
    return `v6:${expanded.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(':')}`;
  }

  return null;
}

/**
 * Endereço de origem segundo o gateway.
 *
 * O `x-forwarded-for` é escrito pelo proxy da plataforma, que **acrescenta** o
 * endereço real ao final da lista. Por isso a última entrada válida é a única
 * confiável: valores anteriores podem ter sido enviados pelo próprio cliente.
 * Sem cabeçalho de proxy, cai para `'unknown'` (um único balde compartilhado).
 */
export function clientAddress(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const address = normalizeAddress(parts[index]);
      if (address) return address;
    }
  }

  for (const header of ['cf-connecting-ip', 'x-real-ip', 'fly-client-ip', 'true-client-ip']) {
    const value = request.headers.get(header);
    if (!value) continue;
    const address = normalizeAddress(value);
    if (address) return address;
  }

  return null;
}

const encoder = new TextEncoder();

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Sujeito pseudonimizado do limite (nunca o IP puro). */
export async function rateLimitSubject(deps: Deps, address: string | null): Promise<string> {
  const secret = deps.config.rateLimitSecret || deps.config.serviceRoleKey;
  if (!secret) {
    // Sem segredo no servidor não há como pseudonimizar; o sujeito vira uma
    // constante, o que mantém a proteção (um balde global) em vez de desligá-la.
    return (await hmacHex('prime-store-rate-limit', address ?? 'unknown')).slice(0, 32);
  }
  return (await hmacHex(secret, address ?? 'unknown')).slice(0, 32);
}

export function limitForRoute(route: string, deps: Deps): RouteLimit | null {
  const defaults = ROUTE_LIMITS[route];
  if (!defaults) return null;
  const override = deps.config.rateLimitOverrides?.[route];
  return Number.isInteger(override) && override && override > 0
    ? { ...defaults, limit: override }
    : defaults;
}

/**
 * Consome uma unidade do orçamento da rota.
 * Devolve `null` quando a requisição pode seguir; caso contrário, a resposta 429.
 */
export async function enforceRateLimit(
  request: Request,
  deps: Deps,
  route: string,
): Promise<Response | null> {
  if (request.method === 'OPTIONS') return preflight();

  const routeLimit = limitForRoute(route, deps);
  if (!routeLimit) return null;

  const subject = await rateLimitSubject(deps, clientAddress(request));

  let decision: RateLimitDecision;
  try {
    decision = await deps.rpc<RateLimitDecision>('consume_rate_limit', {
      p_route: route,
      p_subject: subject,
      p_limit: routeLimit.limit,
      p_window_seconds: routeLimit.windowSeconds,
    });
  } catch (error) {
    // Fail-open deliberado: ver comentário no topo do arquivo.
    deps.log('rate_limit.unavailable', {
      route,
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return null;
  }

  if (decision?.allowed !== false) return null;

  const retryAfter = Math.max(1, Math.min(Number(decision.retry_after_seconds) || routeLimit.windowSeconds, 3600));
  deps.log('rate_limit.blocked', { route, retry_after_seconds: retryAfter });

  return json(
    {
      error: 'rate_limited',
      message: 'Muitas requisições em pouco tempo. Tente novamente em instantes.',
      retry_after_seconds: retryAfter,
    },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  );
}
