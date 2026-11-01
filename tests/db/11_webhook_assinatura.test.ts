import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { createDeps, type Deps } from '../../supabase/functions/_shared/deps';
import { handleCreateOrder } from '../../supabase/functions/_shared/handlers/createOrder';
import { handleMpWebhook } from '../../supabase/functions/_shared/handlers/mpWebhook';
import { toBase64 } from '../../supabase/functions/_shared/crypto';
import { createFakeMercadoPago } from '../unit/fakeMp';
import { connect, resetDatabase, runSql, seedProduct, sqlValue, RELAXED_RATE_LIMIT_OVERRIDES } from './helpers';
import { createPgRpc } from './pgRpc';
import { signWebhook, signedWebhookRequest } from './mpSignature';

/**
 * Missão 07 — etapa 01: autenticidade das notificações do provedor.
 *
 * Regra única desta suíte: **nenhuma notificação sem assinatura válida pode
 * alterar o estado de um pedido nem gravar em `payment_events`.**
 *
 * Os segredos usados aqui são fictícios e vivem só no teste. Não existe rota de
 * bypass e nenhuma variável liga um "modo de teste" na Edge Function.
 */

const WEBHOOK_SECRET = 'segredo-ficticio-do-webhook-missao07';
/** Chave mestra fictícia: 32 bytes aleatórios em base64, só para este teste. */
const MASTER_KEY = toBase64(crypto.getRandomValues(new Uint8Array(32)));

const events = () => sqlValue<number>('select count(*) from public.payment_events');

