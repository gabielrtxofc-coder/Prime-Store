import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminProducts } from './AdminProducts';
import type { AdminProduct } from '../../services/adminApi';

/**
 * Missão UX — protótipo de usabilidade do cadastro de produtos.
 *
 * Cobre apenas o que a reorganização introduziu (seções A–E, dicas por campo,
 * erros junto ao campo, prévia de imagem, margem estimada, resumo, proteção
 * contra perda de dados, estado de salvamento e consistência criar/editar).
 * As regras de negócio continuam cobertas por `adminProducts.test.tsx`.
 */

const api = vi.hoisted(() => ({
  listProducts: vi.fn(),
  getProduct: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  setProductActive: vi.fn(),
}));

vi.mock('../../services/adminApi', () => ({ adminApi: api }));

const PRODUCT: AdminProduct = {
  id: 'prod-1',
  slug: 'conta-alpha',
  name: 'Conta Alpha',
  category_id: 'productivity',
  category_label: 'Produtividade',
  price_cents: 4990,
  cost_cents: 2000,
  margin_cents: 2990,
  is_active: true,
  is_featured: true,
  max_quantity_per_order: 2,
  access_validity_days: 30,
  access_validity_label: '30 dias',
  short_description: 'Conta de teste',
  description: 'Descrição completa',
  instructions: 'Use as credenciais enviadas.',
  conditions: ['Uso pessoal'],
  modality: 'Conta compartilhada',
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

beforeEach(() => {
  api.listProducts.mockResolvedValue({ products: [PRODUCT] });
  api.getProduct.mockResolvedValue({ product: PRODUCT, price_history: [] });
  api.createProduct.mockResolvedValue({ product: PRODUCT });
  api.updateProduct.mockResolvedValue({ product: PRODUCT });
  api.setProductActive.mockResolvedValue({ product: PRODUCT });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const submitForm = () => {
  fireEvent.submit(screen.getByRole('button', { name: 'Criar produto' }).closest('form')!);
};

describe('AdminProducts — usabilidade do cadastro (missão UX)', () => {
  it('organiza o formulário em cinco seções identificáveis, sem etapas escondidas', async () => {
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');

    for (const heading of [
      'Informações principais',
      'Imagens',
      'Preços',
      'Estoque e validade',
      'Publicação e aparência',
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }

    // Continua sendo um único formulário (uma única ação de salvar).
    const form = screen.getByRole('button', { name: 'Criar produto' }).closest('form')!;
    expect(form).toBeInTheDocument();
    expect(within(form).getAllByRole('button', { name: 'Criar produto' })).toHaveLength(1);
  });

  it('mostra dicas por campo e marca os obrigatórios', async () => {
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');

    expect(screen.getByLabelText('Nome')).toBeRequired();
    expect(screen.getByLabelText(/Preço de venda/)).toBeRequired();
    expect(screen.getByLabelText(/Preço de venda/)).toHaveAccessibleDescription(/Valor que o cliente paga, em reais/);
    expect(screen.getByLabelText(/Custo de aquisição/)).toHaveAccessibleDescription(/Opcional/);
    expect(screen.getByLabelText(/URL da imagem/)).toHaveAccessibleDescription(/Cole a URL completa/);
    expect(screen.getByLabelText(/Qtd\. máxima por pedido/)).toHaveAccessibleDescription(/1 a 20/);
  });

  it('coloca a mensagem de erro junto do campo e marca aria-invalid', async () => {
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');

    submitForm();

    const nameField = screen.getByLabelText('Nome');
    expect(nameField).toHaveAttribute('aria-invalid', 'true');
    expect(nameField).toHaveAccessibleDescription(/Informe o nome do produto/);
    expect(screen.getByLabelText(/Preço de venda/)).toHaveAttribute('aria-invalid', 'true');
    // O alerta do topo continua existindo (resumo), mas o erro está no campo.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Informe o nome do produto/);
    expect(api.createProduct).not.toHaveBeenCalled();
  });

  it('pré-visualiza a imagem e permite limpar a seleção', async () => {
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');

    fireEvent.change(screen.getByLabelText(/URL da imagem/), { target: { value: 'https://exemplo.com/capa.png' } });
    const preview = screen.getByRole('img', { name: /Pré-visualização da imagem do produto/ });
    expect(preview).toHaveAttribute('src', 'https://exemplo.com/capa.png');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Limpar imagem' }));
    expect(screen.queryByRole('img', { name: /Pré-visualização/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/URL da imagem/)).toHaveValue('');
  });

  it('valida a URL da imagem e destaca o campo correspondente', async () => {
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Conta Gama' } });
    fireEvent.change(screen.getByLabelText(/Preço de venda/), { target: { value: '49,90' } });
    fireEvent.change(screen.getByLabelText(/URL da imagem/), { target: { value: 'capa.png' } });
    submitForm();

    expect(screen.getByLabelText(/URL da imagem/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/URL da imagem/)).toHaveAccessibleDescription(/URL de imagem válida/);
    expect(api.createProduct).not.toHaveBeenCalled();
  });

  it('calcula a margem estimada a partir de preço e custo digitados', async () => {
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');

    fireEvent.change(screen.getByLabelText(/Preço de venda/), { target: { value: '100,00' } });
    fireEvent.change(screen.getByLabelText(/Custo de aquisição/), { target: { value: '40,00' } });

    const margin = screen.getByText(/Margem estimada/);
    expect(margin).toHaveTextContent('R$ 60,00');
    expect(margin).toHaveTextContent('60%');
  });

  it('exibe resumo antes de salvar e confirma o salvamento com aviso', async () => {
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');

    expect(screen.getByText(/Novo produto — depois de criar/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Conta Gama' } });
    fireEvent.change(screen.getByLabelText(/Preço de venda/), { target: { value: '49,90' } });
    expect(screen.getByText(/Conta Gama · Outras categorias digitais · R\$ 49,90/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Criar produto' }));

    await waitFor(() => expect(api.createProduct).toHaveBeenCalledTimes(1));
    const payload = api.createProduct.mock.calls[0][0];
    expect(payload).toMatchObject({
      name: 'Conta Gama',
      slug: 'conta-gama',
      price_cents: 4990,
      cost_cents: 0,
      image_url: null,
      is_featured: false,
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Produto criado');
    // O formulário volta ao estado inicial após salvar.
    expect(screen.getByLabelText('Nome')).toHaveValue('');
  });

  it('protege contra perda de dados ao trocar de produto ou descartar a edição', async () => {
    const user = userEvent.setup();
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Rascunho' } });
    await user.click(screen.getByRole('button', { name: 'Novo produto' }));

    let dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Descartar alterações?');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByLabelText('Nome')).toHaveValue('Rascunho');

    await user.click(screen.getByRole('button', { name: 'Novo produto' }));
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Descartar alterações' }));
    expect(screen.getByLabelText('Nome')).toHaveValue('');
  });

  it('mantém criar e editar no mesmo formulário, com slug travado e resumo da publicação', async () => {
    const user = userEvent.setup();
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');

    await user.click(screen.getByRole('button', { name: 'Editar' }));

    expect(screen.getByRole('heading', { name: 'Editar produto' })).toBeInTheDocument();
    expect(screen.getByLabelText('Nome')).toHaveValue('Conta Alpha');
    expect(screen.getByLabelText(/Preço de venda/)).toHaveValue('49,90');
    expect(screen.getByLabelText('Slug (URL)')).toBeDisabled();
    expect(screen.getByLabelText('Slug (URL)')).toHaveAccessibleDescription(/não pode ser alterado/);
    expect(screen.getByText(/Conta Alpha · Produtividade · R\$ 49,90 · Publicado/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar alterações' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Criar produto' })).not.toBeInTheDocument();
  });

  it('pede confirmação ao cancelar uma edição com alterações e salva o patch sem slug', async () => {
    const user = userEvent.setup();
    render(<AdminProducts />);
    await screen.findByText('Conta Alpha');

    await user.click(screen.getByRole('button', { name: 'Editar' }));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Conta Alpha 2' } });

    await user.click(screen.getByRole('button', { name: 'Cancelar edição' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Descartar alterações?');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByLabelText('Nome')).toHaveValue('Conta Alpha 2');

    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    await waitFor(() => expect(api.updateProduct).toHaveBeenCalledTimes(1));
    const [id, patch] = api.updateProduct.mock.calls[0];
    expect(id).toBe('prod-1');
    expect(patch.name).toBe('Conta Alpha 2');
    expect(patch).not.toHaveProperty('slug');
    expect(await screen.findByRole('status')).toHaveTextContent('Produto atualizado');
  });
});
