import { createDeps } from '../_shared/deps.ts';
import { handleWyviWorker } from '../_shared/handlers/wyviWorker.ts';

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
 * Gatilhos (todos independentes do navegador do comprador):
 *   1. job `prime-store-wyvi-worker` no pg_cron, a cada minuto, chamando
 *      esta função com `Authorization: Bearer <jwt lido do Vault>` —
 *      ver `supabase/migrations/20261117000000_0044_wyvi_worker_cron.sql`;
 *   2. o poll do `order-status` processa os eventos do pedido consultado;
 *   3. invocação manual/CI com a chave service_role.
 *
 * Autenticação em DUAS camadas (nenhuma desligada): `verify_jwt = true` na
 * plataforma + validação do papel `service_role` dentro do handler
 * (`handleWyviWorker`). Sem chave WyviPay configurada responde 503
 * `payment_not_configured` antes de tocar na fila (fila intacta).
 *
 * A lógica testável vive em `_shared/handlers/wyviWorker.ts`.
 */
Deno.serve((request: Request) => handleWyviWorker(request, createDeps()));
