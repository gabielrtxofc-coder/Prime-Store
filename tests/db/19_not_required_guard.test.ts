import { beforeAll, describe, expect, it } from 'vitest';
import {
  createOrder,
  fakeCiphertextB64,
  randomToken,
  resetDatabase,
  runAs,
  runSql,
  seedProduct,
  sha256Hex,
  sqlValue,
  type OrderResult,
} from './helpers';

/**
 * Missão de correção — BLOQUEIO DE CONFIRMAÇÃO DE PAGAMENTO EM SOLICITAÇÃO.
 *
 * A falha auditada: `apply_payment_status('approved')` sobre um pedido criado
 * pelo fluxo público SEM cobrança (`status = 'requested'`,
 * `payment_status = 'not_required'`, migração 0033) percorria o ramo de
 * aprovação, alocava unidades disponíveis, marcava o pedido como pago e criava
 * a entrega — transformando uma solicitação em venda.
 *
 * Estes testes chamam a função DIRETAMENTE, com contexto privilegiado
 * (`service_role`, o mesmo caminho de `mp-webhook`/`order-status`), e comparam
 * o estado completo do pedido antes e depois da tentativa:
 *
 *   orders, order_items, stock_units, stock_reservations,
 *   stock_reservation_units, payments, order_events, deliveries,
 *   delivery_units e os tokens privados (client_token_hash e token da entrega).
 *
 * A migração 0037 faz `apply_payment_status` devolver
 * `ignored_no_payment_required` sem escrever nada.
 */

interface PaymentResult {
  result: string;
  order_status?: string;
  payment_status?: string;
  delivery_status?: string;
  delivery_id?: string | null;
  requires_admin_review?: boolean;
}

interface DeliveryToken {
  hash: string;
  enc: string;
}

interface RequestOrder {
  order_id: string;
  reference: string;
  status: string;
  payment_status: string;
  delivery_status: string;
  total_cents: number;
  quantity: number;
  items_count: number;
}

function newDeliveryToken(): DeliveryToken {
  return { hash: sha256Hex(randomToken()), enc: fakeCiphertextB64('delivery') };
}

/** Marca de todas as linhas que a confirmação de pagamento poderia tocar. */
async function snapshot(orderId: string, productIds: string[]): Promise<Record<string, unknown>> {
  const rows = await runSql<{ state: Record<string, unknown> }>(
    `select jsonb_build_object(
       'order', (
         select to_jsonb(o) from public.orders o where o.id = $1
       ),
       'order_items', (
         select coalesce(jsonb_agg(to_jsonb(i) order by i.id), '[]'::jsonb)
           from public.order_items i where i.order_id = $1
       ),
       'stock_units', (
         select coalesce(jsonb_agg(
                  jsonb_build_object(
                    'id', u.id, 'status', u.status,
                    'sold_order_id', u.sold_order_id, 'sold_at', u.sold_at
                  ) order by u.id), '[]'::jsonb)
           from public.stock_units u where u.product_id = any ($2::uuid[])
       ),
       'reservations', (
         select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]'::jsonb)
           from public.stock_reservations r where r.order_id = $1
       ),
       'reservation_units', (
         select coalesce(jsonb_agg(to_jsonb(ru) order by ru.id), '[]'::jsonb)
           from public.stock_reservation_units ru
           join public.stock_reservations r on r.id = ru.reservation_id
          where r.order_id = $1
       ),
       'payments', (
         select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at, p.id), '[]'::jsonb)
           from public.payments p where p.order_id = $1
       ),
       'events', (
         select coalesce(jsonb_agg(to_jsonb(e) order by e.id), '[]'::jsonb)
           from public.order_events e where e.order_id = $1
       ),
       'deliveries', (
         select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb)
           from public.deliveries d where d.order_id = $1
       ),
       'delivery_units', (
         select coalesce(jsonb_agg(to_jsonb(du) order by du.id), '[]'::jsonb)
           from public.delivery_units du
           join public.deliveries d on d.id = du.delivery_id
          where d.order_id = $1
       ),
       'private_access', jsonb_build_object(
         'client_token_hash', (select o.client_token_hash from public.orders o where o.id = $1),
         'delivery_tokens', (
           select coalesce(jsonb_agg(
                    jsonb_build_object(
                      'token_hash', d.token_hash,
                      'token_enc', encode(d.token_enc, 'hex'),
                      'status', d.status,
                      'view_count', d.view_count
                    ) order by d.id), '[]'::jsonb)
             from public.deliveries d where d.order_id = $1
         )
       )
     ) as state`,
    [orderId, productIds],
  );
  return rows[0].state;
}

