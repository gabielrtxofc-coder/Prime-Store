import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { connect, randomToken, resetDatabase, runAs, runSql, seedProduct, sha256Hex, sqlValue } from './helpers';

/**
 * Missão 08 — solicitação de compra SEM pagamento.
 *
 * O que estes testes garantem (contrato do banco, independente da interface):
 *  - o pedido nasce em `requested` / `not_required`, sem pagamento e sem entrega;
 *  - preço e total vêm do banco, nunca do que o navegador enviou;
 *  - carrinho com vários produtos vira UM pedido com itens;
 *  - estoque não é reservado nem baixado, mas a disponibilidade é conferida;
 *  - idempotência não duplica a solicitação;
 *  - acompanhamento exige o código privado e devolve os itens.
 */

const NAME = 'Maria Souza';
const EMAIL = 'maria@exemplo.com';

interface RequestResult {
  order: {
    order_id: string;
    reference: string;
    status: string;
    payment_status: string;
    delivery_status: string;
    items_count: number;
    quantity: number;
    unit_price_cents: number;
    total_cents: number;
    buyer_name: string | null;
    created_at: string;
    items: Array<{
      product_id: string;
      product_name: string;
      product_slug: string;
      quantity: number;
      unit_price_cents: number;
      subtotal_cents: number;
    }>;
  };
  idempotent_replay: boolean;
}

async function createRequest(
  items: Array<{ product_id: string; quantity: number }>,
  options: {
    tokenHash?: string;
    idempotencyKey?: string | null;
    name?: string;
    email?: string;
  } = {},
): Promise<RequestResult> {
  const tokenHash = options.tokenHash ?? sha256Hex(randomToken());
  const rows = await runSql<{ result: RequestResult }>(
    `select public.create_purchase_request($1, $2, $3, $4, $5) as result`,
    [
      // `pg` enviaria array JS como literal de array: o contrato é `jsonb`.
      JSON.stringify(items),
      options.name ?? NAME,
      options.email ?? EMAIL,
      tokenHash,
      options.idempotencyKey ?? null,
    ],
  );
  return rows[0].result;
}

