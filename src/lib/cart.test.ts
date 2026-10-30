import { describe, expect, it } from 'vitest';
import { products } from '../data/products';
import { getCartLines, getCartTotals } from './cart';
import { formatCurrency } from './format';
import { validateCheckout, validateContact } from './validation';

const templateKit = products.find((product) => product.id === 'demo-template-kit');
const fixedPlan = products.find((product) => product.id === 'demo-music-individual');

if (!templateKit || !fixedPlan) throw new Error('Fixture de catálogo não encontrada.');

describe('cart pricing and normalization', () => {
  it('recalculates unit prices and totals from the local catalog', () => {
    const lines = getCartLines([
      { productId: templateKit.id, quantity: 2 },
      { productId: fixedPlan.id, quantity: 1 },
    ]);

    expect(lines.map((line) => line.subtotalCents)).toEqual([2980, 1990]);
    expect(getCartTotals(lines)).toEqual({ subtotalCents: 4970, discountCents: 0, totalCents: 4970 });
  });

  it('clamps quantities to product rules and ignores unknown products', () => {
    const lines = getCartLines([
      { productId: templateKit.id, quantity: 100 },
      { productId: fixedPlan.id, quantity: 4 },
      { productId: 'missing-product', quantity: 1 },
    ]);

    expect(lines.map((line) => line.quantity)).toEqual([5, 1]);
  });

  it('floors fractional quantities and safely normalizes non-finite or negative values', () => {
    const lines = getCartLines([
      { productId: templateKit.id, quantity: 2.8 },
      { productId: fixedPlan.id, quantity: Number.POSITIVE_INFINITY },
      { productId: 'demo-ui-icons', quantity: -5 },
    ]);
    expect(lines.map((line) => line.quantity)).toEqual([2, 1, 1]);

    const nonFiniteLines = getCartLines([
      { productId: templateKit.id, quantity: Number.NaN },
      { productId: templateKit.id, quantity: Number.NEGATIVE_INFINITY },
      { productId: fixedPlan.id, quantity: Number.NaN },
    ]);
    expect(nonFiniteLines.map((line) => line.quantity)).toEqual([2, 1]);
  });

  it('merges duplicate product IDs and clamps the merged quantity', () => {
    const lines = getCartLines([
      { productId: templateKit.id, quantity: 3 },
      { productId: templateKit.id, quantity: 4 },
      { productId: fixedPlan.id, quantity: 4 },
      { productId: fixedPlan.id, quantity: 2 },
      { productId: 'removed-product', quantity: 4 },
    ]);

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.quantity)).toEqual([5, 1]);
    expect(getCartTotals(lines).totalCents).toBe(9440);
  });

  it('returns zero totals for an empty cart or entries with unknown products', () => {
    expect(getCartLines([])).toEqual([]);
    expect(getCartLines([{ productId: 'no-longer-in-catalog', quantity: 9 }])).toEqual([]);
    expect(getCartTotals([])).toEqual({ subtotalCents: 0, discountCents: 0, totalCents: 0 });
  });

  it('formats amounts in Brazilian reais', () => {
    expect(formatCurrency(1990)).toBe('R$ 19,90');
  });
});

describe('form validation', () => {
  it('requires valid guest details, matching email, and explicit terms acceptance', () => {
    expect(validateCheckout({
      fullName: 'Ana da Silva',
      email: 'ana@example.com',
      confirmEmail: 'ana@example.com',
      acceptedTerms: true,
    })).toEqual({});

    expect(validateCheckout({
      fullName: 'A',
      email: 'ana@example.com',
      confirmEmail: 'other@example.com',
      acceptedTerms: false,
    })).toMatchObject({
      fullName: 'Informe seu nome completo.',
      confirmEmail: 'Os e-mails informados não são iguais.',
      acceptedTerms: 'Confirme que leu os termos provisórios para continuar.',
    });
  });

  it('validates the local-only contact form', () => {
    expect(validateContact({ name: 'Li', email: 'help@example.com', subject: 'Dúvida', message: 'Preciso de ajuda, por favor.' })).toEqual({});
    expect(validateContact({ name: '', email: 'nope', subject: '', message: '' })).toMatchObject({
      name: 'Informe seu nome.',
      email: 'Informe um e-mail válido.',
      subject: 'Informe um assunto.',
    });
  });
});
