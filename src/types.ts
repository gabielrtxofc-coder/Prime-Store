export type ProductTheme = 'green' | 'red' | 'violet' | 'rose' | 'gray' | 'blue' | 'orange';

export interface Category {
  id: string;
  label: string;
  description: string;
}

export interface Product {
  id: string;
  slug: string;
  name: string;
  categoryId: string;
  shortDescription: string;
  description: string;
  modality: string;
  period: string;
  /** Integer cents, for all local calculations. This is not a commercial offer. */
  priceCents: number;
  monogram: string;
  theme: ProductTheme;
  available: boolean;
  featured: boolean;
  allowQuantity: boolean;
  maxQuantity?: number;
  conditions: string[];
  delivery: string[];
  /** Campos presentes quando o catálogo vem do backend (Supabase). */
  imageUrl?: string | null;
  instructions?: string;
  availableUnits?: number;
  categoryLabel?: string;
  /** Produto de demonstração do sandbox (credenciais fictícias). */
  isDemo?: boolean;
}

export interface CartEntry {
  productId: string;
  quantity: number;
}

export interface CartLine extends CartEntry {
  product: Product;
  unitPriceCents: number;
  subtotalCents: number;
}

export type PaymentMethod = 'pix' | 'card';

export interface DemoOrderLine {
  productId: string;
  name: string;
  modality: string;
  period: string;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
}

export interface DemoOrder {
  id: string;
  buyerName: string;
  buyerEmail: string;
  paymentMethod: PaymentMethod;
  lines: DemoOrderLine[];
  subtotalCents: number;
  totalCents: number;
  createdAt: string;
  status: 'demo-only';
}
