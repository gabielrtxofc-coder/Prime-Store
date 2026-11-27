import { useCallback, useState, type FormEvent } from 'react';
import { Icon } from '../../components/Icon';
import { ConfirmActionDialog } from '../../components/admin/ConfirmActionDialog';
import { useConfirmAction } from '../../components/admin/useConfirmAction';
import {
  discardPendingEnrollment,
  enrollTotpFactor,
  getCurrentSession,
  removeTotpFactor,
  verifyTotp,
  type AdminSession,
  type TotpFactor,
} from '../../services/adminAuth';

interface AdminSecurityProps {
  initialSession: AdminSession;
  /** Notifica o painel para reconsultar a sessão após alterações. */
  onSessionUpdated?: () => void | Promise<void>;
}

interface EnrollmentView {
  factorId: string;
  qrCode: string;
  secret: string;
}

/**
 * Área de Segurança do painel administrativo.
 *
 * Permite ao administrador, sem conhecimento técnico:
 *  - ver os autenticadores cadastrados (verificados e pendentes);
 *  - cadastrar um segundo autenticador, confirmando-o antes de concluir;
 *  - descartar cadastros incompletos;
 *  - remover um fator antigo, desde que reste outro verificado e após validação.
 *
 * Não está disponível no modo demonstrativo.
 */
