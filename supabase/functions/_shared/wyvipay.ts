/**
 * Cliente da WyviPay — API v2 (`https://api.wyvipay.com.br/api/v2`).
 *
 * Referências oficiais consultadas em 2026-11-13 (docs.wyvipay.com.br/v2):
 *   - Visão geral da API (base, autenticação, idempotência, erros, limites)
 *   - Criar cobrança      → POST   /api/v2/cobrancas
 *   - Consultar cobrança  → GET    /api/v2/cobrancas/{txid}
 *   - Cancelar cobrança   → DELETE /api/v2/cobrancas/{txid}
 *   - Pedir reembolso     → POST   /api/v2/reembolsos
 *   - Guia de webhooks    → assinatura HMAC-SHA256 sobre `{carimbo}.{corpo}`
 *   - Ambiente de teste   → chaves `wy_test_`, txid com prefixo `test`,
 *                           eventos com `dados.teste = true`
 *
 * REGRAS DESTE ARQUIVO (deliberadas):
 *   - Nenhum segredo aqui: a chave vem sempre de `WYVI_API_KEY` (config).
 *   - Todo valor em REAIS é enviado como inteiro em centavos (`valor_centavos`);
 *     número com casas decimais, texto ou zero é recusado ANTES da chamada.
 *   - A notificação de webhook NUNCA é fonte de verdade: quem confirma é
 *     `getCharge` (reconsulta) antes de qualquer transição de estado.
 *   - Nenhum dado pessoal do pagador é persistido ou logado por este arquivo.
 *
 * A API v1 (`/api/v1`) encerrou em 16/11/2026 — por isso NENHUM formato da v1
 * é reaproveitado aqui (rotas, campos, cabeçalhos e assinatura mudaram).
 */

import { toHex } from './crypto.ts';

export interface WyviPayConfig {
  /** Chave de API (`wy_test_...` ou `wy_live_...`), lida do ambiente. */
  apiKey: string;
  /** Base HTTPS do provedor (sem sufixo `/api/v2`). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface CreateChargeInput {
  /** Valor em CENTAVOS (inteiro > 0). */
  amountCents: number;
  description: string;
  /** Referência do pedido da loja (volta em consulta e webhook). */
  reference: string;
  /** Validade em segundos (60 … 2.592.000). Padrão da API: 1 hora. */
  expirationSeconds: number;
  /** Chave de idempotência POR PEDIDO (8–120 chars: `[A-Za-z0-9._:-]`). */
  idempotencyKey: string;
}

export interface ChargeSnapshot {
  id: string;
  txid: string;
  situacao: string;
  meio: string;
  valorCentavos: number;
  descricao: string | null;
  referencia: string | null;
  expiraEm: string | null;
  criadaEm: string | null;
  /** PIX copia-e-cola (BR Code). Presente enquanto a cobrança está pendente. */
  copiaECola: string | null;
  /** Imagem do QR em data URI (`data:image/png;base64,...`). Só na CRIAÇÃO. */
  qrcodeDataUri: string | null;
  /** `true` quando a resposta trazia `Idempotent-Replayed: true`. */
  replayed: boolean;
}

export class WyviPayError extends Error {
  readonly httpStatus: number;
  /** Código estável do provedor (`erro.codigo`), ex.: `campo_invalido`. */
  readonly providerCode: string;
  readonly providerMessage: string;

  constructor(httpStatus: number, providerCode: string, providerMessage: string) {
    super(`wyvipay_error:${httpStatus}:${providerCode}`);
    this.httpStatus = httpStatus;
    this.providerCode = providerCode;
    this.providerMessage = providerMessage;
  }
}

/** Janela máxima de idade do `X-Wyvi-Carimbo` (±300 s), conforme a documentação. */
export const WEBHOOK_MAX_AGE_SECONDS = 300;

/** Faixa aceita pela API para `expira_em_segundos`. */
export const MIN_CHARGE_EXPIRATION_SECONDS = 60;
export const MAX_CHARGE_EXPIRATION_SECONDS = 2_592_000;

/** Tamanho da `Idempotency-Key` aceito pela API (8 a 120 caracteres). */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/;

// ---------------------------------------------------------------------------
// Validação de entrada (falha ANTES de qualquer chamada à rede)
// ---------------------------------------------------------------------------

function assertCents(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > 100_000_000) {
    throw new WyviPayError(422, 'campo_invalido', 'valor_centavos deve ser um inteiro em centavos');
  }
}

function assertIdempotencyKey(key: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new WyviPayError(400, 'campo_invalido', 'Idempotency-Key fora do formato 8-120');
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
  idempotencyKey?: string;
}

function parseErrorBody(status: number, text: string): WyviPayError {
  let code = 'erro_desconhecido';
  let message = `HTTP ${status}`;
  try {
    const payload = JSON.parse(text) as {
      erro?: { codigo?: unknown; mensagem?: unknown };
    };
    if (typeof payload?.erro?.codigo === 'string') code = payload.erro.codigo;
    if (typeof payload?.erro?.mensagem === 'string') message = payload.erro.mensagem;
  } catch {
    // Corpo não-JSON: mantém o status como mensagem (nunca vaza corpo cru).
  }
  return new WyviPayError(status, code, message.slice(0, 300));
}

