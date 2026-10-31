import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../../components/Icon';
import {
  startTotpEnrollment,
  verifyTotp,
  type AdminSession,
} from '../../services/adminAuth';

interface AdminMfaGateProps {
  session: AdminSession;
  onVerified: () => void | Promise<void>;
  onSignOut: () => void | Promise<void>;
}

/**
 * Segunda etapa do login. Sem TOTP verificado a sessão fica em AAL1 e o banco
 * recusa qualquer função administrativa (assert_admin → mfa_required).
 */
export function AdminMfaGate({ session, onVerified, onSignOut }: AdminMfaGateProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<{ factorId: string; qrCode: string; secret: string } | null>(null);

  const existingFactor = session.factors[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    if (existingFactor) return;
    void (async () => {
      const result = await startTotpEnrollment();
      if (cancelled) return;
      if (result.ok) setEnrollment(result.value);
      else setError(result.message);
    })();
    return () => {
      cancelled = true;
    };
  }, [existingFactor]);

  const factorId = enrollment?.factorId ?? existingFactor?.id ?? null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setError(null);
    const result = await verifyTotp(factorId, code);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setCode('');
    await onVerified();
  };

  return (
    <section className="container page-section admin-login">
      <div className="admin-login__card">
        <span className="eyebrow-label">VERIFICAÇÃO EM DUAS ETAPAS</span>
        <h1>Confirme o código TOTP</h1>
        <p className="field-hint">
          Conta <strong>{session.email}</strong>. Use o aplicativo autenticador (Google Authenticator, 1Password, Authy…).
        </p>

        {error && (
          <div className="payment-warning" role="alert">
            <Icon name="alert" size={18} />
            <p>{error}</p>
          </div>
        )}

        {!existingFactor && enrollment && (
          <div className="admin-totp-setup">
            <p>Primeiro acesso: leia o QR code abaixo e guarde o segredo em local seguro.</p>
            <img src={enrollment.qrCode} alt="QR code para cadastrar o autenticador TOTP" width={200} height={200} />
            <p className="admin-secret"><code>{enrollment.secret}</code></p>
          </div>
        )}

        <form className="form-grid" onSubmit={submit}>
          <div className="form-field form-field--full">
            <label htmlFor="admin-totp">Código de 6 dígitos</label>
            <input
              id="admin-totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,9}"
              maxLength={9}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
            />
          </div>
          <button className="button button--primary button--large button--full" type="submit" disabled={busy || !factorId}>
            {busy ? 'Validando…' : 'Validar código'}
          </button>
        </form>

        <button className="link-button" type="button" onClick={onSignOut}>Sair desta conta</button>
      </div>
    </section>
  );
}
