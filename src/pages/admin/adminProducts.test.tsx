import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminProducts } from './AdminProducts';
import type { AdminProduct } from '../../services/adminApi';

/**
 * Missão 03.2C — catálogo administrativo sobre os campos reais do banco.
 *
 * Garante: validações que bloqueiam números negativos/inválidos, criação e
 * edição (preço/nome/descrição), ativar/desativar (sem exclusão física),
 * filtros, detalhes com histórico de preço e erros compreensíveis.
 */

const api = vi.hoisted(() => ({
  listProducts: vi.fn(),
  getProduct: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  setProductActive: vi.fn(),
}));

vi.mock('../../services/adminApi', () => ({ adminApi: api }));

const PRODUCT_ACTIVE: AdminProduct = {
  id: 'prod-1',
  slug: 'conta-alpha',
  name: 'Conta Alpha',
  category_id: 'streaming',
  category_label: 'Streaming',
  price_cents: 2990,
  cost_cents: 1000,
  margin_cents: 1990,
  is_active: true,
  is_featured: false,
  max_quantity_per_order: 2,
  access_validity_days: 30,
  access_validity_label: '30 dias',
  short_description: 'Conta de teste Alpha',
  description: 'Descrição completa Alpha',
  instructions: 'Use as credenciais enviadas.',
  conditions: ['Uso pessoal'],
  modality: 'Produto digital',
  period: 'Mensal',
  monogram: 'CA',
  theme: 'blue',
  image_url: null,
  available_units: 5,
  reserved_units: 1,
  sold_units: 7,
  created_at: '2026-10-01T12:00:00.000Z',
  updated_at: '2026-11-01T12:00:00.000Z',
};

const PRODUCT_INACTIVE: AdminProduct = {
  ...PRODUCT_ACTIVE,
  id: 'prod-2',
  slug: 'conta-beta',
  name: 'Conta Beta',
  is_active: false,
};

const ALL_PRODUCTS = { products: [PRODUCT_ACTIVE, PRODUCT_INACTIVE] };

