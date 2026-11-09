import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminStock } from './AdminStock';
import type { AdminProduct, AdminStockList, AdminStockSummary, AdminStockUnit } from '../../services/adminApi';

/**
 * Missão 03.2D — estoque com fontes reais do painel.
 *
 * Garante: badges de sem/baixo estoque apenas com a regra existente (≤ 2),
 * validações de entrada (e-mail, senha mínima, observações), auditoria de
 * visualização de credenciais explícita e o fluxo de importação CSV com
 * prévia preservado.
 */

const api = vi.hoisted(() => ({
  listProducts: vi.fn(),
  stockSummary: vi.fn(),
  listStock: vi.fn(),
  addStock: vi.fn(),
  setStockStatus: vi.fn(),
  previewImport: vi.fn(),
  commitImport: vi.fn(),
}));

vi.mock('../../services/adminApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/adminApi')>();
  return { ...actual, adminApi: api };
});

const PRODUCT_ZERO: AdminProduct = {
  id: 'prod-zero',
  slug: 'sem-estoque',
  name: 'Conta Esgotada',
  category_id: 'streaming',
  category_label: 'Streaming',
  price_cents: 2990,
  cost_cents: 1000,
  margin_cents: 1990,
  is_active: true,
  is_featured: false,
  max_quantity_per_order: 1,
  access_validity_days: 30,
  access_validity_label: '30 dias',
  short_description: '',
  description: '',
  instructions: '',
  conditions: [],
  modality: 'Produto digital',
  period: 'Mensal',
  monogram: 'ES',
  theme: 'blue',
  image_url: null,
  available_units: 0,
  reserved_units: 0,
  sold_units: 9,
  created_at: '2026-10-01T12:00:00.000Z',
  updated_at: '2026-11-01T12:00:00.000Z',
};

const PRODUCT_LOW: AdminProduct = { ...PRODUCT_ZERO, id: 'prod-low', slug: 'baixo', name: 'Conta Limitada', available_units: 2, sold_units: 3 };
const PRODUCT_OK: AdminProduct = { ...PRODUCT_ZERO, id: 'prod-ok', slug: 'ok', name: 'Conta Abundante', available_units: 9, sold_units: 1 };

const UNIT: AdminStockUnit = {
  id: 'unit-1',
  product_id: 'prod-ok',
  product_name: 'Conta Abundante',
  status: 'available',
  notes: '',
  credential_fingerprint: 'a'.repeat(64),
  import_batch_id: null,
  sold_order_id: null,
  sold_at: null,
  created_at: '2026-11-05T10:00:00.000Z',
  updated_at: '2026-11-05T10:00:00.000Z',
  reservation_expires_at: null,
  reservation_order_id: null,
  status_reason: null,
  status_reason_note: '',
  email: null,
  password: null,
};

const SUMMARY: AdminStockSummary = { total: 10, available: 9, reserved: 0, sold: 1, disabled: 0 };
const STOCK_LIST: AdminStockList = { items: [UNIT], total: 1, limit: 100, offset: 0 };

