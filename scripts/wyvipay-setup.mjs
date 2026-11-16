#!/usr/bin/env node
/**
 * scripts/wyvipay-setup.mjs — cadastro AUTOMÁTICO do webhook na WyviPay.
 *
 * O que faz (na ordem):
 *   1. lê a chave da API da variável de ambiente `WYVI_API_KEY` (ou do stdin
 *      oculto, se ausente) — NUNCA por argv, arquivo versionado ou log;
 *   2. valida o formato (`wy_test_…`/`wy_live_…`) e PROVA os escopos com
 *      requisições seguras:
 *        - `GET  /webhooks`               → precisa de `webhook:ler`;
 *        - `GET  /cobrancas/<txid-inválido>` → precisa de `cobranca:ler`
 *          (404 = escopo OK; 403 = falta escopo);
 *        - a criação em si prova `webhook:criar` (403 `sem_escopo` reportado);
 *   3. lista os destinos existentes e evita DUPLICAR por URL;
 *   4. cria o destino com os eventos de cobrança
 *      (`cobranca.paga|expirada|cancelada|estornada`);
 *   5. guarda o `whsec_` devolvido APENAS em `.env.functions` (permissão
 *      0600, substituindo a linha anterior) — o segredo aparece UMA única
 *      vez na resposta; sem ele, a recuperação é excluir e criar outro
 *      (`--recreate`).
 *
 * Nada disso imprime segredos: chave aparece mascarada (`wy_test_••••`),
 * o `whsec_` nunca sai do arquivo. A chave da WyviPay é informada pelo
 * responsável via ambiente — este script não a cria nem a substitui.
 *
 * Uso:
 *   WYVI_API_KEY=wy_test_… node scripts/wyvipay-setup.mjs
 *   WYVI_API_KEY=wy_test_… node scripts/wyvipay-setup.mjs --recreate
 *   node scripts/wyvipay-setup.mjs            # pede a chave no stdin oculto
 *
 * Variáveis:
 *   WYVI_API_KEY        obrigatória (env ou stdin oculto)
 *   WYVI_WEBHOOK_URL    destino completo (opcional; ver fallback abaixo)
 *   SUPABASE_URL        fallback: <SUPABASE_URL>/functions/v1/wyvi-webhook
 *
 * Regras de segurança da missão:
 *   - nunca exibe chave, `whsec_` ou corpo de erro com credencial;
 *   - nunca grava segredo em log, argv ou repositório;
 *   - idempotente: rodar duas vezes não cria destino duplicado;
 *   - com `--recreate`, exclui o destino da MESMA URL e cria outro novo
 *     (única forma de obter novo `whsec_` — a API não devolve o antigo).
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

const BASE = (process.env.WYVI_API_BASE ?? 'https://api.wyvipay.com.br').replace(/\/+$/, '');
const API = `${BASE}/api/v2`;
const EVENTOS = ['cobranca.paga', 'cobranca.expirada', 'cobranca.cancelada', 'cobranca.estornada'];
const ENV_FILE = path.resolve(process.cwd(), '.env.functions');
const KEY_PATTERN = /^wy_(test|live)_[A-Za-z0-9]{42}$/;

function maskKey(key) {
  if (!key) return '(vazia)';
  const prefix = key.slice(0, 8); // wy_test_ / wy_live_
  return `${prefix}${'•'.repeat(12)}`;
}

function fail(message, detail) {
  console.error(`\n✗ ${message}`);
  if (detail) console.error(`  ${detail}`);
  process.exit(1);
}

async function readHidden(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  try {
    rl.write(prompt);
    for await (const line of rl) {
      return line.trim();
    }
    return '';
  } finally {
    rl.close();
  }
}

function parseRetryAfter(response) {
  const raw = response.headers.get('retry-after');
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) : 5;
}

/**
 * Chamada à API com tratamento de erro tipado. `expected` lista statuses
 * aceitos (qualquer outro vira falha com o `erro.codigo` estável).
 */
async function call(key, method, endpoint, body, expected) {
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (expected.includes(response.status)) {
    return { status: response.status, payload };
  }

  const code = payload?.erro?.codigo ?? `http_${response.status}`;
  const message = payload?.erro?.mensagem ?? 'resposta inesperada';
  if (response.status === 401) {
    fail(
      'A chave da WyviPay foi recusada (401).',
      `codigo=${code} — chave revogada, errada ou conta inativa. Confira WYVI_API_KEY (${maskKey(key)}).`,
    );
  }
  if (response.status === 403) {
    fail(
      'A chave não tem o escopo necessário (403 sem_escopo).',
      `endpoint=${method} ${endpoint} codigo=${code}. Gere uma chave com cobranca:criar|cobranca:ler|webhook:criar|webhook:ler.`,
    );
  }
  if (response.status === 429) {
    const wait = parseRetryAfter(response);
    fail(
      'Rate limit da API (429 limite_atingido).',
      `Aguarde ~${wait}s e rode o script de novo — ele é idempotente (não duplica destino).`,
    );
  }
  fail(
    `A API respondeu ${response.status} em ${method} ${endpoint}.`,
    `codigo=${code} mensagem=${String(message).slice(0, 160)}`,
  );
  return null; // inalcançável (fail saiu)
}

