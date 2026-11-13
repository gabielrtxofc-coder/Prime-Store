#!/usr/bin/env node
/**
 * Smoke test HTTP das Edge Functions implantadas.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * ---------------------------
 * Smoke HTTP read-only para as nove Edge Functions implantadas. O script não
 * cria pedidos, não altera estoque, pagamentos, entregas nem dados de clientes.
 * Chamadas sem JWT/credenciais válidas verificam as proteções sem depender de
 * uma conta administrativa real.
 * Este script é o passo que falta, pronto para rodar de qualquer máquina com
 * rede. Ele NÃO testa pagamento: sem `WYVI_API_KEY` (ou `MP_ACCESS_TOKEN`)
 * legado o checkout responde `503 payment_not_configured`, que é justamente o
 * comportamento esperado. O webhook da WyviPay é checado sem segredo algum:
 * o destino responde 503 `webhook_not_configured` (fail-closed) ou 401 para
 * assinatura inválida — ambos são recusas seguras.
 *
 * COMO USAR
 * ---------
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_ANON_KEY=<anon key> \
 *   node scripts/smoke-edge-functions.mjs
 *
 * O teste é somente leitura: usa credenciais inválidas/ausentes e payloads
 * rejeitados antes de qualquer escrita. Não passe JWT administrativo por aqui.
 * Sai com código 1 se qualquer verificação falhar. Nenhum segredo é impresso.
 */

const BASE = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY ?? '';

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

  // create-order: payload inválido é recusado sem gravar pedido.
  // (O smoke não oferece modo de pedido real por política de segurança.)
  // order-status é coberto com um identificador inexistente, sem dados reais.
  {
    const { status, text } = await call('order-status', {
      body: {
        order_id: '00000000-0000-4000-8000-000000000000',
        client_token: 'a'.repeat(40),
      },
    });
    record('order-status não revela pedido inexistente', [403, 404], status, text);
  }

  // 4. entrega: token inventado não revela nada.
  {
    const { status, text } = await call('delivery', { body: { token: 'b'.repeat(43) } });
    record('delivery recusa token inexistente', 404, status, text);
  }

  // 5. webhook sem assinatura válida não processa nada.
  // Comportamento real documentado: sem MP_WEBHOOK_SECRET o handler é
  // fail-closed e responde 503 webhook_not_configured ANTES de qualquer
  // gravação (nada é processado); com o segredo configurado, assinatura
  // inválida rende 401. Ambos os desfechos são recusas seguras.
  {
    const { status, text } = await call('mp-webhook', {
      body: { type: 'payment', data: { id: '1' } },
      headers: { 'x-signature': 'ts=1,v1=deadbeef', 'x-request-id': 'smoke' },
    });
    record('mp-webhook recusa notificação não autenticada', [400, 401, 403, 503], status, text);
  }

  // 6. rotas administrativas exigem JWT no gateway.
  {
    const { status, text } = await call('admin-api', { body: { action: 'session' } });
    record('admin-api sem JWT é 401', 401, status, text);
  }
  {
    const { status, text } = await call('admin-api', {
      body: { action: 'session' },
      jwt: 'invalid-smoke-token',
    });
    record('admin-api recusa JWT inválido', 401, status, text);
  }

  // 7. demo-payment: capabilities é somente leitura; payload inválido é
  // rejeitado antes de qualquer RPC (nenhum pagamento é criado).
  {
    const { status, text } = await call('demo-payment', { method: 'GET' });
    const okShape = status === 200 && text.includes('demo_enabled');
    results.push({ name: 'demo-payment capabilities somente leitura', ok: okShape, expected: '200 + demo_enabled', actual: status });
    console.log(`${okShape ? 'PASS' : 'FAIL'}  demo-payment capabilities somente leitura  (esperado 200 + demo_enabled, recebido ${status})`);
    const preview = text.replace(/\s+/g, ' ').slice(0, 140);
    if (preview) console.log(`      ${preview}`);
  }
  {
    const { status, text } = await call('demo-payment', {
      body: { action: 'approve', order_id: 'nao-e-uuid', client_token: 'a'.repeat(40) },
    });
    record('demo-payment recusa payload inválido sem pagar', 422, status, text);
  }

  // 8. order-request: payload inválido é rejeitado na validação do handler
  // antes de qualquer RPC — nenhum pedido/solicitação é criado.
  {
    const { status, text } = await call('order-request', { body: { items: 'invalido' } });
    record('order-request recusa payload inválido sem criar pedido', 422, status, text);
  }

  // 9. wyvi-webhook (API v2): entrega sem prova de origem nunca processa.
  // Comportamento real documentado: sem WYVI_WEBHOOK_SECRET o handler é
  // fail-closed e responde 503 ANTES de qualquer gravação; com o segredo
  // configurado, assinatura inválida rende 401. Os dois desfechos são
  // recusas seguras — e nenhum deles revela segredo algum.
  {
    const { status, text } = await call('wyvi-webhook', {
      body: { id: '00000000-0000-4000-8000-000000000000', evento: 'cobranca.paga', dados: { txid: 'test000' } },
      headers: {
        'x-wyvi-assinatura': 'v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        'x-wyvi-carimbo': String(Math.floor(Date.now() / 1000)),
        'x-wyvi-entrega': '00000000-0000-4000-8000-000000000001',
        'x-wyvi-evento': 'cobranca.paga',
      },
    });
    record('wyvi-webhook recusa notificação não autenticada', [401, 503], status, text);
  }
  {
    const { status, text } = await call('wyvi-webhook', { body: { evento: 'cobranca.paga' } });
    record('wyvi-webhook sem cabeçalhos X-Wyvi é recusado', [401, 503], status, text);
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificações passaram.`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Falha ao executar o smoke test:', error instanceof Error ? error.message : error);
  process.exit(1);
});
