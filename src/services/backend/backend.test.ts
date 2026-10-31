import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBackendConfig } from './config';
import { BackendError, describeBackendError, invokeFunction } from './http';
import { mapPublicProduct, parseCatalogResponse } from './catalogAdapter';

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('configuração do backend no frontend', () => {
  it('fica desabilitada sem variáveis de ambiente (modo demonstração)', () => {
    const config = getBackendConfig();
    expect(config.enabled).toBe(false);
    expect(config.functionsUrl).toBeNull();
  });

  it('habilita somente com flag explícita e credenciais públicas presentes', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://exemplo.supabase.co/');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'chave-anon');
    expect(getBackendConfig().enabled).toBe(false);

    vi.stubEnv('VITE_BACKEND_ENABLED', 'true');
    const config = getBackendConfig();
    expect(config.enabled).toBe(true);
    expect(config.functionsUrl).toBe('https://exemplo.supabase.co/functions/v1');

    vi.stubEnv('VITE_BACKEND_URL', 'https://api.exemplo.com/v1/');
    expect(getBackendConfig().functionsUrl).toBe('https://api.exemplo.com/v1');
  });
});

describe('adaptação do catálogo público', () => {
  const valid = {
    id: '0f0e0d0c-0000-4000-8000-000000000001',
    slug: 'produto-exemplo',
    name: 'Produto Exemplo',
    shortDescription: 'curta',
    description: 'longa',
    imageUrl: null,
    categoryId: 'music',
    categoryLabel: 'Música',
    modality: 'Assinatura',
    period: '30 dias',
    priceCents: 4990,
    accessValidityDays: 30,
    accessValidityLabel: '30 dias',
    instructions: 'Acesse com as credenciais entregues.',
    conditions: ['condição 1'],
    monogram: 'P',
    theme: 'violet',
    maxQuantity: 3,
    allowQuantity: true,
    featured: true,
    availableUnits: 2,
    available: true,
  };

  it('traduz o contrato da Edge Function para o modelo da interface', () => {
    const product = mapPublicProduct(valid);
    expect(product).not.toBeNull();
    expect(product?.priceCents).toBe(4990);
    expect(product?.available).toBe(true);
    expect(product?.allowQuantity).toBe(true);
    expect(product?.delivery).toEqual(['Acesse com as credenciais entregues.']);
    expect(product?.categoryLabel).toBe('Música');
  });

  it('descarta produtos inválidos em vez de renderizar dados quebrados', () => {
    expect(mapPublicProduct(null)).toBeNull();
    expect(mapPublicProduct({ name: 'sem id' })).toBeNull();
    expect(mapPublicProduct({ id: 'x', name: 'sem preço' })).toBeNull();
    expect(mapPublicProduct({ ...valid, priceCents: 0 })).toBeNull();
    expect(mapPublicProduct({ ...valid, priceCents: 'abc' })).toBeNull();
  });

  it('nunca marca como disponível um produto sem unidades', () => {
    const product = mapPublicProduct({ ...valid, availableUnits: 0, available: true });
    expect(product?.available).toBe(false);
  });

  it('limita a quantidade máxima e deriva tema estável quando ausente', () => {
    const product = mapPublicProduct({ ...valid, maxQuantity: 99, theme: 'inexistente' });
    expect(product?.maxQuantity).toBe(20);
    const again = mapPublicProduct({ ...valid, theme: undefined });
    expect(again?.theme).toBe(mapPublicProduct({ ...valid, theme: undefined })?.theme);
  });

  it('ignora itens inválidos e duplicados na resposta do catálogo', () => {
    const parsed = parseCatalogResponse({
      products: [valid, { ...valid, slug: 'outro' }, { id: 'x' }],
      generated_at: '2026-10-31T00:00:00.000Z',
    });
    expect(parsed.products).toHaveLength(1);
    expect(parsed.generatedAt).toBe('2026-10-31T00:00:00.000Z');
    expect(() => parseCatalogResponse({ products: 'nope' })).toThrow();
  });
});

describe('cliente HTTP das Edge Functions', () => {
  const enableBackend = () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://exemplo.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'chave-anon');
    vi.stubEnv('VITE_BACKEND_ENABLED', 'true');
  };

  it('envia a chave anon e o corpo JSON, sem chave privilegiada', async () => {
    enableBackend();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ products: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await invokeFunction('catalog', { method: 'GET' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).apikey).toBe('chave-anon');
    expect(JSON.stringify(init.headers)).not.toMatch(/service_role|secret/i);
    expect(init.method).toBe('GET');
  });

  it('converte erros do backend em BackendError com código estável', async () => {
    enableBackend();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: 'insufficient_stock', message: 'Estoque insuficiente', available_units: 0 }),
          { status: 409 },
        ),
      ),
    );

    await expect(invokeFunction('create-order', { body: {} })).rejects.toMatchObject({
      name: 'BackendError',
      status: 409,
      code: 'insufficient_stock',
    });

    try {
      await invokeFunction('create-order', { body: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(BackendError);
      expect(describeBackendError(error)).toMatch(/unidade/i);
    }
  });

  it('usa o JWT do usuário quando fornecido (painel administrativo)', async () => {
    enableBackend();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await invokeFunction('admin-api', { body: { action: 'session' }, accessToken: 'jwt-do-admin' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-do-admin');
  });
});
