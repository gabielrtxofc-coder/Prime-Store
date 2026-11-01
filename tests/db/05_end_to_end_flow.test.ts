import { beforeAll, describe, expect, it } from 'vitest';
import {
  credentialFingerprint,
  encryptText,
  loadSecretMaterial,
  randomToken,
  sha256Hex,
  toBase64,
} from '../../supabase/functions/_shared/crypto';
import { handleCreateOrder } from '../../supabase/functions/_shared/handlers/createOrder';
import { handleDelivery } from '../../supabase/functions/_shared/handlers/delivery';
import { handleOrderStatus } from '../../supabase/functions/_shared/handlers/orderStatus';
import { handleMpWebhook } from '../../supabase/functions/_shared/handlers/mpWebhook';
import { handleAdminApi } from '../../supabase/functions/_shared/handlers/adminApi';
import type { Deps } from '../../supabase/functions/_shared/deps';
import { createFakeMercadoPago } from '../unit/fakeMp';
import { connect, resetDatabase, runSql, seedAdmin, sqlValue } from './helpers';
import { createPgRpc } from './pgRpc';
import type { Client } from 'pg';

const MASTER_KEY = toBase64(crypto.getRandomValues(new Uint8Array(32)));

async function seedProductWithRealCredentials(
  masterKey: string,
  total: number,
): Promise<{ productId: string; credentials: Array<{ email: string; password: string }> }> {
  const material = await loadSecretMaterial(masterKey);
  const products = await runSql<{ id: string }>(
    `insert into public.products (slug, name, category_id, price_cents, cost_cents, instructions, max_quantity_per_order)
     values ($1, 'Produto E2E', 'creative', 4990, 1500, 'Entre com o login e a senha entregues.', 2)
     returning id`,
    [`e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`],
  );
  const productId = products[0].id;
  const credentials: Array<{ email: string; password: string }> = [];

  for (let index = 0; index < total; index += 1) {
    const email = `e2e${index}@exemplo.com`;
    const password = `senha-secreta-${index}`;
    await runSql(
      `insert into public.stock_units (product_id, account_email_enc, account_password_enc, credential_fingerprint)
       values ($1, decode($2, 'base64'), decode($3, 'base64'), $4)`,
      [
        productId,
        toBase64(await encryptText(material.encryptionKey, email)),
        toBase64(await encryptText(material.encryptionKey, password)),
        await credentialFingerprint(material, email, password),
      ],
    );
    credentials.push({ email, password });
  }

  return { productId, credentials };
}

