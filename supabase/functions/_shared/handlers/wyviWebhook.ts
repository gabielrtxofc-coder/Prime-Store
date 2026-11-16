import { sha256Hex } from '../crypto.ts';
import { isWyviProduction } from '../config.ts';
import type { Deps } from '../deps.ts';
import { errorResponse, json, methodGuard, preflight } from '../http.ts';
import { verifyWebhookSignature } from '../wyvipay.ts';
import { isUuid } from '../validation.ts';

/**
 * POST /wyvi-webhook — recebimento de eventos da WyviPay (API v2).
 *
 * GARANTIAS (nesta ordem — nenhuma é opcional):
 *   1. Assinatura conferida sobre o CORPO CRU antes de qualquer parse ou
 *      escrita: `HMAC-SHA256(whsec, "{X-Wyvi-Carimbo}.{corpo}")`, janela ±300 s.
 *      Assinatura ausente/errada/velha → 401 e ZERO linhas em `payment_events`.
 *   2. Deduplicação por `X-Wyvi-Entrega` (id da entrega): a mesma entrega
 *      processada duas vezes não repete efeitos (índice único por provedor).
 *   3. A notificação NUNCA é fonte de verdade: este handler apenas REGISTRA
 *      a entrega em `payment_events` (fila persistente) e responde 2xx em
 *      poucos milissegundos. Quem RECONSULTA `GET /cobrancas/{txid}` e aplica
 *      é o processador fora da requisição (`wyvi-worker` / `order-status`).
 *   4. Evento de teste (`dados.teste = true`) em ambiente de produção é
 *      recusado — simulação jamais confirma pedido real.
 *   5. Só `apply_payment_status` (banco) altera pedido/estoque/entrega, e
 *      apenas depois da reconsulta — o corpo do evento nunca vira fato.
 *
 * Por que responder antes de processar: a WyviPay espera 2xx em até 10 s e
 * reentrega em 1ª/30s/2min/10min/1h (5 tentativas). A dedup por
 * `X-Wyvi-Entrega` (índice único) faz qualquer reentrega virar 200 sem
 * efeito repetido; o trabalho pesado roda na fila com backoff próprio.
 */

interface WebhookEnvelope {
  id?: unknown;
  evento?: unknown;
  criado_em?: unknown;
  dados?: Record<string, unknown>;
}

interface RecordedEvent {
  event_id: string;
  duplicate: boolean;
  status: string;
}

/** Eventos que podem alterar o estado de uma cobrança. */
const CHARGE_EVENTS = new Set([
  'cobranca.paga',
  'cobranca.expirada',
  'cobranca.cancelada',
  'cobranca.estornada',
]);

