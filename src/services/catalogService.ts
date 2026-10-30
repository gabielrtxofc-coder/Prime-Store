import { products } from '../data/products';
import type { Product } from '../types';

/** Local data adapter. Replace this module with an HTTP-backed repository later. */
export const catalogService = {
  getAll(): Product[] {
    return products;
  },

  getBySlug(slug: string): Product | undefined {
    return products.find((product) => product.slug === slug);
  },

  getById(id: string): Product | undefined {
    return products.find((product) => product.id === id);
  },

  getPriceCents(productId: string): number | undefined {
    return catalogService.getById(productId)?.priceCents;
  },
};
