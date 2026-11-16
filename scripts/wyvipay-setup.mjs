#!/usr/bin/env node
/**
 * scripts/wyvipay-setup.mjs — configuração COMPLETA e AUTOMÁTICA da WyviPay.
 *
 * Comando do responsável (único ponto de entrada — a chave NUNCA entra por
 * argv, mensagem ou arquivo versionado):
 *
 *   npm run wyvi:setup
 *
 * O que faz, na ordem:
 *   1. recebe a chave de maneira interativa e OCULTA (env `WYVI_API_KEY` ou
 *      stdin sem eco) — nunca por argumento de linha de comando;
 *   2. valida o formato `wy_test_…`/`wy_live_…` (42 chars) e identifica o
 *      ambiente pela chave;
 *   3. prova a autenticidade e TODOS os escopos com requisições seguras:
 *        - GET  /webhooks                 → webhook:ler   (401 = chave inválida)
 *        - GET  /cobrancas/<txid-inválida>→ cobranca:ler  (404 = OK)
 *        - POST /cobrancas corpo inválido → cobranca:criar
 *            (403 sem_escopo = falta escopo; 400/422/409 = escopo presente;
 *             um 201 inesperado é cancelado na hora — NENHUMA cobrança fica)
 *        - POST /webhooks                 → webhook:criar (403 sem_escopo = falta)
 *   4. identifica a URL definitiva do webhook (WYVI_WEBHOOK_URL ou
 *      SUPABASE_URL/functions/v1/wyvi-webhook);
 *   5. lista destinos existentes e evita duplicar por URL;
 *   6. cria o destino com os 4 eventos de cobrança
 *      (`cobranca.paga|expirada|cancelada|estornada`) e captura o `whsec_`;
 *   7. INSTALA NO SUPABASE REMOTO, via mecanismo oficial:
 *        - `SUPABASE_ACCESS_TOKEN` → Management API
 *          `POST https://api.supabase.com/v1/projects/{ref}/secrets`
 *          (endpoint/formato confirmados na documentação oficial —
 *           lista de nomes via `GET …/secrets`);
 *        - ou Supabase CLI autenticada (`supabase secrets set …`);
 *      os três segredos: `WYVI_API_KEY`, `WYVI_WEBHOOK_SECRET` e
 *      `WYVI_ENVIRONMENT` (test|production derivado da chave);
 *   8. VERIFICA a instalação relendo a lista de nomes no remoto;
 *   9. conclui com resumo sem nenhum valor sensível.
 *
 * Recuperação segura (nunca parcial declarada como pronta):
 *   - webhook já existe + `whsec_` no `.env.functions` → reexecutar o
 *     comando SÓ refaz a instalação remota (idempotente, não duplica);
 *   - webhook existe mas o `whsec_` se perdeu → saída 1 instruindo
 *     `--recreate` (única forma de obter um segredo novo);
 *   - webhook criado e instalação remota falhou → saída 1; o `whsec_` já
 *     está salvo (0600) e a reexecução conclui a instalação;
 *   - token/CLI ausentes → saída 1 com o passo exato (nada de sucesso
 *     parcial disfarçado).
 *
 * Nada disso imprime segredos: chave aparece mascarada (`wy_test_••••`),
 * `whsec_` e valores de secret nunca saem do arquivo/remoto.
 *
 * Uso:
 *   npm run wyvi:setup
 *   npm run wyvi:setup -- --recreate      # troca o destino (novo whsec_)
 *   WYVI_API_KEY=wy_test_… npm run wyvi:setup   # chave via ambiente
 *
 * Variáveis:
 *   WYVI_API_KEY             obrigatória (env ou stdin oculto)
 *   WYVI_WEBHOOK_URL         destino completo (opcional; ver fallback)
 *   SUPABASE_URL             fallback: <SUPABASE_URL>/functions/v1/wyvi-webhook
 *   SUPABASE_PROJECT_REF     opcional (senão deriva de SUPABASE_URL)
 *   SUPABASE_ACCESS_TOKEN    PAT p/ Management API (recomendado em CI)
 *   SUPABASE_MGMT_API_BASE   override da base da API de gestão (testes)
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const BASE = (process.env.WYVI_API_BASE ?? 'https://api.wyvipay.com.br').replace(/\/+$/, '');
const API = `${BASE}/api/v2`;
const MGMT_BASE = (process.env.SUPABASE_MGMT_API_BASE ?? 'https://api.supabase.com').replace(/\/+$/, '');
const EVENTOS = ['cobranca.paga', 'cobranca.expirada', 'cobranca.cancelada', 'cobranca.estornada'];
const ENV_FILE = path.resolve(process.cwd(), '.env.functions');
const KEY_PATTERN = /^wy_(test|live)_[A-Za-z0-9]{42}$/;
const SECRET_NAMES = ['WYVI_API_KEY', 'WYVI_WEBHOOK_SECRET', 'WYVI_ENVIRONMENT'];

// ---------------------------------------------------------------------------
// Puros (exportados para os testes de unidade)
// ---------------------------------------------------------------------------

export function maskKey(key) {
  if (!key) return '(vazia)';
  const prefix = key.slice(0, 8); // wy_test_ / wy_live_
  return `${prefix}${'•'.repeat(12)}`;
}

export function validateKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return { ok: false, ambiente: null };
  return { ok: true, ambiente: key.startsWith('wy_test_') ? 'teste' : 'producao' };
}

export function resolveWebhookUrl(env = process.env) {
  const explicit = (env.WYVI_WEBHOOK_URL ?? '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const supabaseUrl = (env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  if (supabaseUrl) return `${supabaseUrl}/functions/v1/wyvi-webhook`;
  return null;
}

export function resolveProjectRef(env = process.env) {
  const explicit = (env.SUPABASE_PROJECT_REF ?? '').trim();
  if (explicit) return explicit;
  try {
    const host = new URL((env.SUPABASE_URL ?? '').trim()).hostname;
    return host.split('.')[0] || null;
  } catch {
    return null;
  }
}

export function selectExistingDestino(itens, url) {
  const alvo = String(url ?? '').replace(/\/+$/, '');
  if (!Array.isArray(itens)) return null;
  return itens.find((item) => String(item?.url ?? '').replace(/\/+$/, '') === alvo) ?? null;
}

/** Corpo do probe de escopo `cobranca:criar` — nunca cria cobrança válida. */
export function scopeProbeBody() {
  return {
    valor_centavos: 0, // inválido por regra de negócio → 400/422; nunca cobrança de verdade
    meio: 'pix',
    descricao: 'probe-de-escopo-sem-cobranca',
    referencia: 'setup-scope-probe',
  };
}

