import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { sha256Hex, toBase64 } from '../../supabase/functions/_shared/crypto';
import { createDeps, type Deps } from '../../supabase/functions/_shared/deps';
import { handleCreateOrder } from '../../supabase/functions/_shared/handlers/createOrder';
import { handleWyviWorker, makeRoleJwt } from '../../supabase/functions/_shared/handlers/wyviWorker';
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
 * Missão 3 — Fase 01/06: handler `handleWyviWorker` (extraído de
 * `wyvi-worker/index.ts`) sobre PostgreSQL real + API falsa:
 *
 *   1. autenticação: sem cabeçalho / anon / garbage → 401 e ZERO leitura
 *      da fila; service_role → 200;
 *   2. sem `WYVI_API_KEY` → 503 `payment_not_configured` antes de reivindicar;
 *   3. fila vazia → `claimed: 0`;
 *   4. evento pendente → claim → consulta à API (fonte da verdade) →
 *      `pending` aplicado → evento `processed`;
 *   5. repetição: evento já processado nunca é reivindicado;
 *   6. falha temporária do provedor (503) → `retry` com backoff
 *      (`attempts+1`, `available_at` futuro, `locked_until` liberado) e
 *      reivindicação imediata retorna `claimed: 0`;
 *   7. recuperação posterior: com a API restabelecida e o evento de novo
 *      disponível, o mesmo evento é processado (fila não se perde).
 *
 * Nenhuma credencial real: chave/segredo/base fictícios; fila alimentada
 * por SQL direto (mesmo formato do webhook).
 */

const API_KEY = 'wy_test_apenas_ficticio_neste_teste';
const WEBHOOK_SECRET = 'whsec_apenas_ficticio_neste_teste_0001';
const API_BASE = 'https://api.wyvipay.test';
const MASTER_KEY = toBase64(crypto.getRandomValues(new Uint8Array(32)));
const FIXED_TXID = 'testw9f4c2a1b8e7d6f5a4c3b2a1'; // 30 chars alnum (formato do fake)

interface EventRow {
  id: string;
  status: string;
  attempts: number;
  available_at: Date;
  locked_until: Date | null;
}