describe('solicitação de pedido sem pagamento', () => {
  let client: Client;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
  }, 60000);

  it('registra carrinho com vários produtos como um pedido aguardando confirmação', async () => {
    const first = await seedProduct({ priceCents: 4990, maxQuantity: 3, stockUnits: 5 });
    const second = await seedProduct({ priceCents: 2990, maxQuantity: 2, stockUnits: 4 });

    const created = await createRequest([
      { product_id: first.productId, quantity: 2 },
      { product_id: second.productId, quantity: 1 },
    ]);

    expect(created.idempotent_replay).toBe(false);
    expect(created.order.status).toBe('requested');
    expect(created.order.payment_status).toBe('not_required');
    expect(created.order.delivery_status).toBe('not_ready');
    expect(created.order.items_count).toBe(2);
    expect(created.order.quantity).toBe(3);
    expect(created.order.total_cents).toBe(4990 * 2 + 2990);
    expect(created.order.reference).toMatch(/^PS-[0-9A-Z]{6}$/);
    expect(created.order.items).toHaveLength(2);

    // Preço unitário gravado por item = preço vigente na tabela de produtos.
    const prices = created.order.items.map((item) => item.unit_price_cents).sort();
    expect(prices).toEqual([2990, 4990]);

    // Nada de pagamento e nada de entrega: nenhuma linha criada nessas tabelas.
    expect(await sqlValue<number>('select count(*)::int from public.payments where order_id = $1', [created.order.order_id])).toBe(0);
    expect(await sqlValue<number>('select count(*)::int from public.deliveries where order_id = $1', [created.order.order_id])).toBe(0);
    expect(await sqlValue<number>('select count(*)::int from public.stock_reservations where order_id = $1', [created.order.order_id])).toBe(0);
    expect(await sqlValue<string | null>('select paid_at::text from public.orders where id = $1', [created.order.order_id])).toBeNull();
    expect(await sqlValue<string>('select buyer_name from public.orders where id = $1', [created.order.order_id])).toBe(NAME);

    // Evento de auditoria do registo.
    const events = await runSql<{ event_type: string; actor: string }>(
      'select event_type, actor from public.order_events where order_id = $1',
      [created.order.order_id],
    );
    expect(events.map((event) => event.event_type)).toContain('request_created');
    expect(events.every((event) => event.actor === 'customer')).toBe(true);
  }, 20000);

  it('não reserva nem baixa unidades do estoque', async () => {
    const product = await seedProduct({ maxQuantity: 5, stockUnits: 3 });

    const availableBefore = await sqlValue<number>(
      `select count(*)::int from public.stock_units where product_id = $1 and status = 'available'`,
      [product.productId],
    );

    await createRequest([{ product_id: product.productId, quantity: 2 }]);

    const availableAfter = await sqlValue<number>(
      `select count(*)::int from public.stock_units where product_id = $1 and status = 'available'`,
      [product.productId],
    );
    expect(availableAfter).toBe(availableBefore);
    expect(await sqlValue<number>('select count(*)::int from public.stock_units where status <> $$available$$')).toBe(0);
  }, 20000);

  it('usa o preço e o total do banco, ignorando qualquer valor enviado pelo cliente', async () => {
    const product = await seedProduct({ priceCents: 1990, maxQuantity: 4, stockUnits: 6 });

    const created = await createRequest([{ product_id: product.productId, quantity: 2 }]);

    expect(created.order.total_cents).toBe(3980);
    expect(created.order.items[0].unit_price_cents).toBe(1990);

    // O banco não aceita preço no payload: a quantidade é o único dado de valor.
    const columns = await runSql<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'order_items'`,
    );
    expect(columns.map((column) => column.column_name)).not.toContain('client_price_cents');
  }, 20000);

  it('recusa produto esgotado, inativo e quantidade acima do limite', async () => {
    const soldOut = await seedProduct({ stockUnits: 0 });
    await expect(createRequest([{ product_id: soldOut.productId, quantity: 1 }])).rejects.toThrow(/insufficient_stock/);

    const inactive = await seedProduct({ stockUnits: 3, active: false });
    await expect(createRequest([{ product_id: inactive.productId, quantity: 1 }])).rejects.toThrow(/product_unavailable/);

    const limited = await seedProduct({ maxQuantity: 2, stockUnits: 10 });
    await expect(createRequest([{ product_id: limited.productId, quantity: 3 }])).rejects.toThrow(
      /quantity_above_product_limit/,
    );

    const cheapest = await seedProduct({ stockUnits: 10, maxQuantity: 10 });
    await expect(createRequest([{ product_id: cheapest.productId, quantity: 0 }])).rejects.toThrow(/invalid_quantity/);
  }, 20000);

  it('recusa carrinho vazio, item repetido e mais de dez produtos', async () => {
    const product = await seedProduct({ stockUnits: 5, maxQuantity: 5 });

    await expect(createRequest([])).rejects.toThrow(/invalid_items/);
    await expect(
      createRequest([
        { product_id: product.productId, quantity: 1 },
        { product_id: product.productId, quantity: 1 },
      ]),
    ).rejects.toThrow(/duplicate_item/);

    const many: Array<{ product_id: string; quantity: number }> = [];
    for (let index = 0; index < 11; index += 1) {
      const seeded = await seedProduct({ stockUnits: 2 });
      many.push({ product_id: seeded.productId, quantity: 1 });
    }
    await expect(createRequest(many)).rejects.toThrow(/invalid_items/);
  }, 40000);

  it('exige nome e e-mail válidos e código privado no formato esperado', async () => {
    const product = await seedProduct({ stockUnits: 5 });
    const items = [{ product_id: product.productId, quantity: 1 }];

    await expect(createRequest(items, { name: ' ' })).rejects.toThrow(/invalid_buyer_name/);
    await expect(createRequest(items, { email: 'invalido' })).rejects.toThrow(/invalid_buyer_email/);
    await expect(createRequest(items, { tokenHash: 'curto' })).rejects.toThrow(/invalid_client_token/);
  }, 20000);

  it('replay da mesma chave devolve a mesma solicitação, sem duplicar pedido nem itens', async () => {
    const product = await seedProduct({ stockUnits: 5, maxQuantity: 3 });
    const idempotencyKey = randomToken(16);
    const tokenHash = sha256Hex(randomToken());

    const first = await createRequest([{ product_id: product.productId, quantity: 1 }], { idempotencyKey, tokenHash });
    const second = await createRequest([{ product_id: product.productId, quantity: 1 }], { idempotencyKey, tokenHash });

    expect(second.idempotent_replay).toBe(true);
    expect(second.order.order_id).toBe(first.order.order_id);
    expect(second.order.reference).toBe(first.order.reference);
    expect(await sqlValue<number>('select count(*)::int from public.orders where idempotency_key = $1', [idempotencyKey])).toBe(1);
    expect(await sqlValue<number>('select count(*)::int from public.order_items where order_id = $1', [first.order.order_id])).toBe(1);
  }, 20000);

  it('replay rotaciona o código quando o cliente perdeu o token da tentativa', async () => {
    const product = await seedProduct({ stockUnits: 5 });
    const idempotencyKey = randomToken(16);

    const first = await createRequest([{ product_id: product.productId, quantity: 1 }], { idempotencyKey });
    const newToken = randomToken();
    const second = await createRequest([{ product_id: product.productId, quantity: 1 }], {
      idempotencyKey,
      tokenHash: sha256Hex(newToken),
    });

    expect(second.order.order_id).toBe(first.order.order_id);

    const status = await runSql<{ result: Record<string, unknown> }>(
      'select public.get_order_status($1, $2) as result',
      [first.order.order_id, sha256Hex(newToken)],
    );
    expect(status[0].result.reference).toBe(first.order.reference);

    // O token antigo deixa de abrir o pedido.
    await expect(
      runSql('select public.get_order_status($1, $2)', [first.order.order_id, sha256Hex('outro-token-qualquer')]),
    ).rejects.toThrow(/order_not_found/);
  }, 20000);

  it('acompanhamento devolve itens, estado e contato somente com o código privado', async () => {
    const first = await seedProduct({ priceCents: 1290, stockUnits: 3, maxQuantity: 2 });
    const second = await seedProduct({ priceCents: 4990, stockUnits: 3 });
    const token = randomToken();
    const tokenHash = sha256Hex(token);

    const created = await createRequest(
      [
        { product_id: first.productId, quantity: 2 },
        { product_id: second.productId, quantity: 1 },
      ],
      { tokenHash },
    );

    const [row] = await runSql<{ result: Record<string, unknown> }>(
      'select public.get_order_status($1, $2) as result',
      [created.order.order_id, tokenHash],
    );
    const status = row.result as {
      status: string;
      payment_status: string;
      total_cents: number;
      items: Array<{ quantity: number; unit_price_cents: number; subtotal_cents: number }>;
      buyer_name: string | null;
      payment: unknown;
      delivery: unknown;
    };

    expect(status.status).toBe('requested');
    expect(status.payment_status).toBe('not_required');
    expect(status.total_cents).toBe(1290 * 2 + 4990);
    expect(status.items).toHaveLength(2);
    expect(status.items.reduce((sum, item) => sum + item.subtotal_cents, 0)).toBe(status.total_cents);
    expect(status.buyer_name).toBe(NAME);
    expect(status.payment).toBeNull();
    expect(status.delivery).toBeNull();

    // Sem o código, ou com outro código, o pedido não existe.
    await expect(
      runSql('select public.get_order_status($1, $2)', [created.order.order_id, sha256Hex('chute-de-terceiro-123456')]),
    ).rejects.toThrow(/order_not_found/);

    // Consulta pelo número do pedido também exige o código.
    const [byReference] = await runSql<{ result: { order_id: string } }>(
      'select public.get_order_status_by_reference($1, $2) as result',
      [created.order.reference, tokenHash],
    );
    expect(byReference.result.order_id).toBe(created.order.order_id);

    await expect(
      runSql('select public.get_order_status_by_reference($1, $2)', [
        created.order.reference,
        sha256Hex('chute-de-terceiro-123456'),
      ]),
    ).rejects.toThrow(/order_not_found/);

    await expect(
      runSql('select public.get_order_status_by_reference($1, $2)', ['PS-ZZZZZZ', tokenHash]),
    ).rejects.toThrow(/order_not_found/);
  }, 20000);

  it('folga de estoque é reavaliada a cada solicitação (sem venda acima da disponibilidade)', async () => {
    const product = await seedProduct({ maxQuantity: 5, stockUnits: 3 });

    await createRequest([{ product_id: product.productId, quantity: 3 }]);
    // Nada foi reservado: a mesma quantidade ainda pode ser solicitada.
    await createRequest([{ product_id: product.productId, quantity: 3 }]);
    // Mas pedir mais do que existe é recusado na hora.
    await expect(createRequest([{ product_id: product.productId, quantity: 4 }])).rejects.toThrow(/insufficient_stock/);
  }, 20000);
});

describe('privilégios da solicitação', () => {
  it('anon não executa a função nem lê os itens do pedido', async () => {
    await expect(
      runAs(
        `select public.create_purchase_request('[]'::jsonb, $1, $2, $3, null)`,
        [NAME, EMAIL, sha256Hex(randomToken())],
        { role: 'anon' },
      ),
    ).rejects.toThrow(/permission denied|nao pode|não pode/i);

    await expect(runAs('select * from public.order_items', [], { role: 'anon' })).rejects.toThrow(
      /permission denied/i,
    );

    expect(
      await sqlValue<boolean>(`select has_function_privilege('anon', 'public.get_order_status_by_reference(text, text)', 'execute')`),
    ).toBe(false);
  }, 20000);

  it('service_role executa a solicitação', async () => {
    expect(
      await sqlValue<boolean>(
        `select has_function_privilege('service_role', 'public.create_purchase_request(jsonb, text, text, text, text)', 'execute')`,
      ),
    ).toBe(true);
  });
});
