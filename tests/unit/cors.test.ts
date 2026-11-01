import { describe, expect, it } from 'vitest';
import {
  allowedOrigins,
  corsHeaders,
  normalizeOrigin,
  resolveAllowedOrigin,
  withCors,
} from '../../supabase/functions/_shared/cors.ts';
import { loadConfig } from '../../supabase/functions/_shared/config.ts';

/**
 * Missão 05 — CORS restrito.
 *
 * Antes, toda resposta saía com `Access-Control-Allow-Origin: *`: qualquer
 * site podia chamar a loja com a chave `anon` (que é pública) em nome do
 * visitante. Estes testes fixam a política nova: só a origem exata da lista,
 * e nada quando não há lista.
 */

const config = loadConfig({
  storeUrl: 'https://loja.exemplo.com',
  allowedOrigins: ['https://preview.exemplo.app', 'http://localhost:5173'],
});

function requestWith(origin?: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers ?? {});
  if (origin !== undefined) headers.set('Origin', origin);
  return new Request('https://projeto.supabase.co/functions/v1/catalog', { ...init, headers });
}

describe('normalização de origem', () => {
  it('reduz a scheme://host:porta e ignora caminho', () => {
    expect(normalizeOrigin('https://Loja.Exemplo.com/produtos?x=1')).toBe('https://loja.exemplo.com');
    expect(normalizeOrigin('http://localhost:5173/')).toBe('http://localhost:5173');
    expect(normalizeOrigin('  HTTPS://A.B.C  ')).toBe('https://a.b.c');
  });

  it('rejeita o que não é origem http(s)', () => {
    expect(normalizeOrigin(null)).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
    expect(normalizeOrigin('null')).toBeNull();
    expect(normalizeOrigin('file:///tmp/x')).toBeNull();
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeOrigin('nao-e-url')).toBeNull();
  });
});

describe('lista de origens autorizadas', () => {
  it('junta ALLOWED_ORIGINS com a origem de STORE_URL, sem duplicar', () => {
    const duplicated = loadConfig({
      storeUrl: 'https://loja.exemplo.com',
      allowedOrigins: ['https://loja.exemplo.com', 'https://loja.exemplo.com/path'],
    });
    expect(allowedOrigins(duplicated)).toEqual(['https://loja.exemplo.com']);
  });

  it('sem ALLOWED_ORIGINS sobra apenas a loja oficial', () => {
    const onlyStore = loadConfig({ storeUrl: 'https://loja.exemplo.com', allowedOrigins: [] });
    expect(allowedOrigins(onlyStore)).toEqual(['https://loja.exemplo.com']);
  });
});

describe('decisão por requisição', () => {
  it('aceita exatamente as origens da lista', () => {
    expect(resolveAllowedOrigin(requestWith('https://preview.exemplo.app'), config)).toBe(
      'https://preview.exemplo.app',
    );
    expect(resolveAllowedOrigin(requestWith('http://localhost:5173'), config)).toBe('http://localhost:5173');
    expect(resolveAllowedOrigin(requestWith('https://loja.exemplo.com'), config)).toBe('https://loja.exemplo.com');
  });

  it('recusa origem parecida, subdomínio e origem desconhecida', () => {
    for (const origin of [
      'https://preview.exemplo.app.evil.com',
      'https://evil.com',
      'http://preview.exemplo.app', // esquema diferente
      'https://localhost:5173',
      'null',
    ]) {
      expect(resolveAllowedOrigin(requestWith(origin), config), origin).toBeNull();
    }
  });

  it('não inventa permissão quando a requisição não tem Origin', () => {
    expect(resolveAllowedOrigin(requestWith(), config)).toBeNull();
  });
});

describe('cabeçalhos aplicados à resposta', () => {
  const response = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('reflete a origem autorizada e mantém os demais cabeçalhos', () => {
    const result = withCors(requestWith('https://preview.exemplo.app'), response(), config);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe('https://preview.exemplo.app');
    expect(result.headers.get('vary')).toBe('Origin');
    expect(result.headers.get('Access-Control-Allow-Headers')).toContain('apikey');
    expect(result.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(result.headers.get('Content-Type')).toBe('application/json');
  });

  it('nunca devolve curinga', async () => {
    for (const origin of ['https://preview.exemplo.app', 'https://evil.com', undefined]) {
      const result = withCors(requestWith(origin), response(), config);
      expect(result.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
      await result.text();
    }
  });

  it('omite Allow-Origin para origem não autorizada e preserva o status', async () => {
    const result = withCors(requestWith('https://evil.com'), response(), config);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
  });

  it('mantém preflight 204 sem corpo e com a origem correta', () => {
    const preflightResponse = new Response(null, { status: 204 });
    const result = withCors(
      requestWith('https://preview.exemplo.app', { method: 'OPTIONS' }),
      preflightResponse,
      config,
    );
    expect(result.status).toBe(204);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe('https://preview.exemplo.app');
  });

  it('erro continua legível pelo navegador autorizado', () => {
    const errorResponse = new Response(JSON.stringify({ error: 'insufficient_stock' }), { status: 409 });
    const result = withCors(requestWith('http://localhost:5173'), errorResponse, config);
    expect(result.status).toBe(409);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('corsHeaders não define Allow-Origin quando a origem é recusada', () => {
    expect(corsHeaders(requestWith('https://evil.com'), config)['Access-Control-Allow-Origin']).toBeUndefined();
  });
});