function buildDeps(
  client: Client,
  fetchImpl: typeof fetch,
  overrides: Partial<Deps['config']> = {},
  userRpc?: Deps['rpc'],
): Deps {
  const rpc = createPgRpc(client);
  return {
    config: {
      supabaseUrl: 'https://fake-project.supabase.test',
      serviceRoleKey: 'service-role-key',
      anonKey: 'anon-key',
      mercadoPagoAccessToken: 'TEST-access-token',
      mercadoPagoWebhookSecret: 'webhook-secret',
      mercadoPagoApiBase: 'https://api.mercadopago.test',
      encryptionKey: MASTER_KEY,
      storeUrl: 'http://localhost:5173',
      paymentNotificationUrl: 'https://fake-project.supabase.test/functions/v1/mp-webhook',
      ...overrides,
    },
    rpc: userRpc ?? rpc,
    rpcForUser: () => userRpc ?? rpc,
    serviceRpc: rpc,
    resolveEncryptionKey: async () => overrides.encryptionKey ?? MASTER_KEY,
    fetchImpl,
    now: () => new Date(),
    log: () => undefined,
  };
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('fluxo completo (Edge Function + PostgreSQL real + Mercado Pago simulado)', () => {
  let client: Client;
  let seed: { productId: string; credentials: Array<{ email: string; password: string }> };
  let mp: ReturnType<typeof createFakeMercadoPago>;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
    seed = await seedProductWithRealCredentials(MASTER_KEY, 2);
    mp = createFakeMercadoPago();
  }, 60000);

  it('cria pedido pelo catálogo até a entrega privada', async () => {
    const deps = buildDeps(client, mp.fetchImpl);

    // 1. Catálogo público não expõe custo nem credenciais.
    const catalog = await deps.rpc<Array<{ id: string; price_cents: number }>>('get_catalog');
    const catalogBody = JSON.stringify(catalog);
    expect(catalogBody).not.toContain('cost_cents');
    expect(catalogBody).not.toContain('exemplo.com');

    // 2. Cliente cria o pedido informando apenas produto e quantidade.
    const createResponse = await handleCreateOrder(
      postJson('https://fn.test/create-order', {
        product_id: seed.productId,
        quantity: 2,
        payer_email: 'comprador@teste.com',
        idempotency_key: 'checkout-e2e-0001',
      }),
      deps,
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      order: { order_id: string; total_cents: number; status: string };
      client_token: string;
      payment: { qr_code: string; qr_code_base64: string };
    };
    expect(created.order.total_cents).toBe(9980);
    expect(created.payment.qr_code).toContain('00020126FAKEPIX');
    expect(created.client_token.length).toBeGreaterThan(40);

    // O e-mail do comprador foi encaminhado ao provedor, mas não foi gravado.
    const stored = await runSql<{ count: string }>(
      `select count(*)::text as count from public.payments where provider_snapshot::text ilike '%comprador@teste.com%'`,
    );
    expect(stored[0].count).toBe('0');

    // 3. Consulta do estado pelo comprador.
    const statusResponse = await handleOrderStatus(
      postJson('https://fn.test/order-status', {
        order_id: created.order.order_id,
        client_token: created.client_token,
      }),
      deps,
    );
    const statusBody = (await statusResponse.json()) as {
      status: string;
      payment: { status: string; qr_code: string };
      delivery: unknown;
    };
    expect(statusResponse.status).toBe(200);
    expect(statusBody.status).toBe('pending_payment');
    expect(statusBody.payment.qr_code).toContain('FAKEPIX');
    expect(statusBody.delivery).toBeNull();

    // 4. Mercado Pago aprova e envia a notificação (payment id real do fake).
    const paymentId = mp.lastPayment?.id as string;
    mp.setStatus('approved');

    const webhookResponse = await handleMpWebhook(
      postJson(
        'https://fn.test/mp-webhook?data.id=' + paymentId,
        { id: 'notif-e2e-1', type: 'payment', action: 'payment.updated', data: { id: paymentId } },
        { 'x-request-id': 'req-e2e-1' },
      ),
      buildDeps(client, mp.fetchImpl, { mercadoPagoWebhookSecret: null }),
    );
    expect(webhookResponse.status).toBe(200);
    const webhookBody = (await webhookResponse.json()) as { result: string };
    expect(webhookBody.result).toBe('approved');

    const orderRow = await runSql<{ status: string; payment_status: string; delivery_status: string }>(
      `select status, payment_status, delivery_status from public.orders where id = $1`,
      [created.order.order_id],
    );
    expect(orderRow[0]).toMatchObject({
      status: 'paid',
      payment_status: 'approved',
      delivery_status: 'ready',
    });

    const sold = await sqlValue<number>(
      `select count(*) from public.stock_units where sold_order_id = $1`,
      [created.order.order_id],
    );
    expect(Number(sold)).toBe(2);

    // 5. Notificação repetida não duplica venda nem entrega.
    const duplicateResponse = await handleMpWebhook(
      postJson(
        'https://fn.test/mp-webhook?data.id=' + paymentId,
        { id: 'notif-e2e-1', type: 'payment', action: 'payment.updated', data: { id: paymentId } },
        { 'x-request-id': 'req-e2e-1' },
      ),
      buildDeps(client, mp.fetchImpl, { mercadoPagoWebhookSecret: null }),
    );
    expect((await duplicateResponse.json()) as { duplicate: boolean }).toMatchObject({ duplicate: true });

    const deliveries = await sqlValue<number>(
      `select count(*) from public.deliveries where order_id = $1`,
      [created.order.order_id],
    );
    expect(Number(deliveries)).toBe(1);

    // 6. Comprador reabre o pedido e recebe o link privado.
    const paidStatus = await handleOrderStatus(
      postJson('https://fn.test/order-status', {
        order_id: created.order.order_id,
        client_token: created.client_token,
      }),
      deps,
    );
    const paidBody = (await paidStatus.json()) as {
      status: string;
      delivery: { url: string; status: string };
    };
    expect(paidBody.status).toBe('paid');
    expect(paidBody.delivery.status).toBe('active');
    expect(paidBody.delivery.url).toContain('/entrega/');

    const token = decodeURIComponent(paidBody.delivery.url.split('/entrega/')[1]);

    // 7. Entrega devolve as credenciais corretas e decifradas.
    const deliveryResponse = await handleDelivery(
      postJson('https://fn.test/delivery', { token }),
      deps,
    );
    expect(deliveryResponse.status).toBe(200);
    const deliveryBody = (await deliveryResponse.json()) as {
      reference: string;
      units: Array<{ email: string; password: string }>;
      product: { instructions: string };
    };
    expect(deliveryBody.units).toHaveLength(2);
    expect(deliveryBody.units.map((unit) => unit.email).sort()).toEqual(
      seed.credentials.map((credential) => credential.email).sort(),
    );
    expect(deliveryBody.product.instructions).toContain('login');
    expect(JSON.stringify(deliveryBody)).not.toContain('email_enc');
    expect(JSON.stringify(deliveryBody)).not.toContain('password_enc');

    // 8. Consulta repetida continua funcionando (link persistente).
    const secondRead = await handleDelivery(
      postJson('https://fn.test/delivery', { token }),
      deps,
    );
    expect(secondRead.status).toBe(200);
    const views = await sqlValue<number>(
      `select view_count from public.deliveries where order_id = $1`,
      [created.order.order_id],
    );
    expect(Number(views)).toBeGreaterThanOrEqual(2);

    // 9. Token inválido não encontra nada.
    const invalid = await handleDelivery(
      postJson('https://fn.test/delivery', { token: randomToken(32) }),
      deps,
    );
    expect(invalid.status).toBe(404);
  });

  it('libera o estoque quando o Mercado Pago está indisponível', async () => {
    const failing = createFakeMercadoPago({ failCreate: true });
    const deps = buildDeps(client, failing.fetchImpl);

    const product = await seedProductWithRealCredentials(MASTER_KEY, 1);
    const response = await handleCreateOrder(
      postJson('https://fn.test/create-order', {
        product_id: product.productId,
        quantity: 1,
        payer_email: 'comprador@teste.com',
      }),
      deps,
    );

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('payment_provider_unavailable');

    const remains = await runSql<{ status: string }>(
      `select status from public.stock_units where product_id = $1`,
      [product.productId],
    );
    expect(remains[0].status).toBe('available');

    const orderStatus = await runSql<{ status: string }>(
      `select status from public.orders where product_id = $1`,
      [product.productId],
    );
    expect(orderStatus[0].status).toBe('failed');
  });

  it('recusa checkout quando o Mercado Pago não está configurado', async () => {
    const deps = buildDeps(client, mp.fetchImpl, { mercadoPagoAccessToken: null });
    const product = await seedProductWithRealCredentials(MASTER_KEY, 1);

    const response = await handleCreateOrder(
      postJson('https://fn.test/create-order', {
        product_id: product.productId,
        quantity: 1,
        payer_email: 'comprador@teste.com',
      }),
      deps,
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe('payment_not_configured');
  });

  it('rejeita quantidade e payload inválidos antes de tocar no estoque', async () => {
    const deps = buildDeps(client, mp.fetchImpl);
    const product = await seedProductWithRealCredentials(MASTER_KEY, 1);

    const invalidQuantity = await handleCreateOrder(
      postJson('https://fn.test/create-order', {
        product_id: product.productId,
        quantity: 0,
        payer_email: 'comprador@teste.com',
      }),
      deps,
    );
    expect(invalidQuantity.status).toBe(422);

    const invalidEmail = await handleCreateOrder(
      postJson('https://fn.test/create-order', {
        product_id: product.productId,
        quantity: 1,
        payer_email: 'invalido',
      }),
      deps,
    );
    expect(invalidEmail.status).toBe(422);

    const reserved = await sqlValue<number>(
      `select count(*) from public.stock_units where product_id = $1 and status = 'reserved'`,
      [product.productId],
    );
    expect(Number(reserved)).toBe(0);
  });

  it('webhook com assinatura inválida é rejeitado e não altera o pedido', async () => {
    const deps = buildDeps(client, mp.fetchImpl);
    const product = await seedProductWithRealCredentials(MASTER_KEY, 1);
    const created = await handleCreateOrder(
      postJson('https://fn.test/create-order', {
        product_id: product.productId,
        quantity: 1,
        payer_email: 'comprador@teste.com',
      }),
      deps,
    );
    const createdBody = (await created.json()) as { order: { order_id: string } };
    const paymentId = mp.lastPayment?.id as string;
    mp.setStatus('approved');

    const response = await handleMpWebhook(
      postJson(
        'https://fn.test/mp-webhook',
        { id: 'notif-bad-signature', type: 'payment', data: { id: paymentId } },
        { 'x-signature': 'ts=1,v1=deadbeef', 'x-request-id': 'req-bad' },
      ),
      deps,
    );
    expect(response.status).toBe(401);

    const row = await runSql<{ status: string }>(
      `select status from public.orders where id = $1`,
      [createdBody.order.order_id],
    );
    expect(row[0].status).toBe('pending_payment');
  });

  it('admin passa por autenticação, allowlist e MFA antes de tocar no estoque', async () => {
    const adminId = await seedAdmin('owner');
    const product = await seedProductWithRealCredentials(MASTER_KEY, 1);

    const fakeAuth = (userId: string | null) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/auth/v1/user')) {
          return userId
            ? new Response(JSON.stringify({ id: userId }), { status: 200 })
            : new Response(JSON.stringify({ message: 'invalid jwt' }), { status: 401 });
        }
        return mp.fetchImpl(input as RequestInfo, init);
      }) as unknown as typeof fetch;

    // 1. Sem cabeçalho Authorization.
    const unauthorized = await handleAdminApi(
      postJson('https://fn.test/admin-api', { action: 'indicators' }),
      buildDeps(client, mp.fetchImpl),
    );
    expect(unauthorized.status).toBe(401);

    // 2. JWT válido, mas fora da allowlist administrativa.
    const nonAdminRpc = createPgRpc(client, {
      role: 'authenticated',
      claims: { sub: '11111111-1111-1111-1111-111111111111', role: 'authenticated', aal: 'aal2' },
    });
    const forbidden = await handleAdminApi(
      postJson('https://fn.test/admin-api', { action: 'indicators' }, { Authorization: 'Bearer jwt-a' }),
      buildDeps(client, fakeAuth('11111111-1111-1111-1111-111111111111'), {}, nonAdminRpc),
    );
    expect(forbidden.status).toBe(403);

    // 3. Administrador sem segundo fator (AAL1) é bloqueado.
    const aal1Rpc = createPgRpc(client, {
      role: 'authenticated',
      claims: { sub: adminId, role: 'authenticated', aal: 'aal1' },
    });
    const mfaRequired = await handleAdminApi(
      postJson('https://fn.test/admin-api', { action: 'indicators' }, { Authorization: 'Bearer jwt-b' }),
      buildDeps(client, fakeAuth(adminId), {}, aal1Rpc),
    );
    expect(mfaRequired.status).toBe(403);
    expect(((await mfaRequired.json()) as { error: string }).error).toBe('mfa_required');

    // 4. Administrador com AAL2 executa a operação.
    const aal2Rpc = createPgRpc(client, {
      role: 'authenticated',
      claims: { sub: adminId, role: 'authenticated', aal: 'aal2' },
    });
    const deps = buildDeps(client, fakeAuth(adminId), {}, aal2Rpc);

    const session = await handleAdminApi(
      postJson('https://fn.test/admin-api', { action: 'session' }, { Authorization: 'Bearer jwt-c' }),
      deps,
    );
    expect(await session.json()).toMatchObject({ is_admin: true, mfa_satisfied: true });

    const addResponse = await handleAdminApi(
      postJson(
        'https://fn.test/admin-api',
        {
          action: 'stock.add',
          payload: {
            productId: product.productId,
            email: 'nova@exemplo.com',
            password: 'senha-nova',
          },
        },
        { Authorization: 'Bearer jwt-c' },
      ),
      deps,
    );
    expect(addResponse.status).toBe(201);

    // 5. Credencial gravada apenas cifrada e recuperável pela API do painel.
    const stored = await runSql<{ account_email_enc: string }>(
      `select encode(account_email_enc, 'base64') as account_email_enc
         from public.stock_units where product_id = $1 order by created_at desc limit 1`,
      [product.productId],
    );
    expect(stored[0].account_email_enc).not.toContain('nova@exemplo.com');

    const list = await handleAdminApi(
      postJson(
        'https://fn.test/admin-api',
        {
          action: 'stock.list',
          payload: { productId: product.productId, includeCredentials: true },
        },
        { Authorization: 'Bearer jwt-c' },
      ),
      deps,
    );
    const listBody = (await list.json()) as { items: Array<{ email: string; password: string }> };
    expect(listBody.items[0]).toMatchObject({ email: 'nova@exemplo.com', password: 'senha-nova' });

    // 6. A leitura de credenciais fica auditada.
    const audit = await sqlValue<number>(
      `select count(*) from public.admin_audit_log where action = 'stock_credentials_listed'`,
    );
    expect(Number(audit)).toBeGreaterThanOrEqual(1);
  });
});
