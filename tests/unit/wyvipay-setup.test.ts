import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cliAvailable,
  cliListShowsName,
  installRemoteSecrets,
  installViaCli,
  installViaManagementApi,
  interpretScopeProbe,
  listSecretNames,
  maskKey,
  readHidden,
  readWhsecFromFile,
  resolveProjectRef,
  resolveWebhookUrl,
  scopeProbeBody,
  secretsToInstall,
  selectExistingDestino,
  validateKey,
} from '../../scripts/wyvipay-setup.mjs';

/**
 * `npm run wyvi:setup` (Fase 02) — cobre as regras puras e o caminho de
 * instalação REMOTA dos secrets via mecanismos oficiais documentados:
 *   - Management API: POST /v1/projects/{ref}/secrets com lista [{name,value}]
 *     e verificação por GET (só nomes);
 *   - Supabase CLI: `supabase secrets set …`.
 * Nenhum teste usa a chave real do responsável nem a rede.
 */

const KEY_TEST = `wy_test_${'a'.repeat(42)}`;
const KEY_LIVE = `wy_live_${'b'.repeat(42)}`;
const WHSEC = `whsec_${'c'.repeat(40)}`;

describe('setup — validação e mascaramento da chave', () => {
  it('aceita wy_test_/wy_live_ com 42 caracteres e identifica o ambiente', () => {
    expect(validateKey(KEY_TEST)).toEqual({ ok: true, ambiente: 'teste' });
    expect(validateKey(KEY_LIVE)).toEqual({ ok: true, ambiente: 'producao' });
  });

  it('recusa formatos inválidos (inclusive tentativas de injetar por argv)', () => {
    for (const bad of [
      '',
      'wy_test_curta',
      `wy_test_${'a'.repeat(41)}`,
      `wy_test_${'a'.repeat(43)}`,
      `wy_dev_${'a'.repeat(42)}`,
      `${KEY_TEST} --projeto-outro`,
      `$(rm -rf /)${KEY_TEST}`,
      'sb_secret_qualquer_coisa',
    ]) {
      expect(validateKey(bad).ok).toBe(false);
    }
  });

  it('mascara a chave em qualquer mensagem (nunca o valor integral)', () => {
    const masked = maskKey(KEY_TEST);
    expect(masked.startsWith('wy_test_')).toBe(true);
    expect(masked).not.toContain('a'.repeat(10));
    expect(maskKey('')).toBe('(vazia)');
  });
});

describe('setup — URL definitiva e projeto', () => {
  it('prefere WYVI_WEBHOOK_URL e cai para SUPABASE_URL/functions/v1/wyvi-webhook', () => {
    expect(resolveWebhookUrl({ WYVI_WEBHOOK_URL: ' https://x.test/v1/wyvi-webhook/ ' })).toBe(
      'https://x.test/v1/wyvi-webhook',
    );
    expect(resolveWebhookUrl({ SUPABASE_URL: 'https://ref.supabase.co' })).toBe(
      'https://ref.supabase.co/functions/v1/wyvi-webhook',
    );
    expect(resolveWebhookUrl({})).toBeNull();
  });

  it('deriva o project ref de SUPABASE_URL ou usa o explícito', () => {
    expect(resolveProjectRef({ SUPABASE_URL: 'https://eorlmqolbknrplvdbbtl.supabase.co' })).toBe(
      'eorlmqolbknrplvdbbtl',
    );
    expect(resolveProjectRef({ SUPABASE_PROJECT_REF: 'refexplicito', SUPABASE_URL: 'https://a.supabase.co' })).toBe(
      'refexplicito',
    );
    expect(resolveProjectRef({})).toBeNull();
  });
});

describe('setup — dedupe de destino', () => {
  const itens = [
    { id: 'wh1', url: 'https://ref.supabase.co/functions/v1/wyvi-webhook', eventos: [] },
    { id: 'wh2', url: 'https://outra.teste/hook', eventos: [] },
  ];

  it('encontra o destino existente por URL (ignora barra final)', () => {
    expect(selectExistingDestino(itens, 'https://ref.supabase.co/functions/v1/wyvi-webhook/').id).toBe('wh1');
    expect(selectExistingDestino(itens, 'https://outra.teste/hook').id).toBe('wh2');
    expect(selectExistingDestino(itens, 'https://outra.teste/outra')).toBeNull();
    expect(selectExistingDestino([], 'https://ref.supabase.co/functions/v1/wyvi-webhook')).toBeNull();
    expect(selectExistingDestino(undefined, 'https://x')).toBeNull();
  });
});