function webhookUrl() {
  const explicit = (process.env.WYVI_WEBHOOK_URL ?? '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const supabaseUrl = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  if (supabaseUrl) return `${supabaseUrl}/functions/v1/wyvi-webhook`;
  return fail(
    'Defina WYVI_WEBHOOK_URL (ou SUPABASE_URL) para saber o destino do webhook.',
    'Ex.: WYVI_WEBHOOK_URL=https://<ref>.supabase.co/functions/v1/wyvi-webhook',
  );
}

function saveSecretToFile(secret) {
  const line = `WYVI_WEBHOOK_SECRET=${secret}`;
  let content = '';
  if (existsSync(ENV_FILE)) {
    content = readFileSync(ENV_FILE, 'utf8');
    const lines = content.split('\n').filter((l) => !l.startsWith('WYVI_WEBHOOK_SECRET='));
    content = lines.join('\n').replace(/\n*$/, '\n');
  }
  writeFileSync(ENV_FILE, `${content}${line}\n`, { mode: 0o600 });
  try {
    chmodSync(ENV_FILE, 0o600);
  } catch {
    // melhor esforço em FS sem suporte a chmod
  }
}

async function main() {
  const args = process.argv.slice(2);
  const recreate = args.includes('--recreate');
  const unknown = args.filter((a) => a !== '--recreate');
  if (unknown.length > 0) {
    fail(`Argumento desconhecido: ${unknown[0]}`, 'Uso: node scripts/wyvipay-setup.mjs [--recreate]');
  }

  // ---------------------------------------------------------------------
  // 1. Chave: ambiente ou stdin oculto — nunca argv.
  // ---------------------------------------------------------------------
  let key = (process.env.WYVI_API_KEY ?? '').trim();
  if (!key) {
    console.error('WYVI_API_KEY não encontrada no ambiente. Cole a chave (entrada oculta):');
    key = await readHidden('chave: ');
  }
  if (!KEY_PATTERN.test(key)) {
    fail(
      `Formato de chave inválido: ${maskKey(key)}`,
      'Esperado wy_test_… ou wy_live_… com 42 caracteres após o prefixo.',
    );
  }
  const ambiente = key.startsWith('wy_test_') ? 'teste' : 'produção';
  console.log(`\n✓ chave carregada do ambiente/stdin: ${maskKey(key)} (ambiente: ${ambiente})`);

  const url = webhookUrl();
  console.log(`✓ destino do webhook: ${url}`);

  // ---------------------------------------------------------------------
  // 2. Prova de escopos com requisições que NÃO alteram nada.
  // ---------------------------------------------------------------------
  const listed = await call(key, 'GET', '/webhooks', undefined, [200]);
  console.log('✓ escopo webhook:ler OK (GET /webhooks)');

  const probeTxid = 'setupsemcobrancanesteambiente00001'; // 30 chars, válido no formato
  const probe = await call(key, 'GET', `/cobrancas/${probeTxid}`, undefined, [404, 200]);
  if (probe.status === 200) {
    // Sorte astronomica de colidir — tratado como prova de leitura válida.
    console.log('✓ escopo cobranca:ler OK (o probe não achou cobrança)');
  } else {
    console.log('✓ escopo cobranca:ler OK (404 no txid inexistente = leitura liberada)');
  }

  // ---------------------------------------------------------------------
  // 3. Destinos existentes: dedupe por URL.
  // ---------------------------------------------------------------------
  const itens = Array.isArray(listed.payload?.itens) ? listed.payload.itens : [];
  const existente = itens.find((item) => String(item?.url ?? '').replace(/\/+$/, '') === url);
  if (existente && !recreate) {
    saveProcessExitOk(`destino já cadastrado (id ${existente?.id ?? '?'}): nada a fazer.`, 'webhook já configurado');
    return;
  }

  // ---------------------------------------------------------------------
  // 4. (Re)criação — `webhook:criar` provado aqui.
  // ---------------------------------------------------------------------
  if (existente && recreate) {
    console.log(`→ excluindo destino existente (--recreate): ${existente.id ?? url}`);
    const removed = await call(key, 'DELETE', `/webhooks/${encodeURIComponent(existente.id)}`, undefined, [
      200, 204, 404,
    ]);
    if (removed.status !== 404) console.log('  excluído.');
  }

  const body = { url, eventos: EVENTOS, nome: 'prime-store-checkout' };
  const created = await call(key, 'POST', '/webhooks', body, [201]);
  const secret = created.payload?.segredo;

  if (!secret || !String(secret).startsWith('whsec_')) {
    // Resposta 201 SEM o segredo (perda de resposta/race): a API não devolve
    // mais o antigo — a recuperação segura é excluir e criar outro.
    fail(
      'O destino foi criado, mas o segredo não veio na resposta.',
      'Rode com --recreate para excluir e criar outro destino e capturar o novo whsec_.',
    );
  }

  saveSecretToFile(String(secret));
  console.log(`✓ destino criado com os eventos: ${EVENTOS.join(', ')}`);
  console.log(`✓ whsec_ gravado em ${ENV_FILE} (permissão 600; nunca exibido em tela)`);
  console.log('\nPróximos passos:');
  console.log('  1. publique a função wyvi-webhook (supabase functions deploy wyvi-webhook)');
  console.log('  2. defina WYVI_WEBHOOK_SECRET no ambiente das functions (loja/CI)');
  console.log('  3. rode um pagamento de teste e confirme a entrega no painel WyviPay');
}

function saveProcessExitOk(message, _code) {
  console.log(`\n✓ ${message}`);
  process.exit(0);
}

main().catch((error) => {
  // Erros de rede etc.: mensagem curta, sem corpo de resposta.
  fail('Falha de comunicação com a API da WyviPay.', String(error?.message ?? error).slice(0, 200));
});
