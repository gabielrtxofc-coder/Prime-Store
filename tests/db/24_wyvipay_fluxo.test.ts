import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { toBase64 } from '../../supabase/functions/_shared/crypto';
import { createDeps, type Deps } from '../../supabase/functions/_shared/deps';
import { handleCreateOrder } from '../../supabase/functions/_shared/handlers/createOrder';
import { handleDelivery } from '../../supabase/functions/_shared/handlers/delivery';
import { handleOrderStatus } from '../../supabase/functions/_shared/handlers/orderStatus';
import { handleWyviWebhook } from '../../supabase/functions/_shared/handlers/wyviWebhook';
import { createFakeWyvi, signWyviEvent, signedWyviRequest } from '../unit/fakeWyvi';
import {
  connect,
  randomToken,
  RELAXED_RATE_LIMIT_OVERRIDES,
  resetDatabase,
  runSql,
  seedProduct,
  sqlValue,
} from './helpers';
import { createPgRpc } from './pgRpc';

/**
 * Missão WyviPay — fluxo completo ponta a ponta sobre o PostgreSQL real:
 *
 *   1. criação de cobrança PIX multi-item (valor em centavos, Idempotency-Key
 *      por pedido, QR + copia-e-cola) sem enviar PII ao provedor;
 *   2. requisição repetida NÃO duplica cobrança nem pedido;
 *   3. falha do provedor libera a reserva (estoque nunca fica preso);
 *   4. webhook: assinatura inválida → 401 e ZERO efeitos; entrega repetida →
 *      um único efeito; aprovação → pedido pago + entrega criada;
 *   5. a notificação NUNCA é fonte de verdade: o estado vem da reconsulta da
 *      cobrança (valor divergente → `amount_mismatch`, entrega bloqueada);
 *   6. expiração/cancelamento devolvem o estoque;
 *   7. evento de teste em produção é recusado (simulação não aprova pedido
 *      real);
 *   8. reconciliação pela consulta de status (webhook atrasado) com throttle;
 *   9. sem provedor configurado: fallback para solicitação ou 503, nunca
 *      pedido pendurado.
 *
 * Nenhuma credencial real é usada: a chave (`wy_test_...`), o segredo
 * (`whsec_...`) e a base da API são fictícios e existem só neste arquivo.
 */

const API_KEY = 'wy_test_apenas_ficticio_neste_teste';
const WEBHOOK_SECRET = 'whsec_apenas_ficticio_neste_teste_0001';
const API_BASE = 'https://api.wyvipay.test';
/** Chave mestra fictícia: 32 bytes aleatórios em base64, só para este teste. */
const MASTER_KEY = toBase64(crypto.getRandomValues(new Uint8Array(32)));

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

interface WyviOrder {
  first: { productId: string };
  second: { productId: string };
  clientToken: string;
  payload: Record<string, unknown>;
  order: { order_id: string; total_cents: number };
  payment: { qr_code: string | null; qr_code_base64: string | null };
  txid: string;
}

