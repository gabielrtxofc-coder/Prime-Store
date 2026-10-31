-- ============================================================================
-- 0018 — ESTADO DE DISPUTA (CHARGEBACK) SEPARADO DE REEMBOLSO
-- ============================================================================
-- `charged_back` e `refunded` não são sinônimos: um reembolso é uma devolução
-- decidida e concluída; um chargeback é uma contestação aberta pelo portador
-- do cartão, que precisa de análise administrativa.
--
-- Este arquivo adiciona apenas o valor ao enum. A alteração precisa ficar
-- isolada da migração que passa a USAR o valor (o PostgreSQL não permite usar
-- um valor de enum recém-criado na mesma transação).
--
-- A migração seguinte (0019) reescreve `apply_payment_status()` com os dois
-- fluxos separados.

alter type public.order_status add value if not exists 'disputed';