describe('setup — prova de escopo cobranca:criar (nunca cria cobrança de verdade)', () => {
  it('o corpo do probe é sempre inválido por regra de negócio', () => {
    expect(scopeProbeBody().valor_centavos).toBe(0);
    expect(scopeProbeBody().meio).toBe('pix');
  });

  it('interpreta os status do probe', () => {
    expect(interpretScopeProbe(403)).toBe('sem_escopo');
    expect(interpretScopeProbe(422)).toBe('escopo_ok');
    expect(interpretScopeProbe(400)).toBe('escopo_ok');
    expect(interpretScopeProbe(409)).toBe('escopo_ok');
    expect(interpretScopeProbe(201)).toBe('criado_inesperado');
    expect(interpretScopeProbe(500)).toBe('resposta_inesperada');
  });
});

describe('setup — segredos a instalar', () => {
  it('monta os três segredos com ambiente derivado da chave', () => {
    const lista = secretsToInstall(KEY_TEST, WHSEC, 'teste');
    expect(lista.map((s) => s.name)).toEqual(['WYVI_API_KEY', 'WYVI_ENVIRONMENT', 'WYVI_WEBHOOK_SECRET']);
    expect(lista.find((s) => s.name === 'WYVI_ENVIRONMENT').value).toBe('test');
    expect(secretsToInstall(KEY_LIVE, WHSEC, 'producao').find((s) => s.name === 'WYVI_ENVIRONMENT').value).toBe(
      'production',
    );
  });
});

// ---------------------------------------------------------------------------
// Instalação remota (Management API / CLI) com fetch/spawn simulados
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('setup — instalação remota via Management API oficial', () => {
  it('POST /v1/projects/{ref}/secrets com lista [{name,value}] e verifica por GET (nomes)', async () => {
    const calls: Array<{ url: string; method: string; body: unknown; auth: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
        auth: String((init?.headers as Record<string, string>)?.Authorization ?? ''),
      });
      if ((init?.method ?? 'GET') === 'POST') return jsonResponse(201, {});
      return jsonResponse(200, [{ name: 'WYVI_API_KEY' }, { name: 'WYVI_ENVIRONMENT' }, { name: 'WYVI_WEBHOOK_SECRET' }]);
    }) as unknown as typeof fetch;

    const secrets = secretsToInstall(KEY_TEST, WHSEC, 'teste');
    const result = await installRemoteSecrets({
      secrets,
      env: { SUPABASE_PROJECT_REF: 'eorlmqolbknrplvdbbtl', SUPABASE_ACCESS_TOKEN: 'sbp_token_ficticio' },
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: true, mecanismo: 'management-api', projectRef: 'eorlmqolbknrplvdbbtl' });
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('https://api.supabase.com/v1/projects/eorlmqolbknrplvdbbtl/secrets');
    expect(post?.auth).toBe('Bearer sbp_token_ficticio');
    expect(Array.isArray(post?.body)).toBe(true);
    expect((post?.body as Array<{ name: string }>).map((s) => s.name)).toEqual([
      'WYVI_API_KEY',
      'WYVI_ENVIRONMENT',
      'WYVI_WEBHOOK_SECRET',
    ]);
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('/secrets'))).toBe(true);
  });

  it('falha com instrução clara quando o token é recusado (401) — nada de sucesso parcial', async () => {
    const fetchImpl = (async () => jsonResponse(401, { message: 'invalid token' })) as unknown as typeof fetch;
    const result = await installRemoteSecrets({
      secrets: secretsToInstall(KEY_TEST, WHSEC, 'teste'),
      env: { SUPABASE_PROJECT_REF: 'ref', SUPABASE_ACCESS_TOKEN: 'sbp_expirado' },
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, fase: 'instalacao', motivo: 'token_invalido', mecanismo: 'management-api' });
  });

  it('403 no POST = PAT sem escopo secrets:write', async () => {
    const fetchImpl = (async () => jsonResponse(403, { message: 'requires secrets:write' })) as unknown as typeof fetch;
    const result = await installRemoteSecrets({
      secrets: secretsToInstall(KEY_TEST, WHSEC, 'teste'),
      env: { SUPABASE_PROJECT_REF: 'ref', SUPABASE_ACCESS_TOKEN: 'sbp_sem_escopo' },
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, motivo: 'sem_escopo_secrets' });
  });

  it('verificação pós-instalação: nome ausente no GET → falha (nunca finge sucesso)', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') return jsonResponse(201, {});
      return jsonResponse(200, [{ name: 'WYVI_API_KEY' }]); // WEBHOOK_SECRET "não chegou"
    }) as unknown as typeof fetch;
    const result = await installRemoteSecrets({
      secrets: secretsToInstall(KEY_TEST, WHSEC, 'teste'),
      env: { SUPABASE_PROJECT_REF: 'ref', SUPABASE_ACCESS_TOKEN: 'sbp_ok' },
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, fase: 'verificacao', motivo: 'nomes_ausentes' });
    expect(String(result.detalhe)).toContain('WYVI_WEBHOOK_SECRET');
    expect(String(result.detalhe)).toContain('WYVI_ENVIRONMENT');
  });

  it('sem project ref → instrução de SUPABASE_URL/SUPABASE_PROJECT_REF', async () => {
    const result = await installRemoteSecrets({ secrets: secretsToInstall(KEY_TEST, WHSEC, 'teste'), env: {} });
    expect(result).toMatchObject({ ok: false, fase: 'identificacao' });
    expect(String(result.instrucao)).toContain('SUPABASE_URL');
  });

  it('sem token e sem CLI → instrução exata (token ou supabase login)', async () => {
    const spawn = (() => ({ error: new Error('ENOENT'), status: null, stderr: '' })) as unknown as typeof import('node:child_process').spawnSync;
    const result = await installRemoteSecrets({
      secrets: secretsToInstall(KEY_TEST, WHSEC, 'teste'),
      env: { SUPABASE_PROJECT_REF: 'ref' },
      spawn,
    });
    expect(result).toMatchObject({ ok: false, motivo: 'sem_instalador' });
    expect(String(result.instrucao)).toContain('SUPABASE_ACCESS_TOKEN');
    expect(String(result.instrucao)).toContain('supabase login');
  });
});

