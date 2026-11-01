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
