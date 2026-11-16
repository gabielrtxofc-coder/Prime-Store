import { withCors } from '../_shared/cors.ts';
import { createDeps } from '../_shared/deps.ts';
import { handleWyviWebhook } from '../_shared/handlers/wyviWebhook.ts';

/**
 * Edge Function `wyvi-webhook` — destino dos eventos da WyviPay (API v2).
 *
 * Endereço a cadastrar na conta WyviPay (painel → Webhooks):
 *   https://<PROJECT_REF>.supabase.co/functions/v1/wyvi-webhook
 * Eventos: cobranca.paga, cobranca.expirada, cobranca.cancelada,
 *          cobranca.estornada (e webhook.teste, opcional, para smoke).
 *
 * `verify_jwt = false` (config.toml): o provedor não envia JWT do Supabase.
 * A autenticidade vem da assinatura HMAC no handler (`X-Wyvi-Assinatura`),
 * conferida sobre o corpo cru ANTES de qualquer escrita no banco.
 *
 * A política de CORS é aplicada na borda; para chamadas servidor→servidor
 * ela é inofensiva, mas mantém o padrão das demais funções.
 */
Deno.serve(async (request: Request) => {
  const deps = createDeps();
  const response = await handleWyviWebhook(request, deps);
  return withCors(request, response, deps.config);
});
