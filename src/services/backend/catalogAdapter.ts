import type { Product, ProductTheme } from '../../types';

/**
 * Tradução do contrato público da Edge Function `catalog` para o modelo da
 * interface. Todo dado recebido é tratado como não confiável: campos ausentes
 * ou inválidos são descartados e nunca viram `undefined` em tempo de execução.
 */

const THEMES: readonly ProductTheme[] = ['green', 'red', 'violet', 'rose', 'gray', 'blue', 'orange'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const asInt = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const normalizeSlug = (value: string): string => {
  const slug = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'produto';
};

/** Tema estável derivado do slug, usado quando o backend não informa um válido. */
export function themeForSlug(slug: string): ProductTheme {
  let hash = 0;
  for (let index = 0; index < slug.length; index += 1) {
    hash = (hash * 31 + slug.charCodeAt(index)) % 100000;
  }
  return THEMES[hash % THEMES.length];
}

export function monogramForName(name: string): string {
  const cleaned = name.replace(/[^A-Za-zÀ-ÿ0-9]/g, '');
  return (cleaned[0] ?? 'P').toUpperCase();
}

export interface MapOptions {
  /** Produto local usado apenas como referência visual (imagem/tema). */
  visualHint?: Pick<Product, 'theme' | 'monogram'>;
}

/**
 * Converte um item de `GET/POST /catalog` em `Product`.
 * Retorna `null` quando o payload não tem o mínimo necessário para exibir
 * um produto (id, nome, preço inteiro positivo e slug).
 */
export function mapPublicProduct(raw: unknown, options: MapOptions = {}): Product | null {
  if (!isRecord(raw)) return null;

  const id = asString(raw.id).trim();
  const name = asString(raw.name).trim();
  const priceCents = asInt(raw.priceCents, -1);
  if (!id || !name || priceCents <= 0) return null;

  const slug = normalizeSlug(asString(raw.slug) || name);
  const themeValue = asString(raw.theme);
  const theme = (THEMES as readonly string[]).includes(themeValue)
    ? (themeValue as ProductTheme)
    : (options.visualHint?.theme ?? themeForSlug(slug));

  const maxQuantity = Math.max(1, Math.min(asInt(raw.maxQuantity, 1), 20));
  const instructions = asString(raw.instructions).trim();
  const conditions = asStringArray(raw.conditions).filter((item) => item.trim().length > 0);
  const availableUnits = Math.max(0, asInt(raw.availableUnits, 0));
  const available = raw.available === true && availableUnits > 0;

  return {
    id,
    slug,
    name,
    categoryId: asString(raw.categoryId, 'other'),
    shortDescription: asString(raw.shortDescription),
    description: asString(raw.description),
    modality: asString(raw.modality) || 'Produto digital',
    period: asString(raw.period) || asString(raw.accessValidityLabel),
    priceCents,
    monogram: (asString(raw.monogram) || options.visualHint?.monogram || monogramForName(name)).slice(0, 2),
    theme,
    available,
    featured: raw.featured === true,
    allowQuantity: raw.allowQuantity === true && maxQuantity > 1,
    maxQuantity,
    conditions,
    delivery: instructions ? [instructions] : [],
    imageUrl: typeof raw.imageUrl === 'string' ? raw.imageUrl : null,
    instructions,
    availableUnits,
    categoryLabel: asString(raw.categoryLabel),
    isDemo: raw.isDemo === true,
  };
}

export interface CatalogPayload {
  products: Product[];
  generatedAt: string | null;
}

/** Lê a resposta de `/catalog` descartando itens inválidos. */
export function parseCatalogResponse(payload: unknown): CatalogPayload {
  if (!isRecord(payload) || !Array.isArray(payload.products)) {
    throw new Error('invalid_catalog_payload');
  }

  const seen = new Set<string>();
  const products: Product[] = [];
  for (const raw of payload.products) {
    const product = mapPublicProduct(raw);
    if (!product || seen.has(product.id)) continue;
    seen.add(product.id);
    products.push(product);
  }

  return {
    products,
    generatedAt: typeof payload.generated_at === 'string' ? payload.generated_at : null,
  };
}
