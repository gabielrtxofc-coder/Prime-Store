import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CartProvider, useCart } from './CartContext';

function CartActionsProbe() {
  const { entries, totalCents, addItem, setQuantity } = useCart();
  return (
    <div>
      <button type="button" onClick={() => addItem('demo-template-kit', Number.NaN)}>Adicionar quantidade NaN</button>
      <button type="button" onClick={() => addItem('demo-template-kit', 2.8)}>Adicionar quantidade fracionária</button>
      <button type="button" onClick={() => setQuantity('demo-template-kit', Number.POSITIVE_INFINITY)}>Definir quantidade infinita</button>
      <output data-testid="cart-entries">{JSON.stringify(entries)}</output>
      <output data-testid="cart-total">{totalCents}</output>
    </div>
  );
}

describe('CartContext quantity safety', () => {
  it('normalizes invalid additions and does not let an invalid update poison state or storage', async () => {
    const user = userEvent.setup();
    render(<CartProvider><CartActionsProbe /></CartProvider>);

    await user.click(screen.getByRole('button', { name: 'Adicionar quantidade NaN' }));
    expect(screen.getByTestId('cart-entries')).toHaveTextContent('[{"productId":"demo-template-kit","quantity":1}]');
    expect(screen.getByTestId('cart-total')).toHaveTextContent('1490');

    await user.click(screen.getByRole('button', { name: 'Adicionar quantidade fracionária' }));
    expect(screen.getByTestId('cart-entries')).toHaveTextContent('[{"productId":"demo-template-kit","quantity":3}]');
    expect(screen.getByTestId('cart-total')).toHaveTextContent('4470');

    await user.click(screen.getByRole('button', { name: 'Definir quantidade infinita' }));
    expect(screen.getByTestId('cart-entries')).toHaveTextContent('[{"productId":"demo-template-kit","quantity":3}]');

    expect(JSON.parse(window.localStorage.getItem('prime-store-demo-cart-v1') ?? '[]')).toEqual([
      { productId: 'demo-template-kit', quantity: 3 },
    ]);
  });
});
