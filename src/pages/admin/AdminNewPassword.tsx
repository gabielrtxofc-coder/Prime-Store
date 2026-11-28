import { useState, type FormEvent } from 'react';
import { Icon } from '../../components/Icon';
import { MIN_PASSWORD_LENGTH, updatePassword } from '../../services/adminAuth';

interface AdminNewPasswordProps {
  /** Chamado depois que a senha foi trocada com sucesso. */
  onDone: () => void | Promise<void>;
  onSignOut: () => void | Promise<void>;
}

/**
 * Tela de nova senha (recuperação pelo link enviado por e-mail).
 *
 * Usa apenas a sessão criada pelo próprio link (`auth.updateUser`). Não cria
 * PIN nem fator adicional. Enquanto a senha não for definida, nada do painel
 * é exibido.
 */
export function AdminNewPassword({ onDone, onSignOut }: AdminNewPasswordProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`A nova senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }
    if (password !== confirm) {
      setError('As senhas não conferem.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await updatePassword(password);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPassword('');
    setConfirm('');
    await onDone();
  };

  return (
    <section className="container page-section admin-login">
      <div className="admin-login__card">
        <span className="eyebrow-label">RECUPERAÇÃO DE ACESSO</span>
        <h1>Definir nova senha</h1>
        <p className="field-hint">Escolha uma senha nova para entrar no painel. Depois disso, basta e-mail e senha.</p>

        {error && (
          <div className="payment-warning" role="alert">
            <Icon name="alert" size={18} />
            <p>{error}</p>
          </div>
        )}

        <form className="form-grid" onSubmit={submit}>
          <div className="form-field form-field--full">
            <label htmlFor="admin-new-password">Nova senha</label>
            <input
              id="admin-new-password"
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="admin-new-password-confirm">Repita a nova senha</label>
            <input
              id="admin-new-password-confirm"
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              required
            />
          </div>
          <button className="button button--primary button--large button--full" type="submit" disabled={busy}>
            {busy ? 'Salvando…' : 'Salvar nova senha'}
          </button>
        </form>
        <button className="link-button" type="button" onClick={onSignOut}>Cancelar e sair</button>
      </div>
    </section>
  );
}
