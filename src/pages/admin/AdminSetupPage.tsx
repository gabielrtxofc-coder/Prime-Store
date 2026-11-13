import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { getBackendConfig } from '../../services/backend/config';
import {
  createInitialAdmin,
  describeBootstrapError,
  getAdminBootstrapStatus,
  type BootstrapStatus,
} from '../../services/adminBootstrap';

/**
 * Configuração inicial TEMPORÁRIA do painel administrativo.
 *
 * Página acessível enquanto as duas contas previstas não existem. Protegida
 * por: (1) código de configuração que vive só no servidor, (2) teto de duas
 * contas decidido no banco, (3) limite de tentativas por origem, (4) allowlist
 * gravada atomicamente. Depois da segunda conta, o servidor encerra a porta e
 * esta página passa a mostrar apenas o aviso de encerramento.
 *
 * Esta página nunca concede sessão nem permissão: cada conta entra pelo login
 * normal (`/admin`) e cadastra o próprio TOTP no primeiro acesso.
 */

type PageState = 'loading' | 'unavailable' | 'form' | 'done';

export function AdminSetupPage() {
  const backendEnabled = getBackendConfig().enabled;
  const [state, setState] = useState<PageState>('loading');
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [role, setRole] = useState<'owner' | 'admin'>('owner');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remainingAfter, setRemainingAfter] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!backendEnabled) {
      setState('unavailable');
      return;
    }
    getAdminBootstrapStatus()
      .then((value) => {
        if (cancelled) return;
        setStatus(value);
        setState(value.available ? 'form' : 'unavailable');
      })
      .catch(() => {
        if (!cancelled) setState('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [backendEnabled]);

  const passwordIssue = useMemo(() => {
    if (password.length === 0) return null;
    if (password.length < 12) return 'A senha precisa de pelo menos 12 caracteres.';
    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
      return 'Misture letras maiúsculas, minúsculas e números.';
    }
    return null;
  }, [password]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (displayName.trim().length < 2) {
      setError('Informe o nome de exibição (mínimo de 2 caracteres).');
      return;
    }
    if (password !== confirmPassword) {
      setError('As senhas não coincidem.');
      return;
    }
    if (passwordIssue) {
      setError(passwordIssue);
      return;
    }

    setBusy(true);
    try {
      const result = await createInitialAdmin({
        code: code.trim(),
        displayName: displayName.trim(),
        email: email.trim(),
        password,
        role,
      });
      setRemainingAfter(result.remaining);
      setCode('');
      setPassword('');
      setConfirmPassword('');
      setState('done');
    } catch (caught) {
      setError(describeBootstrapError(caught));
      const refreshed = await getAdminBootstrapStatus().catch(() => null);
      if (refreshed && !refreshed.available) {
        setStatus(refreshed);
        setState('unavailable');
      }
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') {
    return (
      <section className="container page-section" aria-busy="true">
        <p className="loading-line">
          <span className="loading-spinner" aria-hidden="true" />
          Verificando a configuração inicial…
        </p>
      </section>
    );
  }

  if (state === 'unavailable') {
    return (
      <section className="container page-section admin-login">
        <div className="admin-login__card">
          <span className="eyebrow-label">CONFIGURAÇÃO INICIAL</span>
          <h1>Configuração encerrada</h1>
          <p className="field-hint">
            A criação das contas administrativas iniciais está indisponível neste momento — ou porque as duas contas
            previstas já foram criadas, ou porque a chave temporária foi desligada no servidor.
          </p>
          <p className="field-hint">
            Os administradores continuam entrando normalmente pelo login do painel. Nenhuma ação é necessária para a
            loja pública.
          </p>
          <Link className="button button--primary button--full" to="/admin">Ir para o login do painel</Link>
          <Link className="confirmation-catalog-link" to="/">Voltar à loja</Link>
        </div>
      </section>
    );
  }

  if (state === 'done') {
    const remaining = remainingAfter ?? 0;
    return (
      <section className="container page-section admin-login">
        <div className="admin-login__card">
          <span className="eyebrow-label">CONTA CRIADA</span>
          <h1>Conta administrativa registrada</h1>
          <p className="field-hint" role="status">
            A conta foi criada no serviço de autenticação e incluída na allowlist do painel.
            {remaining > 0
              ? ` Ainda é possível criar mais ${remaining} conta(s) por este procedimento — depois disso a porta se encerra automaticamente.`
              : ' Esta era a segunda conta: a configuração inicial foi encerrada automaticamente e o código não funciona mais.'}
          </p>
          <p className="field-hint">
            No primeiro acesso, entre em /admin com e-mail e senha e cadastre o autenticador (TOTP) quando o painel
            pedir — a verificação em duas etapas continua obrigatória.
          </p>
          {remaining > 0 ? (
            <button className="button button--secondary button--full" type="button" onClick={() => setState('form')}>
              Criar a segunda conta agora
            </button>
          ) : null}
          <Link className="button button--primary button--full" to="/admin">Ir para o login do painel</Link>
          <Link className="confirmation-catalog-link" to="/">Voltar à loja</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="container page-section admin-login">
      <div className="admin-login__card">
        <span className="eyebrow-label">CONFIGURAÇÃO INICIAL · TEMPORÁRIO</span>
        <h1>Criar contas administrativas</h1>
        <p className="field-hint">
          Procedimento único do proprietário para as <strong>duas</strong> contas previstas. Exige o código temporário
          fornecido por quem operou o deploy. Depois da segunda conta, esta página se encerra automaticamente.
        </p>
        <p className="field-hint">
          Cada conta usa a própria senha (cadastrada aqui diretamente no serviço de autenticação) e, no primeiro
          acesso, precisa cadastrar o TOTP. Nada aqui concede acesso sem passar pelo login e pela allowlist do banco.
        </p>

        {status && (
          <p className="field-hint" role="status">
            Vagas restantes na configuração inicial: <strong>{status.remaining}</strong> de 2.
          </p>
        )}

        {error && (
          <div className="payment-warning" role="alert">
            <Icon name="alert" size={18} />
            <p>{error}</p>
          </div>
        )}

        <form className="form-grid" onSubmit={submit}>
          <div className="form-field form-field--full">
            <label htmlFor="setup-code">Código de configuração</label>
            <input
              id="setup-code"
              type="password"
              autoComplete="off"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
            />
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="setup-name">Nome de exibição</label>
            <input
              id="setup-name"
              type="text"
              autoComplete="off"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              minLength={2}
              maxLength={80}
            />
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="setup-email">E-mail da conta</label>
            <input
              id="setup-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="setup-password">Senha</label>
            <input
              id="setup-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={Boolean(passwordIssue)}
              aria-describedby="setup-password-hint"
              required
              minLength={12}
            />
            <p className="field-hint" id="setup-password-hint">
              {passwordIssue ?? 'Mínimo de 12 caracteres, com maiúsculas, minúsculas e números.'}
            </p>
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="setup-password-confirm">Confirme a senha</label>
            <input
              id="setup-password-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              minLength={12}
            />
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="setup-role">Papel</label>
            <select id="setup-role" value={role} onChange={(event) => setRole(event.target.value as 'owner' | 'admin')}>
              <option value="owner">Proprietário (owner)</option>
              <option value="admin">Administrador (admin)</option>
            </select>
          </div>
          <button className="button button--primary button--large button--full" type="submit" disabled={busy}>
            {busy ? 'Criando conta…' : 'Criar conta administrativa'}
          </button>
        </form>

        <Link className="confirmation-catalog-link" to="/admin">Já tenho uma conta — entrar no painel</Link>
        <Link className="confirmation-catalog-link" to="/">Voltar à loja</Link>
      </div>
    </section>
  );
}
