import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CartProvider, useCart } from './CartContext';
import { catalogService } from '../services/catalogService';
import type { Product } from '../types';

/** Produto de teste (não é catálogo: só o snapshot injetado no serviço). */
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

const product: Product = {
  id: PRODUCT_ID,
  slug: 'kit-de-templates',
  name: 'Kit de templates',
  categoryId: 'creative',
  categoryLabel: 'Design e criatividade',
  shortDescription: 'Templates editáveis',
  description: 'Kit de templates digitais.',
  modality: 'Pacote digital',
  period: 'acesso imediato',
  priceCents: 1490,
  monogram: 'K',
  theme: 'violet',
  available: true,
  featured: true,
  allowQuantity: true,
  maxQuantity: 10,
  availableUnits: 8,
  conditions: [],
  delivery: [],
};

function CartActionsProbe() {
  const { entries, totalCents, addItem, setQuantity } = useCart();
  return (
    <div>
      <button type="button" onClick={() => addItem(PRODUCT_ID, Number.NaN)}>Adicionar quantidade NaN</button>
      <button type="button" onClick={() => addItem(PRODUCT_ID, 2.8)}>Adicionar quantidade fracionária</button>
      <button type="button" onClick={() => setQuantity(PRODUCT_ID, Number.POSITIVE_INFINITY)}>Definir quantidade infinita</button>
      <button type="button" onClick={() => addItem('produto-inexistente')}>Adicionar produto inexistente</button>
      <output data-testid="cart-entries">{JSON.stringify(entries)}</output>
      <output data-testid="cart-total">{totalCents}</output>
    </div>
  );
}

beforeEach(() => {
  catalogService.reset();
  catalogService.setSnapshot([product]);
  window.localStorage.clear();
});

afterEach(() => {
  catalogService.reset();
  window.localStorage.clear();
});

describe('CartContext: segurança das quantidades', () => {
  it('normaliza adições inválidas e não deixa um update inválido contaminar estado ou armazenamento', async () => {
    const user = userEvent.setup();
    render(<CartProvider><CartActionsProbe /></CartProvider>);

    await user.click(screen.getByRole('button', { name: 'Adicionar quantidade NaN' }));
    expect(screen.getByTestId('cart-entries')).toHaveTextContent(`[{"productId":"${PRODUCT_ID}","quantity":1,"priceCents":1490}]`);
    expect(screen.getByTestId('cart-total')).toHaveTextContent('1490');

    await user.click(screen.getByRole('button', { name: 'Adicionar quantidade fracionária' }));
    expect(screen.getByTestId('cart-entries')).toHaveTextContent(`"quantity":3`);
    expect(screen.getByTestId('cart-total')).toHaveTextContent('4470');

    await user.click(screen.getByRole('button', { name: 'Definir quantidade infinita' }));
    expect(screen.getByTestId('cart-entries')).toHaveTextContent(`"quantity":3`);

    await user.click(screen.getByRole('button', { name: 'Adicionar produto inexistente' }));
    expect(screen.getByTestId('cart-entries')).toHaveTextContent(`"quantity":3`);

    const stored = JSON.parse(window.localStorage.getItem('prime-store-cart-v2') ?? '[]');
    expect(stored).toEqual([{ productId: PRODUCT_ID, quantity: 3, priceCents: 1490 }]);
  });

  it('não adiciona produto indisponível', async () => {
    catalogService.setSnapshot([{ ...product, available: false, availableUnits: 0 }]);
    const user = userEvent.setup();
    render(<CartProvider><CartActionsProbe /></CartProvider>);

    await user.click(screen.getByRole('button', { name: 'Adicionar quantidade NaN' }));
    expect(screen.getByTestId('cart-total')).toHaveTextContent('0');
  });
});

describe('CartContext: teto de 10 produtos distintos por pedido', () => {
  const manyProducts = Array.from({ length: 11 }, (_, index) => ({
    ...product,
    id: `11111111-1111-4111-8111-${String(200000000000 + index).padStart(12, '0')}`,
    slug: `produto-limite-${index}`,
    name: `Produto limite ${index}`,
  }));

  function ManyProductsProbe() {
    const { entries, addItem } = useCart();
    return (
      <div>
        {manyProducts.map((item) => (
          <button key={item.id} type="button" onClick={() => addItem(item.id)}>
            Adicionar {item.name}
          </button>
        ))}
        <output data-testid="cart-entries">{JSON.stringify(entries)}</output>
      </div>
    );
  }

  it('aceita 10 produtos distintos e recusa o 11º sem alterar o carrinho', async () => {
    catalogService.setSnapshot(manyProducts);
    const user = userEvent.setup();
    render(
      <CartProvider>
        <ManyProductsProbe />
      </CartProvider>,
    );

    for (const item of manyProducts.slice(0, 10)) {
      await user.click(screen.getByRole('button', { name: `Adicionar ${item.name}` }));
    }
    const entriesAfterTen = JSON.parse(screen.getByTestId('cart-entries').textContent ?? '[]') as unknown[];
    expect(entriesAfterTen).toHaveLength(10);

    await user.click(screen.getByRole('button', { name: `Adicionar ${manyProducts[10].name}` }));
    const entriesAfterEleventh = JSON.parse(screen.getByTestId('cart-entries').textContent ?? '[]') as unknown[];
    expect(entriesAfterEleventh).toHaveLength(10);
    expect(entriesAfterEleventh).not.toContainEqual(
      expect.objectContaining({ productId: manyProducts[10].id }),
    );

    // Um produto JÁ presente continua recebendo quantidade (o teto é de
    // produtos distintos, não de unidades).
    await user.click(screen.getByRole('button', { name: `Adicionar ${manyProducts[0].name}` }));
    const entriesFinal = JSON.parse(screen.getByTestId('cart-entries').textContent ?? '[]') as Array<{
      productId: string;
      quantity: number;
    }>;
    expect(entriesFinal).toHaveLength(10);
    expect(entriesFinal.find((entry) => entry.productId === manyProducts[0].id)?.quantity).toBe(2);
  });
});
