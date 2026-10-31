#!/usr/bin/env node
/**
 * Smoke test HTTP das Edge Functions implantadas.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * ---------------------------
 * O ambiente onde a missão 03 foi executada não tem saída de rede para
 * `*.supabase.co`, então as 6 funções foram verificadas por metadados
 * (`list_edge_functions` / `get_edge_function`) — nunca por requisição HTTP.
 * Este script é o passo que falta, pronto para rodar de qualquer máquina com
 * rede. Ele NÃO testa pagamento: sem `MP_ACCESS_TOKEN` o checkout responde
 * `503 payment_not_configured`, que é justamente o comportamento esperado.
 *
 * COMO USAR
 * ---------
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_ANON_KEY=<anon key> \
 *   node scripts/smoke-edge-functions.mjs
 *
 * Opcionais:
 *   PRODUCT_ID=<uuid de produto ativo>   # testa criação de pedido de verdade
 *   ADMIN_JWT=<access token AAL2>        # testa o admin-api autenticado
 *
 * Sai com código 1 se qualquer verificação falhar. Nenhum segredo é impresso.
 */

const BASE = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const PRODUCT_ID = process.env.PRODUCT_ID ?? null;
const ADMIN_JWT = process.env.ADMIN_JWT ?? null;

if (!BASE || !ANON) {
  console.error('Defina SUPABASE_URL e SUPABASE_ANON_KEY.');
  process.exit(2);
}

const results = [];

function record(name, expected, actual, bodyText) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  results.push({ name, ok, expected, actual });
  const preview = (bodyText ?? '').replace(/\s+/g, ' ').slice(0, 140);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (esperado ${expected}, recebido ${actual})`);
  if (preview) console.log(`      ${preview}`);
}

async function call(slug, { method = 'POST', body, headers = {}, jwt } = {}) {
  const response = await fetch(`${BASE}/functions/v1/${slug}`, {
    method,
    headers: {
      apikey: ANON,
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text };
}

async function main() {
  // 1. Catálogo público.
  {
    const { status, text } = await call('catalog', { method: 'GET' });
    record('catalog responde 200', 200, status, text);
  }

  // 2. checkout: payload inválido é recusado sem criar nada.
  {
    const { status, text } = await call('create-order', { body: { quantity: 1 } });
    record('create-order recusa payload inválido', 422, status, text);
  }

  // 2b. checkout: produto inexistente não vaza existência de nada.
  {
    const { status, text } = await call('create-order', {
      body: {
        product_id: '00000000-0000-4000-8000-000000000000',
        quantity: 1,
        payer_email: 'smoke@example.com',
      },
    });
    record('create-order recusa produto inexistente', [404, 409], status, text);
  }

  // 2c. checkout real (opcional): cria pedido de verdade se houver produto.
  if (PRODUCT_ID) {
    const key = `smoke-${Date.now()}`;
    const payload = {
      product_id: PRODUCT_ID,
      quantity: 1,
      payer_email: 'smoke@example.com',
      idempotency_key: key,
    };
    const first = await call('create-order', { body: payload });
    record('create-order cria pedido', [200, 201], first.status, first.text);
    const replay = await call('create-order', { body: payload });
    record('create-order repetido é idempotente', first.status, replay.status, replay.text);

    // 3. order-status: token errado não revela o pedido.
    try {
      const orderId = JSON.parse(first.text).order_id;
      if (orderId) {
        const wrong = await call('order-status', {
          body: { order_id: orderId, client_token: 'a'.repeat(40) },
        });
        record('order-status recusa token errado', [403, 404], wrong.status, wrong.text);
      }
    } catch {
      /* corpo não-JSON: já registrado acima */
    }
  }

  // 4. entrega: token inventado não revela nada.
  {
    const { status, text } = await call('delivery', { body: { token: 'b'.repeat(43) } });
    record('delivery recusa token inexistente', 404, status, text);
  }

  // 5. webhook sem assinatura válida não processa nada.
  {
    const { status, text } = await call('mp-webhook', {
      body: { type: 'payment', data: { id: '1' } },
      headers: { 'x-signature': 'ts=1,v1=deadbeef', 'x-request-id': 'smoke' },
    });
    record('mp-webhook recusa assinatura inválida', [400, 401, 403], status, text);
  }

  // 6. rotas administrativas exigem JWT no gateway.
  {
    const { status, text } = await call('admin-api', { body: { action: 'session' } });
    record('admin-api sem JWT é 401', 401, status, text);
  }
  if (ADMIN_JWT) {
    const { status, text } = await call('admin-api', { body: { action: 'session' }, jwt: ADMIN_JWT });
    record('admin-api com JWT AAL2 responde', [200, 403], status, text);
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificações passaram.`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Falha ao executar o smoke test:', error instanceof Error ? error.message : error);
  process.exit(1);
});
