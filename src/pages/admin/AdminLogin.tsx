import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { requestPasswordReset, signInWithPassword } from '../../services/adminAuth';

interface AdminLoginProps {
  onSignedIn: () => void | Promise<void>;
  initialError?: string | null;
  /** Há conta administrativa provisionada? Se não, oferecemos o modo demonstrativo. */
  demoAvailable?: boolean;
  onStartDemo?: () => void;
  /**
   * Backend configurado neste build. Quando false, o formulário de entrada não
   * tem para onde ir (o Supabase não está definido) e só o modo demonstrativo
   * é oferecido — antes desta correção o visitante ficava sem caminho nenhum.
   */
  backendConfigured?: boolean;
}

export function AdminLogin({
  onSignedIn,
  initialError = null,
  demoAvailable = false,
  onStartDemo,
  backendConfigured = true,
}: AdminLoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await signInWithPassword(email, password);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPassword('');
    await onSignedIn();
  };

  const recover = async () => {
    if (!email.trim()) {
      setError('Informe o e-mail da conta antes de solicitar a recuperação.');
      return;
    }
    await requestPasswordReset(email);
    setNotice('Se a conta existir, enviamos um link de redefinição para o e-mail informado.');
  };

  return (
    <section className="container page-section admin-login">
      <div className="admin-login__card">
        <span className="eyebrow-label">ACESSO RESTRITO</span>
        <h1>Painel administrativo</h1>
        <p className="field-hint">
          Duas contas administrativas. O cadastro público está desativado e a verificação em duas etapas é obrigatória.
        </p>

        {error && (
          <div className="payment-warning" role="alert">
            <Icon name="alert" size={18} />
            <p>{error}</p>
          </div>
        )}
        {notice && <p className="field-hint" role="status">{notice}</p>}

        {!backendConfigured && (
          <p className="field-hint" role="status">
            Backend não configurado neste ambiente: a entrada real de contas está indisponível.
            {demoAvailable ? ' Use o modo demonstrativo abaixo para revisar as telas.' : ''}
          </p>
        )}

        {backendConfigured && (
          <form className="form-grid" onSubmit={submit}>
            <div className="form-field form-field--full">
              <label htmlFor="admin-email">E-mail</label>
              <input
                id="admin-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="form-field form-field--full">
              <label htmlFor="admin-password">Senha</label>
              <input
                id="admin-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            <button className="button button--primary button--large button--full" type="submit" disabled={busy}>
              {busy ? 'Entrando…' : 'Entrar'}
            </button>
          </form>
        )}

        {backendConfigured && (
          <button className="link-button" type="button" onClick={recover}>Esqueci minha senha</button>
        )}

        {backendConfigured && (
          <Link className="link-button" to="/admin/setup">Configuração inicial do proprietário</Link>
        )}

        {demoAvailable && onStartDemo && (
          <div className="admin-login__demo">
            <span className="demo-tag">SEM CONTA AINDA?</span>
            <p className="field-hint">
              O provisionamento das duas contas administrativas depende dos e-mails oficiais. Enquanto isso, é possível revisar as telas com
              dados fictícios — sem qualquer acesso ao banco e sem alterar nada.
            </p>
            <button className="button button--secondary button--small" type="button" onClick={onStartDemo}>
              Ver painel em modo demonstração
            </button>
          </div>
        )}

        <Link className="confirmation-catalog-link" to="/">Voltar à loja</Link>
      </div>
    </section>
  );
}
