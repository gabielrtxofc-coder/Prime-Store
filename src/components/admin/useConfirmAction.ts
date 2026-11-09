import { useCallback, useRef, useState } from 'react';

/**
 * Missão 07 — ação pendente de confirmação (diálogos destrutivos/sensíveis).
 *
 * O chamador descreve o registro afetado + consequência; o componente
 * `ConfirmActionDialog` renderiza a confirmação. Enquanto `busy`,
 * cancelar é bloqueado e o botão de confirmar fica desabilitado.
 */
export interface PendingConfirm {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => Promise<void>;
}

export function useConfirmAction() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingRef = useRef<PendingConfirm | null>(null);
  const busyRef = useRef(false);

  const request = useCallback((descriptor: PendingConfirm) => {
    pendingRef.current = descriptor;
    setPending(descriptor);
  }, []);

  const cancel = useCallback(() => {
    if (busyRef.current) return;
    pendingRef.current = null;
    setPending(null);
  }, []);

  const confirm = useCallback(async () => {
    const current = pendingRef.current;
    if (!current || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await current.action();
    } finally {
      busyRef.current = false;
      pendingRef.current = null;
      setBusy(false);
      setPending(null);
    }
  }, []);

  return { pending, busy, request, cancel, confirm };
}