describe('24 — WyviPay: cobrança, webhook protegido e entrega', () => {
  let client: Client;
  let fake: ReturnType<typeof createFakeWyvi>;
  let deps: Deps;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
    fake = createFakeWyvi({ qrcodeOnCreate: null }); // como o ambiente de teste real
    const rpc = createPgRpc(client);
    deps = createDeps({
      config: {
        supabaseUrl: 'https://fake-project.supabase.test',
        serviceRoleKey: 'service-role-key',
        anonKey: 'anon-key',
        wyviApiKey: API_KEY,
        wyviWebhookSecret: WEBHOOK_SECRET,
        wyviApiBase: API_BASE,
        wyviEnvironment: 'test',
        encryptionKey: MASTER_KEY,
        storeUrl: 'https://loja.teste',
        paymentNotificationUrl: 'https://fake-project.supabase.test/functions/v1/mp-webhook',
        rateLimitOverrides: RELAXED_RATE_LIMIT_OVERRIDES,
      },
      rpc,
      rpcForUser: () => rpc,
      serviceRpc: rpc,
      fetchImpl: fake.fetchImpl,
      resolveEncryptionKey: async () => MASTER_KEY,
      log: () => undefined,
    });
  }, 60000);

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function post(url: string, body: unknown, headers: Record<string, string> = {}): Request {
    return new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  async function createOrder(
    payload: Record<string, unknown>,
    depsOverride: Deps = deps,
  ): Promise<HttpResult> {
    const response = await handleCreateOrder(post('https://fn.test/create-order', payload), depsOverride);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function sendWebhook(
    params: { secret?: string; evento: string; dados: Record<string, unknown>; deliveryId?: string },
    depsOverride: Deps = deps,
  ): Promise<HttpResult> {
    const signed = signWyviEvent({
      secret: params.secret ?? WEBHOOK_SECRET,
      evento: params.evento,
      deliveryId: params.deliveryId ?? randomUUID(),
      dados: params.dados,
    });
    const response = await handleWyviWebhook(signedWyviRequest(signed), depsOverride);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function orderState(orderId: string) {
    const rows = await runSql<{ status: string; payment_status: string; delivery_status: string }>(
      `select status, payment_status, delivery_status from public.orders where id = $1`,
      [orderId],
    );
    return rows[0];
  }

  async function stockState(productId: string) {
    const rows = await runSql<{ status: string; count: number }>(
      `select status, count(*)::int as count
         from public.stock_units where product_id = $1 group by status order by status`,
      [productId],
    );
    return rows;
  }

  async function callOrderStatus(
    orderId: string,
    clientToken: string,
    depsOverride: Deps = deps,
  ): Promise<HttpResult> {
    const response = await handleOrderStatus(
      post('https://fn.test/order-status', { order_id: orderId, client_token: clientToken }),
      depsOverride,
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  function countEvents(orderId: string, eventType: string): Promise<number> {
    return sqlValue<number>(
      `select count(*) from public.order_events where order_id = $1 and event_type = $2`,
      [orderId, eventType],
    ).then((value) => Number(value));
  }

  function countDeliveries(orderId: string): Promise<number> {
    return sqlValue<number>(`select count(*) from public.deliveries where order_id = $1`, [orderId]).then(
      (value) => Number(value),
    );
  }

  /** Pedido multi-item criado pela WyviPay (2× produto A + 1× produto B). */
  async function newWyviOrder(overrides: Record<string, unknown> = {}): Promise<WyviOrder> {
    const first = await seedProduct({ priceCents: 5000, stockUnits: 2, maxQuantity: 5 });
    const second = await seedProduct({ priceCents: 7990, stockUnits: 2, maxQuantity: 5 });
    const clientToken = randomToken(32);
    const payload: Record<string, unknown> = {
      items: [
        { product_id: first.productId, quantity: 2 },
        { product_id: second.productId, quantity: 1 },
      ],
      payer_email: 'comprador@teste.com',
      buyer_name: 'Maria Souza',
      idempotency_key: randomToken(16),
      client_token: clientToken,
      ...overrides,
    };
    const created = await createOrder(payload);
    expect(created.status).toBe(201);
    const order = created.body.order as { order_id: string; total_cents: number };
    const payment = created.body.payment as { qr_code: string | null; qr_code_base64: string | null };
    const txid = (await sqlValue<string>(
      `select provider_payment_id from public.payments where order_id = $1`,
      [order.order_id],
    )) as unknown as string;
    return { first, second, clientToken, payload, order, payment, txid };
  }

  /** Deps de um ambiente SEM nenhuma chave de pagamento. */
  function depsWithoutProvider(): Deps {
    return createDeps({
      config: {
        supabaseUrl: 'https://fake-project.supabase.test',
        serviceRoleKey: 'service-role-key',
        anonKey: 'anon-key',
        encryptionKey: MASTER_KEY,
        storeUrl: 'https://loja.teste',
        rateLimitOverrides: RELAXED_RATE_LIMIT_OVERRIDES,
      },
      rpc: createPgRpc(client),
      fetchImpl: fake.fetchImpl,
      resolveEncryptionKey: async () => MASTER_KEY,
      log: () => undefined,
    });
  }

  // ---------------------------------------------------------------------
  // 0. Privilégios das funções novas/recriadas (regressão de grants)
  // ---------------------------------------------------------------------

  it('só o service_role executa attach_payment/attach_order_buyer/record_payment_event', async () => {
    const rows = await runSql<{ fn: string; sr: boolean; anon: boolean }>(
      `select p.proname as fn,
              has_function_privilege('service_role', p.oid, 'execute') as sr,
              has_function_privilege('anon', p.oid, 'execute') as anon
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('attach_payment', 'attach_order_buyer', 'record_payment_event')`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.sr, `${row.fn} deve ser executável por service_role`).toBe(true);
      expect(row.anon, `${row.fn} NÃO pode ser executável por anon`).toBe(false);
    }
  });

  // ---------------------------------------------------------------------
  // 1. Criação da cobrança multi-item
  // ---------------------------------------------------------------------

  it('cria cobrança PIX multi-item em centavos, com Idempotency-Key por pedido e sem PII', async () => {
    const { first, second, order, payment, txid } = await newWyviOrder();

    // Valor inteiro em centavos, decidido pelo banco.
    expect(order.total_cents).toBe(2 * 5000 + 7990);
    // QR: em ambiente de teste a WyviPay não devolve imagem — só copia-e-cola.
    expect(payment.qr_code).toContain('FAKEWYVI');
    expect(payment.qr_code_base64).toBeNull();

    // Idempotência POR PEDIDO: a chave enviada ao provedor é determinística.
    const last = fake.createCalls.at(-1)!;
    expect(last.headers['idempotency-key']).toBe(`order-${order.order_id}`);
    expect(last.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(last.body).toMatchObject({ valor_centavos: order.total_cents, meio: 'pix' });

    // Nenhum dado pessoal do pagador vai para a API da WyviPay.
    const serialized = JSON.stringify(last.body);
    expect(serialized).not.toContain('Maria');
    expect(serialized).not.toContain('comprador@teste.com');
    expect((last.body as { pagador?: unknown }).pagador).toBeUndefined();

    // Estado no banco: pedido, itens, cobrança e reserva.
    const itemRows = await sqlValue<number>(`select count(*) from public.order_items where order_id = $1`, [
      order.order_id,
    ]);
    expect(Number(itemRows)).toBe(2);

    const paymentRow = await runSql<{ provider: string; provider_payment_id: string; status: string }>(
      `select provider, provider_payment_id, status from public.payments where order_id = $1`,
      [order.order_id],
    );
    expect(paymentRow).toHaveLength(1);
    expect(paymentRow[0]).toMatchObject({ provider: 'wyvipay', provider_payment_id: txid, status: 'pending' });

    expect(await orderState(order.order_id)).toMatchObject({
      status: 'pending_payment',
      payment_status: 'pending',
    });
    // Nome do comprador gravado com prova de posse (comprovante interno).
    const buyer = await sqlValue<string>(`select buyer_name from public.orders where id = $1`, [order.order_id]);
    expect(buyer).toBe('Maria Souza');

    expect(await stockState(first.productId)).toEqual([{ status: 'reserved', count: 2 }]);
    expect(await stockState(second.productId)).toEqual([
      { status: 'available', count: 1 },
      { status: 'reserved', count: 1 },
    ]);
    expect(txid).toMatch(/^test/);
  }, 30000);

  it('repetir a mesma requisição devolve o MESMO pedido e a MESMA cobrança', async () => {
    const original = await newWyviOrder();
    const chargesBefore = fake.chargeCount;

    const replay = await createOrder(original.payload);

    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect((replay.body.order as { order_id: string }).order_id).toBe(original.order.order_id);

    // Nenhuma cobrança nova e nenhum pagamento novo.
    expect(fake.chargeCount).toBe(chargesBefore);
    const paymentsCount = await sqlValue<number>(`select count(*) from public.payments where order_id = $1`, [
      original.order.order_id,
    ]);
    expect(Number(paymentsCount)).toBe(1);
  }, 30000);

  it('mesma chave de idempotência com OUTRO token não sequestra o pedido (409)', async () => {
    const product = await seedProduct({ stockUnits: 1 });
    const idempotencyKey = randomToken(16);

    const owner = await createOrder({
      items: [{ product_id: product.productId, quantity: 1 }],
      payer_email: 'comprador@teste.com',
      buyer_name: 'Maria Souza',
      idempotency_key: idempotencyKey,
      client_token: randomToken(32),
    });
    expect(owner.status).toBe(201);
    const orderId = (owner.body.order as { order_id: string }).order_id;

    const attacker = await createOrder({
      items: [{ product_id: product.productId, quantity: 1 }],
      payer_email: 'atacante@teste.com',
      buyer_name: 'Atacante',
      idempotency_key: idempotencyKey,
      client_token: randomToken(32),
    });
    expect(attacker.status).toBe(409);
    expect(attacker.body.error).toBe('idempotency_conflict');
    // Nenhum dado do pedido vaza na resposta de erro.
    expect(JSON.stringify(attacker.body)).not.toContain(orderId);
  }, 30000);

  // ---------------------------------------------------------------------
  // 2. Falha de comunicação com o provedor
  // ---------------------------------------------------------------------

  it('falha de comunicação na criação → 502 e reserva LIBERADA (estoque nunca preso)', async () => {
    const product = await seedProduct({ priceCents: 4990, stockUnits: 2, maxQuantity: 5 });
    fake.setFailCreate(true);
    try {
      const result = await createOrder({
        items: [{ product_id: product.productId, quantity: 2 }],
        payer_email: 'comprador@teste.com',
        buyer_name: 'Maria Souza',
        idempotency_key: randomToken(16),
        client_token: randomToken(32),
      });
      expect(result.status).toBe(502);
      expect(result.body.error).toBe('payment_provider_unavailable');
      // Nenhuma credencial ou detalhe interno na resposta.
      expect(JSON.stringify(result.body)).not.toContain(API_KEY);
    } finally {
      fake.setFailCreate(false);
    }

    const orderId = (await sqlValue<string>(`select id from public.orders order by created_at desc limit 1`)) as unknown as string;
    expect(await orderState(orderId)).toMatchObject({ status: 'failed' });
    expect(await stockState(product.productId)).toEqual([{ status: 'available', count: 2 }]);
    // Nenhuma cobrança órfã gravada.
    const payments = await sqlValue<number>(`select count(*) from public.payments where order_id = $1`, [orderId]);
    expect(Number(payments)).toBe(0);
  }, 30000);

  // ---------------------------------------------------------------------
  // 3. Webhook: assinatura e fail-closed
  // ---------------------------------------------------------------------

  it('assinatura inválida → 401 e ZERO eventos gravados, pedido intacto', async () => {
    const { order, txid } = await newWyviOrder();
    fake.setSituacao(txid, 'concluida');
    const eventsBefore = Number(
      await sqlValue<number>(`select count(*) from public.payment_events where provider = 'wyvipay'`),
    );

    const result = await sendWebhook({
      secret: 'whsec_errado_outro_segredo',
      evento: 'cobranca.paga',
      dados: { txid, valor_centavos: 17990 },
    });

    expect(result.status).toBe(401);
    expect(result.body.error).toBe('invalid_signature');
    expect(
      Number(await sqlValue<number>(`select count(*) from public.payment_events where provider = 'wyvipay'`)),
    ).toBe(eventsBefore);
    expect(await orderState(order.order_id)).toMatchObject({
      status: 'pending_payment',
      payment_status: 'pending',
    });
    // Nenhuma entrega nasceu de uma notificação não autenticada.
    expect(await countDeliveries(order.order_id)).toBe(0);
  }, 30000);

  it('segredo do webhook não configurado → 503 fail-closed (nunca processa sem prova)', async () => {
    const { order, txid } = await newWyviOrder();
    fake.setSituacao(txid, 'concluida');
    const withoutSecret: Deps = { ...deps, config: { ...deps.config, wyviWebhookSecret: null } };

    const result = await sendWebhook(
      { evento: 'cobranca.paga', dados: { txid, valor_centavos: 17990 } },
      withoutSecret,
    );

    expect(result.status).toBe(503);
    expect(result.body.error).toBe('webhook_not_configured');
    expect(await orderState(order.order_id)).toMatchObject({ status: 'pending_payment' });
  }, 30000);

  // ---------------------------------------------------------------------
  // 4. Aprovação legítima + dedup + entrega só depois do pagamento
  // ---------------------------------------------------------------------

  it('webhook legítimo paga o pedido, cria a entrega e a repetição não duplica efeito', async () => {
    const { order, txid, first, second, clientToken } = await newWyviOrder();
    fake.setSituacao(txid, 'concluida');

    // ANTES do pagamento: a entrega não existe nem por token adivinhado.
    const deliveryEarly = await handleDelivery(
      new Request(`https://fn.test/delivery?token=${randomToken(32)}`),
      deps,
    );
    expect(deliveryEarly.status).toBe(404);

    const ok = await sendWebhook({
      evento: 'cobranca.paga',
      dados: { txid, valor_centavos: 17990, pago_em: '2026-11-13T12:00:00Z' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.result).toBe('approved');

    expect(await orderState(order.order_id)).toMatchObject({
      status: 'paid',
      payment_status: 'approved',
      delivery_status: 'ready',
    });
    expect(await countDeliveries(order.order_id)).toBe(1);

    // Estoque: unidades reservadas viraram vendas.
    expect(await stockState(first.productId)).toEqual([{ status: 'sold', count: 2 }]);
    expect(await stockState(second.productId)).toEqual([
      { status: 'available', count: 1 },
      { status: 'sold', count: 1 },
    ]);

    // A consulta do pedido (token certo) enxerga a entrega pronta.
    const status = await callOrderStatus(order.order_id, clientToken);
    expect(status.body).toMatchObject({ status: 'paid', payment_status: 'approved' });
    expect((status.body.delivery as { status: string } | null)?.status).toBe('active');
    expect(typeof (status.body.delivery as { url: string | null }).url).toBe('string');

    // ---- Retentativas: mesma entrega repetida, mesmo efeito único ----
    const deliveryId = randomUUID();
    const firstDelivery = await sendWebhook({ evento: 'cobranca.paga', dados: { txid }, deliveryId });
    expect(firstDelivery.status).toBe(200);

    const repeat = await sendWebhook({ evento: 'cobranca.paga', dados: { txid }, deliveryId });
    expect(repeat.status).toBe(200);
    expect(repeat.body.duplicate).toBe(true);

    // Um ÚNICO efeito: um pagamento aprovado, uma entrega, um evento de venda.
    expect(await countEvents(order.order_id, 'payment_approved')).toBe(1);
    expect(await countDeliveries(order.order_id)).toBe(1);
  }, 30000);

  // ---------------------------------------------------------------------
  // 5. A notificação nunca é fonte de verdade
  // ---------------------------------------------------------------------

  it('evento diz "paga" mas a API diz "pendente" → nada muda (reconsulta manda)', async () => {
    const { order, txid } = await newWyviOrder();
    // Cobrança continua pendente na fonte de verdade.

    const result = await sendWebhook({ evento: 'cobranca.paga', dados: { txid, valor_centavos: 17990 } });

    expect(result.status).toBe(200);
    expect(result.body.result).toBe('pending'); // o que a API devolveu
    expect(await orderState(order.order_id)).toMatchObject({
      status: 'pending_payment',
      payment_status: 'pending',
    });
    expect(await countDeliveries(order.order_id)).toBe(0);
  }, 30000);

  it('valor divergente entre cobrança e pedido → amount_mismatch e entrega BLOQUEADA', async () => {
    const { order, txid } = await newWyviOrder();
    // A "API" passa a devolver outro valor: a reconsulta diverge do pedido.
    const charge = fake.getCharge(txid);
    expect(charge).toBeDefined();
    charge!.valor_centavos = 1;

    try {
      const result = await sendWebhook({ evento: 'cobranca.paga', dados: { txid, valor_centavos: 1 } });

      expect(result.status).toBe(200);
      expect(result.body.result).toBe('amount_mismatch');
      expect(await orderState(order.order_id)).toMatchObject({ payment_status: 'amount_mismatch' });
      expect((await orderState(order.order_id)).status).not.toBe('paid');
      expect(await countDeliveries(order.order_id)).toBe(0);
      // A divergência gera uma pendência de reembolso para análise humana.
      const refunds = await sqlValue<number>(
        `select count(*) from public.refund_requests where order_id = $1 and reason = 'payment_amount_mismatch'`,
        [order.order_id],
      );
      expect(Number(refunds)).toBe(1);
    } finally {
      charge!.valor_centavos = 17990;
    }
  }, 30000);

  // ---------------------------------------------------------------------
  // 6. Expiração e cancelamento liberam a reserva
  // ---------------------------------------------------------------------

  it('cobrança expirada (venceu sem pagamento) → pedido encerrado e estoque liberado', async () => {
    const { order, txid, first, second } = await newWyviOrder();
    fake.setSituacao(txid, 'falhou');

    const result = await sendWebhook({ evento: 'cobranca.expirada', dados: { txid } });

    expect(result.status).toBe(200);
    expect(result.body.result).toBe('cancelled');
    expect(await orderState(order.order_id)).toMatchObject({
      status: 'expired',
      payment_status: 'cancelled',
    });
    expect(await stockState(first.productId)).toEqual([{ status: 'available', count: 2 }]);
    expect(await stockState(second.productId)).toEqual([{ status: 'available', count: 2 }]);
  }, 30000);

  it('cancelamento no provedor → pedido encerrado e estoque liberado', async () => {
    const { order, txid, first } = await newWyviOrder();
    fake.setSituacao(txid, 'cancelada');

    const result = await sendWebhook({ evento: 'cobranca.cancelada', dados: { txid } });

    expect(result.status).toBe(200);
    expect(result.body.result).toBe('cancelled');
    expect(await orderState(order.order_id)).toMatchObject({
      status: 'expired',
      payment_status: 'cancelled',
    });
    expect(await stockState(first.productId)).toEqual([{ status: 'available', count: 2 }]);
  }, 30000);

  // ---------------------------------------------------------------------
  // 7. Evento de teste nunca aprova pedido real
  // ---------------------------------------------------------------------

  it('dados.teste em ambiente de produção → ignorado, pedido segue intacto', async () => {
    const { order, txid } = await newWyviOrder();
    fake.setSituacao(txid, 'concluida');
    const productionDeps: Deps = createDeps({
      config: {
        ...deps.config,
        wyviApiKey: 'wy_live_ainda_ficticio_neste_teste',
        wyviEnvironment: 'production' as const,
      },
      rpc: createPgRpc(client),
      fetchImpl: fake.fetchImpl,
      resolveEncryptionKey: async () => MASTER_KEY,
      log: () => undefined,
    });

    const result = await sendWebhook(
      { evento: 'cobranca.paga', dados: { txid, teste: true, ambiente: 'homologacao' } },
      productionDeps,
    );

    expect(result.status).toBe(200);
    expect(result.body.ignored).toBe(true);
    expect(result.body.reason).toBe('test_event_in_production');
    expect(await orderState(order.order_id)).toMatchObject({
      status: 'pending_payment',
      payment_status: 'pending',
    });
    expect(await countDeliveries(order.order_id)).toBe(0);
  }, 30000);

  // ---------------------------------------------------------------------
  // 8. Reconciliação pela consulta (webhook atrasado) + throttle
  // ---------------------------------------------------------------------

  it('order-status reconcilia com a API quando o webhook atrasa, respeitando o throttle de 15 s', async () => {
    const { order, txid, clientToken } = await newWyviOrder();
    fake.setSituacao(txid, 'concluida');
    const readsOf = () => fake.getReadCalls().filter((call) => call.url.includes(txid)).length;
    const readsBefore = readsOf();

    const status = await callOrderStatus(order.order_id, clientToken);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ status: 'paid', payment_status: 'approved' });

    const readsAfterFirst = readsOf();
    expect(readsAfterFirst).toBeGreaterThan(readsBefore);

    // Segunda consulta imediata: THROTTLE — nenhuma chamada nova à API.
    const again = await callOrderStatus(order.order_id, clientToken);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'paid', payment_status: 'approved' });
    expect(readsOf()).toBe(readsAfterFirst);

    expect(await orderState(order.order_id)).toMatchObject({ status: 'paid' });
    expect(await countDeliveries(order.order_id)).toBe(1);
  }, 30000);

  // ---------------------------------------------------------------------
  // 9. Sem provedor configurado: fallback e 503 (nunca pedido preso)
  // ---------------------------------------------------------------------

  it('sem chave de pagamento + fallback_to_request → solicitação sem reserva; replay vira 409', async () => {
    const product = await seedProduct({ priceCents: 4990, stockUnits: 2, maxQuantity: 5 });
    const noProvider = depsWithoutProvider();
    const payload = {
      items: [{ product_id: product.productId, quantity: 2 }],
      payer_email: 'comprador@teste.com',
      buyer_name: 'Maria Souza',
      idempotency_key: randomToken(16),
      client_token: randomToken(32),
      fallback_to_request: true,
    };
    const createsBefore = fake.createCalls.length;

    const result = await createOrder(payload, noProvider);
    expect(result.status).toBe(201);
    expect(result.body.payment_mode).toBe('request');
    expect(result.body.payment).toBeNull();

    const orderId = (result.body.order as { order_id: string }).order_id;
    expect(await orderState(orderId)).toMatchObject({ status: 'requested', payment_status: 'not_required' });
    // Solicitação sem pagamento: NENHUMA reserva de estoque.
    expect(await stockState(product.productId)).toEqual([{ status: 'available', count: 2 }]);
    // E nenhuma cobrança foi tentada na API.
    expect(fake.createCalls.length).toBe(createsBefore);

    // Repetição da MESMA identidade sem provedor: devolve a MESMA solicitação
    // (idempotente, sem nova linha) — o cliente que perdeu a resposta recupera
    // o comprovante em vez de ficar sem saída.
    const replay = await createOrder(payload, noProvider);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotent_replay).toBe(true);
    expect(replay.body.payment_mode).toBe('request');
    expect((replay.body.order as { order_id: string }).order_id).toBe(orderId);
    expect(fake.createCalls.length).toBe(createsBefore);

    // O MESMO pedido reencontrado quando o provedor JÁ está configurado é uma
    // tentativa encerrada (`requested` nunca vira cobrança): 409 explícito para
    // o cliente recomeçar — nunca uma cobrança nova sobre uma solicitação.
    const withProvider = await createOrder(payload, deps);
    expect(withProvider.status).toBe(409);
    expect(withProvider.body.error).toBe('previous_attempt_closed');
    expect(fake.createCalls.length).toBe(createsBefore);
  }, 30000);

  it('sem chave e SEM fallback → 503 com reserva liberada (pedido não fica pendurado)', async () => {
    const product = await seedProduct({ priceCents: 4990, stockUnits: 2, maxQuantity: 5 });
    const noProvider = depsWithoutProvider();

    const result = await createOrder(
      {
        items: [{ product_id: product.productId, quantity: 1 }],
        payer_email: 'comprador@teste.com',
        buyer_name: 'Maria Souza',
        idempotency_key: randomToken(16),
        client_token: randomToken(32),
      },
      noProvider,
    );

    expect(result.status).toBe(503);
    expect(result.body.error).toBe('payment_not_configured');
    expect(await stockState(product.productId)).toEqual([{ status: 'available', count: 2 }]);
    const orderId = (await sqlValue<string>(`select id from public.orders order by created_at desc limit 1`)) as unknown as string;
    expect(await orderState(orderId)).toMatchObject({ status: 'failed' });
  }, 30000);

  // ---------------------------------------------------------------------
  // 10. Compatibilidade: formato legado mono-item continua funcionando
  // ---------------------------------------------------------------------

  it('payload legado (product_id + quantity) também gera cobrança WyviPay', async () => {
    const product = await seedProduct({ priceCents: 7990, stockUnits: 1, maxQuantity: 5 });
    const result = await createOrder({
      product_id: product.productId,
      quantity: 1,
      payer_email: 'comprador@teste.com',
      idempotency_key: randomToken(16),
      client_token: randomToken(32),
    });

    expect(result.status).toBe(201);
    const payment = result.body.payment as { qr_code: string | null };
    expect(payment.qr_code).toContain('FAKEWYVI');
    const orderId = (result.body.order as { order_id: string }).order_id;
    const payments = await runSql<{ provider: string }>(
      `select provider from public.payments where order_id = $1`,
      [orderId],
    );
    expect(payments[0].provider).toBe('wyvipay');
  }, 30000);
});