describe('setup — instalação remota via Supabase CLI (sem segredos em argv)', () => {
  const HELP_OK = 'Usage:\n  supabase secrets set [flags]\n\nFlags:\n      --env-file string   Read secrets from a .env file.\n';
  const LIST_OK = '|NAME|DIGEST|\n|-|-|\n|`WYVI_API_KEY`|`sha256:x`|\n|`WYVI_ENVIRONMENT`|`sha256:y`|\n|`WYVI_WEBHOOK_SECRET`|`sha256:z`|\n';

  function fakeSpawn(behavior: {
    help?: { status: number; stdout: string };
    set?: { status: number; stdout?: string; stderr?: string; onSet?: (args: string[]) => void };
    list?: { status: number; stdout?: string; stderr?: string };
  }) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') return { error: undefined, status: 0, stdout: '2.99.0', stderr: '' };
      if (args[0] === 'secrets' && args[1] === 'set' && args[2] === '--help') {
        const h = behavior.help ?? { status: 0, stdout: HELP_OK };
        return { error: undefined, status: h.status, stdout: h.stdout, stderr: '' };
      }
      if (args[0] === 'secrets' && args[1] === 'set') {
        behavior.set?.onSet?.(args);
        const s = behavior.set ?? { status: 0 };
        return { error: undefined, status: s.status, stdout: s.stdout ?? 'ok', stderr: s.stderr ?? '' };
      }
      if (args[0] === 'secrets' && args[1] === 'list') {
        const l = behavior.list ?? { status: 0, stdout: LIST_OK };
        return { error: undefined, status: l.status, stdout: l.stdout ?? '', stderr: l.stderr ?? '' };
      }
      return { error: undefined, status: 1, stdout: '', stderr: 'inesperado' };
    }) as unknown as typeof import('node:child_process').spawnSync;
    return { calls, spawn };
  }

  const secrets = () => secretsToInstall(KEY_TEST, WHSEC, 'teste');

  it('usa arquivo temporário 0600 + `--env-file` (NENHUM valor em argv) e verifica por nomes', () => {
    let envFile = '';
    let envContent = '';
    let envMode = 0;
    const { calls, spawn } = fakeSpawn({
      set: {
        status: 0,
        onSet: (args) => {
          const idx = args.indexOf('--env-file');
          envFile = idx >= 0 ? args[idx + 1] : '';
          if (envFile) {
            const st = statSync(envFile);
            envMode = st.mode & 0o777;
            envContent = readFileSync(envFile, 'utf8');
          }
        },
      },
    });

    const result = installViaCli({ secrets: secrets(), projectRef: 'ref', spawn });
    expect(result).toMatchObject({ ok: true });

    // 1) NENHUM segredo em nenhum argumento de processo.
    const allArgs = calls.flatMap((c) => [c.cmd, ...c.args]);
    const joined = allArgs.join('\n');
    expect(joined).not.toContain(KEY_TEST);
    expect(joined).not.toContain(WHSEC);
    expect(joined).not.toContain('WYVI_API_KEY=');
    expect(joined).not.toContain('WYVI_WEBHOOK_SECRET=');
    expect(joined).not.toContain('WYVI_ENVIRONMENT=test');

    // 2) arquivo temporário existiu, era0600 e continha os3 segredos.
    expect(envFile).toContain('wyvi-secrets-');
    expect(envMode).toBe(0o600);
    expect(envContent).toContain(`WYVI_API_KEY=${KEY_TEST}`);
    expect(envContent).toContain(`WYVI_WEBHOOK_SECRET=${WHSEC}`);
    expect(envContent).toContain('WYVI_ENVIRONMENT=test');

    // 3) REMOVIDO após o uso (não sobra nada em disco).
    expect(existsSync(envFile)).toBe(false);

    // 4) verificação por NOMES via `secrets list` (nunca valores).
    const listCall = calls.find((c) => c.args[0] === 'secrets' && c.args[1] === 'list');
    expect(listCall?.args).toContain('--project-ref');
  });

  it('arquivo temporário é removido MESMO quando o `secrets set` falha', () => {
    let envFile = '';
    const { spawn } = fakeSpawn({
      set: {
        status: 1,
        stderr: 'erro simulado',
        onSet: (args) => {
          const idx = args.indexOf('--env-file');
          envFile = idx >= 0 ? args[idx + 1] : '';
        },
      },
    });
    const result = installViaCli({ secrets: secrets(), projectRef: 'ref', spawn });
    expect(result).toMatchObject({ ok: false, reason: 'cli_falhou' });
    expect(envFile).not.toBe('');
    expect(existsSync(envFile)).toBe(false);
  });

  it('redige valores de segredo no detalhe de erro (nunca vazam p/ logs)', () => {
    const { spawn } = fakeSpawn({
      set: { status: 1, stderr: `falha ao processar WYVI_API_KEY=${KEY_TEST} e whsec=${WHSEC}` },
    });
    const result = installViaCli({ secrets: secrets(), projectRef: 'ref', spawn });
    expect(result.ok).toBe(false);
    expect(String((result as { detail?: string }).detail)).not.toContain(KEY_TEST);
    expect(String((result as { detail?: string }).detail)).not.toContain(WHSEC);
    expect(String((result as { detail?: string }).detail)).toContain('[REMOVIDO]');
  });

  it('CLI sem suporte a --env-file ⇒ bloqueio explícito (sem fallback argv)', () => {
    const { calls, spawn } = fakeSpawn({ help: { status: 0, stdout: 'Usage: supabase secrets set <NAME=VALUE>\n' } });
    const result = installViaCli({ secrets: secrets(), projectRef: 'ref', spawn });
    expect(result).toMatchObject({ ok: false, reason: 'cli_sem_env_file' });
    // nunca tentou um set com valores em argv
    const setCalls = calls.filter((c) => c.args[0] === 'secrets' && c.args[1] === 'set' && c.args[2] !== '--help');
    expect(setCalls).toHaveLength(0);
  });

  it('set ok mas `secrets list` sem um nome ⇒ verificação falha (nada de sucesso falso)', () => {
    const { spawn } = fakeSpawn({
      list: { status: 0, stdout: '|NAME|DIGEST|\n|-|-|\n|`WYVI_API_KEY`|`sha256:x`|\n|`WYVI_ENVIRONMENT`|`sha256:y`|\n' },
    });
    const result = installViaCli({ secrets: secrets(), projectRef: 'ref', spawn });
    expect(result).toMatchObject({ ok: false, reason: 'nomes_ausentes' });
    expect(String((result as { detail?: string }).detail)).toContain('WYVI_WEBHOOK_SECRET');
  });

  it('installRemoteSecrets sem token usa o caminho CLI completo (set + verificação)', async () => {
    const { calls, spawn } = fakeSpawn({});
    const result = await installRemoteSecrets({
      secrets: secrets(),
      env: { SUPABASE_PROJECT_REF: 'ref' }, // sem SUPABASE_ACCESS_TOKEN
      spawn,
    });
    expect(result).toMatchObject({ ok: true, mecanismo: 'cli', verificacao: 'lista_nomes' });
    // sequência: --version (disponibilidade), help (sintaxe), set --env-file, list
    expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      '--version',
      'secrets set',
      'secrets set',
      'secrets list',
    ]);
    const joined = calls.flatMap((c) => c.args).join('\n');
    expect(joined).not.toContain(KEY_TEST);
    expect(joined).not.toContain(WHSEC);
  });

  it('CLI presente mas falhando → erro propagado (nada de sucesso silencioso)', () => {
    const { spawn } = fakeSpawn({ help: { status: 0, stdout: HELP_OK }, set: { status: 1, stderr: 'not logged in' } });
    const result = installViaCli({ secrets: secrets(), projectRef: 'ref', spawn });
    expect(result).toMatchObject({ ok: false, reason: 'cli_falhou' });
  });

  it('cliAvailable reflete o spawn real', () => {
    expect(cliAvailable((() => ({ error: undefined, status: 0, stdout: '2.0.0' })) as never)).toBe(true);
    expect(cliAvailable((() => ({ error: new Error('ENOENT') })) as never)).toBe(false);
  });
});

