import type { Product } from '../types';

/**
 * Arte do produto.
 *
 * Quando o cadastro tem imagem (`imageUrl`), ela é exibida. Sem imagem, a loja
 * desenha um monograma com o tema do produto — não há mais selo "DEMO": a arte
 * não representa disponibilidade, que é sempre exibida em texto ao lado.
 */
export function ProductArtwork({ product, size = 'card' }: { product: Product; size?: 'card' | 'detail' }) {
  const imageUrl = typeof product.imageUrl === 'string' && product.imageUrl.trim().length > 0
    ? product.imageUrl.trim()
    : null;

  return (
    <div className={`product-art product-art--${product.theme} product-art--${size}`}>
      <span className="product-art__orb product-art__orb--one" aria-hidden="true" />
      <span className="product-art__orb product-art__orb--two" aria-hidden="true" />
      {imageUrl ? (
        <img
          className="product-art__image"
          src={imageUrl}
          alt={`Imagem de ${product.name}`}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="product-art__monogram" aria-hidden="true">{product.monogram}</span>
      )}
      <span className="product-art__grid" aria-hidden="true" />
    </div>
  );
}