/** Solicitação pública sem pagamento (fluxo real: `order-request` → service_role). */
async function createRequest(
  items: Array<{ product_id: string; quantity: number }>,
): Promise<{ order: RequestOrder; tokenHash: string }> {
  const tokenHash = sha256Hex(randomToken());
  const rows = await runAs<{ result: { order: RequestOrder } }>(
    `select public.create_purchase_request($1, 'Maria Souza', 'maria@exemplo.com', $2, null) as result`,
    [JSON.stringify(items), tokenHash],
    { role: 'service_role' },
  );
  return { order: rows[0].result.order, tokenHash };
}

async function attachPayment(orderId: string, providerId: string, totalCents: number): Promise<void> {
  await runAs(
    `select public.attach_payment($1, $2, 'pending', $3, '00020126pix-copia-e-cola', 'iVBORw0KGgo=', null, now() + interval '30 minutes')`,
    [orderId, providerId, totalCents],
    { role: 'service_role' },
  );
}

/**
 * Chama `apply_payment_status` exatamente como o webhook/consulta de status:
 * papel `service_role`, argumentos nomeados iguais aos do PostgREST.
 */
async function applyPayment(
  orderId: string,
  options: {
    status?: string;
    providerId?: string;
    amountCents?: number | null;
    token?: DeliveryToken | null;
    detail?: string | null;
  } = {},
): Promise<PaymentResult> {
  const token = options.token ?? null;
  const rows = await runAs<{ result: PaymentResult }>(
    `select public.apply_payment_status(
       p_order_id => $1,
       p_provider_payment_id => $2,
       p_provider_status => $3,
       p_status_detail => $4,
       p_amount_cents => $5,
       p_delivery_token_hash => $6,
       p_delivery_token_enc_b64 => $7
     ) as result`,
    [
      orderId,
      options.providerId ?? `MP-${randomToken(6)}`,
      options.status ?? 'approved',
      options.detail ?? 'accredited',
      options.amountCents === undefined ? null : options.amountCents,
      token?.hash ?? null,
      token?.enc ?? null,
    ],
    { role: 'service_role' },
  );
  return rows[0].result;
}

async function createMultiOrder(
  items: Array<{ product_id: string; quantity: number }>,
): Promise<{ order: OrderResult; tokenHash: string }> {
  const tokenHash = sha256Hex(randomToken());
  // `create_order_multi` devolve o resumo do pedido diretamente.
  const rows = await runAs<{ result: OrderResult }>(
    `select public.create_order_multi($1, null, $2) as result`,
    [JSON.stringify(items), tokenHash],
    { role: 'service_role' },
  );
  return { order: rows[0].result, tokenHash };
}

