import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSetupPage } from './AdminSetupPage';
import { BackendError } from '../../services/backend/http';
import { createInitialAdmin, getAdminBootstrapStatus } from '../../services/adminBootstrap';

/**
 * Missão 14 — porta TEMPORÁRIA de configuração inicial.
 *
 * O que estes testes garantem na interface:
 *  1. com a porta encerrada no servidor, a página só mostra o aviso de
 *     encerramento — nenhum campo de criação é exibido;
 *  2. com a porta aberta, o envio carrega exatamente o que o proprietário
 *     digitou (código, nome, e-mail, senha, papel) e nada além disso;
 *  3. sucesso informa quantas vagas restam e não expõe a senha digitada;
 *  4. erro de código inválido mostra a mensagem orientada, sem detalhes
 *     internos;
 *  5. a senha fraca é bloqueada antes de qualquer chamada de rede.
 */

vi.mock('../../services/adminBootstrap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/adminBootstrap')>();
  return {
    ...actual,
    getAdminBootstrapStatus: vi.fn(),
    createInitialAdmin: vi.fn(),
  };
});

const statusMock = vi.mocked(getAdminBootstrapStatus);
const createMock = vi.mocked(createInitialAdmin);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/setup']}>
      <AdminSetupPage />
    </MemoryRouter>,
  );
}

async function openAvailableForm() {
  statusMock.mockResolvedValue({ configured: true, available: true, remaining: 2 });
  renderPage();
  return screen.findByRole('heading', { name: 'Criar contas administrativas' });
}

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://exemplo.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'chave-anon');
  vi.stubEnv('VITE_BACKEND_ENABLED', 'true');
  vi.clearAllMocks();
});

describe('configuração inicial temporária — /admin/setup', () => {
  it('porta encerrada no servidor: mostra só o aviso, sem formulário', async () => {
    statusMock.mockResolvedValue({ configured: true, available: false, remaining: 0 });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Configuração encerrada' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Código de configuração')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ir para o login do painel' })).toHaveAttribute('href', '/admin');
  });

  it('porta aberta: envia exatamente o que o proprietário digitou', async () => {
    await openAvailableForm();
    createMock.mockResolvedValue({ remaining: 1 });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Código de configuração'), 'codigo-do-servidor');
    await user.type(screen.getByLabelText('Nome de exibição'), 'Proprietário da Loja');
    await user.type(screen.getByLabelText('E-mail da conta'), 'Dono@Example.com');
    await user.type(screen.getByLabelText('Senha', { exact: true }), 'SenhaForte1234');
    await user.type(screen.getByLabelText('Confirme a senha'), 'SenhaForte1234');
    await user.selectOptions(screen.getByLabelText('Papel'), 'owner');
    await user.click(screen.getByRole('button', { name: 'Criar conta administrativa' }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith({
      code: 'codigo-do-servidor',
      displayName: 'Proprietário da Loja',
      email: 'Dono@Example.com',
      password: 'SenhaForte1234',
      role: 'owner',
    });
    expect(await screen.findByRole('heading', { name: 'Conta administrativa registrada' })).toBeInTheDocument();
    expect(screen.getByText(/ainda é possível criar mais 1 conta/i)).toBeInTheDocument();
  });

  it('segunda conta encerra: aviso explícito de encerramento automático', async () => {
    await openAvailableForm();
    createMock.mockResolvedValue({ remaining: 0 });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Código de configuração'), 'codigo-do-servidor');
    await user.type(screen.getByLabelText('Nome de exibição'), 'Segunda Conta');
    await user.type(screen.getByLabelText('E-mail da conta'), 'segunda@example.com');
    await user.type(screen.getByLabelText('Senha', { exact: true }), 'SenhaForte1234');
    await user.type(screen.getByLabelText('Confirme a senha'), 'SenhaForte1234');
    await user.click(screen.getByRole('button', { name: 'Criar conta administrativa' }));

    expect(await screen.findByText(/configuração inicial foi encerrada automaticamente/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Criar a segunda conta agora' })).not.toBeInTheDocument();
  });

  it('código inválido: mensagem orientada, sem detalhes internos', async () => {
    await openAvailableForm();
    createMock.mockRejectedValue(new BackendError(403, 'invalid_code', 'Código de configuração inválido.'));
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Código de configuração'), 'errado-errado');
    await user.type(screen.getByLabelText('Nome de exibição'), 'Qualquer Nome');
    await user.type(screen.getByLabelText('E-mail da conta'), 'x@example.com');
    await user.type(screen.getByLabelText('Senha', { exact: true }), 'SenhaForte1234');
    await user.type(screen.getByLabelText('Confirme a senha'), 'SenhaForte1234');
    await user.click(screen.getByRole('button', { name: 'Criar conta administrativa' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/código de configuração incorreto/i);
  });

  it('senha fraca é bloqueada antes de qualquer chamada de rede', async () => {
    await openAvailableForm();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Código de configuração'), 'codigo-do-servidor');
    await user.type(screen.getByLabelText('Nome de exibição'), 'Qualquer Nome');
    await user.type(screen.getByLabelText('E-mail da conta'), 'x@example.com');
    await user.type(screen.getByLabelText('Senha', { exact: true }), 'fraca');
    await user.type(screen.getByLabelText('Confirme a senha'), 'fraca');
    await user.click(screen.getByRole('button', { name: 'Criar conta administrativa' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/pelo menos 12 caracteres/i);
    expect(createMock).not.toHaveBeenCalled();
  });
});
