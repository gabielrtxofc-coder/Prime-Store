import { describe, expect, it } from 'vitest';
import type { Product } from '../types';
import {
  getCartLines,
  getCartPriceChanges,
  getCartTotals,
  getUnavailableCartItems,
  maxOrderableQuantity,
} from './cart';
import { formatCurrency } from './format';
import { validateCheckout, validateContact } from './validation';

/**
 * Fixtures locais do teste (não são catálogo: a loja só lê produtos do
 * backend). Reproduzem as regras de quantidade usadas pelas telas.
 */
const templateKit: Product = {
  id: 'fixture-template-kit',
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
  maxQuantity: 5,
  availableUnits: 8,
  conditions: [],
  delivery: [],
};

const fixedPlan: Product = {
  ...templateKit,
  id: 'fixture-fixed-plan',
  slug: 'acesso-fixo',
  name: 'Acesso de unidade única',
  priceCents: 1990,
  allowQuantity: false,
  maxQuantity: 1,
  availableUnits: 4,
};

const thirdProduct: Product = {
  ...templateKit,
  id: 'fixture-ui-icons',
  slug: 'icones-interface',
  name: 'Pacote de ícones',
  priceCents: 990,
  maxQuantity: 3,
  availableUnits: 3,
};

const catalog = [templateKit, fixedPlan, thirdProduct];

describe('carrinho: preços e normalização', () => {
  it('recalcula preço unitário e total a partir do catálogo do backend', () => {
    const lines = getCartLines(
      [
        { productId: templateKit.id, quantity: 2 },
        { productId: fixedPlan.id, quantity: 1 },
      ],
      catalog,
    );

    expect(lines.map((line) => line.subtotalCents)).toEqual([2980, 1990]);
    expect(getCartTotals(lines)).toEqual({ subtotalCents: 4970, discountCents: 0, totalCents: 4970 });
  });

  it('limita quantidades às regras do produto e ignora produtos fora do catálogo', () => {
    const lines = getCartLines(
      [
        { productId: templateKit.id, quantity: 100 },
        { productId: fixedPlan.id, quantity: 4 },
        { productId: 'missing-product', quantity: 1 },
      ],
      catalog,
    );

    expect(lines.map((line) => line.quantity)).toEqual([5, 1]);
  });

  it('arredonda quantidades fracionárias e trata valores inválidos', () => {
    const lines = getCartLines(
      [
        { productId: templateKit.id, quantity: 2.8 },
        { productId: fixedPlan.id, quantity: Number.POSITIVE_INFINITY },
        { productId: thirdProduct.id, quantity: -5 },
      ],
      catalog,
    );
    expect(lines.map((line) => line.quantity)).toEqual([2, 1, 1]);

    const nonFiniteLines = getCartLines(
      [
        { productId: templateKit.id, quantity: Number.NaN },
        { productId: templateKit.id, quantity: Number.NEGATIVE_INFINITY },
        { productId: fixedPlan.id, quantity: Number.NaN },
      ],
      catalog,
    );
    expect(nonFiniteLines.map((line) => line.quantity)).toEqual([2, 1]);
  });

  it('consolida duplicatas do mesmo produto e limita a soma', () => {
    const lines = getCartLines(
      [
        { productId: templateKit.id, quantity: 3 },
        { productId: templateKit.id, quantity: 4 },
        { productId: fixedPlan.id, quantity: 4 },
        { productId: fixedPlan.id, quantity: 2 },
        { productId: 'removed-product', quantity: 4 },
      ],
      catalog,
    );

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.quantity)).toEqual([5, 1]);
    expect(getCartTotals(lines).totalCents).toBe(9440);
  });

  it('nunca pede mais unidades do que existem no estoque', () => {
    const scarce: Product = { ...templateKit, availableUnits: 2, maxQuantity: 5 };
    const lines = getCartLines([{ productId: scarce.id, quantity: 5 }], [scarce]);
    expect(lines[0].quantity).toBe(2);
    expect(maxOrderableQuantity(scarce)).toBe(2);
  });

  it('devolve zero para carrinho vazio ou só com produtos desconhecidos', () => {
    expect(getCartLines([], catalog)).toEqual([]);
    expect(getCartLines([{ productId: 'no-longer-in-catalog', quantity: 9 }], catalog)).toEqual([]);
    expect(getCartTotals([])).toEqual({ subtotalCents: 0, discountCents: 0, totalCents: 0 });
  });

  it('identifica item que ficou indisponível depois de entrar no carrinho', () => {
    const soldOut: Product = { ...thirdProduct, available: false, availableUnits: 0 };
    const stock = [templateKit, fixedPlan, soldOut];

    const lines = getCartLines([{ productId: templateKit.id, quantity: 1 }, { productId: soldOut.id, quantity: 2 }], stock);
    expect(lines.map((line) => line.productId)).toEqual([templateKit.id]);

    const unavailable = getUnavailableCartItems([{ productId: soldOut.id, quantity: 2 }], stock);
    expect(unavailable).toEqual([
      { productId: soldOut.id, name: soldOut.name, quantity: 2, reason: 'unavailable' },
    ]);

    const removed = getUnavailableCartItems([{ productId: 'saiu-do-catalogo', quantity: 1 }], stock);
    expect(removed[0].reason).toBe('removed');
  });

  it('usa o preço atual do catálogo e sinaliza divergência com o preço antigo', () => {
    const repriced: Product = { ...templateKit, priceCents: 1890 };
    const entries = [{ productId: repriced.id, quantity: 1, priceCents: 1490 }];

    const lines = getCartLines(entries, [repriced]);
    // O valor da linha é o do catálogo, não o que o navegador guardou.
    expect(lines[0].unitPriceCents).toBe(1890);
    expect(lines[0].subtotalCents).toBe(1890);

    expect(getCartPriceChanges(entries, [repriced])).toEqual([
      { productId: repriced.id, name: repriced.name, previousCents: 1490, currentCents: 1890 },
    ]);
    expect(getCartPriceChanges([{ productId: repriced.id, quantity: 1, priceCents: 1890 }], [repriced])).toEqual([]);
  });
});

describe('formatação', () => {
  it('formata valores em reais', () => {
    expect(formatCurrency(1990)).toBe('R$\u00a019,90');
  });
});

describe('validação de formulários', () => {
  it('exige dados válidos, e-mails iguais e aceite dos termos', () => {
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

  it('valida o formulário de contato', () => {
    expect(validateContact({ name: 'Li', email: 'help@example.com', subject: 'Dúvida', message: 'Preciso de ajuda, por favor.' })).toEqual({});
    expect(validateContact({ name: '', email: 'nope', subject: '', message: '' })).toMatchObject({
      name: 'Informe seu nome.',
      email: 'Informe um e-mail válido.',
      subject: 'Informe um assunto.',
    });
  });
});
