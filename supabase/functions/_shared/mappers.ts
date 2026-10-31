/** Conversão entre o formato do banco (snake_case) e o contrato da API. */

export interface CatalogRow {
  id: string;
  slug: string;
  name: string;
  short_description: string;
  description: string;
  image_url: string | null;
  category_id: string;
  category_label: string;
  modality: string;
  period: string;
  price_cents: number;
  access_validity_days: number | null;
  access_validity_label: string;
  instructions: string;
  conditions: string[];
  monogram: string;
  theme: string;
  max_quantity_per_order: number;
  is_featured: boolean;
  available_units: number;
  is_available: boolean;
  is_demo?: boolean;
}

export interface PublicProduct {
  id: string;
  slug: string;
  name: string;
  shortDescription: string;
  description: string;
  imageUrl: string | null;
  categoryId: string;
  categoryLabel: string;
  modality: string;
  period: string;
  priceCents: number;
  accessValidityDays: number | null;
  accessValidityLabel: string;
  instructions: string;
  conditions: string[];
  monogram: string;
  theme: string;
  maxQuantity: number;
  allowQuantity: boolean;
  featured: boolean;
  availableUnits: number;
  available: boolean;
  /** Produto de demonstração (somente em sandbox). */
  isDemo: boolean;
}

export function mapCatalogProduct(row: CatalogRow): PublicProduct {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    shortDescription: row.short_description,
    description: row.description,
    imageUrl: row.image_url,
    categoryId: row.category_id,
    categoryLabel: row.category_label,
    modality: row.modality,
    period: row.period,
    priceCents: row.price_cents,
    accessValidityDays: row.access_validity_days,
    accessValidityLabel: row.access_validity_label,
    instructions: row.instructions,
    conditions: row.conditions ?? [],
    monogram: row.monogram,
    theme: row.theme,
    maxQuantity: row.max_quantity_per_order,
    allowQuantity: row.max_quantity_per_order > 1,
    featured: row.is_featured,
    availableUnits: row.available_units,
    available: row.is_available,
    isDemo: row.is_demo === true,
  };
}

export function centsToNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
