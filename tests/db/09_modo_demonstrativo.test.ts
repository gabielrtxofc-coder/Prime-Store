import { beforeAll, describe, expect, it } from 'vitest';
import {
  createOrder,
  fakeCiphertextB64,
  hmacHex,
  randomToken,
  resetDatabase,
  runSql,
  seedProduct,
  sha256Hex,
  sqlValue,
} from './helpers';

interface PgError extends Error {
  code?: string;
  detail?: string;
}

/**
 * Missão 05 — verificação das migrações 0026..0029 (modo demonstrativo).
 *
 * Garante que a aprovação simulada:
 *   - nasce DESLIGADA e só responde quando a chave `demo_payments_enabled` é ligada;
 *   - nunca é executável por `anon`/`authenticated` (só `service_role`);
 *   - exige prova de posse, reserva válida e produto/unidades `is_demo`;
 *   - reutiliza o fluxo real (`apply_payment_status`), registrando `provider = 'demo'`.
 */
async function enableDemoMode(): Promise<void> {
  await runSql(`update public.app_settings set value = 'true'::jsonb where key = 'demo_payments_enabled'`);
}

async function disableDemoMode(): Promise<void> {
  await runSql(`update public.app_settings set value = 'false'::jsonb where key = 'demo_payments_enabled'`);
}

async function markDemoProduct(productId: string): Promise<void> {
  await runSql(`update public.products set is_demo = true where id = $1`, [productId]);
  await runSql(`update public.stock_units set is_demo = true where product_id = $1`, [productId]);
}

async function demoApprove(
  orderId: string,
  tokenHash: string,
  options: { deliveryHash?: string | null } = {},
): Promise<Record<string, unknown>> {
  const rows = await runSql<{ result: Record<string, unknown> }>(
    `select public.demo_approve_payment($1, $2, $3, $4) as result`,
    [
      orderId,
      tokenHash,
      options.deliveryHash ?? sha256Hex(randomToken()),
      fakeCiphertextB64('delivery-token'),
    ],
  );
  return rows[0].result;
}

