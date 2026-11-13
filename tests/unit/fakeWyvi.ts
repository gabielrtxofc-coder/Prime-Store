/**
 * Servidor WyviPay (API v2) simulado no nível de `fetch`.
 *
 * Exercita o cliente HTTP REAL (`_shared/wyvipay.ts`): URL base, rotas
 * `/api/v2/...`, cabeçalhos `Authorization`/`Idempotency-Key`, validação
 * estrita de valores e o formato das respostas — sem depender da rede (que é
 * bloqueada neste ambiente) e sem nenhuma chave real.
 *
 * Inclui também o helper de ASSINATURA de webhook no formato exato da API v2:
 *   `X-Wyvi-Assinatura: v1=<hex>` sobre `HMAC-SHA256(whsec, "{carimbo}.{corpo}")`
 * com `X-Wyvi-Carimbo`, `X-Wyvi-Entrega` e `X-Wyvi-Evento`.
 * Nenhum segredo real é usado: o teste escolhe o `whsec_` de mentira.
 */

import { createHmac } from 'node:crypto';

export interface FakeCharge {
  id: string;
  txid: string;
  situacao: string;
  meio: string;
  plano: string;
  valor_centavos: number;
  tarifa: { total_centavos: number; fixo_centavos: number; percentual_bps: number; minimo_centavos: number };
  liquido_centavos: number;
  pix: { copia_e_cola: string; qrcode: string | null };
  expira_em: string;
  descricao: string;
  referencia: string;
  criada_em: string;
}