export async function handleWyviWebhook(request: Request, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();

  try {
    methodGuard(request, ['POST']);

    // Corpo CRU primeiro: a assinatura cobre os bytes recebidos, não um
    // objeto re-serializado (a ordem das chaves mudaria a conta).
    const rawBody = await request.text();

    const secret = deps.config.wyviWebhookSecret;
    if (!secret) {
      // Fail-closed: sem `whsec_` não existe prova de origem. O provedor
      // reenvia as entregas pendentes depois que o segredo for configurado.
      deps.log('wyvi_webhook.not_configured', {});
      return json({ error: 'webhook_not_configured' }, { status: 503 });
    }

    const signatureHeader = request.headers.get('x-wyvi-assinatura');
    const carimboHeader = request.headers.get('x-wyvi-carimbo');
    const entregaHeader = request.headers.get('x-wyvi-entrega');
    const eventoHeader = request.headers.get('x-wyvi-evento');

    const signatureValid = await verifyWebhookSignature({
      rawBody,
      signatureHeader,
      carimboHeader,
      secret,
      now: deps.now(),
    });

    if (!signatureValid) {
      // Nada é gravado nem consultado: notificação não autenticada não deixa
      // rastro no banco nem pode alterar estado de pedido algum.
      deps.log('wyvi_webhook.invalid_signature', {
        has_signature: Boolean(signatureHeader),
        has_carimbo: Boolean(carimboHeader),
      });
      return json({ error: 'invalid_signature' }, { status: 401 });
    }

    let body: WebhookEnvelope = {};
    try {
      body = rawBody ? (JSON.parse(rawBody) as WebhookEnvelope) : {};
    } catch {
      body = {};
    }

    const deliveryId =
      (entregaHeader && entregaHeader.trim()) ||
      (typeof body.id === 'string' && body.id.trim()) ||
      null;
    if (!deliveryId) {
      // Sem id de entrega não há como deduplicar: recusa explícita.
      return json({ error: 'missing_delivery_id' }, { status: 400 });
    }

    const evento =
      (eventoHeader && eventoHeader.trim()) ||
      (typeof body.evento === 'string' && body.evento) ||
      'desconhecido';
    const dados = (body.dados ?? {}) as Record<string, unknown>;
    const txid = typeof dados.txid === 'string' ? dados.txid : null;
    const payloadHash = await sha256Hex(rawBody || deliveryId);

    // Subconjunto APROVADO do corpo (nunca pagador/PII): o processador da
    // fila usa `txid`/`referencia` para casar sem regravar o payload cru.
    const referenceRaw = typeof dados.referencia === 'string' ? dados.referencia.trim() : '';
    const providerData: Record<string, unknown> = {};
    if (txid) providerData.txid = txid;
    if (referenceRaw) providerData.referencia = referenceRaw.slice(0, 120);
    if (typeof dados.teste === 'boolean') providerData.teste = dados.teste;
    if (typeof dados.ambiente === 'string') providerData.ambiente = dados.ambiente.slice(0, 32);
    if (typeof dados.valor_centavos === 'number') providerData.valor_centavos = dados.valor_centavos;

    const recorded = await deps.rpc<RecordedEvent>('record_payment_event', {
      p_notification_id: deliveryId,
      p_event_type: evento,
      p_action: null,
      p_data_id: txid,
      p_signature_valid: true,
      p_payload_hash: payloadHash,
      p_provider: 'wyvipay',
      p_provider_data: providerData,
      p_reference: isUuid(referenceRaw) ? referenceRaw : null,
    });

    if (recorded.duplicate) {
      // Mesma entrega (retentativa do provedor): terminal → 200 sem novo
      // efeito; ainda na fila → já registrada, não duplica o enfileiramento.
      return json({ received: true, duplicate: true, status: recorded.status });
    }

    // Eventos fora da família de cobrança (ex.: `webhook.teste`,
    // `chave.rotacionada`) ou sem txid: respondemos 200 para não gerar
    // retentativa, sem efeito nenhum no pedido.
    if (!CHARGE_EVENTS.has(evento) || !txid) {
      await deps.rpc('finish_payment_event', {
        p_event_id: recorded.event_id,
        p_status: 'ignored',
        p_error: 'evento_sem_efeito',
      });
      return json({ received: true, ignored: true });
    }

    // ------------------------------------------------------------------
    // Ambiente de teste nunca confirma pedido real (controle R4).
    // ------------------------------------------------------------------
    const isTestEvent = dados.teste === true || dados.ambiente === 'homologacao';
    if (isTestEvent && isWyviProduction(deps.config)) {
      deps.log('wyvi_webhook.test_event_in_production', { delivery_id: deliveryId });
      await deps.rpc('finish_payment_event', {
        p_event_id: recorded.event_id,
        p_status: 'ignored',
        p_error: 'evento_de_teste_em_producao',
      });
      return json({ received: true, ignored: true, reason: 'test_event_in_production' });
    }

    if (!deps.config.wyviApiKey) {
      // Sem chave não há como reconsultar — mas o evento NÃO é marcado
      // `failed` (não há evidência contra ele): fica na fila (`received`) e
      // 503 faz o provedor reentregar; quando a chave existir, processa.
      deps.log('wyvi_webhook.pending_not_configured', { delivery_id: deliveryId });
      return json({ error: 'payment_not_configured' }, { status: 503 });
    }

    // Registrado e na fila: o processamento (reconsulta + aplicação) roda
    // FORA desta requisição — `wyvi-worker` ou o poll de `order-status`.
    return json({ received: true, queued: true, delivery_id: deliveryId });
  } catch (error) {
    return errorResponse(error);
  }
}