describe('modo demonstrativo (migrações 0026 a 0029)', () => {
  beforeAll(async () => {
    await resetDatabase();
  }, 60000);

  it('nasce desligado e recusa a aprovação simulada antes de qualquer ativação', async () => {
    const enabled = await sqlValue<boolean>(`select public.demo_payments_enabled()`);
    expect(enabled).toBe(false);

    const seed = await seedProduct({ stockUnits: 1 });
    await markDemoProduct(seed.productId);
    const { order, tokenHash } = await createOrder(seed.productId, 1);

    await expect(demoApprove(order.order_id, tokenHash)).rejects.toMatchObject({ code: 'P0001' });

    const stillPending = await sqlValue<string>(`select status from public.orders where id = $1`, [
      order.order_id,
    ]);
    expect(stillPending).toBe('pending_payment');
  });

  it('não concede execução de demo_approve_payment/demo_seed_stock a anon ou authenticated', async () => {
    const privileges = await runSql<{
      approve_anon: boolean;
      approve_authenticated: boolean;
      approve_service: boolean;
      seed_anon: boolean;
      seed_authenticated: boolean;
      seed_service: boolean;
    }>(
      `select
         has_function_privilege('anon', 'public.demo_approve_payment(uuid,text,text,text)', 'EXECUTE') as approve_anon,
         has_function_privilege('authenticated', 'public.demo_approve_payment(uuid,text,text,text)', 'EXECUTE') as approve_authenticated,
         has_function_privilege('service_role', 'public.demo_approve_payment(uuid,text,text,text)', 'EXECUTE') as approve_service,
         has_function_privilege('anon', 'public.demo_seed_stock(uuid,jsonb)', 'EXECUTE') as seed_anon,
         has_function_privilege('authenticated', 'public.demo_seed_stock(uuid,jsonb)', 'EXECUTE') as seed_authenticated,
         has_function_privilege('service_role', 'public.demo_seed_stock(uuid,jsonb)', 'EXECUTE') as seed_service`,
    );

    expect(privileges[0]).toEqual({
      approve_anon: false,
      approve_authenticated: false,
      approve_service: true,
      seed_anon: false,
      seed_authenticated: false,
      seed_service: true,
    });
  });

  it('aprova somente com prova de posse, produto e unidades is_demo, reutilizando o fluxo real', async () => {
    await enableDemoMode();
    const seed = await seedProduct({ stockUnits: 2, maxQuantity: 2 });
    await markDemoProduct(seed.productId);
    const { order, tokenHash } = await createOrder(seed.productId, 1);

    const result = await demoApprove(order.order_id, tokenHash);
    expect(result).toMatchObject({ demo: true, result: 'approved', order_status: 'paid' });

    const state = await runSql<{
      order_status: string;
      payment_status: string;
      delivery_status: string;
      provider: string;
      provider_payment_id: string;
      delivery_state: string;
      reservation_state: string;
      sold_units: number;
      audit_events: number;
    }>(
      `select o.status as order_status,
              o.payment_status,
              o.delivery_status,
              p.provider,
              p.provider_payment_id,
              d.status as delivery_state,
              r.status as reservation_state,
              (select count(*) from public.stock_units s
                where s.sold_order_id = o.id and s.status = 'sold' and s.is_demo) as sold_units,
              (select count(*) from public.order_events e
                where e.order_id = o.id and e.event_type = 'demo_payment_approved') as audit_events
         from public.orders o
         join public.payments p on p.order_id = o.id
         join public.deliveries d on d.order_id = o.id
         join public.stock_reservations r on r.order_id = o.id
        where o.id = $1`,
      [order.order_id],
    );

    expect(state[0].order_status).toBe('paid');
    expect(state[0].payment_status).toBe('approved');
    expect(state[0].provider).toBe('demo');
    expect(state[0].provider_payment_id).toBe(`DEMO-${order.reference}`);
    expect(state[0].delivery_state).toBe('active');
    expect(state[0].reservation_state).toBe('consumed');
    expect(Number(state[0].sold_units)).toBe(1);
    expect(Number(state[0].audit_events)).toBe(1);

    // Nenhum evento do Mercado Pago é criado pelo caminho simulado.
    const paymentEvents = await sqlValue<number>(
      `select count(*) from public.payment_events where provider = 'mercado_pago'`,
    );
    expect(Number(paymentEvents)).toBe(0);
  });

  it('exige o token privado do pedido (sem prova de posse não há aprovação)', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    await markDemoProduct(seed.productId);
    const { order } = await createOrder(seed.productId, 1);

    await expect(demoApprove(order.order_id, sha256Hex(randomToken()))).rejects.toMatchObject({
      code: 'P0002',
    });
  });

  it('recusa produto que não é de demonstração', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    const { order, tokenHash } = await createOrder(seed.productId, 1);

    await expect(demoApprove(order.order_id, tokenHash)).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('demo_not_allowed'),
    });
  });

  it('bloqueia aprovação quando alguma unidade reservada é real (credencial de verdade)', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    await runSql(`update public.products set is_demo = true where id = $1`, [seed.productId]);
    const { order, tokenHash } = await createOrder(seed.productId, 1);

    // A unidade permanece com is_demo = false: simulação não entrega credencial real.
    await expect(demoApprove(order.order_id, tokenHash)).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('demo_real_stock_blocked'),
    });
  });

  it('recusa reserva vencida e devolve as unidades ao estoque', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    await markDemoProduct(seed.productId);
    const { order, tokenHash } = await createOrder(seed.productId, 1);

    // Simula o relógio: pedido e reserva vencidos (30 minutos já passaram).
    await runSql(
      `update public.orders set reservation_expires_at = now() - interval '1 minute' where id = $1`,
      [order.order_id],
    );
    await runSql(
      `update public.stock_reservations
          set starts_at = now() - interval '31 minutes',
              expires_at = now() - interval '1 minute'
        where order_id = $1`,
      [order.order_id],
    );

    await expect(demoApprove(order.order_id, tokenHash)).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('demo_reservation_expired'),
    });

    // A exceção desfaz a própria transação: quem devolve as unidades é o
    // processo de expiração, executado de forma independente.
    await runSql(`select public.expire_overdue_reservations($1)`, [seed.productId]);

    const after = await runSql<{ order_status: string; reservation_state: string; available: number }>(
      `select o.status as order_status,
              r.status as reservation_state,
              (select count(*) from public.stock_units s
                where s.product_id = o.product_id and s.status = 'available') as available
         from public.orders o
         join public.stock_reservations r on r.order_id = o.id
        where o.id = $1`,
      [order.order_id],
    );
    expect(after[0].order_status).toBe('expired');
    expect(after[0].reservation_state).toBe('expired');
    expect(Number(after[0].available)).toBe(1);

    // Pedido expirado não é pagável em modo de demonstração.
    await expect(demoApprove(order.order_id, tokenHash)).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('demo_order_not_payable'),
    });
  });

  it('não permite aprovar duas vezes o mesmo pedido', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    await markDemoProduct(seed.productId);
    const { order, tokenHash } = await createOrder(seed.productId, 1);

    await demoApprove(order.order_id, tokenHash);
    await expect(demoApprove(order.order_id, tokenHash)).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('demo_order_not_payable'),
    });
  });

  it('desliga novamente assim que a chave volta a false', async () => {
    await disableDemoMode();
    const seed = await seedProduct({ stockUnits: 1 });
    await markDemoProduct(seed.productId);
    const { order, tokenHash } = await createOrder(seed.productId, 1);

    await expect(demoApprove(order.order_id, tokenHash)).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('demo_disabled'),
    });
    await enableDemoMode();
  });

  it('semeadura fictícia só aceita produto is_demo e respeita o limite de unidades', async () => {
    const demoSeed = await seedProduct({ stockUnits: 0 });
    await runSql(`update public.products set is_demo = true where id = $1`, [demoSeed.productId]);

    const makeUnit = (index: number) => ({
      email_enc_b64: fakeCiphertextB64(`demo${index}@prime-store.test`),
      password_enc_b64: fakeCiphertextB64(`Demo-12345${index}`),
      fingerprint: hmacHex('test-fingerprint-key', `demo${index}@prime-store.test:Demo-12345${index}`),
      notes: 'Credencial fictícia de demonstração',
    });
    const unit = makeUnit(0);

    const seeded = await runSql<{ result: { created: number } }>(
      `select public.demo_seed_stock($1, $2::jsonb) as result`,
      [demoSeed.productId, JSON.stringify([makeUnit(1), makeUnit(2), makeUnit(3)])],
    );
    expect(seeded[0].result.created).toBe(3);

    const flagged = await sqlValue<number>(
      `select count(*) from public.stock_units where product_id = $1 and is_demo`,
      [demoSeed.productId],
    );
    expect(Number(flagged)).toBe(3);

    const realProduct = await seedProduct({ stockUnits: 0 });
    await expect(
      runSql(`select public.demo_seed_stock($1, $2::jsonb) as result`, [
        realProduct.productId,
        JSON.stringify([unit]),
      ]),
    ).rejects.toMatchObject({ code: 'P0001', message: expect.stringContaining('demo_not_allowed') });

    const tooMany = Array.from({ length: 18 }, (_, index) => makeUnit(index + 10));
    await expect(
      runSql(`select public.demo_seed_stock($1, $2::jsonb) as result`, [
        demoSeed.productId,
        JSON.stringify(tooMany),
      ]),
    ).rejects.toMatchObject({ code: 'P0001', message: expect.stringContaining('demo_seed_limit') });
  });
});
