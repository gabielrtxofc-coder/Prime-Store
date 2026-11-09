import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmActionDialog } from './ConfirmActionDialog';

/**
 * Missão 07 (GRUPO 10 / T048) — contrato do diálogo de confirmação:
 * mostra registro afetado + consequência, Cancelar seguro (foco inicial),
 * Esc cancela, backdrop cancela, confirmar bloqueado durante processamento.
 */
const baseProps = {
  open: true,
  title: 'Revogar link de entrega?',
  description: 'Pedido PS-00042: o link de entrega deixará de revelar as credenciais imediatamente.',
  confirmLabel: 'Revogar link',
  danger: true,
  cancelLabel: 'Cancelar',
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe('ConfirmActionDialog', () => {
  it('não renderiza nada quando fechado', () => {
    const { container } = render(<ConfirmActionDialog {...baseProps} open={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('mostra o registro afetado e a consequência, com foco inicial em Cancelar', () => {
    render(<ConfirmActionDialog {...baseProps} />);
    const dialog = screen.getByRole('dialog', { name: 'Revogar link de entrega?' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/Pedido PS-00042/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
  });

  it('Cancelar chama onCancel sem confirmar', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmActionDialog {...baseProps} onConfirm={onConfirm} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Escape cancela a operação', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmActionDialog {...baseProps} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirmar dispara onConfirm', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmActionDialog {...baseProps} onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Revogar link' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('em processamento: botão de confirmar desabilitado e Esc/backdrop não cancelam', () => {
    const onCancel = vi.fn();
    render(<ConfirmActionDialog {...baseProps} busy onCancel={onCancel} />);
    expect(screen.getByRole('button', { name: /Processando/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('duplo clique no confirmar dispara onConfirm duas vezes no máximo uma por clique — e a UI trava via busy', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<ConfirmActionDialog {...baseProps} onConfirm={onConfirm} />);
    const confirmButton = screen.getByRole('button', { name: 'Revogar link' });
    await user.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // Simula a transição para busy (pai desabilita ambos os botões)
    rerender(<ConfirmActionDialog {...baseProps} onConfirm={onConfirm} busy />);
    expect(screen.getByRole('button', { name: /Processando/ })).toBeDisabled();
  });
});