beforeEach(() => {
  api.listProducts.mockResolvedValue({ products: [PRODUCT_ZERO, PRODUCT_LOW, PRODUCT_OK] });
  api.stockSummary.mockResolvedValue(SUMMARY);
  api.listStock.mockResolvedValue(STOCK_LIST);
  api.addStock.mockResolvedValue({ unit: { id: 'unit-new', status: 'available' } });
  api.setStockStatus.mockResolvedValue({ unit: { ...UNIT, status: 'disabled' } });
  api.previewImport.mockResolvedValue({
    total_rows: 2,
    valid_rows: 1,
    rejected_rows: 1,
    duplicated_in_file: 0,
    rejected: [{ row_number: 2, reason: 'senha ausente' }],
    preview: [{ row_number: 1, email: 'a***@b.com', password: '***', notes: '' }],
  });
  api.commitImport.mockResolvedValue({
    report: { imported: 1, duplicates: 0, invalid: 1, failures: [{ row_number: 2, reason: 'senha ausente' }] },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AdminStock (missão 03.2D)', () => {
  it('resume o estoque real e sinaliza zero/baixo apenas pela regra ≤ 2', async () => {
    render(<AdminStock />);
    expect((await screen.findAllByText('Conta Esgotada')).length).toBeGreaterThan(0);

    const levelsHeading = screen.getByRole('heading', { name: 'Estoque por produto' });
    const levelsTable = levelsHeading.closest('.admin-panel')!;
    const rowOf = (name: string) =>
      [...levelsTable.querySelectorAll('tbody tr')].find((row) => row.textContent?.includes(name))!;
    expect(rowOf('Conta Esgotada')).toHaveTextContent('sem estoque');
    expect(rowOf('Conta Limitada')).toHaveTextContent('estoque baixo');
    expect(rowOf('Conta Abundante')).toHaveTextContent('ok');

    // Resumo agregado vindo do backend
    const summaryPanel = screen.getByText('Disponíveis').closest('.admin-metrics')!;
    expect(summaryPanel).toHaveTextContent('9');
  });

  it('bloqueia e-mail inválido e senha curta antes de chamar o backend', async () => {
    render(<AdminStock />);
    await screen.findAllByText('Conta Esgotada');

    const form = screen.getByRole('button', { name: 'Cadastrar unidade' }).closest('form')!;
    fireEvent.change(screen.getByLabelText('Produto', { selector: '#stock-product' }), { target: { value: 'prod-ok' } });

    fireEvent.change(screen.getByLabelText(/E-mail \/ login/), { target: { value: 'sem-arroba' } });
    fireEvent.change(screen.getByLabelText(/Senha da conta/), { target: { value: 'senha-forte-123' } });
    fireEvent.submit(form);
    expect(await screen.findByRole('alert')).toHaveTextContent('e-mail/login válido');

    fireEvent.change(screen.getByLabelText(/E-mail \/ login/), { target: { value: 'conta@exemplo.com' } });
    fireEvent.change(screen.getByLabelText(/Senha da conta/), { target: { value: '123' } });
    fireEvent.submit(form);
    expect(await screen.findByRole('alert')).toHaveTextContent('pelo menos 6 caracteres');
    expect(api.addStock).not.toHaveBeenCalled();
  });

  it('cadastra unidade válida e limpa o formulário', async () => {
    render(<AdminStock />);
    await screen.findAllByText('Conta Esgotada');

    const form = screen.getByRole('button', { name: 'Cadastrar unidade' }).closest('form')!;
    fireEvent.change(screen.getByLabelText('Produto'), { target: { value: 'prod-ok' } });
    fireEvent.change(screen.getByLabelText(/E-mail \/ login/), { target: { value: '  conta@exemplo.com  ' } });
    fireEvent.change(screen.getByLabelText(/Senha da conta/), { target: { value: 'senha-forte-123' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(api.addStock).toHaveBeenCalledWith(
        expect.objectContaining({ productId: 'prod-ok', email: 'conta@exemplo.com' }),
      );
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Unidade cadastrada');
  });

  it('exibe o aviso de auditoria ao mostrar credenciais (stock_credentials_listed)', async () => {
    const user = userEvent.setup();
    render(<AdminStock />);
    await screen.findAllByText('Conta Esgotada');

    expect(screen.getByText(/stock_credentials_listed/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Exibir credenciais/ }));
    await waitFor(() => {
      expect(api.listStock).toHaveBeenCalledWith(expect.objectContaining({ includeCredentials: true }));
    });
  });

  it('fluxo CSV preservado: prévia obrigatória antes de importar', async () => {
    const user = userEvent.setup();
    render(<AdminStock />);
    await screen.findAllByText('Conta Esgotada');

    fireEvent.change(screen.getByLabelText('Produto', { selector: '#stock-product' }), { target: { value: 'prod-ok' } });
    fireEvent.change(screen.getByLabelText('Conteúdo CSV'), { target: { value: 'a@b.com,senha1\nlinha-invalida' } });

    const importButton = screen.getByRole('button', { name: /Importar/ });
    expect(importButton).toBeDisabled(); // nada entra sem prévia

    await user.click(screen.getByRole('button', { name: 'Pré-visualizar' }));
    expect(await screen.findByText(/1 válidas/)).toBeInTheDocument();
    expect(api.previewImport).toHaveBeenCalledWith('prod-ok', expect.stringContaining('a@b.com'));

    await user.click(screen.getByRole('button', { name: /Importar 1 válidas/ }));
    const dialog = await screen.findByRole('dialog');
    expect(api.commitImport).not.toHaveBeenCalled(); // nada grava antes da confirmação
    await user.click(within(dialog).getByRole('button', { name: 'Importar' }));
    await waitFor(() => {
      expect(api.commitImport).toHaveBeenCalledWith('prod-ok', expect.stringContaining('a@b.com'), expect.any(String));
    });
    expect(await screen.findByText(/Importadas:/)).toBeInTheDocument();
  });

  it('desativar unidade exige motivo categorizado e envia o motivo ao backend', async () => {
    const user = userEvent.setup();
    render(<AdminStock />);
    await screen.findAllByText('Conta Abundante');

    await user.click(screen.getByRole('button', { name: 'Desativar' }));
    const dialog = await screen.findByRole('dialog');

    // Sem motivo, o confirmar fica bloqueado e nada é enviado.
    const confirmButton = within(dialog).getByRole('button', { name: 'Desativar' });
    expect(confirmButton).toBeDisabled();
    expect(api.setStockStatus).not.toHaveBeenCalled();

    // Motivo "outro" exige nota com pelo menos 5 caracteres.
    await user.selectOptions(screen.getByLabelText(/Motivo do ajuste/), 'other');
    expect(confirmButton).toBeDisabled();
    await user.type(screen.getByLabelText(/Nota/), 'conta vazou');
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);
    await waitFor(() => {
      expect(api.setStockStatus).toHaveBeenCalledWith('unit-1', 'disabled', 'other', 'conta vazou');
    });
  });

  it('reativar unidade não pede motivo', async () => {
    const user = userEvent.setup();
    const disabledUnit = { ...UNIT, status: 'disabled' as const, status_reason: 'invalid_credential' as const };
    api.listStock.mockResolvedValue({ items: [disabledUnit], total: 1, limit: 100, offset: 0 });
    api.setStockStatus.mockResolvedValue({ id: 'unit-1', status: 'available', reason: null, note: '' });
    render(<AdminStock />);
    await screen.findAllByText('Conta Abundante');

    await user.click(screen.getByRole('button', { name: 'Reativar' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText(/Motivo do ajuste/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reativar' }));
    await waitFor(() => {
      expect(api.setStockStatus).toHaveBeenCalledWith('unit-1', 'available', null, '');
    });
  });

  it('erro de carga mostra alerta sem quebrar as demais seções', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.listStock.mockRejectedValue(new Error('falha no estoque'));
    render(<AdminStock />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
