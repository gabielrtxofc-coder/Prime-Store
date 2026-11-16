import { type Deps } from '../deps.ts';
import { json } from '../http.ts';
import { processWyviEvent, settleEvent, type ClaimedWyviEvent } from '../wyviEvents.ts';

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
}