describe('setup — instalador da API de gestão (unidade)', () => {
  it('installViaManagementApi devolve ok apenas em 200/201', async () => {
    const ok = await installViaManagementApi({
      token: 't',
      projectRef: 'p',
      secrets: [{ name: 'A', value: '1' }],
      fetchImpl: (async () => jsonResponse(201, {})) as never,
    });
    expect(ok.ok).toBe(true);
    const bad = await installViaManagementApi({
      token: 't',
      projectRef: 'p',
      secrets: [{ name: 'A', value: '1' }],
      fetchImpl: (async () => jsonResponse(500, { err: 'x' })) as never,
    });
    expect(bad).toMatchObject({ ok: false, status: 500 });
  });

  it('listSecretNames só aceita 200 e devolve nomes (a API nunca devolve valores)', async () => {
    const list = await listSecretNames({
      token: 't',
      projectRef: 'p',
      fetchImpl: (async () => jsonResponse(200, [{ name: 'WYVI_API_KEY' }])) as never,
    });
    expect(list).toMatchObject({ ok: true, names: ['WYVI_API_KEY'] });
    const denied = await listSecretNames({
      token: 't',
      projectRef: 'p',
      fetchImpl: (async () => jsonResponse(401, {})) as never,
    });
    expect(denied).toMatchObject({ ok: false, status: 401 });
  });
});

