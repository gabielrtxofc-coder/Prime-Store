import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * E2E do `npm run wyvi:setup` (Fase 02) em SUBPROCESSO contra uma API
 * WyviPay falsa + Management API falsa, tudo em localhost — sem rede, sem a
 * chave real e sem tocar no `.env.functions` do repositório (cwd é temporário).
 *
 * Cenários: chave válida instalando os 3 secrets; reexecução idempotente
 * (destino existente não duplica); chave inválida; escopo ausente; falha na
 * instalação remota; recuperação via --recreate; e a garantia de que NENHUM
 * segredo aparece na saída.
 */

const KEY = `wy_test_${'z'.repeat(42)}`;
const PROJECT_REF = 'eorlmqolbknrplvdbbtl';

interface Scenario {
  /** Se true, GET /webhooks devolve 401 (chave recusada). */
  invalidKey?: boolean;
  /** Se true, POST /cobrancas devolve 403 sem_escopo. */
  missingScope?: boolean;
  /** Status do POST /secrets da Management API (padrão 201). */
  mgmtStatus?: number;
  /** Estado inicial da lista de webhooks. */
  webhooks?: Array<{ id: string; url: string; eventos: string[] }>;
  /** Cenário "segredo perdido": destino existe mas sem whsec no arquivo. */
  existingWebhookOnly?: boolean;
}

interface FakeState {
  webhookPosts: number;
  webhookDeletes: number;
  mgmtPosts: Array<{ names: string[]; auth: string }>;
  createdSecrets: Map<string, string>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function startFake(scenario: Scenario): Promise<{ server: Server; state: FakeState; port: number }> {
  const state: FakeState = {
    webhookPosts: 0,
    webhookDeletes: 0,
    mgmtPosts: [],
    createdSecrets: new Map(),
  };
  const webhooks = [...(scenario.webhooks ?? [])];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as unknown) : null;

      // ---- Management API falsa (secrets) ----
      if (url.pathname === `/v1/projects/${PROJECT_REF}/secrets`) {
        if (req.method === 'POST') {
          if (scenario.mgmtStatus && scenario.mgmtStatus !== 201) {
            json(res, scenario.mgmtStatus, { message: 'falha simulada' });
            return;
          }
          const lista = body as Array<{ name: string; value: string }>;
          state.mgmtPosts.push({
            names: lista.map((s) => s.name),
            auth: String(req.headers.authorization ?? ''),
          });
          for (const item of lista) state.createdSecrets.set(item.name, item.value);
          json(res, 201, {});
          return;
        }
        if (req.method === 'GET') {
          json(res, 200, [...state.createdSecrets.keys()].map((name) => ({ name })));
          return;
        }
      }

