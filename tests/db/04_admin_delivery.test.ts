import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createOrder,
  fakeCiphertextB64,
  hmacHex,
  randomToken,
  resetDatabase,
  runAs,
  runSql,
  seedAdmin,
  seedProduct,
  seedStockUnit,
  sha256Hex,
  sqlValue,
} from './helpers';

async function asAdmin<T extends Record<string, unknown> = Record<string, unknown>>(
  userId: string,
  sql: string,
  values: unknown[] = [],
  aal: 'aal1' | 'aal2' = 'aal2',
): Promise<T[]> {
  return runAs<T>(sql, values, {
    role: 'authenticated',
    claims: { sub: userId, role: 'authenticated', aal },
  });
}

describe('autorização administrativa, estoque e entregas', () => {
  let adminId: string;

  beforeAll(async () => {
    await resetDatabase();
    adminId = await seedAdmin('owner');
  }, 60000);

  it('exige sessão autenticada para funções administrativas', async () => {
    await expect(
      runAs(`select public.admin_indicators()`, [], { role: 'authenticated', claims: { role: 'authenticated' } }),
    ).rejects.toMatchObject({ code: '28000', message: expect.stringContaining('not_authenticated') });
  });

  it('rejeita usuário autenticado que não está na allowlist', async () => {
    const rows = await runSql<{ id: string }>(
      `insert into auth.users (email) values ('intruso@prime.invalid') returning id`,
    );
    await expect(
      asAdmin(rows[0].id, `select public.admin_indicators()`),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('not_admin') });
  });

  it('exige MFA (AAL2) mesmo para administrador ativo', async () => {
    await expect(
      asAdmin(adminId, `select public.admin_indicators()`, [], 'aal1'),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('mfa_required') });

    const indicators = await asAdmin(adminId, `select public.admin_indicators()`);
    expect(indicators).toHaveLength(1);
  });

  it('administrador sem AAL2 também não consegue alterar estoque', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    await expect(
      asAdmin(
        adminId,
        `select public.admin_add_stock_unit($1, $2, $3, $4)`,
        [seed.productId, fakeCiphertextB64('e'), fakeCiphertextB64('p'), hmacHex('k', 'x')],
        'aal1',
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cadastra, edita e desativa produtos com histórico de preços', async () => {
    const created = await asAdmin<{ result: { id: string; price_cents: number } }>(
      adminId,
      `select public.admin_create_product($1::jsonb) as result`,
      [
        JSON.stringify({
          slug: `curso-${randomBytes(4).toString('hex')}`,
          name: 'Curso de exemplo',
          category_id: 'creative',
          price_cents: 9990,
          cost_cents: 3000,
          short_description: 'Descrição curta',
          instructions: 'Acesse com o login enviado.',
          max_quantity_per_order: 2,
          conditions: ['Uso pessoal'],
        }),
      ],
    );
    const productId = created[0].result.id;
    expect(created[0].result.price_cents).toBe(9990);

    await asAdmin(adminId, `select public.admin_update_product($1, $2::jsonb)`, [
      productId,
      JSON.stringify({ price_cents: 12990, name: 'Curso de exemplo (novo)' }),
    ]);

    const history = await runSql<{ old_price_cents: number; new_price_cents: number }>(
      `select old_price_cents, new_price_cents from public.product_price_history where product_id = $1`,
      [productId],
    );
    expect(history).toHaveLength(1);
    expect(history[0].old_price_cents).toBe(9990);
    expect(history[0].new_price_cents).toBe(12990);

    const beforeDeactivate = await runSql<{ id: string }>(
      `select id from public.public_catalog where id = $1`,
      [productId],
    );
    expect(beforeDeactivate).toHaveLength(1);

    await asAdmin(adminId, `select public.admin_set_product_active($1, false)`, [productId]);
    await asAdmin(adminId, `select public.admin_set_product_active($1, true)`, [productId]);
    await asAdmin(adminId, `select public.admin_set_product_active($1, false)`, [productId]);

    const afterDeactivate = await runSql<{ id: string }>(
      `select id from public.public_catalog where id = $1`,
      [productId],
    );
    expect(afterDeactivate).toHaveLength(0);

    const list = await asAdmin<{ result: Array<{ id: string; available_units: number }> }>(
      adminId,
      `select public.admin_list_products(null, true) as result`,
    );
    const listed = list[0].result.find((item) => item.id === productId);
    expect(listed).toBeDefined();
  });

  it('impede unidades duplicadas e importa em lote com relatório de falhas', async () => {
    const seed = await seedProduct({ stockUnits: 0 });
    const fingerprint = hmacHex('k', 'conta@exemplo.com:senha');

    await asAdmin(adminId, `select public.admin_add_stock_unit($1, $2, $3, $4)`, [
      seed.productId,
      fakeCiphertextB64('email'),
      fakeCiphertextB64('senha'),
      fingerprint,
    ]);

    await expect(
      asAdmin(adminId, `select public.admin_add_stock_unit($1, $2, $3, $4)`, [
        seed.productId,
        fakeCiphertextB64('email'),
        fakeCiphertextB64('senha'),
        fingerprint,
      ]),
    ).rejects.toMatchObject({ code: '23505' });

    const rows = [
      {
        row_number: 2,
        email_enc: fakeCiphertextB64('a'),
        password_enc: fakeCiphertextB64('b'),
        fingerprint: hmacHex('k', 'novo1@exemplo.com:senha1'),
        notes: 'linha 2',
      },
      {
        row_number: 3,
        email_enc: fakeCiphertextB64('c'),
        password_enc: fakeCiphertextB64('d'),
        // duplicada dentro do próprio arquivo
        fingerprint: hmacHex('k', 'novo1@exemplo.com:senha1'),
      },
      {
        row_number: 4,
        email_enc: fakeCiphertextB64('e'),
        password_enc: fakeCiphertextB64('f'),
        fingerprint: 'invalido',
      },
    ];
    const rejected = [
      { row_number: 5, reason: 'senha ausente' },
      { row_number: 6, reason: 'email invalido' },
    ];

    const result = await asAdmin<{
      result: {
        batch_id: string;
        imported: number;
        duplicates: number;
        invalid: number;
        failures: Array<{ row_number: number; reason: string }>;
      };
    }>(
      adminId,
      `select public.admin_import_stock_units($1, $2::jsonb, $3::jsonb, 'lote.csv') as result`,
      [seed.productId, JSON.stringify(rows), JSON.stringify(rejected)],
    );

    const report = result[0].result;
    expect(report.imported).toBe(1);
    expect(report.duplicates).toBe(1);
    expect(report.invalid).toBe(3);
    expect(report.failures.map((failure) => failure.row_number).sort()).toEqual([3, 4, 5, 6]);

    const stored = await sqlValue<number>(
      `select count(*) from public.stock_units where product_id = $1`,
      [seed.productId],
    );
    expect(Number(stored)).toBe(2);
  });

  it('não devolve ciphertext de credenciais sem pedido explícito e audita a leitura', async () => {
    const seed = await seedProduct({ stockUnits: 1 });

    const plain = await asAdmin<{ result: { items: Array<Record<string, unknown>> } }>(
      adminId,
      `select public.admin_list_stock($1, null, null, 50, 0, false) as result`,
      [seed.productId],
    );
    const item = plain[0].result.items[0];
    expect(item.email_enc).toBeNull();
    expect(item.password_enc).toBeNull();
    expect(item.credential_fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const withCredentials = await asAdmin<{ result: { items: Array<Record<string, unknown>> } }>(
      adminId,
      `select public.admin_list_stock($1, null, null, 50, 0, true) as result`,
      [seed.productId],
    );
    expect(typeof withCredentials[0].result.items[0].email_enc).toBe('string');

    const audited = await sqlValue<number>(
      `select count(*) from public.admin_audit_log where action = 'stock_credentials_listed'`,
    );
    expect(Number(audited)).toBeGreaterThanOrEqual(1);
  });

  it('expõe pedidos, filtros, indicadores e reembolsos no painel', async () => {
    const seed = await seedProduct({ priceCents: 4000, stockUnits: 2 });
    const { order } = await createOrder(seed.productId, 1);

    const list = await asAdmin<{
      result: { items: Array<{ id: string; reference: string; open_refund_requests: number }>; total: number };
    }>(adminId, `select public.admin_list_orders($1, null, null, null, null, false, 50, 0) as result`, [
      order.reference,
    ]);
    expect(list[0].result.items).toHaveLength(1);
    expect(list[0].result.items[0].id).toBe(order.order_id);

    const detail = await asAdmin<{ result: { order: Record<string, unknown> } }>(
      adminId,
      `select public.admin_get_order($1) as result`,
      [order.order_id],
    );
    expect(detail[0].result.order.client_token_hash).toBeUndefined();
    expect(detail[0].result.order.reference).toBe(order.reference);

    const indicators = await asAdmin<{ result: Record<string, number | unknown[]> }>(
      adminId,
      `select public.admin_indicators() as result`,
    );
    expect(indicators[0].result.orders_pending_payment).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(indicators[0].result.low_stock_products)).toBe(true);

    // Fora de qualquer falha, o filtro de problemas não deve listar o pedido.
    const problems = await asAdmin<{ result: { items: unknown[] } }>(
      adminId,
      `select public.admin_list_orders(null, null, null, null, null, true, 50, 0) as result`,
    );
    expect(problems[0].result.items).toHaveLength(0);
  });

  it('revoga entrega e impede consulta de credenciais após reembolso', async () => {
    const seed = await seedProduct({ priceCents: 3000, stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);
    const providerId = `MP-${randomToken(5)}`;
    const tokenHash = sha256Hex(randomToken());
    const tokenEnc = fakeCiphertextB64('delivery');

    await runSql(
      `select public.attach_payment($1, $2, 'pending', $3, 'qr', null, null, now() + interval '30 minutes')`,
      [order.order_id, providerId, order.total_cents],
    );
    await runSql(`select public.apply_payment_status($1, $2, 'approved', null, $3, $4, $5)`, [
      order.order_id,
      providerId,
      order.total_cents,
      tokenHash,
      tokenEnc,
    ]);

    const deliveryId = await sqlValue<string>(
      `select id from public.deliveries where order_id = $1`,
      [order.order_id],
    );

    const before = await runSql<{ result: { units: unknown[] } }>(
      `select public.resolve_delivery($1) as result`,
      [tokenHash],
    );
    expect(before[0].result.units).toHaveLength(1);

    await asAdmin(adminId, `select public.admin_revoke_delivery($1, 'teste')`, [deliveryId]);

    await expect(
      runSql(`select public.resolve_delivery($1)`, [tokenHash]),
    ).rejects.toMatchObject({ code: 'P0002' });

    const orderStatus = await sqlValue<string>(
      `select delivery_status from public.orders where id = $1`,
      [order.order_id],
    );
    expect(orderStatus).toBe('revoked');

    // Revogação é idempotente.
    const again = await asAdmin<{ result: { already_revoked: boolean } }>(
      adminId,
      `select public.admin_revoke_delivery($1, 'teste') as result`,
      [deliveryId],
    );
    expect(again[0].result.already_revoked).toBe(true);

    const audit = await sqlValue<number>(
      `select count(*) from public.admin_audit_log where action = 'delivery_revoked'`,
    );
    expect(Number(audit)).toBeGreaterThanOrEqual(1);
  });

  it('reembolso processado revoga a entrega e pedido com pendência aparece nos indicadores', async () => {
    const seed = await seedProduct({ priceCents: 3000, stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);

    await runSql(
      `insert into public.refund_requests (order_id, reason, amount_cents, created_by, provider_payment_id)
       values ($1, 'cliente solicitou', $2, 'system', 'MP-reembolso')`,
      [order.order_id, order.total_cents],
    );
    const refundId = await sqlValue<string>(
      `select id from public.refund_requests where order_id = $1`,
      [order.order_id],
    );

    const pendingList = await asAdmin<{ result: Array<{ id: string }> }>(
      adminId,
      `select public.admin_list_refund_requests('pending') as result`,
    );
    expect(pendingList[0].result.some((item) => item.id === refundId)).toBe(true);

    await asAdmin(adminId, `select public.admin_resolve_refund($1, 'processed', 'estornado no MP')`, [
      refundId,
    ]);

    const row = await runSql<{ status: string; delivery_status: string }>(
      `select status, delivery_status from public.orders where id = $1`,
      [order.order_id],
    );
    expect(row[0].status).toBe('refunded');
    expect(row[0].delivery_status).toBe('revoked');

    const audit = await sqlValue<number>(
      `select count(*) from public.admin_audit_log where action = 'refund_processed'`,
    );
    expect(Number(audit)).toBe(1);
  });

  it('registra auditoria de todas as operações administrativas testadas', async () => {
    const actions = await runSql<{ action: string }>(
      `select distinct action from public.admin_audit_log order by action`,
    );
    const names = actions.map((row) => row.action);
    expect(names).toEqual(
      expect.arrayContaining([
        'delivery_revoked',
        'product_activated',
        'product_created',
        'product_deactivated',
        'product_updated',
        'refund_processed',
        'stock_credentials_listed',
        'stock_imported',
        'stock_unit_added',
      ]),
    );
  });

  it('não permite que o comprador consulte entrega de pedido não pago', async () => {
    const seed = await seedProduct({ priceCents: 3000, stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);
    const tokenHash = sha256Hex(randomToken());

    // Entrega "fantasma" inserida diretamente para simular inconsistência.
    await runSql(
      `insert into public.deliveries (order_id, token_hash, token_enc) values ($1, $2, $3)`,
      [order.order_id, tokenHash, fakeCiphertextB64('d')],
    );

    await expect(
      runSql(`select public.resolve_delivery($1)`, [tokenHash]),
    ).rejects.toMatchObject({ code: 'P0002' });
  });

  it('não permite editar unidade já reservada ou vendida', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    await createOrder(seed.productId, 1); // reserva a única unidade
    const unitId = seed.units[0];

    await expect(
      asAdmin(adminId, `select public.admin_update_stock_unit($1, $2, $3, $4)`, [
        unitId,
        fakeCiphertextB64('novo'),
        fakeCiphertextB64('novo'),
        hmacHex('k', 'outra:senha'),
      ]),
    ).rejects.toMatchObject({ code: 'P0001', message: expect.stringContaining('not_editable') });
  });

  it('permite desativar e reativar unidade disponível', async () => {
    const seed = await seedProduct({ stockUnits: 0 });
    const unitId = await seedStockUnit(seed.productId, 'reativar@exemplo.com', 'senha');

    await asAdmin(adminId, `select public.admin_set_stock_unit_status($1, 'disabled')`, [unitId]);
    let status = await sqlValue<string>(`select status from public.stock_units where id = $1`, [unitId]);
    expect(status).toBe('disabled');

    await asAdmin(adminId, `select public.admin_set_stock_unit_status($1, 'available')`, [unitId]);
    status = await sqlValue<string>(`select status from public.stock_units where id = $1`, [unitId]);
    expect(status).toBe('available');
  });
});
