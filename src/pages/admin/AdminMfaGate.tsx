import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../../components/Icon';
import {
  discardPendingEnrollment,
  startTotpEnrollment,
  verifyTotp,
  type AdminSession,
  type TotpFactor,
} from '../../services/adminAuth';

interface AdminMfaGateProps {
  session: AdminSession;
  onVerified: () => void | Promise<void>;
  onSignOut: () => void | Promise<void>;
  /** Reconsulta a sessão (usado para tentar novamente após erro de rede). */
  onRetry?: () => void | Promise<void>;
}

interface EnrollmentView {
  factorId: string;
  qrCode: string;
  secret: string;
}

/**
 * Segunda etapa do login. Sem TOTP verificado a sessão fica em AAL1 e o banco
 * recusa qualquer função administrativa (assert_admin → mfa_required).
 *
 * O painel NUNCA é liberado por aqui: qualquer erro ou fator pendente mantém o
 * usuário no portão. Códigos recusados ou fatores pendentes são tratados com
 * mensagens claras e orientação de sincronização de relógio.
 */
export function AdminMfaGate({ session, onVerified, onSignOut, onRetry }: AdminMfaGateProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<EnrollmentView | null>(null);
  const [selectedFactorId, setSelectedFactorId] = useState<string | null>(null);

  const verified: TotpFactor[] = session.factors ?? [];
  const pending: TotpFactor[] = session.pendingFactors ?? [];
  const allFactors: TotpFactor[] = [...verified, ...pending];

  // Só iniciamos um NOVO cadastro quando não há fator algum (verificado ou
  // pendente) e quando a listagem de fatores não falhou. Se falhou, mostramos
  // erro/retry em vez de cadastrar às cegas (evita duplicações).
  const needsEnrollment = verified.length === 0 && pending.length === 0 && !session.factorError;

  useEffect(() => {
    if (!needsEnrollment) return;
    // Sem guarda persistente aqui: sob React StrictMode o efeito roda duas
    // vezes (mount → cleanup → mount). A deduplicação REAL acontece no serviço
    // (`enrollTotpFactor` reaproveita o cadastro em andamento), por isso
    // re-executar é seguro e nunca cria dois fatores.
    let cancelled = false;
    void (async () => {
      const result = await startTotpEnrollment();
      if (cancelled) return;
      if (result.ok) {
        setEnrollment({ factorId: result.value.factorId, qrCode: result.value.qrCode, secret: result.value.secret });
      } else {
        setError(result.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsEnrollment]);

  const activeFactorId = selectedFactorId ?? allFactors[0]?.id ?? enrollment?.factorId ?? null;
  const showQr = Boolean(enrollment);
  const hasPendingWithoutQr = pending.length > 0 && !enrollment;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeFactorId) return;
    setBusy(true);
    setError(null);
    const result = await verifyTotp(activeFactorId, code);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setCode('');
    await onVerified();
  };

  const retry = async () => {
    setError(null);
    setEnrollment(null);
    setSelectedFactorId(null);
    await (onRetry ?? onVerified)();
  };

  // Fator pendente sem nenhum verificado: se o segredo foi perdido (ex.:
  // atualização da página no meio do cadastro), o administrador ficaria preso
  // no portão. Descartar um fator PENDENTE (nunca verificado) não enfraquece o
  // MFA — a conta continua sem nenhum fator e sem acesso administrativo.
  const discardAndRestart = async () => {
    setBusy(true);
    setError(null);
    const result = await discardPendingEnrollment();
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setEnrollment(null);
    await (onRetry ?? onVerified)();
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
            {session.factorError && (
              <button className="link-button" type="button" onClick={retry}>
                Tentar novamente
              </button>
            )}
          </div>
        )}

        {session.factorError && !error && (
          <div className="payment-warning" role="alert">
            <Icon name="alert" size={18} />
            <p>Não foi possível carregar seus autenticadores. Verifique a conexão e tente novamente.</p>
            <button className="link-button" type="button" onClick={retry}>
              Tentar novamente
            </button>
          </div>
        )}

        {!session.factorError && showQr && (
          <div className="admin-totp-setup">
            <p>Primeiro acesso: leia o QR code abaixo e guarde o segredo em local seguro.</p>
            <img src={enrollment!.qrCode} alt="QR code para cadastrar o autenticador TOTP" width={200} height={200} />
            <p className="admin-secret"><code>{enrollment!.secret}</code></p>
          </div>
        )}

        {!session.factorError && hasPendingWithoutQr && (
          <div className="admin-totp-setup">
            <p>
              Há um cadastro de autenticador em andamento. Abra o aplicativo onde você iniciou o cadastro e
              digite o código exibido para concluí-lo.
            </p>
            {verified.length === 0 && (
              <button className="button button--secondary" type="button" onClick={discardAndRestart} disabled={busy}>
                Descartar cadastro incompleto e começar novamente
              </button>
            )}
          </div>
        )}

        {!session.factorError && activeFactorId && (
          <form className="form-grid" onSubmit={submit}>
            {allFactors.length > 1 && (
              <div className="form-field form-field--full">
                <label htmlFor="admin-totp-factor">Autenticador</label>
                <select
                  id="admin-totp-factor"
                  value={activeFactorId}
                  onChange={(event) => setSelectedFactorId(event.target.value)}
                >
                  {allFactors.map((factor) => (
                    <option key={factor.id} value={factor.id}>
                      {factor.friendlyName ?? (factor.id === activeFactorId ? 'Autenticador' : 'Autenticador')}
                    </option>
                  ))}
                </select>
              </div>
            )}
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
            <button className="button button--primary button--large button--full" type="submit" disabled={busy || !activeFactorId}>
              {busy ? 'Validando…' : 'Validar código'}
            </button>
          </form>
        )}

        {!session.factorError && !activeFactorId && !error && (
          <p className="loading-line"><span className="loading-spinner" aria-hidden="true" />Preparando a verificação…</p>
        )}

        <p className="admin-mfa-hint">
          <Icon name="clock" size={16} />
          Mantenha a data e a hora do seu dispositivo sincronizadas automaticamente. Os códigos TOTP dependem do
          relógio: se o aparelho estiver adiantado ou atrasado, o código será recusado mesmo sendo digitado corretamente.
        </p>

        <button className="link-button" type="button" onClick={onSignOut}>Sair desta conta</button>
      </div>
    </section>
  );
}
