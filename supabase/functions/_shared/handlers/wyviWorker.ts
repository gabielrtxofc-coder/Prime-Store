import { type Deps } from '../deps.ts';
import { json } from '../http.ts';
import {
  processWyviEvent,
  settleEvent,
  type ClaimedWyviEvent,
  type EventOutcome,
} from '../wyviEvents.ts';

const MAX_EVENTS_PER_RUN = 10;
const MAX_RUN_DURATION_MS = 30_000;

/**
 * Lógica da Edge Function `wyvi-worker` isolada do `Deno.serve` para ser
 * testável pelos mesmos harnesses dos demais handlers (vitest importa este
 * módulo direto, sem Deno).
 *
 * Duas camadas de autenticação (nada foi desligado — ver migração 0044):
 *   1. plataforma: `verify_jwt = true` valida o JWT antes do código rodar;
 *   2. handler: o PAPEL `service_role` precisa estar no claim do JWT.
 * O job `prime-store-wyvi-worker` envia `Authorization: Bearer <jwt-vault>`.
 * Um JWT de `anon` ou sem cabeçalho nunca dispara processamento.
 *
 * Sem chave WyviPay configurada responde 503 `payment_not_configured` ANTES
 * de reivindicar — a fila permanece intacta; nada se perde.
 */

/** Só o service role (chave do servidor) pode acionar o processador. */
export function isServiceRole(request: Request): boolean {
  const header = request.headers.get('authorization') ?? '';
  const part = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i.exec(header)?.[2];
  if (!part) return false;
  try {
    // JWTs commonly omit base64 padding. Restore it before `atob` so the
    // same check works with both legacy Supabase tokens and test fixtures.
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { role?: unknown };
    return claims?.role === 'service_role';
  } catch {
    return false;
  }
}

/** JWT sintético com o papel informado — usado pelos testes e nenhum outro lugar. */
export function makeRoleJwt(role: string): string {
  const enc = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ role })}.assinatura-de-teste`;
}

export async function handleWyviWorker(request: Request, deps: Deps): Promise<Response> {
  // verify_jwt (plataforma) já exige JWT; aqui exigimos o PAPEL service_role —
  // um JWT de anon não pode disparar processamento.
  if (!isServiceRole(request)) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, { status: 405 });

  try {
    const config = deps.config;
    if (!config.wyviApiKey) {
      return json({ error: 'payment_not_configured' }, { status: 503 });
    }

    const wyviConfig = {
      apiKey: config.wyviApiKey,
      baseUrl: config.wyviApiBase,
      fetchImpl: deps.fetchImpl,
    };

    const summary = { claimed: 0, processed: 0, ignored: 0, retried: 0, failed: 0 };
    // Não travar os últimos itens de um lote enquanto os primeiros aguardam a API.
    const deadline = Date.now() + MAX_RUN_DURATION_MS;
    while (summary.claimed < MAX_EVENTS_PER_RUN && Date.now() < deadline) {
      const events = await deps.rpc<ClaimedWyviEvent[]>('claim_wyvi_events', {
        p_order_id: null,
        p_limit: 1,
      });
      if (!Array.isArray(events)) throw new Error('invalid_claim');
      if (!events.length) break;
      const [event] = events;
      summary.claimed++;

      let outcome: EventOutcome;
      try {
        outcome = await processWyviEvent(deps, wyviConfig, event);
      } catch {
        // Uma falha inesperada por evento não pode transformar um claim em
        // sucesso silencioso. Reenfileira com o mesmo mecanismo de backoff;
        // a resposta HTTP continua estável e sem detalhes internos.
        outcome = { disposition: 'retry', reason: 'event_processing_failed' };
      }

      const result = await settleEvent(deps, event, outcome);
      // Sem confirmação da RPC de desfecho, o evento continua recuperável
      // quando a lease expirar — nunca contabilizar como processado.
      if (result === 'unsettled') throw new Error('settle_failed');
      if (result === 'retry') summary.retried++;
      else summary[result]++;
    }
    return json(summary);
  } catch {
    deps.log('wyvi_worker.failed', {});
    return json({ error: 'worker_failed' }, { status: 500 });
  }
}