export function AdminSecurity({ initialSession, onSessionUpdated }: AdminSecurityProps) {
  const [session, setSession] = useState<AdminSession>(initialSession);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [enrollment, setEnrollment] = useState<EnrollmentView | null>(null);
  const [enrollCode, setEnrollCode] = useState('');
  const [enrollBusy, setEnrollBusy] = useState(false);

  const { pending, busy, request, cancel, confirm } = useConfirmAction();

  const reload = useCallback(async () => {
    const result = await getCurrentSession();
    if (result.ok && result.value) setSession(result.value);
    await onSessionUpdated?.();
  }, [onSessionUpdated]);

  const verified: TotpFactor[] = session.factors ?? [];
  const pendingFactors: TotpFactor[] = session.pendingFactors ?? [];
  const canAdd = session.canEnrollMore && pendingFactors.length === 0;

  const startEnrollment = async () => {
    setError(null);
    setNotice(null);
    setEnrollBusy(true);
    const result = await enrollTotpFactor('Prime Store Admin');
    setEnrollBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setEnrollment({ factorId: result.value.factorId, qrCode: result.value.qrCode, secret: result.value.secret });
    setEnrollCode('');
  };

  const confirmEnrollment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enrollment) return;
    setEnrollBusy(true);
    setError(null);
    const result = await verifyTotp(enrollment.factorId, enrollCode);
    setEnrollBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setEnrollment(null);
    setEnrollCode('');
    setNotice('Novo autenticador adicionado e verificado com sucesso.');
    await reload();
  };

  const discardIncomplete = async () => {
    setError(null);
    setEnrollBusy(true);
    // Descarta EXATAMENTE o fator do cadastro em andamento (o serviço valida
    // remotamente que ele segue pendente antes de remover).
    const result = await discardPendingEnrollment(enrollment?.factorId);
    setEnrollBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // Sessão recém-confirmada pelo serviço (refresh + revalidação de AAL,
    // fatores e permissões) após o unenroll.
    if (result.value) setSession(result.value);
    setEnrollment(null);
    setEnrollCode('');
    setNotice('Cadastro incompleto descartado.');
    await reload();
  };

  const askRemove = (factor: TotpFactor) => {
    request({
      title: 'Remover autenticador',
      description: `Tem certeza de que deseja remover o autenticador "${factor.friendlyName ?? 'sem nome'}"? Esta ação não pode ser desfeita. Mantenha ao menos um autenticador ativo.`,
      confirmLabel: 'Remover',
      danger: true,
      action: async () => {
        const result = await removeTotpFactor(factor.id);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        // Sessão recém-confirmada pelo serviço (refresh + revalidação de AAL
        // e fatores). Se todos os fatores sumiram, ela volta como AAL1 e o
        // painel reage (portão de re-cadastro) no refresh abaixo.
        if (result.value) setSession(result.value);
        setNotice('Autenticador removido com sucesso.');
        await reload();
      },
    });
  };

  const askDiscardPending = (factor: TotpFactor) => {
    request({
      title: 'Descartar cadastro incompleto',
      description: `O autenticador "${factor.friendlyName ?? 'sem nome'}" não foi concluído. Deseja descartá-lo?`,
      confirmLabel: 'Descartar',
      danger: true,
      action: async () => {
        // Apenas o fator selecionado; o serviço valida o estado remoto e
        // revalida a sessão (refresh + AAL + fatores + permissões).
        const result = await discardPendingEnrollment(factor.id);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        if (result.value) setSession(result.value);
        setNotice('Cadastro incompleto descartado.');
        await reload();
      },
    });
  };

  return (
    <div className="admin-security">
      <header className="page-heading">
        <span className="eyebrow-label">SEGURANÇA</span>
        <h2>Autenticadores do painel</h2>
        <p>Gerencie os autenticadores de verificação em duas etapas usados para acessar a administração.</p>
      </header>

      {error && (
        <div className="payment-warning" role="alert">
          <Icon name="alert" size={18} />
          <p>{error}</p>
        </div>
      )}

      {notice && (
        <div className="admin-notice" role="status">
          <Icon name="check" size={18} />
          <p>{notice}</p>
        </div>
      )}

      {session.factorError && !error && (
        <div className="payment-warning" role="alert">
          <Icon name="alert" size={18} />
          <p>Não foi possível carregar seus autenticadores. Tente novamente mais tarde.</p>
        </div>
      )}

      <section className="admin-security__list" aria-label="Autenticadores cadastrados">
        {verified.length === 0 && pendingFactors.length === 0 && !session.factorError && (
          <p className="admin-empty">Nenhum autenticador cadastrado.</p>
        )}

        {verified.map((factor) => (
          <article key={factor.id} className="admin-security__item">
            <span className="admin-security__icon" aria-hidden="true"><Icon name="shield" size={20} /></span>
            <div className="admin-security__info">
              <strong>{factor.friendlyName ?? 'Autenticador'}</strong>
              <span className="admin-pill admin-pill--ok">Ativo (verificado)</span>
            </div>
            {verified.length > 1 && (
              <button
                className="button button--ghost button--small"
                type="button"
                onClick={() => askRemove(factor)}
                disabled={busy}
              >
                Remover
              </button>
            )}
          </article>
        ))}

        {pendingFactors.map((factor) => (
          <article key={factor.id} className="admin-security__item">
            <span className="admin-security__icon" aria-hidden="true"><Icon name="clock" size={20} /></span>
            <div className="admin-security__info">
              <strong>{factor.friendlyName ?? 'Autenticador'}</strong>
              <span className="admin-pill admin-pill--warn">Pendente (incompleto)</span>
            </div>
            <button
              className="button button--ghost button--small"
              type="button"
              onClick={() => askDiscardPending(factor)}
              disabled={busy}
            >
              Descartar
            </button>
          </article>
        ))}
      </section>

      {!session.factorError && (
        <section className="admin-security__actions">
          {!enrollment && canAdd && (
            <button
              className="button button--primary"
              type="button"
              onClick={startEnrollment}
              disabled={enrollBusy}
            >
              <Icon name="plus" size={16} /> Adicionar segundo autenticador
            </button>
          )}

          {!enrollment && !canAdd && pendingFactors.length === 0 && (
            <p className="admin-empty">Você já atingiu o limite de dois autenticadores.</p>
          )}

          {enrollment && (
            <div className="admin-totp-setup">
              <h3>Conclua o cadastro do novo autenticador</h3>
              <p>Leia o QR code abaixo no seu aplicativo autenticador e digite o código exibido para confirmar.</p>
              <img src={enrollment.qrCode} alt="QR code para cadastrar o novo autenticador TOTP" width={200} height={200} />
              <p className="admin-secret"><code>{enrollment.secret}</code></p>
              <form className="form-grid" onSubmit={confirmEnrollment}>
                <div className="form-field form-field--full">
                  <label htmlFor="admin-enroll-code">Código de 6 dígitos</label>
                  <input
                    id="admin-enroll-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9 ]{6,9}"
                    maxLength={9}
                    value={enrollCode}
                    onChange={(event) => setEnrollCode(event.target.value)}
                    required
                  />
                </div>
                <div className="admin-security__enroll-actions">
                  <button
                    className="button button--primary"
                    type="submit"
                    disabled={enrollBusy}
                  >
                    {enrollBusy ? 'Confirmando…' : 'Confirmar autenticador'}
                  </button>
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={discardIncomplete}
                    disabled={enrollBusy}
                  >
                    Descartar
                  </button>
                </div>
              </form>
            </div>
          )}
        </section>
      )}

      <p className="admin-footnote">
        <Icon name="alert" size={15} /> Mantenha sempre ao menos um autenticador ativo. A verificação em duas etapas é
        obrigatória para qualquer operação administrativa.
      </p>

      <ConfirmActionDialog
        open={pending !== null}
        title={pending?.title ?? ''}
        description={pending?.description ?? ''}
        confirmLabel={pending?.confirmLabel ?? 'Confirmar'}
        danger={pending?.danger}
        busy={busy}
        onConfirm={confirm}
        onCancel={cancel}
      />
    </div>
  );
}