export interface FakeWyviOptions {
  /** POST /cobrancas responde 503 `indisponivel` (falha de comunicação). */
  failCreate?: boolean;
  /**
   * Imagem do QR devolvida na CRIAÇÃO. `null` reproduz o ambiente de teste
   * real da WyviPay (lá o `qrcode` vem `null` e o front desenha do copia-e-cola).
   * Padrão: data URI fictício.
   */
  qrcodeOnCreate?: string | null;
  /** Valor fixo do `txid` gerado (quando precisar de um txid conhecido). */
  fixedTxid?: string;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const ALLOWED_CREATE_FIELDS = new Set([
  'valor_centavos',
  'meio',
  'descricao',
  'referencia',
  'expira_em_segundos',
  'pagador',
  'notificacao',
  'subconta',
  'conta_liquidacao',
  'divisao',
  'cartao',
]);

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function errorBody(codigo: string, mensagem: string, campo?: string): unknown {
  return {
    erro: { codigo, mensagem, ...(campo ? { campo } : {}) },
    request_id: `req-${codigo}`,
  };
}

export function createFakeWyvi(options: FakeWyviOptions = {}) {
  const charges = new Map<string, FakeCharge>();
  const idempotencyIndex = new Map<string, string>(); // Idempotency-Key → txid
  const calls: RecordedCall[] = [];
  // Mutável em tempo de teste: simular uma janela de instabilidade do provedor
  // sem recriar o servidor fake.
  const state = { failCreate: options.failCreate ?? false };
  let sequence = 0;

  function chargeView(charge: FakeCharge, forCreation: boolean): FakeCharge {
    if (forCreation) return charge;
    // A CONSULTA nunca devolve a imagem do QR (documentação v2): só o
    // copia-e-cola. Quem mostra o QR de novo usa o valor persistido.
    return { ...charge, pix: { copia_e_cola: charge.pix.copia_e_cola, qrcode: null } };
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) headers[key.toLowerCase()] = String(value);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, method, headers, body });

    const base = 'https://api.wyvipay.test/api/v2';

    // ---------------------------------------------------------------------
    // POST /cobrancas — criação com validação estrita e idempotência
    // ---------------------------------------------------------------------
    if (method === 'POST' && url === `${base}/cobrancas`) {
      const idempotencyKey = headers['idempotency-key'];
      if (!idempotencyKey) {
        return jsonResponse(errorBody('idempotencia_obrigatoria', 'Idempotency-Key é obrigatória'), 400);
      }
      if (!/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) {
        return jsonResponse(errorBody('campo_invalido', 'Idempotency-Key fora do formato', 'Idempotency-Key'), 400);
      }
      if (state.failCreate) {
        return jsonResponse(errorBody('indisponivel', 'Recebimento temporariamente indisponível'), 503);
      }
      if (!body) return jsonResponse(errorBody('corpo_invalido', 'Corpo inválido'), 400);

      // Campo desconhecido é recusado (validação estrita da v2).
      for (const key of Object.keys(body)) {
        if (!ALLOWED_CREATE_FIELDS.has(key)) {
          return jsonResponse(errorBody('campo_desconhecido', `Campo desconhecido: ${key}`, key), 422);
        }
      }
      // Valor: inteiro em centavos, > 0 (sem conversão silenciosa).
      const valor = body.valor_centavos;
      if (typeof valor !== 'number' || !Number.isInteger(valor) || valor <= 0) {
        return jsonResponse(errorBody('campo_invalido', 'valor_centavos deve ser inteiro', 'valor_centavos'), 422);
      }
      if (typeof body.referencia !== 'string' || body.referencia.length === 0) {
        return jsonResponse(errorBody('campo_obrigatorio', 'referencia obrigatória', 'referencia'), 422);
      }

      // Repetição com a MESMA chave e MESMOS dados → 200 + Idempotent-Replayed.
      const existingTxid = idempotencyIndex.get(idempotencyKey);
      if (existingTxid) {
        const existing = charges.get(existingTxid);
        if (!existing) return jsonResponse(errorBody('nao_encontrada', 'cobrança não encontrada'), 404);
        const conflict =
          existing.valor_centavos !== valor ||
          existing.referencia !== body.referencia ||
          existing.descricao !== String(body.descricao ?? '');
        if (conflict) {
          return jsonResponse(
            {
              ...errorBody('idempotencia_conflitante', 'Chave já usada com outros dados'),
              detalhes: { txid: existing.txid, campos: ['valor_centavos'] },
            },
            409,
          );
        }
        return jsonResponse(chargeView(existing, false), 200, { 'Idempotent-Replayed': 'true' });
      }

      sequence += 1;
      const txid =
        options.fixedTxid ??
        `test${Array.from({ length: 26 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')}`;
      const expirationSeconds =
        typeof body.expira_em_segundos === 'number' ? body.expira_em_segundos : 3600;
      const now = Date.now();
      const charge: FakeCharge = {
        id: `6f0c1d9a-7b2e-4f51-9a3c-${String(1_000_000 + sequence).padStart(12, '0')}`,
        txid,
        situacao: 'pendente',
        meio: 'pix',
        plano: 'W1',
        valor_centavos: valor,
        tarifa: { total_centavos: 45, fixo_centavos: 45, percentual_bps: 0, minimo_centavos: 0 },
        liquido_centavos: valor - 45,
        pix: {
          copia_e_cola: `00020126FAKEWYVI${txid}5204581253039865802BR6304ABCD`,
          qrcode:
            options.qrcodeOnCreate === null
              ? null
              : (options.qrcodeOnCreate ?? `data:image/png;base64,QR-${txid}`),
        },
        expira_em: new Date(now + expirationSeconds * 1000).toISOString(),
        descricao: String(body.descricao ?? ''),
        referencia: body.referencia,
        criada_em: new Date(now).toISOString(),
      };
      charges.set(txid, charge);
      idempotencyIndex.set(idempotencyKey, txid);
      return jsonResponse(chargeView(charge, true), 201);
    }

    // ---------------------------------------------------------------------
    // GET /cobrancas/{txid} — fonte de verdade
    // ---------------------------------------------------------------------
    if (method === 'GET' && url.startsWith(`${base}/cobrancas/`)) {
      const txid = decodeURIComponent(url.slice(`${base}/cobrancas/`.length));
      const charge = charges.get(txid);
      if (!charge) return jsonResponse(errorBody('nao_encontrada', 'cobrança não encontrada'), 404);
      return jsonResponse(chargeView(charge, false), 200);
    }

    // ---------------------------------------------------------------------
    // DELETE /cobrancas/{txid} — cancelamento idempotente
    // ---------------------------------------------------------------------
    if (method === 'DELETE' && url.startsWith(`${base}/cobrancas/`)) {
      const txid = decodeURIComponent(url.slice(`${base}/cobrancas/`.length));
      const charge = charges.get(txid);
      if (!charge) return jsonResponse(errorBody('nao_encontrada', 'cobrança não encontrada'), 404);
      if (charge.situacao === 'concluida') {
        return jsonResponse(
          { ...errorBody('nao_cancelavel', 'cobrança já paga'), detalhes: { situacao: charge.situacao } },
          409,
        );
      }
      if (charge.situacao === 'cancelada') {
        return jsonResponse({ txid, situacao: 'cancelada', ja_estava_cancelada: true }, 200);
      }
      charge.situacao = 'cancelada';
      return jsonResponse({ txid, situacao: 'cancelada', ja_estava_cancelada: false }, 200);
    }

    // ---------------------------------------------------------------------
    // POST /reembolsos
    // ---------------------------------------------------------------------
    if (method === 'POST' && url === `${base}/reembolsos`) {
      const idempotencyKey = headers['idempotency-key'];
      if (!idempotencyKey) {
        return jsonResponse(errorBody('idempotencia_obrigatoria', 'Idempotency-Key é obrigatória'), 400);
      }
      const txid = String(body?.txid ?? '');
      const charge = charges.get(txid);
      if (!charge) return jsonResponse(errorBody('cobranca_nao_encontrada', 'cobrança inexistente'), 404);
      if (charge.situacao !== 'concluida') {
        return jsonResponse(errorBody('cobranca_nao_paga', 'Só dá devolver o que foi pago'), 422);
      }
      return jsonResponse(
        {
          id: `reemb-${sequence}`,
          txid,
          valor_centavos: typeof body?.valor_centavos === 'number' ? body.valor_centavos : charge.valor_centavos,
          situacao: 'em_processamento',
          natureza: 'original',
          motivo: String(body?.motivo ?? ''),
        },
        201,
      );
    }

    return jsonResponse(errorBody('nao_encontrada', `rota desconhecida: ${method} ${url}`), 404);
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    charges,
    /** Muda a situação de uma cobrança (simula pagamento/expiração no provedor). */
    setSituacao(txid: string, situacao: string): void {
      const charge = charges.get(txid);
      if (!charge) throw new Error(`cobrança inexistente: ${txid}`);
      charge.situacao = situacao;
    },
    getCharge(txid: string): FakeCharge | undefined {
      return charges.get(txid);
    },
    /** Liga/desliga a falha de comunicação no POST /cobrancas. */
    setFailCreate(value: boolean): void {
      state.failCreate = value;
    },
    /** Chamadas de consulta (GET /cobrancas/{txid}). */
    getReadCalls(): RecordedCall[] {
      return calls.filter((call) => call.method === 'GET' && call.url.includes('/api/v2/cobrancas/'));
    },
    /** Quantas cobranças existem de fato (proteção contra duplicação). */
    get chargeCount(): number {
      return charges.size;
    },
    /** Chamadas de criação (POST /cobrancas). */
    get createCalls(): RecordedCall[] {
      return calls.filter((call) => call.method === 'POST' && call.url.endsWith('/api/v2/cobrancas'));
    },
    reset(): void {
      charges.clear();
      idempotencyIndex.clear();
      calls.length = 0;
      sequence = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Assinatura de webhook (formato exato da API v2)
// ---------------------------------------------------------------------------

export interface SignedWyviEvent {
  headers: Record<string, string>;
  body: string;
}

/**
 * Monta uma entrega assinada como a WyviPay manda:
 *   X-Wyvi-Assinatura: v1=<hmac(carimbo + "." + corpo)>
 *   X-Wyvi-Carimbo, X-Wyvi-Entrega, X-Wyvi-Evento + corpo `{id, evento, ...}`.
 * Nenhum segredo real: o teste escolhe o `whsec_`.
 */
export function signWyviEvent(params: {
  secret: string;
  evento: string;
  deliveryId: string;
  dados: Record<string, unknown>;
  /** Segundos desde a época; padrão: agora. */
  ts?: number;
  /** Corpo opcional já serializado (para testes de corpo adulterado). */
  rawBody?: string;
}): SignedWyviEvent {
  const ts = String(params.ts ?? Math.floor(Date.now() / 1000));
  const body =
    params.rawBody ??
    JSON.stringify({
      id: params.deliveryId,
      evento: params.evento,
      criado_em: new Date().toISOString(),
      dados: params.dados,
    });
  const hmac = createHmac('sha256', params.secret).update(`${ts}.${body}`).digest('hex');

  return {
    headers: {
      'Content-Type': 'application/json',
      'X-Wyvi-Assinatura': `v1=${hmac}`,
      'X-Wyvi-Carimbo': ts,
      'X-Wyvi-Entrega': params.deliveryId,
      'X-Wyvi-Evento': params.evento,
    },
    body,
  };
}

/** Requisição assinada pronta para `handleWyviWebhook`. */
export function signedWyviRequest(signed: SignedWyviEvent, url = 'https://fn.test/wyvi-webhook'): Request {
  return new Request(url, { method: 'POST', headers: signed.headers, body: signed.body });
}