      // ---- API WyviPay falsa ----
      if (url.pathname === '/api/v2/webhooks') {
        if (req.method === 'GET') {
          if (scenario.invalidKey) {
            json(res, 401, { erro: { codigo: 'chave_invalida', mensagem: 'chave recusada' } });
            return;
          }
          json(res, 200, { itens: webhooks });
          return;
        }
        if (req.method === 'POST') {
          state.webhookPosts += 1;
          const novo = { id: `wh${state.webhookPosts}`, ...(body as object) } as {
            id: string;
            url: string;
            eventos: string[];
          };
          webhooks.push(novo);
          json(res, 201, { id: novo.id, url: novo.url, eventos: novo.eventos, segredo: `whsec_${'s'.repeat(40)}` });
          return;
        }
      }
      if (url.pathname.startsWith('/api/v2/webhooks/')) {
        if (req.method === 'DELETE') {
          state.webhookDeletes += 1;
          const id = url.pathname.split('/').pop();
          const idx = webhooks.findIndex((w) => w.id === id);
          if (idx >= 0) webhooks.splice(idx, 1);
          json(res, 200, {});
          return;
        }
      }
      if (url.pathname === '/api/v2/cobrancas') {
        if (req.method === 'POST') {
          if (scenario.missingScope) {
            json(res, 403, { erro: { codigo: 'sem_escopo', mensagem: 'falta cobranca:criar' } });
            return;
          }
          // Corpo do probe é inválido (valor 0) → 422 de validação.
          json(res, 422, { erro: { codigo: 'campo_invalido', mensagem: 'valor_centavos' } });
          return;
        }
      }
      if (url.pathname.startsWith('/api/v2/cobrancas/')) {
        if (req.method === 'GET') {
          json(res, 404, { erro: { codigo: 'nao_encontrada', mensagem: 'sem cobrança' } });
          return;
        }
      }
      json(res, 404, { erro: { codigo: 'rota_desconhecida', mensagem: url.pathname } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, state, port };
}

/**
 * Assíncrono de propósito: um spawnSync bloquearia o event loop deste
 * processo — e é nele que roda a API falsa que o filho precisa consultar.
 */
function runSetup(cwd: string, env: Record<string, string>, args: string[] = []): Promise<{
  status: number | null;
  output: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve('scripts/wyvipay-setup.mjs'), ...args], {
      cwd,
      env: { ...process.env, WYVI_API_KEY: KEY, ...env },
    });
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (output += c.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

describe('wyvi:setup — E2E em subprocesso com API falsa', () => {
  let tmp: string;
  const servers: Array<{ server: Server; state: FakeState }> = [];

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'wyvi-e2e-'));
  });

  afterAll(() => {
    for (const s of servers) s.server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function withScenario(
    scenario: Scenario,
    fn: (state: FakeState, env: Record<string, string>) => void | Promise<void>,
  ) {
    const { server, state, port } = await startFake(scenario);
    servers.push({ server, state });
    try {
      await fn(state, {
        WYVI_API_BASE: `http://127.0.0.1:${port}`,
        SUPABASE_MGMT_API_BASE: `http://127.0.0.1:${port}`,
        SUPABASE_PROJECT_REF: PROJECT_REF,
        SUPABASE_ACCESS_TOKEN: 'sbp_ficticio_para_o_teste',
        SUPABASE_URL: 'https://eorlmqolbknrplvdbbtl.supabase.co',
      });
    } finally {
      server.close();
    }
  }

  it('fluxo completo: valida, cria destino, instala os 3 secrets e NÃO imprime segredos', async () => {
    await withScenario({}, async (state, env) => {
      const run = await runSetup(tmp, env);
      expect(run.status).toBe(0);
      // Saída sem nenhum valor sensível.
      expect(run.output).not.toContain(KEY);
      expect(run.output).not.toContain(`whsec_${'s'.repeat(10)}`);
      expect(run.output).toContain('wy_test_'); // apenas a forma mascarada
      expect(run.output).toContain('instalados no Supabase');
      // Um destino criado, um POST de secrets com os três nomes.
      expect(state.webhookPosts).toBe(1);
      expect(state.mgmtPosts).toHaveLength(1);
      expect(state.mgmtPosts[0].names).toEqual(['WYVI_API_KEY', 'WYVI_ENVIRONMENT', 'WYVI_WEBHOOK_SECRET']);
      expect(state.mgmtPosts[0].auth).toBe('Bearer sbp_ficticio_para_o_teste');
      // whsec salvo em arquivo próprio do cwd temporário, permissão 600.
      const envFile = path.join(tmp, '.env.functions');
      expect(readFileSync(envFile, 'utf8')).toContain('WYVI_WEBHOOK_SECRET=whsec_');
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
    });
  });

  it('reexecução: destino já existe → não duplica, reutiliza o whsec_ e reinstala', async () => {
    await withScenario(
      {
        webhooks: [
          {
            id: 'wh_existente',
            url: 'https://eorlmqolbknrplvdbbtl.supabase.co/functions/v1/wyvi-webhook',
            eventos: ['cobranca.paga'],
          },
        ],
      },
      async (state, env) => {
        // Primeiro cria o arquivo whsec local simulando a execução anterior.
        const run = await runSetup(tmp, env);
        expect(run.status).toBe(0);
        expect(state.webhookPosts).toBe(0); // dedupe: não criou destino novo
        expect(state.webhookDeletes).toBe(0);
        expect(state.mgmtPosts.length).toBeGreaterThan(0); // segredos (re)instalados
        expect(run.output).toContain('destino já cadastrado');
      },
    );
  });

  it('sem whsec local e destino existente → recusa com instrução --recreate (sem falso sucesso)', async () => {
    const tmp2 = mkdtempSync(path.join(tmpdir(), 'wyvi-e2e-semwhsec-'));
    try {
      await withScenario(
        {
          webhooks: [
            {
              id: 'wh1',
              url: 'https://eorlmqolbknrplvdbbtl.supabase.co/functions/v1/wyvi-webhook',
              eventos: ['cobranca.paga'],
            },
          ],
        },
        async (_state, env) => {
          const run = await runSetup(tmp2, env);
          expect(run.status).toBe(1);
          expect(run.output).toContain('--recreate');
          expect(run.output).not.toContain(KEY);
        },
      );
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it('--recreate: exclui o destino antigo, cria outro com novo whsec_ e conclui', async () => {
    const tmp3 = mkdtempSync(path.join(tmpdir(), 'wyvi-e2e-recreate-'));
    try {
      await withScenario(
        {
          webhooks: [
            {
              id: 'wh_velho',
              url: 'https://eorlmqolbknrplvdbbtl.supabase.co/functions/v1/wyvi-webhook',
              eventos: ['cobranca.paga'],
            },
          ],
        },
        async (state, env) => {
          const run = await runSetup(tmp3, env, ['--recreate']);
          expect(run.status).toBe(0);
          expect(state.webhookDeletes).toBe(1);
          expect(state.webhookPosts).toBe(1);
          expect(readFileSync(path.join(tmp3, '.env.functions'), 'utf8')).toContain('WYVI_WEBHOOK_SECRET=whsec_');
          expect(run.output).not.toContain(KEY);
        },
      );
    } finally {
      rmSync(tmp3, { recursive: true, force: true });
    }
  });

  it('chave inválida (401) → falha imediata sem criar destino nem instalar nada', async () => {
    const tmp4 = mkdtempSync(path.join(tmpdir(), 'wyvi-e2e-401-'));
    try {
      await withScenario({ invalidKey: true }, async (state, env) => {
        const run = await runSetup(tmp4, env);
        expect(run.status).toBe(1);
        expect(run.output).toContain('401');
        expect(state.webhookPosts).toBe(0);
        expect(state.mgmtPosts).toHaveLength(0);
        expect(run.output).not.toContain(KEY);
      });
    } finally {
      rmSync(tmp4, { recursive: true, force: true });
    }
  });

  it('formato de chave inválido → falha antes de qualquer requisição', async () => {
    const tmp5 = mkdtempSync(path.join(tmpdir(), 'wyvi-e2e-formato-'));
    try {
      const run = await runSetup(tmp5, { WYVI_API_KEY: 'nao_e_chave_wyvi', WYVI_API_BASE: 'http://127.0.0.1:1' });
      expect(run.status).toBe(1);
      expect(run.output).toContain('Formato de chave inválido');
    } finally {
      rmSync(tmp5, { recursive: true, force: true });
    }
  });

  it('sem escopo cobranca:criar (403) → falha explicando o escopo, sem criar destino', async () => {
    const tmp6 = mkdtempSync(path.join(tmpdir(), 'wyvi-e2e-403-'));
    try {
      await withScenario({ missingScope: true }, async (state, env) => {
        const run = await runSetup(tmp6, env);
        expect(run.status).toBe(1);
        expect(run.output).toContain('sem_escopo');
        expect(state.webhookPosts).toBe(0);
        expect(state.mgmtPosts).toHaveLength(0);
        expect(run.output).not.toContain(KEY);
      });
    } finally {
      rmSync(tmp6, { recursive: true, force: true });
    }
  });

  it('falha na instalação remota (500) → saída 1 com fase=instalacao; reexecução conclui', async () => {
    const tmp7 = mkdtempSync(path.join(tmpdir(), 'wyvi-e2e-mgmt-'));
    try {
      // 1ª tentativa: Management API falha.
      await withScenario({ mgmtStatus: 500 }, async (state, env) => {
        const run = await runSetup(tmp7, env);
        expect(run.status).toBe(1);
        expect(run.output).toContain('instalação remota');
        expect(run.output).toContain('fase=instalacao');
        expect(state.webhookPosts).toBe(1); // destino criado e whsec salvo (recuperável)
        expect(readFileSync(path.join(tmp7, '.env.functions'), 'utf8')).toContain('whsec_');
      });
      // 2ª tentativa: API saudável → aproveita o whsec salvo e conclui
      // (o destino criado na 1ª tentativa segue cadastrado no provedor).
      await withScenario(
        {
          webhooks: [
            {
              id: 'wh1',
              url: 'https://eorlmqolbknrplvdbbtl.supabase.co/functions/v1/wyvi-webhook',
              eventos: ['cobranca.paga'],
            },
          ],
        },
        async (state, env) => {
          const run = await runSetup(tmp7, env);
          expect(run.status).toBe(0);
          expect(state.webhookPosts).toBe(0); // não duplica destino
          expect(state.mgmtPosts).toHaveLength(1);
          expect(run.output).toContain('instalados no Supabase');
        },
      );
    } finally {
      rmSync(tmp7, { recursive: true, force: true });
    }
  });
});
