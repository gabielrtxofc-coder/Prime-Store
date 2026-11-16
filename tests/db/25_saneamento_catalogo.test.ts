import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { toBase64 } from '../../supabase/functions/_shared/crypto';
import { createDeps, type Deps } from '../../supabase/functions/_shared/deps';
import { handleCreateOrder } from '../../supabase/functions/_shared/handlers/createOrder';
import { createFakeWyvi } from '../unit/fakeWyvi';
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
 * Missão 3 — Fase 03 (saneamento do catálogo): arquivar os produtos demo
 * preservando histórico e bloquear a compra de produto indisponível.
 *
 * Regras cobertas:
 *   1. arquivamento = `is_active=false` + `archived_at=now()`; o registro
 *      NUNCA é apagado (ids, `is_demo` e referências de pedidos preservados);
 *   2. a visão `public_catalog` (fonte do catálogo público) exclui o
 *      arquivado — catálogo com apenas produtos reais;
 *   3. a compra de produto arquivado/inativo é recusada no banco
 *      (`product_unavailable` / `product_archived`) — verificado no handler;
 *   4. pedidos existentes sobre produto demo permanecem íntegros;
 *   5. catálogo vazio (tudo arquivado) devolve lista vazia sem erro;
 *   6. um NOVO produto cadastrado no teste aparece no catálogo em seguida.
 */

const MASTER_KEY = toBase64(crypto.getRandomValues(new Uint8Array(32)));