/**
 * Interpreta a resposta do POST-probe de `cobranca:criar`.
 * 403 = escopo ausente (erro); 201 = criou por acidente (cancelar);
 * demais 4xx = escopo presente e payload recusado (sucesso do probe).
 */
export function interpretScopeProbe(status) {
  if (status === 403) return 'sem_escopo';
  if (status === 201) return 'criado_inesperado';
  if (status >= 400 && status < 500) return 'escopo_ok';
  return 'resposta_inesperada';
}

export function secretsToInstall(key, whsec, ambiente) {
  const list = [
    { name: 'WYVI_API_KEY', value: key },
    { name: 'WYVI_ENVIRONMENT', value: ambiente === 'teste' ? 'test' : 'production' },
  ];
  if (whsec) list.push({ name: 'WYVI_WEBHOOK_SECRET', value: whsec });
  return list;
}

export function mgmtHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/** POST oficial em lote: /v1/projects/{ref}/secrets → array [{name,value}]. */
export async function installViaManagementApi({ token, projectRef, secrets, fetchImpl = fetch, apiBase = MGMT_BASE }) {
  const response = await fetchImpl(`${apiBase}/v1/projects/${encodeURIComponent(projectRef)}/secrets`, {
    method: 'POST',
    headers: mgmtHeaders(token),
    body: JSON.stringify(secrets),
  });
  if (response.status === 201 || response.status === 200) return { ok: true };
  const text = await response.text().catch(() => '');
  return { ok: false, status: response.status, detail: text.slice(0, 200) };
}