describe('guarda de solicitação sem pagamento em apply_payment_status (0037)', () => {
  beforeAll(async () => {
    await resetDatabase();
  }, 120000);

  it('A — aprovação forjada sobre solicitação requested/not_required é ignorada sem alterar nada', async () => {
    const seed = await seedProduct({ priceCents: 5000, maxQuantity: 3, stockUnits: 3 });
    const { order } = await createRequest([{ product_id: seed.productId, quantity: 2 }]);

    expect(order).toMatchObject({
      status: 'requested',
      payment_status: 'not_required',
      delivery_status: 'not_ready',
    });

    const before = await snapshot(order.order_id, [seed.productId]);
    const token = newDeliveryToken();

    const result = await applyPayment(order.order_id, {
      status: 'approved',
      providerId: 'FORGED-APPROVED-1',
      amountCents: order.total_cents,
      token,
    });

    expect(result.result).toBe('ignored_no_payment_required');
    expect(result.order_status).toBe('requested');
    expect(result.payment_status).toBe('not_required');
    expect(result.delivery_status).toBe('not_ready');

    const after = await snapshot(order.order_id, [seed.productId]);
    expect(after).toEqual(before);

    // Nada de venda, estoque, reserva, pagamento, evento ou entrega.
    expect(after.order).toMatchObject({
      status: 'requested',
      payment_status: 'not_required',
      delivery_status: 'not_ready',
      paid_at: null,
    });
    expect((after.stock_units as unknown[]).length).toBe(3);
    expect(after.stock_units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'available', sold_order_id: null, sold_at: null }),
      ]),
    );
    expect(after.reservations).toEqual([]);
    expect(after.payments).toEqual([]);
    expect(after.deliveries).toEqual([]);
    expect((after.private_access as { delivery_tokens: unknown[] }).delivery_tokens).toEqual([]);

    // O token de entrega forjado não abre nada.
    const [resolved] = await runSql<{ blocked: boolean }>(
      `select not exists (
         select 1 from public.deliveries where token_hash = $1
       ) as blocked`,
      [token.hash],
    );
    expect(resolved.blocked).toBe(true);

    // Acompanhamento público continua relatando a solicitação, não uma venda.
    const [status] = await runAs<{ result: { status: string; payment_status: string; delivery: unknown } }>(
      `select public.get_order_status($1, $2) as result`,
      [order.order_id, (before.order as { client_token_hash: string }).client_token_hash],
      { role: 'service_role' },
    );
    expect(status.result.status).toBe('requested');
    expect(status.result.payment_status).toBe('not_required');
    expect(status.result.delivery).toBeNull();
  }, 60000);

  it('B — tentativas repetidas continuam ignoradas', async () => {
    const seed = await seedProduct({ priceCents: 3500, maxQuantity: 2, stockUnits: 2 });
    const { order } = await createRequest([{ product_id: seed.productId, quantity: 1 }]);

    const before = await snapshot(order.order_id, [seed.productId]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await applyPayment(order.order_id, {
        status: 'approved',
        providerId: `FORGED-REPEAT-${attempt}`,
        amountCents: order.total_cents,
        token: newDeliveryToken(),
      });
      expect(result.result).toBe('ignored_no_payment_required');
      expect(await snapshot(order.order_id, [seed.productId])).toEqual(before);
    }
  }, 60000);

  it('C — marcador isolado `status = requested` bloqueia mesmo com cobrança real pendente', async () => {
    const seed = await seedProduct({ priceCents: 4200, maxQuantity: 2, stockUnits: 2 });
    const { order } = await createOrder(seed.productId, 1);
    await attachPayment(order.order_id, 'MP-ISOLATED-REQUESTED', order.total_cents);

    // Força apenas o marcador de estado, mantendo pagamento e reserva legítimos.
    await runSql(`update public.orders set status = 'requested' where id = $1`, [order.order_id]);

    const before = await snapshot(order.order_id, [seed.productId]);
    const result = await applyPayment(order.order_id, {
      status: 'approved',
      providerId: 'MP-ISOLATED-REQUESTED',
      amountCents: order.total_cents,
      token: newDeliveryToken(),
    });

    expect(result.result).toBe('ignored_no_payment_required');
    expect(await snapshot(order.order_id, [seed.productId])).toEqual(before);
    expect(await sqlValue<number>(
      `select count(*)::int from public.stock_units where product_id = $1 and status = 'sold'`,
      [seed.productId],
    )).toBe(0);
  }, 60000);

  it('D — marcador isolado `payment_status = not_required` bloqueia mesmo em pedido pending_payment', async () => {
    const seed = await seedProduct({ priceCents: 2700, maxQuantity: 2, stockUnits: 2 });
    const { order } = await createOrder(seed.productId, 1);
    await attachPayment(order.order_id, 'MP-ISOLATED-NOTREQ', order.total_cents);

    await runSql(`update public.orders set payment_status = 'not_required' where id = $1`, [
      order.order_id,
    ]);

    const before = await snapshot(order.order_id, [seed.productId]);
    const result = await applyPayment(order.order_id, {
      status: 'approved',
      providerId: 'MP-ISOLATED-NOTREQ',
      amountCents: order.total_cents,
      token: newDeliveryToken(),
    });

    expect(result.result).toBe('ignored_no_payment_required');
    expect(await snapshot(order.order_id, [seed.productId])).toEqual(before);

    // A unidade continua reservada, não vendida, e não há entrega.
    const [state] = await runSql<{ reserved: number; sold: number; deliveries: number }>(
      `select
         (select count(*)::int from public.stock_units where product_id = $1 and status = 'reserved') as reserved,
         (select count(*)::int from public.stock_units where product_id = $1 and status = 'sold') as sold,
         (select count(*)::int from public.deliveries where order_id = $2) as deliveries`,
      [seed.productId, order.order_id],
    );
    expect(state).toEqual({ reserved: 1, sold: 0, deliveries: 0 });
  }, 60000);

  it('E — nenhum estado do provedor (nem divergência de valor) altera a solicitação', async () => {
    const seed = await seedProduct({ priceCents: 6000, maxQuantity: 3, stockUnits: 3 });
    const { order } = await createRequest([{ product_id: seed.productId, quantity: 2 }]);

    const before = await snapshot(order.order_id, [seed.productId]);

    const statuses = [
      'approved',
      'pending',
      'in_process',
      'rejected',
      'cancelled',
      'refunded',
      'charged_back',
      'expired',
      'qualquer_coisa',
    ];

    for (const providerStatus of statuses) {
      const result = await applyPayment(order.order_id, {
        status: providerStatus,
        providerId: `FORGED-${providerStatus}`,
        amountCents: order.total_cents,
        token: newDeliveryToken(),
      });
      expect(result.result, `status do provedor: ${providerStatus}`).toBe(
        'ignored_no_payment_required',
      );
    }

    // Divergência de valor: a guarda vem antes da checagem financeira.
    const mismatch = await applyPayment(order.order_id, {
      status: 'approved',
      providerId: 'FORGED-MISMATCH',
      amountCents: order.total_cents - 1,
      token: newDeliveryToken(),
    });
    expect(mismatch.result).toBe('ignored_no_payment_required');

    expect(await snapshot(order.order_id, [seed.productId])).toEqual(before);
    expect(await sqlValue<number>(
      `select count(*)::int from public.refund_requests where order_id = $1`,
      [order.order_id],
    )).toBe(0);
  }, 60000);

  it('F — venda legítima de um produto continua funcionando (aprovação + entrega + idempotência)', async () => {
    const seed = await seedProduct({ priceCents: 4900, maxQuantity: 1, stockUnits: 2 });
    const { order } = await createOrder(seed.productId, 1);
    await attachPayment(order.order_id, 'MP-LEGIT-1', order.total_cents);

    const token = newDeliveryToken();
    const result = await applyPayment(order.order_id, {
      status: 'approved',
      providerId: 'MP-LEGIT-1',
      amountCents: order.total_cents,
      token,
    });

    expect(result.result).toBe('approved');
    expect(result.order_status).toBe('paid');
    expect(result.payment_status).toBe('approved');
    expect(result.delivery_status).toBe('ready');

    const [state] = await runSql<Record<string, unknown>>(
      `select o.status, o.payment_status, o.delivery_status, o.paid_at is not null as paid,
              (select count(*)::int from public.stock_units where product_id = $2 and status = 'sold') as sold,
              (select count(*)::int from public.deliveries where order_id = $1) as deliveries,
              (select count(*)::int from public.payments where order_id = $1) as payments
         from public.orders o where o.id = $1`,
      [order.order_id, seed.productId],
    );
    expect(state).toMatchObject({
      status: 'paid',
      payment_status: 'approved',
      delivery_status: 'ready',
      paid: true,
      sold: 1,
      deliveries: 1,
      payments: 1,
    });

    // A entrega legítima abre normalmente.
    const [delivery] = await runSql<{ result: Record<string, unknown> }>(
      `select public.resolve_delivery($1) as result`,
      [token.hash],
    );
    expect(delivery.result).toBeTruthy();

    // Aprovação repetida: idempotente, sem segunda entrega nem segundo pagamento.
    const repeated = await applyPayment(order.order_id, {
      status: 'approved',
      providerId: 'MP-LEGIT-1',
      amountCents: order.total_cents,
      token: newDeliveryToken(),
    });
    expect(repeated.result).toBe('already_applied');
    expect(await sqlValue<number>(
      `select count(*)::int from public.deliveries where order_id = $1`,
      [order.order_id],
    )).toBe(1);
  }, 60000);

  it('G — venda legítima multi-produto continua funcionando', async () => {
    const first = await seedProduct({ priceCents: 1990, maxQuantity: 2, stockUnits: 2 });
    const second = await seedProduct({ priceCents: 2590, maxQuantity: 2, stockUnits: 2 });
    const { order } = await createMultiOrder([
      { product_id: first.productId, quantity: 1 },
      { product_id: second.productId, quantity: 2 },
    ]);
    await attachPayment(order.order_id, 'MP-LEGIT-MULTI', order.total_cents);

    const result = await applyPayment(order.order_id, {
      status: 'approved',
      providerId: 'MP-LEGIT-MULTI',
      amountCents: order.total_cents,
      token: newDeliveryToken(),
    });

    expect(result.result).toBe('approved');

    const [state] = await runSql<Record<string, unknown>>(
      `select o.status, o.delivery_status,
              (select count(*)::int from public.stock_units where product_id in ($2, $3) and status = 'sold') as sold,
              (select count(*)::int from public.delivery_units du
                 join public.deliveries d on d.id = du.delivery_id
                where d.order_id = $1) as delivery_units,
              (select count(*)::int from public.order_items where order_id = $1) as items
         from public.orders o where o.id = $1`,
      [order.order_id, first.productId, second.productId],
    );
    expect(state).toMatchObject({ status: 'paid', delivery_status: 'ready', sold: 3, delivery_units: 3, items: 2 });
  }, 60000);

  it('H — recusa, reembolso e estorno de vendas legítimas continuam funcionando', async () => {
    // Recusa: devolve o estoque e encerra o pedido.
    const rejectedSeed = await seedProduct({ priceCents: 3000, maxQuantity: 1, stockUnits: 1 });
    const { order: rejectedOrder } = await createOrder(rejectedSeed.productId, 1);
    await attachPayment(rejectedOrder.order_id, 'MP-REJECT', rejectedOrder.total_cents);

    const rejected = await applyPayment(rejectedOrder.order_id, {
      status: 'rejected',
      providerId: 'MP-REJECT',
      amountCents: rejectedOrder.total_cents,
      detail: 'cc_rejected_other_reason',
    });
    expect(rejected.result).toBe('rejected');
    const [rejectedState] = await runSql<{ status: string; available: number }>(
      `select o.status,
              (select count(*)::int from public.stock_units where product_id = $2 and status = 'available') as available
         from public.orders o where o.id = $1`,
      [rejectedOrder.order_id, rejectedSeed.productId],
    );
    expect(rejectedState).toEqual({ status: 'failed', available: 1 });

    // Reembolso de venda paga: revoga a entrega.
    const paidSeed = await seedProduct({ priceCents: 5100, maxQuantity: 1, stockUnits: 1 });
    const { order: paidOrder } = await createOrder(paidSeed.productId, 1);
    await attachPayment(paidOrder.order_id, 'MP-REFUND', paidOrder.total_cents);
    const deliveryToken = newDeliveryToken();
    const approved = await applyPayment(paidOrder.order_id, {
      status: 'approved',
      providerId: 'MP-REFUND',
      amountCents: paidOrder.total_cents,
      token: deliveryToken,
    });
    expect(approved.result).toBe('approved');

    const refunded = await applyPayment(paidOrder.order_id, {
      status: 'refunded',
      providerId: 'MP-REFUND',
      amountCents: paidOrder.total_cents,
    });
    expect(refunded.result).toBe('refunded');
    expect(await sqlValue<string>(
      `select status from public.deliveries where order_id = $1`,
      [paidOrder.order_id],
    )).toBe('revoked');
    await expect(
      runSql(`select public.resolve_delivery($1)`, [deliveryToken.hash]),
    ).rejects.toMatchObject({ code: 'P0002' });

    // Estorno/chargeback posterior: registra contestação sem reabrir a entrega.
    const chargedBack = await applyPayment(paidOrder.order_id, {
      status: 'charged_back',
      providerId: 'MP-REFUND',
      amountCents: paidOrder.total_cents,
    });
    expect(chargedBack.result).toBe('charged_back');
    expect(chargedBack.order_status).toBe('refunded');
    expect(await sqlValue<string>(
      `select status from public.deliveries where order_id = $1`,
      [paidOrder.order_id],
    )).toBe('revoked');
  }, 60000);

  it('I — checkout público sem pagamento permanece inalterado (sem reserva, sem cobrança)', async () => {
    const seed = await seedProduct({ priceCents: 8900, maxQuantity: 2, stockUnits: 2 });

    const { order } = await createRequest([{ product_id: seed.productId, quantity: 2 }]);
    expect(order).toMatchObject({
      status: 'requested',
      payment_status: 'not_required',
      delivery_status: 'not_ready',
    });

    // Quantidade acima do estoque disponível continua recusada.
    const scarce = await seedProduct({ priceCents: 1500, maxQuantity: 2, stockUnits: 1 });
    await expect(
      createRequest([{ product_id: scarce.productId, quantity: 2 }]),
    ).rejects.toMatchObject({ message: expect.stringContaining('insufficient_stock') });

    const [state] = await runSql<Record<string, unknown>>(
      `select
         (select count(*)::int from public.stock_units where product_id = $1 and status = 'available') as available,
         (select count(*)::int from public.stock_units where product_id = $1 and status = 'reserved') as reserved,
         (select count(*)::int from public.stock_reservations where order_id = $2) as request_reservations,
         (select count(*)::int from public.payments where order_id = $2) as request_payments,
         (select count(*)::int from public.deliveries where order_id = $2) as request_deliveries`,
      [seed.productId, order.order_id],
    );
    expect(state).toMatchObject({
      available: 2,
      reserved: 0,
      request_reservations: 0,
      request_payments: 0,
      request_deliveries: 0,
    });
  }, 60000);
});