describe('25 — saneamento do catálogo: demo arquivado, histórico preservado', () => {
  let client: Client;
  let deps: Deps;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
    const rpc = createPgRpc(client);
    deps = createDeps({
      config: {
        supabaseUrl: 'https://fake-project.supabase.test',
        serviceRoleKey: 'service-role-key',
        anonKey: 'anon-key',
        wyviApiKey: 'wy_test_apenas_ficticio_neste_teste',
        wyviWebhookSecret: 'whsec_apenas_ficticio_neste_teste_0001',
        wyviApiBase: 'https://api.wyvipay.test',
        wyviEnvironment: 'test',
        encryptionKey: MASTER_KEY,
        storeUrl: 'https://loja.teste',
        paymentNotificationUrl: 'https://fake-project.supabase.test/functions/v1/mp-webhook',
        rateLimitOverrides: RELAXED_RATE_LIMIT_OVERRIDES,
      },
      rpc,
      rpcForUser: () => rpc,
      serviceRpc: rpc,
      fetchImpl: createFakeWyvi().fetchImpl,
      resolveEncryptionKey: async () => MASTER_KEY,
      log: () => undefined,
    });
  }, 60000);

  async function demoIds(): Promise<string[]> {
    return runSql<{ id: string }>(`select id from public.products order by created_at`).then((rows) =>
      rows.map((r) => r.id),
    );
  }

  async function publicCatalogIds(): Promise<string[]> {
    return runSql<{ id: string }>(`select id from public.public_catalog order by created_at`).then((rows) =>
      rows.map((r) => r.id),
    );
  }

  it('prepara 2 produtos demo + 1 real e um pedido sobre o demo (histórico)', async () => {
    const demoA = await seedProduct({ stockUnits: 1 });
    const demoB = await seedProduct({ stockUnits: 1 });
    const real = await seedProduct({ stockUnits: 1 }); // produto real que permanece no catálogo
    await runSql(`update public.products set is_demo = true where id = any($1::uuid[])`, [
      [demoA.productId, demoB.productId],
    ]);
    expect(real.productId).toBeTruthy();

    // Pedido REAL sobre o produto demoA (criação de cobrança no fake, sem
    // rede) — depois do arquivamento este pedido precisa permanecer intacto.
    const response = await handleCreateOrder(
      new Request('https://fn.test/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ product_id: demoA.productId, quantity: 1 }],
          payer_email: 'comprador-historico@teste.com',
          idempotency_key: randomToken(16),
        }),
      }),
      deps,
    );
    expect(response.status).toBe(201);
    const orderRows = await runSql<{ id: string; product_id: string; status: string }>(
      `select id, product_id, status from public.orders order by created_at desc limit 1`,
    );
    expect(orderRows[0].product_id).toBe(demoA.productId);
    expect(orderRows[0].status).toBe('pending_payment');

    const total = await sqlValue<number>(`select count(*)::int from public.products`);
    expect(Number(total)).toBe(3);
  }, 30000);

  it('arquiva os 2 demo sem apagar nada e o catálogo público só vê o produto real', async () => {
    const antes = await demoIds();
    const pedidosAntes = await sqlValue<number>(`select count(*)::int from public.orders`);

    // Caminho de saneamento: os dois demo viram arquivados (o admin real usa
    // o mesmo par de colunas; nada de DELETE).
    const result = await runSql<{ id: string; is_active: boolean; archived_at: Date | null; is_demo: boolean }>(
      `update public.products
          set is_active = false, archived_at = now()
        where is_demo = true and archived_at is null
        returning id, is_active, archived_at, is_demo`,
    );
    expect(result).toHaveLength(2);
    for (const row of result) {
      expect(row.is_active).toBe(false);
      expect(row.archived_at).not.toBeNull();
      expect(row.is_demo).toBe(true);
    }

    // Nenhum registro someu: mesmos ids, mesma contagem.
    const depois = await demoIds();
    expect(depois.sort()).toEqual(antes.sort());

    // Histórico preservado.
    const pedidosDepois = await sqlValue<number>(`select count(*)::int from public.orders`);
    expect(Number(pedidosDepois)).toBe(Number(pedidosAntes));
    const pedidoDemo = await runSql<{ id: string; status: string }>(
      `select id, status from public.orders where product_id = any($1::uuid[])`,
      [antes],
    );
    expect(pedidoDemo).toHaveLength(1);
    expect(pedidoDemo[0].status).toBe('pending_payment');

    // Catálogo público: só o produto real (view public_catalog = fonte do get_catalog).
    const visiveis = await publicCatalogIds();
    expect(visiveis).toHaveLength(1);
    expect(visiveis.sort()).toEqual(
      (await runSql<{ id: string }>(`select id from public.products where is_demo = false`)).map((r) => r.id).sort(),
    );
    const real = await runSql<{ is_demo: boolean; archived_at: Date | null }>(
      `select is_demo, archived_at from public.products where id = $1`,
      [visiveis[0]],
    );
    expect(real[0].is_demo).toBe(false);
    expect(real[0].archived_at).toBeNull();
  });

  it('produto arquivado/inativo não é comprável (recusa no banco)', async () => {
    const arquivado = await seedProduct({ stockUnits: 1 });
    await runSql(`update public.products set archived_at = now(), is_active = false where id = $1`, [
      arquivado.productId,
    ]);
    const inativo = await seedProduct({ stockUnits: 1, active: false });

    const responseArquivado = await handleCreateOrder(
      new Request('https://fn.test/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ product_id: arquivado.productId, quantity: 1 }],
          payer_email: 'comprador@teste.com',
          idempotency_key: randomToken(16),
        }),
      }),
      deps,
    );
    expect(responseArquivado.status).toBe(404);
    expect(((await responseArquivado.json()) as { error?: string }).error).toBe('product_unavailable');

    const responseInativo = await handleCreateOrder(
      new Request('https://fn.test/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ product_id: inativo.productId, quantity: 1 }],
          payer_email: 'comprador@teste.com',
          idempotency_key: randomToken(16),
        }),
      }),
      deps,
    );
    expect(responseInativo.status).toBe(404);
    expect(((await responseInativo.json()) as { error?: string }).error).toBe('product_unavailable');

    // Nenhum pedido nasceu das tentativas recusadas.
    const pedidosRecusados = await sqlValue<number>(
      `select count(*)::int from public.orders where product_id = any($1::uuid[])`,
      [[arquivado.productId, inativo.productId]],
    );
    expect(Number(pedidosRecusados)).toBe(0);
  });

  it('catálogo vazio (tudo arquivado) responde lista vazia — e novo produto aparece', async () => {
    await runSql(`update public.products set is_active = false, archived_at = coalesce(archived_at, now())`);
    expect(await publicCatalogIds()).toHaveLength(0);

    // Cadastro de produto real no teste → aparece imediatamente no catálogo.
    const novo = await seedProduct({ stockUnits: 1 });
    const visiveis = await publicCatalogIds();
    expect(visiveis).toContain(novo.productId);

    // E segue fora do catálogo o que está arquivado.
    const fora = await runSql<{ id: string }>(
      `select id from public.public_catalog where id in (
         select id from public.products where archived_at is not null
       )`,
    );
    expect(fora).toHaveLength(0);
  });
});