async function request(
  config: WyviPayConfig,
  options: RequestOptions,
): Promise<{ status: number; headers: Headers; body: unknown }> {
  if (!config.apiKey) throw new WyviPayError(401, 'sem_credencial', 'chave nao configurada');
  const fetchImpl = config.fetchImpl ?? fetch;
  const base = (config.baseUrl ?? 'https://api.wyvipay.com.br').replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);

  try {
    const response = await fetchImpl(`${base}/api/v2${options.path}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
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

    // 201 (criada) e 200 (repetição idempotente com `Idempotent-Replayed`)
    // são sucesso; qualquer outro status vira `WyviPayError` estável.
    if (!response.ok) {
      throw parseErrorBody(response.status, text);
    }

    return { status: response.status, headers: response.headers, body: payload };
  } catch (error) {
    if (error instanceof WyviPayError) throw error;
    // Rede/timeout: o chamador deve consultar a cobrança antes de tentar de
    // novo com a MESMA Idempotency-Key (a API pode ter criado a cobrança).
    throw new WyviPayError(503, 'indisponivel', error instanceof Error ? error.message : 'network_error');
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Mapeamento de resposta
// ---------------------------------------------------------------------------

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function readPixBlock(payload: Record<string, unknown>): { copiaECola: string | null; qrcode: string | null } {
  const pix = (payload.pix ?? {}) as Record<string, unknown>;
  return {
    copiaECola: readString(pix, 'copia_e_cola'),
    qrcode: readString(pix, 'qrcode'),
  };
}

function toSnapshot(raw: unknown, replayed: boolean): ChargeSnapshot {
  const payload = (raw ?? {}) as Record<string, unknown>;
  const pix = readPixBlock(payload);
  return {
    id: readString(payload, 'id') ?? '',
    txid: readString(payload, 'txid') ?? '',
    situacao: readString(payload, 'situacao') ?? 'pendente',
    meio: readString(payload, 'meio') ?? 'pix',
    valorCentavos: typeof payload.valor_centavos === 'number' ? payload.valor_centavos : 0,
    descricao: readString(payload, 'descricao'),
    referencia: readString(payload, 'referencia'),
    expiraEm: readString(payload, 'expira_em'),
    criadaEm: readString(payload, 'criada_em'),
    copiaECola: pix.copiaECola,
    qrcodeDataUri: pix.qrcode,
    replayed,
  };
}

// ---------------------------------------------------------------------------
// Operações
// ---------------------------------------------------------------------------

/**
 * Cria uma cobrança PIX. A `Idempotency-Key` é OBRIGATÓRIA: repetir com a
 * mesma chave devolve a mesma cobrança (`200` + `Idempotent-Replayed: true`),
 * sem criar nada de novo — é isso que impede cobrança duplicada por pedido.
 */
export async function createCharge(
  config: WyviPayConfig,
  input: CreateChargeInput,
): Promise<ChargeSnapshot> {
  assertCents(input.amountCents);
  assertIdempotencyKey(input.idempotencyKey);

  const expiration = Math.min(
    Math.max(Math.trunc(input.expirationSeconds), MIN_CHARGE_EXPIRATION_SECONDS),
    MAX_CHARGE_EXPIRATION_SECONDS,
  );

  const { status, headers, body } = await request(config, {
    method: 'POST',
    path: '/cobrancas',
    idempotencyKey: input.idempotencyKey,
    body: {
      valor_centavos: input.amountCents,
      meio: 'pix',
      descricao: input.description.slice(0, 140),
      referencia: input.reference.slice(0, 120),
      expira_em_segundos: expiration,
    },
  });

  const replayed =
    headers.get('idempotent-replayed') === 'true' || status === 200;
  return toSnapshot(body, replayed);
}

/** Consulta a fonte de verdade da cobrança pelo `txid`. */
export async function getCharge(config: WyviPayConfig, txid: string): Promise<ChargeSnapshot> {
  if (!/^[A-Za-z0-9]{26,35}$/.test(txid)) {
    throw new WyviPayError(404, 'nao_encontrada', 'txid fora do formato');
  }
  const { body } = await request(config, {
    method: 'GET',
    path: `/cobrancas/${encodeURIComponent(txid)}`,
  });
  return toSnapshot(body, false);
}

/**
 * Cancela uma cobrança ainda não paga. Idempotente do lado da API:
 * repetir responde `200` com `ja_estava_cancelada: true`.
 * `409 nao_cancelavel` quando já paga/vencida.
 */
export async function cancelCharge(
  config: WyviPayConfig,
  txid: string,
): Promise<{ txid: string; situacao: string; jaEstavaCancelada: boolean }> {
  const { body } = await request(config, {
    method: 'DELETE',
    path: `/cobrancas/${encodeURIComponent(txid)}`,
  });
  const payload = (body ?? {}) as Record<string, unknown>;
  return {
    txid: readString(payload, 'txid') ?? txid,
    situacao: readString(payload, 'situacao') ?? 'cancelada',
    jaEstavaCancelada: payload.ja_estava_cancelada === true,
  };
}

/**
 * Pede reembolso de uma cobrança paga. `valor_centavos` deve ser sempre o
 * VALOR BRUTO do pedido (regra de produto registrada em `docs/wyvipay.md`);
 * sem o campo a API devolve o líquido — diferença contábil.
 */
export async function createRefund(
  config: WyviPayConfig,
  input: { txid: string; amountCents: number; reason: string; idempotencyKey: string },
): Promise<{ id: string; situacao: string; valorCentavos: number }> {
  if (!Number.isInteger(input.amountCents) || input.amountCents < 1) {
    throw new WyviPayError(422, 'campo_invalido', 'valor_centavos invalido');
  }
  assertIdempotencyKey(input.idempotencyKey);

  const { body } = await request(config, {
    method: 'POST',
    path: '/reembolsos',
    idempotencyKey: input.idempotencyKey,
    body: {
      txid: input.txid,
      valor_centavos: input.amountCents,
      motivo: input.reason.slice(0, 300),
    },
  });
  const payload = (body ?? {}) as Record<string, unknown>;
  return {
    id: readString(payload, 'id') ?? '',
    situacao: readString(payload, 'situacao') ?? 'em_processamento',
    valorCentavos: typeof payload.valor_centavos === 'number' ? payload.valor_centavos : 0,
  };
}

// ---------------------------------------------------------------------------
// Estados: situação da WyviPay → status da máquina existente do projeto
// ---------------------------------------------------------------------------

export interface MappedStatus {
  /** Valor aceito por `apply_payment_status` (migração 0037). */
  providerStatus: string;
  statusDetail: string;
}

/**
 * Traduz a `situacao` da API v2 para o vocabulário já existente:
 *   pendente   → pending      (reflete, sem efeito)
 *   concluida  → approved     (consome reserva / aloca / cria entrega)
 *   cancelada  → cancelled    (libera reserva)
 *   falhou     → cancelled    (venceu sem pagamento — libera reserva)
 *   estornada  → refunded     (revoga entrega)
 * Nunca inventa estados novos: a máquina de estados é a do banco (0019/0037).
 */
export function mapChargeSituacao(situacao: string): MappedStatus {
  switch (situacao) {
    case 'pendente':
      return { providerStatus: 'pending', statusDetail: 'wyvi_pendente' };
    case 'concluida':
      return { providerStatus: 'approved', statusDetail: 'wyvi_concluida' };
    case 'cancelada':
      return { providerStatus: 'cancelled', statusDetail: 'wyvi_cancelada' };
    case 'falhou':
      return { providerStatus: 'cancelled', statusDetail: 'wyvi_expirada' };
    case 'estornada':
      return { providerStatus: 'refunded', statusDetail: 'wyvi_estornada' };
    default:
      return { providerStatus: 'pending', statusDetail: `wyvi_${situacao}`.slice(0, 60) };
  }
}

// ---------------------------------------------------------------------------
// Assinatura de webhook
// ---------------------------------------------------------------------------

function timingSafeEqualHex(expectedHex: string, receivedHex: string): boolean {
  if (expectedHex.length !== receivedHex.length) return false;
  let difference = 0;
  for (let index = 0; index < expectedHex.length; index += 1) {
    difference |= expectedHex.charCodeAt(index) ^ receivedHex.charCodeAt(index);
  }
  return difference === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return toHex(new Uint8Array(signature));
}

export interface WebhookVerificationInput {
  /** Bytes EXATOS recebidos (antes de qualquer JSON.parse). */
  rawBody: string;
  signatureHeader: string | null;
  carimboHeader: string | null;
  secret: string;
  now: Date;
}

/**
 * Confere a assinatura do webhook da WyviPay.
 *
 * Fórmula (docs v2): `HMAC-SHA256(whsec, "{X-Wyvi-Carimbo}.{corpo cru}")`,
 * no cabeçalho `X-Wyvi-Assinatura: v1=<hex>`, com o carimbo limitado a ±300 s.
 *
 * Por que o carimbo entra na conta: sem ele, uma entrega legítima capturada
 * poderia ser reenviada para sempre. A janela NÃO pode ser ampliada — enfraquece
 * a proteção contra replay.
 *
 * Comparação sempre em tempo constante (`timingSafeEqualHex`), nunca `===`.
 */
export async function verifyWebhookSignature(input: WebhookVerificationInput): Promise<boolean> {
  const { signatureHeader, carimboHeader, secret, rawBody, now } = input;

  if (!signatureHeader || !signatureHeader.startsWith('v1=')) return false;
  const receivedHex = signatureHeader.slice(3).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(receivedHex)) return false;
  if (!carimboHeader || !/^[0-9]{1,15}$/.test(carimboHeader)) return false;

  const carimbo = Number(carimboHeader);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(carimbo) || Math.abs(nowSeconds - carimbo) > WEBHOOK_MAX_AGE_SECONDS) {
    return false;
  }

  const expectedHex = await hmacSha256Hex(secret, `${carimboHeader}.${rawBody}`);
  return timingSafeEqualHex(expectedHex, receivedHex);
}