beforeEach(() => {
  api.listProducts.mockResolvedValue(ALL_PRODUCTS);
  api.getProduct.mockResolvedValue({
    product: PRODUCT_ACTIVE,
    price_history: [
      { old_price_cents: 1500, new_price_cents: 2990, old_cost_cents: 800, new_cost_cents: 1000, changed_at: '2026-10-15T12:00:00.000Z' },
    ],
  });
  api.createProduct.mockResolvedValue({ product: PRODUCT_ACTIVE });
  api.updateProduct.mockResolvedValue({ product: PRODUCT_ACTIVE });
  api.setProductActive.mockResolvedValue({ product: { ...PRODUCT_ACTIVE, is_active: false } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const fillValidForm = () => {
  fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Conta Gama' } });
  fireEvent.change(screen.getByLabelText(/Preço de venda/), { target: { value: '49,90' } });
};

describe('AdminProducts (missão 03.2C)', () => {
  it('lista produtos reais com preços em BRL e situação', async () => {
    render(<AdminProducts />);
    expect(await screen.findByText('Conta Alpha')).toBeInTheDocument();
    expect(screen.getByText('Conta Beta')).toBeInTheDocument();
    expect(screen.getAllByText('R$ 29,90').length).toBeGreaterThan(0);
    expect(screen.getByText('ativo')).toBeInTheDocument();
    expect(screen.getByText('inativo')).toBeInTheDocument();
  });

  it('busca é enviada ao backend e o filtro de situação é aplicado', async () => {
    const user = userEvent.setup();
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');

    await user.type(screen.getByLabelText('Buscar produtos'), 'alpha');
    await waitFor(() => {
      expect(api.listProducts).toHaveBeenLastCalledWith('alpha', true);
    });

    await user.selectOptions(screen.getByLabelText('Filtrar por situação'), 'inactive');
    expect(screen.queryByText('Conta Alpha')).not.toBeInTheDocument();
    expect(screen.getByText('Conta Beta')).toBeInTheDocument();
  });

  it('bloqueia preço zero/negativo e custo negativo na criação', async () => {
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');

    // Preço zero
    fillValidForm();
    fireEvent.change(screen.getByLabelText(/Preço de venda/), { target: { value: '0' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Criar produto' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('maior que zero');
    expect(api.createProduct).not.toHaveBeenCalled();

    // Preço negativo
    fireEvent.change(screen.getByLabelText(/Preço de venda/), { target: { value: '-10' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Criar produto' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('maior que zero');

    // Custo negativo
    fireEvent.change(screen.getByLabelText(/Preço de venda/), { target: { value: '19,90' } });
    fireEvent.change(screen.getByLabelText(/Custo de aquisição/), { target: { value: '-5' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Criar produto' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Custo de aquisição inválido');
    expect(api.createProduct).not.toHaveBeenCalled();
  });

  it('bloqueia quantidade máxima e validade inválidas', async () => {
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');
    fillValidForm();

    fireEvent.change(screen.getByLabelText(/Qtd\. máxima/), { target: { value: '0' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Criar produto' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('entre 1 e 20');

    fireEvent.change(screen.getByLabelText(/Qtd\. máxima/), { target: { value: '25' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Criar produto' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('entre 1 e 20');

    fireEvent.change(screen.getByLabelText(/Qtd\. máxima/), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/Validade do acesso/), { target: { value: '0' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Criar produto' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Validade do acesso');
    expect(api.createProduct).not.toHaveBeenCalled();
  });

  it('cria produto válido com payload saneado (preço em centavos)', async () => {
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');
    fillValidForm();
    fireEvent.change(screen.getByLabelText(/Custo de aquisição/), { target: { value: '12,50' } });
    fireEvent.change(screen.getByLabelText(/Qtd\. máxima/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar produto' }));
    await waitFor(() => {
      expect(api.createProduct).toHaveBeenCalledTimes(1);
    });
    const [payload] = api.createProduct.mock.calls[0];
    expect(payload.price_cents).toBe(4990);
    expect(payload.cost_cents).toBe(1250);
    expect(payload.max_quantity_per_order).toBe(5);
    expect(payload.name).toBe('Conta Gama');
    expect(payload.slug).toBe('conta-gama');
  });

  it('edita preço de produto existente e não reenvia slug', async () => {
    const user = userEvent.setup();
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');

    const editButtons = screen.getAllByRole('button', { name: 'Editar' });
    await user.click(editButtons[0]);
    const priceInput = screen.getByLabelText(/Preço de venda/);
    fireEvent.change(priceInput, { target: { value: '39,90' } });
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    await waitFor(() => {
      expect(api.updateProduct).toHaveBeenCalledWith('prod-1', expect.objectContaining({ price_cents: 3990 }));
    });
    const [, patch] = api.updateProduct.mock.calls[0];
    expect(patch).not.toHaveProperty('slug');
  });

  it('desativa e reativa produto sem exclusão física', async () => {
    const user = userEvent.setup();
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');

    await user.click(screen.getByRole('button', { name: 'Desativar' }));
    const dialog = await screen.findByRole('dialog');
    expect(api.setProductActive).not.toHaveBeenCalled(); // desativa só após confirmar
    await user.click(within(dialog).getByRole('button', { name: 'Desativar' }));
    expect(api.setProductActive).toHaveBeenCalledWith('prod-1', false);

    // Nunca oferece exclusão: pedidos antigos continuam íntegros.
    expect(screen.queryByRole('button', { name: /excluir|deletar|remover/i })).not.toBeInTheDocument();
  });

  it('detalhes mostram histórico de preço real do backend', async () => {
    const user = userEvent.setup();
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');

    await user.click(screen.getAllByRole('button', { name: 'Detalhes' })[0]);
    expect(await screen.findByText(/Detalhes — Conta Alpha/)).toBeInTheDocument();
    expect(api.getProduct).toHaveBeenCalledWith('prod-1');
    expect(screen.getByText('Histórico de preço')).toBeInTheDocument();
    expect(screen.getByText('R$ 15,00')).toBeInTheDocument(); // preço anterior no histórico
  });

  it('erro de carregamento é exibido como alerta, sem dados inventados', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.listProducts.mockRejectedValue(new Error('falha ao listar'));
    render(<AdminProducts />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Nenhum produto/)).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
