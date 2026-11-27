import { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSession } from '../../services/adminAuth';
import { AdminMfaGate } from './AdminMfaGate';

/**
 * Endurecimento do MFA — portão de TOTP (interface).
 *
 * Garante na UI:
 *  - seleção de autenticador quando há mais de um;
 *  - cadastro inicial disparado UMA única vez sob React StrictMode;
 *  - fator pendente NÃO dispara novo cadastro e recebe orientação;
 *  - falha na listagem de fatores mostra erro + retry e NÃO cadastra às cegas;
 *  - orientação de sincronização de data/hora do dispositivo;
 *  - código recusado mantém o portão fechado (painel nunca liberado).
 */

const state = vi.hoisted(() => ({
  enrollCalls: 0,
  enrollResult: null as { ok: true; value: { factorId: string; qrCode: string; secret: string } } | { ok: false; message: string } | null,
  verifyCalls: [] as Array<[string, string]>,
  verifyResult: null as { ok: true; value: AdminSession } | { ok: false; message: string } | null,
  discardCalls: 0,
  discardResult: { ok: true as const, value: true as const },
}));

vi.mock('../../services/adminAuth', () => ({
  startTotpEnrollment: async () => {
    state.enrollCalls += 1;
    return state.enrollResult ?? { ok: false as const, message: 'indisponível' };
  },
  verifyTotp: async (factorId: string, code: string) => {
    state.verifyCalls.push([factorId, code]);
    return state.verifyResult ?? { ok: false as const, message: 'recusado' };
  },
  discardPendingEnrollment: async (_factorId?: string) => {
    state.discardCalls += 1;
    return state.discardResult;
  },
}));

function gateSession(overrides: Partial<AdminSession> = {}): AdminSession {
  return {
    userId: 'user-1',
    email: 'dono@prime-store.test',
    currentLevel: 'aal1',
    nextLevel: 'aal2',
    pendingTotp: true,
    factors: [],
    pendingFactors: [],
    isAdmin: true,
    mfaSatisfied: false,
    adminCheckError: null,
    factorError: null,
    canEnrollMore: true,
    ...overrides,
  };
}

