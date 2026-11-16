import { loadConfig } from '../_shared/config.ts';
import { createDeps } from '../_shared/deps.ts';
import { json } from '../_shared/http.ts';
import { processWyviEvent, settleEvent, type ClaimedWyviEvent } from '../_shared/wyviEvents.ts';

/**
 * Edge Function `wyvi-worker` — processador FORA DA REQUISIÇÃO da fila
 * `payment_events` (provedor `wyvipay`).
 *
 * O webhook (`wyvi-webhook`) só valida assinatura, deduplica por
 * `X-Wyvi-Entrega`, grava na fila e responde 2xx em poucos ms — a
 * WyviPay exige resposta em até 10 s. Este worker reivindica os eventos
 * VENCIDos (claim SKIP LOCKED: duas instâncias nunca processam o mesmo),
 * RECONSULTA a cobrança na API (fonte da verdade), aplica via
 * `apply_payment_status` e grava o desfecho — com backoff reenfileirando
 * o que falhar (15s, 30s, 1m … ~8h; 10ª tentativa → `failed` visível).
 *
 * `verify_jwt` padrão TRUE: só o service role (chave do servidor) chama.
 * Sem chave WyviPay configurada responde 503 `payment_not_configured`
 * (a fila permanece intacta; nada se perde).
 *
 * Gatilho natural: o provedor aciona após o webhook (ou o operador/CI
 * agenda). O poll do `order-status` também processa os eventos do pedido
 * consultado — recuperação mesmo sem worker vivo.
 */
/** Só o service role (chave do servidor) pode acionar o processador. */
function isServiceRole(request: Request): boolean {
  const header = request.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  const part = token.split('.')[1];
  if (!part) return false;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return json?.role === 'service_role';
  } catch {
    return false;
  }
}

Deno.serve(async (request: Request) => {
  // verify_jwt (plataforma) já exige JWT; aqui exigimos o PAPEL service_role —
  // um JWT de anon não pode disparar processamento.
  if (!isServiceRole(request)) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const config = loadConfig();
    if (!config.wyviApiKey) {
      return json({ error: 'payment_not_configured' }, { status: 503 });
    }

    const deps = createDeps();
    const wyviConfig = {
      apiKey: config.wyviApiKey,
      baseUrl: config.wyviApiBase,
      fetchImpl: fetch,
    };

    const events = await deps.rpc<ClaimedWyviEvent[]>('claim_wyvi_events', {
      p_order_id: null,
      p_limit: 10,
    });

    const summary = { claimed: 0, processed: 0, ignored: 0, retried: 0, failed: 0 };
    if (Array.isArray(events) && events.length > 0) {
      summary.claimed = events.length;
      for (const event of events) {
        const outcome = await processWyviEvent(deps, wyviConfig, event);
        await settleEvent(deps, event, outcome);
        if (outcome.disposition === 'processed') summary.processed += 1;
        else if (outcome.disposition === 'ignored') summary.ignored += 1;
        else if (outcome.disposition === 'retry') summary.retried += 1;
        else summary.failed += 1;
      }
    }

    return json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unexpected_error';
    // Nunca vaza segredos: apenas a mensagem já tratada dos módulos.
    return json({ error: message.slice(0, 200) }, { status: 500 });
  }
});
