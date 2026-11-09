import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Missão 07 — confirmação explícita para ações destrutivas/sensíveis.
 *
 * Contrato do diálogo:
 * - mostra QUAL registro será afetado e a CONSEQUÊNCIA da operação;
 * - Cancelar é sempre seguro (foco inicial fica nele);
 * - Esc / clique no fundo cancelam (exceto durante processamento);
 * - o botão de confirmar fica desabilitado enquanto `busy` ou quando
 *   `confirmDisabled` sinaliza validação pendente — sem duplo clique;
 * - foco preso no diálogo (Tab/Shift+Tab cicla), como um modal real.
 */
export interface ConfirmActionDialogProps {
  open: boolean;
  title: string;
  /** Descrição com o registro afetado + consequência em linguagem simples. */
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Visual de perigo para ações irreversíveis. */
  danger?: boolean;
  /** Em processamento: confirma desabilitado e Esc não fecha. */
  busy?: boolean;
  /** Validações externas podem bloquear a confirmação (ex.: motivo obrigatório). */
  confirmDisabled?: boolean;
  /** Conteúdo extra entre a descrição e os botões (ex.: campos do motivo). */
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmActionDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancelar',
  danger = false,
  busy = false,
  confirmDisabled = false,
  children,
  onConfirm,
  onCancel,
}: ConfirmActionDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Refs para callbacks: o efeito roda apenas em abertura/processamento,
  // sem roubar o foco dos campos a cada tecla digitada.
  const onCancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  useEffect(() => {
    onCancelRef.current = onCancel;
    busyRef.current = busy;
  });

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (busyRef.current) return;
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key === 'Tab') {
        const focusable = [cancelRef.current, confirmRef.current].filter(
          (element): element is HTMLButtonElement => element !== null && !element.disabled,
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="admin-dialog__backdrop"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-confirm-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="admin-confirm-dialog-title">{title}</h2>
        <p>{description}</p>
        {children && <div className="admin-dialog__fields">{children}</div>}
        <div className="admin-dialog__actions">
          <button
            ref={cancelRef}
            className="button button--secondary"
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className={`button ${danger ? 'button--danger' : 'button--primary'}`}
            type="button"
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? 'Processando…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
