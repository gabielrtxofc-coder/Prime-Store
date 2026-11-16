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
 *   1. recebe a chave de maneira interativa e OCULTA (TTY real em modo raw
 *      com eco desativado — Enter, backspace, Ctrl+C; restaura o terminal
 *      em qualquer cenário). `WYVI_API_KEY` só é aceita em execução NÃO
 *      interativa (automação/CI, sem TTY). Nunca por argumento de linha
 *      de comando; sem TTY seguro e sem env ⇒ erro explícito (nunca
 *      fallback com eco);
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
 *        - ou Supabase CLI autenticada, SEM segredos em argv:
 *          `supabase secrets set --env-file <temp0600> --project-ref <ref>`
 *          (sintaxe confirmada com a própria CLI via `--help` antes;
 *          arquivo temporário exclusivo com permissão 600, removido em
 *          `finally`); verificação por `secrets list` (só nomes);
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
 *   npm run wyvi:setup                    # caminho manual normal (TTY oculto)
 *   npm run wyvi:setup -- --recreate      # troca o destino (novo whsec_)
 *   WYVI_API_KEY=wy_test_… npm run wyvi:setup   # só automação/CI (sem TTY)
 *
 * Variáveis:
 *   WYVI_API_KEY             automação/CI (sem TTY); no manual, digite oculto
 *   WYVI_WEBHOOK_URL         destino completo (opcional; ver fallback)
 *   SUPABASE_URL             fallback: <SUPABASE_URL>/functions/v1/wyvi-webhook
 *   SUPABASE_PROJECT_REF     opcional (senão deriva de SUPABASE_URL)
 *   SUPABASE_ACCESS_TOKEN    PAT p/ Management API (recomendado em CI)
 *   SUPABASE_MGMT_API_BASE   override da base da API de gestão (testes)
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
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

/** Redige valores de segredo em qualquer texto de erro/log (nunca vazam). */
function redactDetail(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s.value) out = out.split(s.value).join('[REMOVIDO]');
  }
  return out.slice(0, 200);
}