describe('26 — wyvi-worker: autenticação, fila e recuperação', () => {
  let client: Client;
  let deps: Deps;
  let depsSemChave: Deps;
  let fake: ReturnType<typeof createFakeWyvi>;
  let orderId: string;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
    const rpc = createPgRpc(client);
    fake = createFakeWyvi({ fixedTxid: FIXED_TXID });
    const config = {
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
    };
    deps = createDeps({
      config,
      rpc,
      rpcForUser: () => rpc,
      serviceRpc: rpc,
      fetchImpl: fake.fetchImpl,
      resolveEncryptionKey: async () => MASTER_KEY,
      log: () => undefined,
    });
    depsSemChave = createDeps({
      config: { ...config, wyviApiKey: '' },
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

  function workerRequest(role: string | null): Request {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (role !== null) headers.Authorization = `Bearer ${makeRoleJwt(role)}`;
    return new Request('https://fn.test/wyvi-worker', { method: 'POST', headers, body: '{}' });
  }

  async function callWorker(role: string | null, which: Deps = deps): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await handleWyviWorker(workerRequest(role), which);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function insertEvent(txid: string, notificationId: string, reference: string): Promise<void> {
    await runSql(
      `insert into public.payment_events
         (provider, notification_id, event_type, data_id, signature_valid, payload_hash,
          provider_data, reference, status, attempts)
       values ('wyvipay', $1, 'cobranca.paga', $2, true, $3, $4::jsonb, $5, 'received', 0)`,
      [
        notificationId,
        txid,
        await sha256Hex(notificationId),
        JSON.stringify({ txid, referencia: reference, id: randomUUID(), situacao: 'paga', valor_centavos: 5000 }),
        reference,
      ],
    );
  }

  async function eventRow(notificationId: string): Promise<EventRow> {
    const rows = await runSql<EventRow>(
      `select id, status, attempts, available_at, locked_until
         from public.payment_events where notification_id = $1`,
      [notificationId],
    );
    return rows[0];
  }

  async function createChargeAndOrder(): Promise<string> {
    const product = await seedProduct({ priceCents: 5000, stockUnits: 1 });
    const response = await handleCreateOrder(
      new Request('https://fn.test/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ product_id: product.productId, quantity: 1 }],
          payer_email: 'comprador-worker@teste.com',
          idempotency_key: randomToken(16),
        }),
      }),
      deps,
    );
    expect(response.status).toBe(201);
    const rows = await runSql<{ id: string }>(`select id from public.orders order by created_at desc limit 1`);
    // A cobrança foi criada no fake (fixedTxid) para este pedido.
    expect(fake.createCalls.length).toBeGreaterThan(0);
    return rows[0].id;
  }

  // ---------------------------------------------------------------------
  // 1. Autenticação (duas camadas — aqui a camada do handler)
  // ---------------------------------------------------------------------

  it('sem cabeçalho / anon / garbage → 401 e NENHUM evento lido', async () => {
    const semHeader = await callWorker(null);
    expect(semHeader).toEqual({ status: 401, body: { error: 'unauthorized' } });

    const anon = await callWorker('anon');
    expect(anon.status).toBe(401);

    const request = new Request('https://fn.test/wyvi-worker', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-invalido' },
      body: '{}',
    });
    const garbage = await handleWyviWorker(request, deps);
    expect(garbage.status).toBe(401);

    // Nenhuma consulta foi feita à API (nenhum GET registrado).
    expect(fake.getReadCalls()).toHaveLength(0);
  });

  it('service_role + fila vazia → 200 {claimed: 0}', async () => {
    const ok = await callWorker('service_role');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ claimed: 0, processed: 0, ignored: 0, retried: 0, failed: 0 });
    expect(fake.getReadCalls()).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // 2. Sem chave configurada: 503 antes de tocar na fila
  // ---------------------------------------------------------------------

  it('sem WYVI_API_KEY → 503 payment_not_configured e o evento permanece intacto', async () => {
    const ntf = `ntf_503_${randomToken(8)}`;
    await insertEvent(FIXED_TXID, ntf, randomUUID());

    const res = await callWorker('service_role', depsSemChave);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'payment_not_configured' });

    const row = await eventRow(ntf);
    expect(row.status).toBe('received');
    expect(Number(row.attempts)).toBe(0);
    expect(row.locked_until).toBeNull();
    expect(fake.getReadCalls()).toHaveLength(0);

    await runSql(`delete from public.payment_events where notification_id = $1`, [ntf]);
  });

  // ---------------------------------------------------------------------
  // 3-4. Evento pendente → claim → API → processed
  // ---------------------------------------------------------------------

  it('evento pendente é processado: claim → consulta → pending aplicado → processed', async () => {
    orderId = await createChargeAndOrder();
    const ntf = `ntf_ok_${randomToken(8)}`;
    await insertEvent(FIXED_TXID, ntf, orderId);

    const res = await callWorker('service_role');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ claimed: 1, processed: 1, retried: 0, failed: 0 });

    const row = await eventRow(ntf);
    expect(row.status).toBe('processed');
    // claim_wyvi_events incrementa `attempts` ao reivindicar: 1 = primeira
    // tentativa (e única, sem retry).
    expect(Number(row.attempts)).toBe(1);

    // A notificação foi consultada na API (fonte da verdade) e o pedido
    // seguiu como pendente (cobrança ainda `pendente` no provedor).
    expect(fake.getReadCalls()).toHaveLength(1);
    const order = await runSql<{ status: string; payment_status: string }>(
      `select status, payment_status from public.orders where id = $1`,
      [orderId],
    );
    expect(order[0].payment_status).toBe('pending');
  });

  it('repetição: evento já processado nunca é reivindicado de novo', async () => {
    const antes = fake.getReadCalls().length;
    const res = await callWorker('service_role');
    expect(res.body).toEqual({ claimed: 0, processed: 0, ignored: 0, retried: 0, failed: 0 });
    expect(fake.getReadCalls()).toHaveLength(antes); // nenhuma nova consulta
  });

  // ---------------------------------------------------------------------
  // 6-7. Falha temporária → backoff → recuperação posterior
  // ---------------------------------------------------------------------

  it('falha temporária do provedor → retry com backoff; recuperação posterior processa o mesmo evento', async () => {
    // Reentrega do mesmo pagamento com outro notification_id (como o provedor faz).
    const ntfRetry = `ntf_retry_${randomToken(8)}`;
    await insertEvent(FIXED_TXID, ntfRetry, orderId);

    // Simula instabilidade: GET da cobrança responde 503 nesta rodada.
    const fetchOriginal = fake.fetchImpl;
    const fetchInstavel = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (methodGet(init) && url.includes(`/cobrancas/${FIXED_TXID}`)) {
        return new Response(
          JSON.stringify({ erro: { codigo: 'indisponivel', mensagem: 'instabilidade temporária' } }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return fetchOriginal(input, init);
    }) as typeof fetch;
    const depsInstavel = createDeps({
      config: deps.config,
      rpc: createPgRpc(client),
      rpcForUser: () => createPgRpc(client),
      serviceRpc: createPgRpc(client),
      fetchImpl: fetchInstavel,
      resolveEncryptionKey: async () => MASTER_KEY,
      log: () => undefined,
    });

    const res1 = await callWorker('service_role', depsInstavel);
    expect(res1.status).toBe(200);
    expect(res1.body).toMatchObject({ claimed: 1, retried: 1, processed: 0, failed: 0 });

    const row1 = await eventRow(ntfRetry);
    expect(row1.status).toBe('received'); // continua na fila
    expect(Number(row1.attempts)).toBe(1);
    expect(row1.locked_until).toBeNull(); // claim liberado no reschedule
    expect(new Date(row1.available_at).getTime()).toBeGreaterThan(Date.now()); // backoff ~15s

    // Reivindicação imediata: o backoff segura (nada vence).
    const res2 = await callWorker('service_role');
    expect(res2.body).toMatchObject({ claimed: 0 });

    // Passado o backoff (simulado disponibilizando o evento) e restabelecida
    // a API, o MESMO evento é processado — a fila não se perde.
    await runSql(`update public.payment_events set available_at = now() where notification_id = $1`, [ntfRetry]);
    const res3 = await callWorker('service_role');
    expect(res3.body).toMatchObject({ claimed: 1, processed: 1 });
    const row3 = await eventRow(ntfRetry);
    expect(row3.status).toBe('processed');

    // Fila zerada.
    const restantes = await sqlValue<number>(
      `select count(*)::int from public.payment_events where status = 'received'`,
    );
    expect(Number(restantes)).toBe(0);
  });
});

function methodGet(init?: RequestInit): boolean {
  return (init?.method ?? 'GET') === 'GET';
}