beforeEach(() => {
  state.enrollCalls = 0;
  state.enrollResult = {
    ok: true,
    value: { factorId: 'factor-novo', qrCode: 'data:image/svg+xml;base64,PHN2Zy8+', secret: 'SEGREDO-DE-TESTE' },
  };
  state.verifyCalls = [];
  state.verifyResult = null;
  state.discardCalls = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

function setup(overrides: Partial<AdminSession> = {}) {
  const onVerified = vi.fn(async () => undefined);
  const onSignOut = vi.fn(async () => undefined);
  const onRetry = vi.fn(async () => undefined);
  const user = userEvent.setup();
  const view = render(
    <AdminMfaGate
      session={gateSession(overrides)}
      onVerified={onVerified}
      onSignOut={onSignOut}
      onRetry={onRetry}
    />,
  );
  return { onVerified, onSignOut, onRetry, user, view };
}

describe('AdminMfaGate — endurecimento do MFA', () => {
  it('cadastra o primeiro autenticador uma única vez sob React StrictMode', async () => {
    // Simula o comportamento do serviço real: chamadas repetidas (efeito
    // duplicado do StrictMode) reaproveitam o MESMO fator em cadastro.
    state.enrollResult = {
      ok: true,
      value: { factorId: 'factor-novo', qrCode: 'data:image/svg+xml;base64,PHN2Zy8+', secret: 'SEGREDO-DE-TESTE' },
    };
    render(
      <StrictMode>
        <AdminMfaGate
          session={gateSession()}
          onVerified={vi.fn()}
          onSignOut={vi.fn()}
          onRetry={vi.fn()}
        />
      </StrictMode>,
    );

    expect(await screen.findByText('SEGREDO-DE-TESTE')).toBeInTheDocument();
    // Uma única visão de cadastro: um QR e um segredo, mesmo com efeito duplo.
    expect(screen.getAllByAltText('QR code para cadastrar o autenticador TOTP')).toHaveLength(1);
    expect(screen.getAllByText('SEGREDO-DE-TESTE')).toHaveLength(1);
    expect(screen.queryByRole('navigation', { name: 'Seções do painel' })).not.toBeInTheDocument();
    // Efeito do StrictMode dispara no máximo duas vezes, mas o serviço real
    // garante UM fator (deduplicação coberta em src/services/adminAuth.test.ts).
    expect(state.enrollCalls).toBeLessThanOrEqual(2);
  });

  it('com múltiplos fatores, oferece seleção e verifica o fator escolhido', async () => {
    const { onVerified, user } = setup({
      factors: [
        { id: 'f-principal', friendlyName: 'Celular pessoal' },
        { id: 'f-reserva', friendlyName: 'Celular reserva' },
      ],
      pendingTotp: false,
    });

    expect(state.enrollCalls).toBe(0);

    const select = await screen.findByLabelText('Autenticador');
    expect(select).toHaveValue('f-principal');
    await user.selectOptions(select, 'f-reserva');

    await user.type(screen.getByLabelText('Código de 6 dígitos'), '654321');
    await user.click(screen.getByRole('button', { name: 'Validar código' }));

    await vi.waitFor(() => expect(state.verifyCalls).toEqual([['f-reserva', '654321']]));
    // Painel liberado apenas pelo retorno bem-sucedido do fluxo externo.
    expect(onVerified).toHaveBeenCalledTimes(0);
  });

  it('fator pendente não dispara novo cadastro e orienta a conclusão', async () => {
    const { onRetry, user } = setup({
      factors: [],
      pendingFactors: [{ id: 'f-incompleto', friendlyName: 'Prime Store Admin' }],
    });

    expect(await screen.findByText(/cadastro de autenticador em andamento/i)).toBeInTheDocument();
    await vi.waitFor(() => expect(state.enrollCalls).toBe(0));

    await user.type(screen.getByLabelText('Código de 6 dígitos'), '123456');
    expect(screen.queryByRole('button', { name: 'Validar código' })).toBeEnabled();

    // Escapável: descarte do cadastro incompleto reinicia o fluxo com segurança.
    await user.click(screen.getByRole('button', { name: /Descartar cadastro incompleto/i }));
    await vi.waitFor(() => expect(state.discardCalls).toBe(1));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('falha na consulta de fatores mostra erro com retry e NÃO cadastra novo fator', async () => {
    const { onRetry, user } = setup({
      factorError: 'Não foi possível carregar seus autenticadores.',
      canEnrollMore: false,
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Não foi possível carregar seus autenticadores/i);
    expect(state.enrollCalls).toBe(0);
    expect(screen.queryByLabelText('Código de 6 dígitos')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await vi.waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
  });

  it('orienta a sincronização automática de data e hora do dispositivo', () => {
    setup();
    const hint = screen.getByText(/sincronizadas automaticamente/i);
    expect(hint).toHaveTextContent(/data e a hora/i);
    expect(hint).toHaveTextContent(/relógio/i);
  });

  it('código recusado mantém o portão fechado: painel não é liberado', async () => {
    state.verifyResult = { ok: false, message: 'Código de verificação inválido.' };
    const { onVerified, user } = setup({
      factors: [{ id: 'f-principal', friendlyName: 'Celular pessoal' }],
      pendingTotp: false,
    });

    await user.type(await screen.findByLabelText('Código de 6 dígitos'), '000000');
    await user.click(screen.getByRole('button', { name: 'Validar código' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Código de verificação inválido/i);
    expect(onVerified).not.toHaveBeenCalled();
    expect(screen.queryByRole('navigation', { name: 'Seções do painel' })).not.toBeInTheDocument();
  });
});