/** O output de `secrets list` menciona o nome exato (limites não-ident)? */
export function cliListShowsName(output, name) {
  const re = new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`);
  return re.test(String(output ?? ''));
}

/**
 * Caminho CLI SEM segredos em argv:
 *   1. confirma a sintaxe com a própria CLI (`secrets set --help` deve
 *      listar `--env-file` — sem suporte ⇒ bloqueio explícito, nunca
 *      fallback para argv com valores);
 *   2. grava arquivo temporário exclusivo com permissão 600;
 *   3. `supabase secrets set --env-file <arq> --project-ref <ref>`;
 *   4. verifica por NOMES via `secrets list` (nunca valores);
 *   5. remove o arquivo temporário em QUALQUER cenário (finally).
 */
export function installViaCli({ secrets, projectRef, spawn = spawnSync, tmpBase = tmpdir() }) {
  const help = spawn('supabase', ['secrets', 'set', '--help'], { encoding: 'utf8' });
  if (help.error) return { ok: false, reason: 'cli_ausente' };
  const helpOut = `${help.stdout ?? ''}${help.stderr ?? ''}`;
  if (help.status !== 0 || !helpOut.includes('--env-file')) {
    return {
      ok: false,
      reason: 'cli_sem_env_file',
      detail: 'Supabase CLI sem suporte a `secrets set --env-file`; atualize a CLI (segredos nunca vão por argv).',
    };
  }

  const dir = mkdtempSync(path.join(tmpBase, 'wyvi-secrets-'));
  const file = path.join(dir, 'secrets.env');
  try {
    writeFileSync(file, `${secrets.map((s) => `${s.name}=${s.value}`).join('\n')}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    chmodSync(file, 0o600);

    const result = spawn(
      'supabase',
      ['secrets', 'set', '--env-file', file, '--project-ref', projectRef],
      { encoding: 'utf8' },
    );
    if (result.error) return { ok: false, reason: 'cli_ausente', tempFile: file };
    if (result.status !== 0) {
      return { ok: false, reason: 'cli_falhou', detail: redactDetail(result.stderr ?? result.stdout, secrets), tempFile: file };
    }

    const list = spawn('supabase', ['secrets', 'list', '--project-ref', projectRef], { encoding: 'utf8' });
    if (list.error) return { ok: false, reason: 'verificacao_falhou', detail: 'secrets list indisponível', tempFile: file };
    if (list.status !== 0) {
      return { ok: false, reason: 'verificacao_falhou', detail: redactDetail(list.stderr ?? list.stdout, secrets), tempFile: file };
    }
    const saida = `${list.stdout ?? ''}`;
    const faltando = secrets.filter((s) => !cliListShowsName(saida, s.name)).map((s) => s.name);
    if (faltando.length > 0) {
      return { ok: false, reason: 'nomes_ausentes', detail: faltando.join(', '), tempFile: file };
    }
    return { ok: true, tempFile: file };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    if (!inst.ok) {
      return {
        ok: false,
        fase: inst.reason === 'nomes_ausentes' || inst.reason === 'verificacao_falhou' ? 'verificacao' : 'instalacao',
        motivo: inst.reason,
        detalhe: inst.detail,
        mecanismo: 'cli',
      };
    }
    return { ok: true, mecanismo: 'cli', projectRef, verificacao: 'lista_nomes' };
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

/**
 * Entrada OCULTA em TTY real: modo raw (o terminal desativa o eco),
 * tratando Enter, backspace, Ctrl+C (e sequências de seta ignoradas).
 * Restaura o terminal em QUALQUER cenário (sucesso, erro, sinal).
 * Nunca exibe nem registra o valor digitado. Sem TTY seguro → erro
 * explícito (nunca lê pipe/stdin com eco implícito).
 *
 * `stdin`/`write`/`exit` são injetáveis para os testes de unidade;
 * no uso real vêm de `process`.
 */
export async function readHidden(
  prompt,
  { stdin = process.stdin, write = (text) => process.stderr.write(text), exit = (code) => process.exit(code) } = {},
) {
  if (!stdin || !stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error(
      'entrada insegura: sem TTY — a chave deve ser digitada em um terminal com eco desativado; em automação/CI use WYVI_API_KEY.',
    );
  }
  const wasRaw = Boolean(stdin.isRaw);
  return await new Promise((resolve, reject) => {
    let buf = '';
    let escapeState = 0; // 0=normal, 1=após ESC, 2=dentro de CSI/SS3
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // terminal já restaurado ou indisponível — nada mais a fazer
      }
      stdin.pause();
    };
    const cancel = (message, exitCode) => {
      cleanup();
      write('\n');
      const error = new Error(message);
      error.cancelled = true;
      error.exitCode = exitCode;
      reject(error);
    };
    const onEnd = () => cancel('entrada encerrada antes do Enter (EOF).', 1);
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onSigint = () => {
      cleanup();
      exit(130);
    };
    const onSigterm = () => {
      cleanup();
      exit(143);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (escapeState === 2) {
          // CSI/SS3 (ESC [ … final / ESC O … final): descarta até o byte final
          if (ch >= '@' && ch <= '~') escapeState = 0;
          continue;
        }
        if (escapeState === 1) {
          // byte após ESC: '[' ou 'O' iniciam sequência; senão é byte final solto
          escapeState = ch === '[' || ch === 'O' ? 2 : 0;
          continue;
        }
        if (ch === '\u001b') {
          escapeState = 1;
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          write('\n');
          resolve(buf.trim());
          return;
        }
        if (ch === '\u0003') {
          cancel('entrada cancelada (Ctrl+C).', 130);
          return;
        }
        if (ch === '\u0004') {
          if (buf.length === 0) cancel('entrada vazia (Ctrl+D).', 1);
          continue;
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        if (ch < ' ') continue; // demais controles ignorados
        buf += ch;
      }
    };
    try {
      stdin.setRawMode(true);
    } catch (error) {
      reject(new Error(`não foi possível ativar o modo raw do terminal: ${error.message}`));
      return;
    }
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    stdin.resume();
    write(prompt);
  });
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
  // 1. Chave: env WYVI_API_KEY (automação/CI) OU entrada OCULTA em TTY
  //    (caminho manual normal) — nunca argv; sem env e sem TTY seguro ⇒
  //    erro explícito (nunca fallback lendo pipe com eco).
  // ---------------------------------------------------------------------
  let key;
  let keyVia;
  const envKey = (process.env.WYVI_API_KEY ?? '').trim();
  if (envKey) {
    key = envKey;
    keyVia = 'WYVI_API_KEY (automação)';
  } else if (process.stdin.isTTY) {
    console.error('Cole a chave WyviPay (entrada oculta — nada aparecerá na tela):');
    try {
      key = await readHidden('chave: ');
      keyVia = 'entrada oculta';
    } catch (error) {
      if (error?.cancelled) {
        console.error(`\n✗ ${error.message}`);
        process.exit(error.exitCode ?? 130);
      }
      fail('Não foi possível ler a chave do terminal.', String(error?.message ?? error));
    }
  } else {
    fail(
      'Sem TTY seguro e sem WYVI_API_KEY: entrada da chave recusada.',
      'Rode em um terminal interativo (a chave é digitada com eco desativado) ou exporte WYVI_API_KEY em automação/CI.',
    );
  }
  const chave = validateKey(key);
  if (!chave.ok) {
    fail(
      `Formato de chave inválido: ${maskKey(key)}`,
      'Esperado wy_test_… ou wy_live_… com 42 caracteres após o prefixo.',
    );
  }
  const ambiente = chave.ambiente;
  console.log(`\n✓ chave carregada via ${keyVia}: ${maskKey(key)} (ambiente: ${ambiente})`);

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
