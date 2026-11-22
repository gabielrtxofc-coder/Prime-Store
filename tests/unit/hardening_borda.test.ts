import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_ROWS, validateStockRows } from '../../supabase/functions/_shared/csv.ts';
import {
  ApiError,
  MAX_REQUEST_BODY_BYTES,
  errorResponse,
  readBodyText,
  readJson,
  readJsonOrEmpty,
} from '../../supabase/functions/_shared/http.ts';
import { loadConfig } from '../../supabase/functions/_shared/config.ts';
import { corsHeaders } from '../../supabase/functions/_shared/cors.ts';
import { readEnvFlag, readEnvValue, readPublicEnv } from '../../src/lib/publicEnv.ts';

/**
 * Missão 15 — endurecimento de borda.
 *
 * Cada bloco fixa uma garantia que antes NÃO existia e que é fácil de perder
 * numa refatoração futura:
 *
 *  1. corpo de requisição com teto, medido em bytes e durante a leitura;
 *  2. importação de CSV com teto de LINHAS (não só de caracteres por campo);
 *  3. nenhum valor não-`VITE_` atravessa o leitor de variáveis públicas;
 *  4. CORS fecha por padrão quando não há lista de origens configurada
 *     (o caso que derrubou a produção: `ALLOWED_ORIGINS`/`STORE_URL` ausentes);
 *  5. o 413 novo vira erro estável, não `internal_error`.
 */

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://projeto.supabase.co/functions/v1/admin-api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

describe('corpo de requisição tem teto (bytes, durante a leitura)', () => {
  it('aceita JSON normal e devolve o objeto', async () => {
    await expect(readJson<{ ok: boolean }>(jsonRequest('{"ok":true}'))).resolves.toEqual({ ok: true });
  });

  it('Content-Length declarado acima do teto é recusado SEM ler o corpo', async () => {
    const request = jsonRequest('{"ok":true}', { 'Content-Length': String(MAX_REQUEST_BODY_BYTES + 1) });
    await expect(readJson(request)).rejects.toMatchObject({ status: 413, code: 'payload_too_large' });
  });

  it('corpo realmente acima do teto é recusado mesmo sem Content-Length confiável', async () => {
    // O Chromium/undici sempre define Content-Length para string; para provar o
    // corte DURANTE a leitura usamos um stream e um teto pequeno.
    const payload = 'x'.repeat(64);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    const request = new Request('https://projeto.supabase.co/functions/v1/x', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);

    await expect(readBodyText(request, 100)).rejects.toMatchObject({ status: 413 });
  });

  it('JSON inválido continua sendo 400 invalid_json (não 500)', async () => {
    await expect(readJson(jsonRequest('{quebrado'))).rejects.toMatchObject({ status: 400, code: 'invalid_json' });
  });

  it('corpo vazio é invalid_json, não exceção crua', async () => {
    const request = new Request('https://projeto.supabase.co/functions/v1/x', {
      method: 'POST',
      body: '',
    });
    await expect(readJson(request)).rejects.toMatchObject({ status: 400, code: 'invalid_json' });
  });

  it('413 sai como erro estável e sem detalhe interno', async () => {
    const response = errorResponse(new ApiError(413, 'payload_too_large', 'Corpo da requisição acima do limite.'));
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('payload_too_large');
    expect(body.message).not.toMatch(/stack|at .*\.ts/i);
  });

  it('corpo opcional (filtros) tolera lixo, mas NÃO tolera corpo gigante', async () => {
    await expect(readJsonOrEmpty(jsonRequest('{lixo'))).resolves.toEqual({});
    await expect(readJsonOrEmpty(jsonRequest('{"q":"x"}'))).resolves.toEqual({ q: 'x' });
    const gigante = jsonRequest('{}', { 'Content-Length': String(MAX_REQUEST_BODY_BYTES + 1) });
    await expect(readJsonOrEmpty(gigante)).rejects.toMatchObject({ status: 413 });
  });

  it('o teto cobre com folga o maior corpo legítimo (CSV de 2 MB)', () => {
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(2 * 1024 * 1024);
    // ...mas não é "sem limite": um corpo de 100 MB nunca é aceito.
    expect(MAX_REQUEST_BODY_BYTES).toBeLessThan(10 * 1024 * 1024);
  });
});

