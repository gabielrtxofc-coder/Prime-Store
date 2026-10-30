import type { Product } from '../types';
import { ProductCard } from './ProductCard';

export function ProductGrid({ products: items }: { products: Product[] }) {
  return (
    <div className="product-grid">
      {items.map((product) => <ProductCard key={product.id} product={product} />)}
    </div>
  );
}