describe('mp-webhook — validação da assinatura', () => {
  let client: Client;
  let mp: ReturnType<typeof createFakeMercadoPago>;
  let deps: Deps;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
    mp = createFakeMercadoPago();
    const rpc = createPgRpc(client);
    deps = createDeps({
      config: {
        supabaseUrl: 'https://fake-project.supabase.test',
        serviceRoleKey: 'service-role-key',
        rateLimitOverrides: RELAXED_RATE_LIMIT_OVERRIDES,
        anonKey: 'anon-key',
        mercadoPagoAccessToken: 'TEST-access-token',
        mercadoPagoWebhookSecret: WEBHOOK_SECRET,
        mercadoPagoApiBase: 'https://api.mercadopago.test',
        encryptionKey: MASTER_KEY,
        storeUrl: 'http://localhost:5173',
        paymentNotificationUrl: 'https://fake-project.supabase.test/functions/v1/mp-webhook',
      },
      rpc,
      rpcForUser: () => rpc,
      serviceRpc: rpc,
      fetchImpl: mp.fetchImpl,
      resolveEncryptionKey: async () => MASTER_KEY,
      log: () => undefined,
    });
  }, 60000);

  /** Cria um pedido pago-pendente com cobrança PIX simulada. */
  async function newPendingOrder() {
    const product = await seedProduct({ stockUnits: 1 });
    const response = await handleCreateOrder(
      new Request('https://fn.test/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: product.productId, quantity: 1, payer_email: 'comprador@teste.com' }),
      }),
      deps,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { order: { order_id: string } };
    return { orderId: body.order.order_id, paymentId: mp.lastPayment?.id as string };
  }

  async function orderState(orderId: string) {
    const rows = await runSql<{ status: string; payment_status: string; delivery_status: string }>(
      `select status, payment_status, delivery_status from public.orders where id = $1`,
      [orderId],
    );
    return rows[0];
  }

  async function call(request: Request, overrides: Partial<Deps> = {}) {
    const response = await handleMpWebhook(request, { ...deps, ...overrides });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('aceita notificação com assinatura válida e aplica o pagamento', async () => {
    const { orderId, paymentId } = await newPendingOrder();
    mp.setStatus('approved');
    const before = await events();

    const signed = signWebhook({ dataId: paymentId, requestId: 'req-ok-1', secret: WEBHOOK_SECRET });
    const { status, body } = await call(signedWebhookRequest(signed));

    expect(status).toBe(200);
    expect(body.result).toBe('approved');
    expect(await orderState(orderId)).toMatchObject({
      status: 'paid',
      payment_status: 'approved',
      delivery_status: 'ready',
    });
    expect(Number(await events())).toBe(Number(before) + 1);

    // A notificação é só o gatilho: o estado aplicado vem da consulta ao provedor.
    const providerCalls = mp.calls.filter((entry) => entry.method === 'GET' && entry.url.includes(paymentId));
    expect(providerCalls.length).toBeGreaterThan(0);

    // O evento registrado fica marcado como assinatura válida.
    const row = await runSql<{ signature_valid: boolean }>(
      `select signature_valid from public.payment_events order by received_at desc limit 1`,
    );
    expect(row[0].signature_valid).toBe(true);
  }, 20000);

  it('recusa assinatura incorreta sem tocar no pedido', async () => {
    const { orderId, paymentId } = await newPendingOrder();
    mp.setStatus('approved');
    const before = await events();

    const soldBefore = Number(await sqlValue<number>(`select count(*) from public.stock_units where status = 'sold'`));
    const signed = signWebhook({ dataId: paymentId, requestId: 'req-bad-1', secret: 'segredo-errado' });
    const { status, body } = await call(signedWebhookRequest(signed));

    expect(status).toBe(401);
    expect(body.error).toBe('invalid_signature');
    expect(await orderState(orderId)).toMatchObject({ status: 'pending_payment', payment_status: 'pending' });
    expect(Number(await events())).toBe(Number(before));

    // Nenhuma venda nova: a unidade continua reservada, não vendida.
    expect(
      Number(await sqlValue<number>(`select count(*) from public.stock_units where status = 'sold'`)),
    ).toBe(soldBefore);
  }, 20000);

  it('recusa notificação sem o cabeçalho de assinatura', async () => {
    const { orderId, paymentId } = await newPendingOrder();
    const before = await events();

    const { status } = await call(
      new Request(`https://fn.test/mp-webhook?data.id=${paymentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-sem-assinatura' },
        body: JSON.stringify({ id: 'notif-sem-assinatura', type: 'payment', data: { id: paymentId } }),
      }),
    );

    expect(status).toBe(401);
    expect(await orderState(orderId)).toMatchObject({ status: 'pending_payment' });
    expect(Number(await events())).toBe(Number(before));
  }, 20000);

  it('recusa tudo quando o segredo da aplicação não está configurado', async () => {
    const { orderId, paymentId } = await newPendingOrder();
    const before = await events();

    const signed = signWebhook({ dataId: paymentId, requestId: 'req-sem-segredo', secret: WEBHOOK_SECRET });
    const { status, body } = await call(signedWebhookRequest(signed), {
      config: { ...deps.config, mercadoPagoWebhookSecret: null },
    });

    expect(status).toBe(503);
    expect(body.error).toBe('webhook_not_configured');
    expect(await orderState(orderId)).toMatchObject({ status: 'pending_payment' });
    expect(Number(await events())).toBe(Number(before));
  }, 20000);

  it('recusa cabeçalhos incompletos (sem x-request-id, sem data.id ou sem ts)', async () => {
    const { orderId, paymentId } = await newPendingOrder();
    const before = await events();
    const signed = signWebhook({ dataId: paymentId, requestId: 'req-incompleto', secret: WEBHOOK_SECRET });

    const variants: Array<[string, Request]> = [
      [
        'sem x-request-id',
        new Request('https://fn.test/mp-webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-signature': signed.headers['x-signature'] },
          body: signed.body,
        }),
      ],
      [
        'sem data.id',
        new Request('https://fn.test/mp-webhook', {
          method: 'POST',
          headers: signed.headers,
          body: JSON.stringify({ id: 'notif-sem-data-id', type: 'payment' }),
        }),
      ],
      [
        'assinatura sem ts',
        new Request('https://fn.test/mp-webhook', {
          method: 'POST',
          headers: { ...signed.headers, 'x-signature': `v1=${signed.headers['x-signature']?.split('v1=')[1]}` },
          body: signed.body,
        }),
      ],
      [
        'assinatura sem v1',
        new Request('https://fn.test/mp-webhook', {
          method: 'POST',
          headers: { ...signed.headers, 'x-signature': `ts=${signed.headers['x-signature']?.split('ts=')[1]?.split(',')[0]}` },
          body: signed.body,
        }),
      ],
    ];

    for (const [label, request] of variants) {
      const { status } = await call(request);
      expect(status, label).toBe(401);
    }

    expect(await orderState(orderId)).toMatchObject({ status: 'pending_payment' });
    expect(Number(await events())).toBe(Number(before));
  }, 20000);

  it('recusa assinatura antiga (replay de notificação legítima)', async () => {
    const { orderId, paymentId } = await newPendingOrder();
    const before = await events();

    const signed = signWebhook({
      dataId: paymentId,
      requestId: 'req-antigo',
      secret: WEBHOOK_SECRET,
      ts: Math.floor(Date.now() / 1000) - 60 * 60 * 48,
    });
    const { status, body } = await call(signedWebhookRequest(signed));

    expect(status).toBe(401);
    expect(body.error).toBe('stale_signature');
    expect(await orderState(orderId)).toMatchObject({ status: 'pending_payment' });
    expect(Number(await events())).toBe(Number(before));
  }, 20000);

  it('assinatura válida com dados inválidos não altera pedido nem derruba a rota', async () => {
    const { orderId, paymentId } = await newPendingOrder();
    const before = await events();

    // Assinada de verdade, mas o provedor não conhece esse pagamento.
    const signed = signWebhook({ dataId: '999999999999', requestId: 'req-inexistente', secret: WEBHOOK_SECRET });
    const { status } = await call(signedWebhookRequest(signed));

    // 500 sinaliza ao provedor para reenviar; o pedido continua intacto.
    expect([200, 500]).toContain(status);
    expect(await orderState(orderId)).toMatchObject({ status: 'pending_payment' });

    // Corpo que não é JSON: assinatura confere, então nada é processado.
    const manifestTs = String(Math.floor(Date.now() / 1000));
    const unsignedBody = 'nao-e-json';
    const { createHmac } = await import('node:crypto');
    const v1 = createHmac('sha256', WEBHOOK_SECRET)
      .update(`id:${paymentId};request-id:req-lixo;ts:${manifestTs};`)
      .digest('hex');
    const lixo = await call(
      new Request('https://fn.test/mp-webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': `ts=${manifestTs},v1=${v1}`,
          'x-request-id': 'req-lixo',
        },
        body: unsignedBody,
      }),
    );
    expect([200, 401, 503]).toContain(lixo.status);
    expect(await orderState(orderId)).toMatchObject({ status: 'pending_payment' });

    // O evento do provedor inexistente pode ficar registrado como `failed`, mas
    // o pedido nunca muda de estado e nenhuma venda é concluída.
    const failedEvents = await sqlValue<number>(
      `select count(*) from public.payment_events where status = 'failed'`,
    );
    expect(Number(failedEvents)).toBeGreaterThanOrEqual(1);
    expect(await orderState(orderId)).toMatchObject({ status: 'pending_payment' });
    expect(Number(await events())).toBeGreaterThanOrEqual(Number(before));
  }, 20000);

  it('notificação repetida é idempotente e não duplica entrega', async () => {
    const { orderId, paymentId } = await newPendingOrder();
    mp.setStatus('approved');
    const signed = signWebhook({
      dataId: paymentId,
      requestId: 'req-duplicada',
      secret: WEBHOOK_SECRET,
      notificationId: 'notif-repetida-1',
    });

    const first = await call(signedWebhookRequest(signed));
    expect(first.status).toBe(200);
    expect(first.body.result).toBe('approved');

    const second = await call(signedWebhookRequest(signed));
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    expect(
      Number(await sqlValue<number>('select count(*) from public.deliveries where order_id = $1', [orderId])),
    ).toBe(1);
    expect(await orderState(orderId)).toMatchObject({ status: 'paid', delivery_status: 'ready' });
  }, 20000);

  it('notificação recusada não aparece no histórico de eventos', async () => {
    const rows = await runSql<{ notification_id: string; signature_valid: boolean }>(
      `select notification_id, signature_valid from public.payment_events order by received_at`,
    );
    for (const row of rows) {
      expect(row.signature_valid, `evento ${row.notification_id} sem assinatura válida`).toBe(true);
      expect(row.notification_id).not.toMatch(/sem-assinatura|incompleto|bad/);
    }
  });
});