describe('importação de CSV tem teto de linhas', () => {
  function rows(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      rowNumber: index + 2,
      email: `pessoa${index}@exemplo.com`,
      password: `senha-${index}`,
      notes: '',
    }));
  }

  it('arquivo dentro do teto é aceito por inteiro e não marca truncamento', () => {
    const result = validateStockRows(rows(10));
    expect(result.truncated).toBe(false);
    expect(result.valid).toHaveLength(10);
  });

  it('excedente é cortado, marcado como truncado e nunca vira linha válida', () => {
    const result = validateStockRows(rows(MAX_IMPORT_ROWS + 25));
    expect(result.truncated).toBe(true);
    expect(result.valid).toHaveLength(MAX_IMPORT_ROWS);
    expect(result.valid.some((row) => row.email === `pessoa${MAX_IMPORT_ROWS}@exemplo.com`)).toBe(false);
  });

  it('um CSV de 2 MB com ~60 mil linhas não explode a função', () => {
    // Mesmo formato que o parser entrega: tudo é considerado, mas só o teto
    // inicial é validado. Antes, as 60 mil linhas eram todas cifradas.
    const result = validateStockRows(rows(60_000));
    expect(result.valid.length).toBe(MAX_IMPORT_ROWS);
    expect(result.truncated).toBe(true);
  });

  it('teto é configurável para testes e para operação maior', () => {
    const result = validateStockRows(rows(30), undefined, undefined, { maxRows: 5 });
    expect(result.valid).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });
});

describe('variáveis públicas: só VITE_ atravessa', () => {
  it('não entrega segredo do processo para o bundle', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'segredo-que-nao-pode-vazar';
    process.env.PRIME_ENCRYPTION_KEY = 'chave-mestra';
    try {
      const env = readPublicEnv();
      expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
      expect(env.PRIME_ENCRYPTION_KEY).toBeUndefined();
    } finally {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.PRIME_ENCRYPTION_KEY;
    }
  });

  it('flag pública continua funcionando (inclusive via stubEnv dos testes)', () => {
    process.env.VITE_ADMIN_DEMO = 'true';
    try {
      expect(readEnvFlag('VITE_ADMIN_DEMO')).toBe(true);
      expect(readPublicEnv().VITE_ADMIN_DEMO).toBe('true');
    } finally {
      delete process.env.VITE_ADMIN_DEMO;
    }
  });

  it('nome não público é sempre vazio, mesmo com valor no processo', () => {
    process.env.WYVI_API_KEY = 'wy_test_nao_deve_aparecer';
    try {
      expect(readEnvValue('WYVI_API_KEY')).toBe('');
      expect(readEnvFlag('WYVI_API_KEY')).toBe(false);
    } finally {
      delete process.env.WYVI_API_KEY;
    }
  });
});

describe('CORS: sem lista configurada, fecha (defeito que derrubou a produção)', () => {
  // Produção estava sem `ALLOWED_ORIGINS` e sem `STORE_URL`: o site real
  // recebia 200 sem `Access-Control-Allow-Origin` e o navegador bloqueava
  // TODA chamada. A correção foi configurar as origens; esta é a rede de
  // segurança que impede o contrário — abrir por acidente quando a lista some.
  it('nenhuma origem é liberada quando a lista está vazia e a URL é o default', () => {
    const config = loadConfig({
      storeUrl: 'http://localhost:5173',
      allowedOrigins: [],
    });
    const request = new Request('https://projeto.supabase.co/functions/v1/catalog', {
      headers: { Origin: 'https://prime-store-gilt.vercel.app' },
    });
    expect(corsHeaders(request, config)['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('a origem de produção, uma vez configurada, é liberada exatamente', () => {
    const config = loadConfig({
      storeUrl: 'https://prime-store-gilt.vercel.app',
      allowedOrigins: ['https://prime-store-gilt.vercel.app'],
    });
    const request = new Request('https://projeto.supabase.co/functions/v1/catalog', {
      headers: { Origin: 'https://prime-store-gilt.vercel.app' },
    });
    expect(corsHeaders(request, config)['Access-Control-Allow-Origin']).toBe('https://prime-store-gilt.vercel.app');
  });
});