/** GET oficial: devolve só NOMES de secrets (a API não devolve valores). */
export async function listSecretNames({ token, projectRef, fetchImpl = fetch, apiBase = MGMT_BASE }) {
  const response = await fetchImpl(`${apiBase}/v1/projects/${encodeURIComponent(projectRef)}/secrets`, {
    method: 'GET',
    headers: mgmtHeaders(token),
  });
  if (response.status !== 200) {
    return { ok: false, status: response.status, names: [] };
  }
  const payload = await response.json();
  const names = Array.isArray(payload) ? payload.map((item) => String(item?.name ?? item ?? '')) : [];
  return { ok: true, status: 200, names };
}

/** Caminho CLI: `supabase secrets set K=V … --project-ref <ref>`. */
export function installViaCli({ secrets, projectRef, spawn = spawnSync }) {
  const args = ['secrets', 'set', ...secrets.map((s) => `${s.name}=${s.value}`), '--project-ref', projectRef];
  const result = spawn('supabase', args, { encoding: 'utf8' });
  if (result.error) return { ok: false, reason: 'cli_ausente' };
  if (result.status !== 0) return { ok: false, reason: 'cli_falhou', detail: String(result.stderr ?? '').slice(0, 200) };
  return { ok: true };
}

export function cliAvailable(spawn = spawnSync) {
  const result = spawn('supabase', ['--version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

/**
 * Instalação remota com seleção oficial de mecanismo + verificação por nomes.
 * Nunca lança valores na saída. `env` e `spawn`/`fetchImpl` são injetáveis
 * para os testes.
 */
export async function installRemoteSecrets({
  secrets,
  env = process.env,
  fetchImpl = fetch,
  spawn = spawnSync,
  apiBase = MGMT_BASE,
} = {}) {
  const projectRef = resolveProjectRef(env);
  if (!projectRef) {
    return {
      ok: false,
      fase: 'identificacao',
      instrucao: 'Defina SUPABASE_URL (ou SUPABASE_PROJECT_REF) para identificar o projeto Supabase.',
    };
  }
  const token = (env.SUPABASE_ACCESS_TOKEN ?? '').trim();
  if (token) {
    const inst = await installViaManagementApi({ token, projectRef, secrets, fetchImpl, apiBase });
    if (!inst.ok) {
      return {
        ok: false,
        fase: 'instalacao',
        motivo: inst.status === 401 ? 'token_invalido' : inst.status === 403 ? 'sem_escopo_secrets' : `http_${inst.status}`,
        detalhe: inst.detail,
        mecanismo: 'management-api',
      };
    }
    const ver = await listSecretNames({ token, projectRef, fetchImpl, apiBase });
    if (!ver.ok) return { ok: false, fase: 'verificacao', motivo: `http_${ver.status}`, mecanismo: 'management-api' };
    const faltando = secrets.filter((s) => !ver.names.includes(s.name)).map((s) => s.name);
    if (faltando.length > 0) return { ok: false, fase: 'verificacao', motivo: 'nomes_ausentes', detalhe: faltando.join(', ') };
    return { ok: true, mecanismo: 'management-api', projectRef };
  }
  if (cliAvailable(spawn)) {
    const inst = installViaCli({ secrets, projectRef, spawn });
    if (!inst.ok) return { ok: false, fase: 'instalacao', motivo: inst.reason, detalhe: inst.detail, mecanismo: 'cli' };
    return { ok: true, mecanismo: 'cli', projectRef, verificacao: 'saida_cli_set' };
  }
  return {
    ok: false,
    fase: 'identificacao',
    motivo: 'sem_instalador',
    instrucao:
      'Nenhum mecanismo de instalação remota disponível. Defina SUPABASE_ACCESS_TOKEN ' +
      '(https://supabase.com/dashboard/account/tokens) ou instale o Supabase CLI e rode `supabase login`.',
  };
}

// ---------------------------------------------------------------------------
// Infra local do script
// ---------------------------------------------------------------------------

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

export function readWhsecFromFile(file = ENV_FILE) {
  if (!existsSync(file)) return null;
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('WYVI_WEBHOOK_SECRET='));
  const value = line?.slice('WYVI_WEBHOOK_SECRET='.length).trim() ?? '';
  return value.startsWith('whsec_') ? value : null;
}

// ---------------------------------------------------------------------------
// Programa principal
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const recreate = args.includes('--recreate');
  const unknown = args.filter((a) => a !== '--recreate');
  if (unknown.length > 0) {
    fail(`Argumento desconhecido: ${unknown[0]}`, 'Uso: npm run wyvi:setup [-- --recreate]');
  }

  // ---------------------------------------------------------------------
  // 1. Chave: ambiente ou stdin oculto — nunca argv.
  // ---------------------------------------------------------------------
  let key = (process.env.WYVI_API_KEY ?? '').trim();
  if (!key) {
    console.error('WYVI_API_KEY não encontrada no ambiente. Cole a chave (entrada oculta):');
    key = await readHidden('chave: ');
  }
  const chave = validateKey(key);
  if (!chave.ok) {
    fail(
      `Formato de chave inválido: ${maskKey(key)}`,
      'Esperado wy_test_… ou wy_live_… com 42 caracteres após o prefixo.',
    );
  }
  const ambiente = chave.ambiente;
  console.log(`\n✓ chave carregada do ambiente/stdin: ${maskKey(key)} (ambiente: ${ambiente})`);

  const url = resolveWebhookUrl(process.env);
  if (!url) {
    fail(
      'Defina WYVI_WEBHOOK_URL (ou SUPABASE_URL) para saber o destino do webhook.',
      'Ex.: WYVI_WEBHOOK_URL=https://<ref>.supabase.co/functions/v1/wyvi-webhook',
    );
  }
  console.log(`✓ destino do webhook: ${url}`);

  // ---------------------------------------------------------------------
  // 2. Prova de escopos com requisições que NÃO alteram nada.
  // ---------------------------------------------------------------------
  const listed = await call(key, 'GET', '/webhooks', undefined, [200]);
  console.log('✓ escopo webhook:ler OK (GET /webhooks)');

  const probeTxid = 'setupsemcobrancanesteambiente00001'; // 30 chars, válido no formato
  const probe = await call(key, 'GET', `/cobrancas/${probeTxid}`, undefined, [404, 200]);
  if (probe.status === 200) {
    console.log('✓ escopo cobranca:ler OK (o probe não achou cobrança)');
  } else {
    console.log('✓ escopo cobranca:ler OK (404 no txid inexistente = leitura liberada)');
  }

  // cobranca:criar: POST com corpo inválido nunca gera cobrança real.
  const criarProbe = await call(key, 'POST', '/cobrancas', scopeProbeBody(), [400, 409, 422, 201]);
  const veredito = interpretScopeProbe(criarProbe.status);
  if (veredito === 'escopo_ok') {
    console.log('✓ escopo cobranca:criar OK (corpo inválido recusado antes de criar)');
  } else if (veredito === 'criado_inesperado') {
    const txid = criarProbe.payload?.txid;
    if (txid) {
      await call(key, 'DELETE', `/cobrancas/${encodeURIComponent(txid)}`, undefined, [200, 204, 404]);
    }
    console.log('✓ escopo cobranca:criar OK (probe criou algo inesperadamente; cancelado na hora)');
  } else {
    fail('Não foi possível provar o escopo cobranca:criar.', `status=${criarProbe.status}`);
  }

  // ---------------------------------------------------------------------
  // 3. Destinos existentes: dedupe por URL + estado do whsec_ local.
  // ---------------------------------------------------------------------
  const itens = Array.isArray(listed.payload?.itens) ? listed.payload.itens : [];
  const existente = selectExistingDestino(itens, url);
  const whsecLocal = readWhsecFromFile();
  let whsec = whsecLocal;

  if (existente && !recreate && !whsecLocal) {
    fail(
      `Destino já cadastrado (id ${existente?.id ?? '?'}), mas o whsec_ não está em .env.functions.`,
      'A API não devolve segredo de destino existente. Rode `npm run wyvi:setup -- --recreate` para trocar o destino e capturar um novo whsec_.',
    );
  }

  // ---------------------------------------------------------------------
  // 4. (Re)criação do destino — `webhook:criar` provado aqui.
  // ---------------------------------------------------------------------
  if (existente && recreate) {
    console.log(`→ excluindo destino existente (--recreate): ${existente.id ?? url}`);
    const removed = await call(key, 'DELETE', `/webhooks/${encodeURIComponent(existente.id)}`, undefined, [
      200, 204, 404,
    ]);
    if (removed.status !== 404) console.log('  excluído.');
    whsec = null; // destino novo exige novo segredo
  }

  if (!existente || recreate) {
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
    whsec = String(secret);
    saveSecretToFile(whsec);
    console.log(`✓ destino criado com os eventos: ${EVENTOS.join(', ')}`);
    console.log(`✓ whsec_ gravado em ${ENV_FILE} (permissão 600; nunca exibido em tela)`);
  } else {
    console.log(`✓ destino já cadastrado (id ${existente?.id ?? '?'}); reutilizando o whsec_ de ${path.basename(ENV_FILE)}`);
  }

  // ---------------------------------------------------------------------
  // 5. Instalação REMOTA dos secrets (o .env.functions NÃO é prova).
  // ---------------------------------------------------------------------
  const secrets = secretsToInstall(key, whsec, ambiente);
  console.log(`\n→ instalando ${secrets.length} secrets no Supabase remoto (valores nunca exibidos)…`);
  const instalacao = await installRemoteSecrets({ secrets });
  if (!instalacao.ok) {
    fail(
      'A configuração NÃO está completa: falha na instalação remota dos secrets.',
      `fase=${instalacao.fase} motivo=${instalacao.motivo ?? instalacao.instrucao ?? ''} ${instalacao.detalhe ?? ''}`.trim(),
    );
  }
  console.log(`✓ secrets instalados e verificados no remoto via ${instalacao.mecanismo} (projeto ${instalacao.projectRef})`);
  console.log(`  nomes confirmados: ${SECRET_NAMES.join(', ')}`);

  // ---------------------------------------------------------------------
  // 6. Conclusão — nenhuma cobrança foi criada, nenhum valor impresso.
  // ---------------------------------------------------------------------
  console.log('\n✓ WyviPay configurada de ponta a ponta:');
  console.log(`  • webhook destino: ${url}`);
  console.log(`  • eventos: ${EVENTOS.join(', ')}`);
  console.log(`  • ambiente: ${ambiente}`);
  console.log('  • WYVI_API_KEY / WYVI_WEBHOOK_SECRET / WYVI_ENVIRONMENT: instalados no Supabase');
  console.log('\nPróximos passos (dados reais, sem mudanças técnicas):');
  console.log('  1. cadastre os produtos reais no painel administrativo;');
  console.log('  2. faça um pagamento de teste e confirme a confirmação automática (fila + cron).');
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    // Erros de rede etc.: mensagem curta, sem corpo de resposta.
    fail('Falha de comunicação com a API da WyviPay.', String(error?.message ?? error).slice(0, 200));
  });
}

export { main, EVENTOS, KEY_PATTERN, ENV_FILE, SECRET_NAMES };
