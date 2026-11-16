import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cliAvailable,
  installRemoteSecrets,
  installViaCli,
  installViaManagementApi,
  interpretScopeProbe,
  listSecretNames,
  maskKey,
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

describe('setup — instalação remota via Supabase CLI', () => {
  it('usa `supabase secrets set K=V … --project-ref` quando não há token no ambiente', async () => {
    const spawn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'supabase' && args[0] === '--version') return { error: undefined, status: 0, stdout: '2.99.0', stderr: '' };
      return { error: undefined, status: 0, stdout: 'secrets set ok', stderr: '' };
    }) as unknown as typeof import('node:child_process').spawnSync;

    const secrets = secretsToInstall(KEY_TEST, WHSEC, 'teste');
    const result = await installRemoteSecrets({
      secrets,
      env: { SUPABASE_PROJECT_REF: 'ref' }, // sem SUPABASE_ACCESS_TOKEN
      spawn,
    });
    expect(result).toMatchObject({ ok: true, mecanismo: 'cli' });
    const setCall = (spawn as unknown as { mock: { calls: Array<[string, string[]]> } }).mock.calls.find(
      ([, args]) => args[0] === 'secrets',
    );
    expect(setCall?.[0]).toBe('supabase');
    expect(setCall?.[1][1]).toBe('set');
    expect(setCall?.[1]).toContain(`WYVI_API_KEY=${KEY_TEST}`);
    expect(setCall?.[1]).toContain(`WYVI_WEBHOOK_SECRET=${WHSEC}`);
    expect(setCall?.[1]).toContain('WYVI_ENVIRONMENT=test');
    expect(setCall?.[1].slice(-2)).toEqual(['--project-ref', 'ref']);
  });

  it('CLI presente mas falhando → erro propagado (nada de sucesso silencioso)', () => {
    const spawn = (() => ({ error: undefined, status: 1, stdout: '', stderr: 'not logged in' })) as unknown as typeof import('node:child_process').spawnSync;
    const result = installViaCli({
      secrets: secretsToInstall(KEY_TEST, WHSEC, 'teste'),
      projectRef: 'ref',
      spawn,
    });
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
