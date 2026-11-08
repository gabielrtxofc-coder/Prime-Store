import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  credentialFingerprint,
  encryptText,
  loadSecretMaterial,
  sha256Hex,
  toBase64,
} from '../../supabase/functions/_shared/crypto';
import { handleDelivery } from '../../supabase/functions/_shared/handlers/delivery';
import type { Deps } from '../../supabase/functions/_shared/deps';
import { connect, resetDatabase, runSql, sqlValue } from './helpers';
import { createPgRpc } from './pgRpc';

/**
 * Missão 09 — jornada completa do pedido multi-produto pela Edge Function.
 *
 * O teste atravessa as camadas reais: RPC no PostgreSQL, entrega decifrada em
 * Node (WebCrypto) e resposta HTTP do handler `delivery`. Nenhum provedor
 * financeiro participa: a confirmação é interna, ligada apenas neste arquivo.
 */

const MASTER_KEY = toBase64(crypto.getRandomValues(new Uint8Array(32)));

/** Mesmo formato de override usado pelos testes existentes. */
const RELAXED_LIMITS = { delivery: 1000, 'order-status': 1000 } as unknown as Deps['config'];

interface SeededProduct {
  productId: string;
  credentials: Array<{ email: string; password: string }>;
}

async function seedWithRealCredentials(
  name: string,
  priceCents: number,
  total: number,
): Promise<SeededProduct> {
  const material = await loadSecretMaterial(MASTER_KEY);
  const rows = await runSql<{ id: string }>(
    `insert into public.products (
       slug, name, category_id, price_cents, cost_cents, instructions,
       access_validity_label, access_validity_days, max_quantity_per_order
     ) values ($1, $2, 'creative', $3, 1000, $4, '12 meses', 365, 5)
     returning id`,
    [`multi-${Math.random().toString(36).slice(2, 8)}`, name, priceCents, `Instruções de ${name}`],
  );
  const productId = rows[0].id;
  const credentials: Array<{ email: string; password: string }> = [];

  for (let index = 0; index < total; index += 1) {
    const email = `${name.toLowerCase().replace(/\s+/g, '')}${index}@exemplo.com`;
    const password = `senha-${name.slice(0, 3)}-${index}`;
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

function buildDeps(client: Client): Deps {
  const rpc = createPgRpc(client);
  return {
    config: {
      supabaseUrl: 'https://fake-project.supabase.test',
      serviceRoleKey: 'service-role-key',
      anonKey: 'anon-key',
      mercadoPagoAccessToken: null,
      mercadoPagoWebhookSecret: null,
      mercadoPagoApiBase: 'https://api.mercadopago.test',
      encryptionKey: MASTER_KEY,
      storeUrl: 'http://localhost:5173',
      paymentNotificationUrl: null,
      rateLimitOverrides: RELAXED_LIMITS,
    } as Deps['config'],
    rpc,
    rpcForUser: () => rpc,
    serviceRpc: rpc,
    resolveEncryptionKey: async () => MASTER_KEY,
    fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    now: () => new Date(),
    log: () => undefined,
  };
}

function postJson(body: unknown): Request {
  return new Request('https://fn.test/delivery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface DeliveryBody {
  reference: string;
  items_count: number;
  items: Array<{
    product_id: string;
    product_name: string;
    instructions: string;
    access_validity_label: string;
    quantity: number;
    units: Array<{ email: string; password: string; notes: string }>;
  }>;
  product: { id: string; name: string };
  units: Array<{ email: string; password: string }>;
}

describe('jornada multi-produto pela Edge Function', () => {
  let client: Client;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
    await runSql(`update public.app_settings set value = 'true'::jsonb
                   where key = 'internal_confirmation_enabled'`);
  }, 60000);

  it('processa o pedido, libera a entrega e devolve cada produto com suas credenciais', async () => {
    const piano = await seedWithRealCredentials('Curso Piano', 4990, 3);
    const violao = await seedWithRealCredentials('Curso Violao', 2990, 2);

    const clientToken = 'token-de-teste-da-jornada-multi';
    const clientTokenHash = await sha256Hex(clientToken);
    const deliveryToken = 'token-de-entrega-da-jornada-multi';
    const deliveryHash = await sha256Hex(deliveryToken);
    const deliveryEnc = toBase64(crypto.getRandomValues(new Uint8Array(48)));

    // 1. Pedido multi-item: reserva os dois produtos.
    const created = await runSql<{ result: { order_id: string; total_cents: number } }>(
      `select public.create_order_multi($1, null, $2) as result`,
      [
        JSON.stringify([
          { product_id: piano.productId, quantity: 2 },
          { product_id: violao.productId, quantity: 1 },
        ]),
        clientTokenHash,
      ],
    );
    const orderId = created[0].result.order_id;
    expect(created[0].result.total_cents).toBe(4990 * 2 + 2990);

    // 2. Confirmação válida (interna, isolada): venda + entrega automática.
    const confirmed = await runSql<{ result: { result: string } }>(
      `select public.internal_confirm_payment($1, $2, $3, $4) as result`,
      [orderId, clientTokenHash, deliveryHash, deliveryEnc],
    );
    expect(confirmed[0].result.result).toBe('approved');

    // 3. Edge Function entrega: credenciais decifradas, agrupadas por produto.
    const deps = buildDeps(client);
    const response = await handleDelivery(postJson({ token: deliveryToken }), deps);
    expect(response.status).toBe(200);

    const body = (await response.json()) as DeliveryBody;
    expect(body.items_count).toBe(2);
    expect(body.items).toHaveLength(2);

    const pianoGroup = body.items.find((item) => item.product_id === piano.productId)!;
    const violaoGroup = body.items.find((item) => item.product_id === violao.productId)!;

    expect(pianoGroup.product_name).toBe('Curso Piano');
    expect(pianoGroup.instructions).toBe('Instruções de Curso Piano');
    expect(pianoGroup.access_validity_label).toBe('12 meses');
    // Comprou 2 das 3 unidades disponíveis do piano: a entrega tem exatamente essas 2.
    const purchasedPiano = piano.credentials.slice(0, 2);
    expect(pianoGroup.units.map((unit) => unit.email).sort()).toEqual(
      purchasedPiano.map((credential) => credential.email).sort(),
    );
    expect(pianoGroup.units.map((unit) => unit.password).sort()).toEqual(
      purchasedPiano.map((credential) => credential.password).sort(),
    );

    expect(violaoGroup.product_name).toBe('Curso Violao');
    expect(violaoGroup.units).toHaveLength(1);
    expect(violaoGroup.units[0].email).toBe(violao.credentials[0].email);
    expect(violaoGroup.units[0].password).toBe(violao.credentials[0].password);

    // Compatibilidade: formato plano continua presente e completo.
    expect(body.units).toHaveLength(3);
    expect(body.product.id).toBe(piano.productId);

    // 4. Nada de ciphertext na resposta.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('email_enc');
    expect(serialized).not.toContain('password_enc');

    // 5. Reabrir a entrega com o mesmo acesso privado devolve o mesmo conteúdo.
    const again = await handleDelivery(postJson({ token: deliveryToken }), deps);
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as DeliveryBody;
    expect(againBody.items.map((item) => item.product_id).sort()).toEqual(
      [piano.productId, violao.productId].sort(),
    );

    const views = await sqlValue<number>(
      `select view_count from public.deliveries where order_id = $1`,
      [orderId],
    );
    expect(Number(views)).toBeGreaterThanOrEqual(2);

    // 6. Antes da confirmação (aqui: token de outro pedido) não há acesso.
    const wrong = await handleDelivery(postJson({ token: 'nao-existe-este-token' }), deps);
    expect(wrong.status).toBe(404);

    // 7. Estoque: cada unidade vendida uma única vez, para este pedido.
    const soldPiano = await sqlValue<number>(
      `select count(*)::int from public.stock_units
        where product_id = $1 and status = 'sold' and sold_order_id = $2`,
      [piano.productId, orderId],
    );
    expect(Number(soldPiano)).toBe(2);

    const availableViolao = await sqlValue<number>(
      `select count(*)::int from public.stock_units
        where product_id = $1 and status = 'available'`,
      [violao.productId],
    );
    expect(Number(availableViolao)).toBe(1);
  });

  it('revogação bloqueia o acesso a todos os produtos', async () => {
    const deps = buildDeps(client);
    const seedA = await seedWithRealCredentials('Revoga A', 1990, 1);
    const seedB = await seedWithRealCredentials('Revoga B', 1990, 1);

    const clientTokenHash = await sha256Hex('token-revogacao-jornada');
    // Token privado com a entropia mínima exigida pela validação da rota.
    const deliveryToken = 'revogacao-jornada-4fT1x9QpLm2Zb8Vc';
    const created = await runSql<{ result: { order_id: string } }>(
      `select public.create_order_multi($1, null, $2) as result`,
      [
        JSON.stringify([
          { product_id: seedA.productId, quantity: 1 },
          { product_id: seedB.productId, quantity: 1 },
        ]),
        clientTokenHash,
      ],
    );
    const orderId = created[0].result.order_id;

    // O token de entrega é derivado aqui (e não da URL) porque este teste
    // monta a entrega direto pelo banco.
    const confirmedRevoke = await runSql<{ result: { result: string } }>(
      `select public.internal_confirm_payment($1, $2, $3, $4) as result`,
      [
        orderId,
        clientTokenHash,
        await sha256Hex(deliveryToken),
        toBase64(crypto.getRandomValues(new Uint8Array(48))),
      ],
    );

    const firstRead = await handleDelivery(postJson({ token: deliveryToken }), deps);
    expect(firstRead.status).toBe(200);

    const deliveryId = await sqlValue<string>(
      `select id from public.deliveries where order_id = $1`,
      [orderId],
    );
    await runSql(`update public.deliveries set status = 'revoked', revoked_at = now() where id = $1`, [
      deliveryId,
    ]);
    await runSql(`update public.orders set delivery_status = 'revoked' where id = $1`, [orderId]);

    const blocked = await handleDelivery(postJson({ token: deliveryToken }), deps);
    expect(blocked.status).not.toBe(200);
    const blockedBody = JSON.stringify(await blocked.json());
    expect(blockedBody).not.toContain('@exemplo.com');
  });
});
