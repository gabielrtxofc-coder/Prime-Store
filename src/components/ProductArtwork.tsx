import type { Product } from '../types';

export function ProductArtwork({ product, size = 'card' }: { product: Product; size?: 'card' | 'detail' }) {
  return (
    <div className={`product-art product-art--${product.theme} product-art--${size}`} aria-hidden="true">
      <span className="product-art__orb product-art__orb--one" />
      <span className="product-art__orb product-art__orb--two" />
      <span className="product-art__monogram">{product.monogram}</span>
      <span className="product-art__tag">DEMO</span>
      <span className="product-art__grid" />
    </div>
  );
}