describe('setup — whsec_ local (recuperação sem duplicar destino)', () => {
  it('lê o segredo salvo e ignora linhas inválidas', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wyvi-setup-'));
    try {
      const file = path.join(dir, '.env.functions');
      writeFileSync(file, `OUTRA=1\nWYVI_WEBHOOK_SECRET=${WHSEC}\n`, { mode: 0o600 });
      expect(readWhsecFromFile(file)).toBe(WHSEC);
      writeFileSync(file, 'WYVI_WEBHOOK_SECRET=lixo\n');
      expect(readWhsecFromFile(file)).toBeNull();
      expect(readWhsecFromFile(path.join(dir, 'nao-existe'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// readHidden — entrada oculta em TTY (A4)
// ---------------------------------------------------------------------------

/** TTY falso: EventEmitter + isTTY/setRawMode/pause/setEncoding reais. */
class FakeTty extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawModes: boolean[] = [];
  paused = false;
  setRawMode(v: boolean): void {
    this.isRaw = v;
    this.rawModes.push(v);
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
}

describe('setup — readHidden (entrada oculta em TTY)', () => {
  it('recusa entrada insegura sem TTY (nunca lê pipe com eco)', async () => {
    const writes: string[] = [];
    await expect(
      readHidden('chave: ', { stdin: { isTTY: false } as never, write: (t) => writes.push(t) }),
    ).rejects.toThrow(/entrada insegura/);
    expect(writes).toHaveLength(0); // nem o prompt foi emitido
  });

  it('recusa stdin sem setRawMode (objeto não-TTY)', async () => {
    await expect(readHidden('chave: ', { stdin: { isTTY: true } as never })).rejects.toThrow(/entrada insegura/);
  });

  it('lê a chave em modo raw: ativa raw, não ecoa nada e restaura ao Enter', async () => {
    const tty = new FakeTty();
    const writes: string[] = [];
    const promise = readHidden('chave: ', { stdin: tty as never, write: (t) => writes.push(t) });
    expect(tty.rawModes).toEqual([true]); // raw ligado na hora do prompt
    expect(writes).toEqual(['chave: ']);
    tty.emit('data', KEY_TEST);
    tty.emit('data', '\r');
    await expect(promise).resolves.toBe(KEY_TEST);
    expect(tty.rawModes).toEqual([true, false]); // restaurado
    expect(tty.paused).toBe(true);
    // a chave digitada NUNCA aparece em nenhum write
    expect(writes.join('')).not.toContain(KEY_TEST);
    expect(writes.join('')).toBe('chave: \n');
  });

  it('backspace apaga; setas/controles são ignoradas; trim nas pontas', async () => {
    const tty = new FakeTty();
    const writes: string[] = [];
    const promise = readHidden('p: ', { stdin: tty as never, write: (t) => writes.push(t) });
    tty.emit('data', 'abc');
    tty.emit('data', '\u007f\u007f'); // dois backspaces: "abc" → "a"
    tty.emit('data', '\u001b[A'); // seta pra cima (CSI) — ignorada
    tty.emit('data', 'X ');
    tty.emit('data', '\n');
    await expect(promise).resolves.toBe('aX'); // backspace apagou; trim remove espaço final
    expect(tty.rawModes).toEqual([true, false]);
  });

  it('Ctrl+C cancela com exitCode 130 e restaura o terminal', async () => {
    const tty = new FakeTty();
    const writes: string[] = [];
    const promise = readHidden('p: ', { stdin: tty as never, write: (t) => writes.push(t) });
    tty.emit('data', KEY_TEST.slice(0, 10)); // digitou parte da chave
    tty.emit('data', '\u0003');
    await expect(promise).rejects.toMatchObject({ cancelled: true, exitCode: 130 });
    expect(tty.rawModes).toEqual([true, false]);
    expect(writes.join('')).not.toContain(KEY_TEST);
  });

  it('Ctrl+D em buffer vazio cancela com exitCode 1 e restaura', async () => {
    const tty = new FakeTty();
    const promise = readHidden('p: ', { stdin: tty as never, write: () => {} });
    tty.emit('data', '\u0004');
    await expect(promise).rejects.toMatchObject({ cancelled: true, exitCode: 1 });
    expect(tty.rawModes).toEqual([true, false]);
  });

  it('erro do stream rejeita e RESTAURA o terminal (cenário de erro)', async () => {
    const tty = new FakeTty();
    const promise = readHidden('p: ', { stdin: tty as never, write: () => {} });
    tty.emit('error', new Error('stream quebrou'));
    await expect(promise).rejects.toThrow('stream quebrou');
    expect(tty.rawModes).toEqual([true, false]);
    expect(tty.paused).toBe(true);
  });

  it('EOF antes do Enter cancela e restaura', async () => {
    const tty = new FakeTty();
    const promise = readHidden('p: ', { stdin: tty as never, write: () => {} });
    tty.emit('end');
    await expect(promise).rejects.toMatchObject({ cancelled: true, exitCode: 1 });
    expect(tty.rawModes).toEqual([true, false]);
  });
});

describe('setup — cliListShowsName (verificação por nomes)', () => {
  it('reconhece nomes na tabela da CLI com limites corretos', () => {
    const table = '|NAME|DIGEST|\n|-|-|\n|`WYVI_API_KEY`|`abc`|\n|`WYVI_WEBHOOK_SECRET`|`def`|\n';
    expect(cliListShowsName(table, 'WYVI_API_KEY')).toBe(true);
    expect(cliListShowsName(table, 'WYVI_WEBHOOK_SECRET')).toBe(true);
    expect(cliListShowsName(table, 'WYVI_ENVIRONMENT')).toBe(false);
  });

  it('não confunde nome contido em outro (limite não-ident)', () => {
    expect(cliListShowsName('WYVI_API_KEY_EXTRA=1', 'WYVI_API_KEY')).toBe(false);
    expect(cliListShowsName('WYVI_API_KEY', 'WYVI_API_KEY')).toBe(true);
  });
});
