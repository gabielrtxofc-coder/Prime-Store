-- ============================================================================
-- ENCERRAMENTO MANUAL da configuração inicial administrativa (idempotente)
-- ============================================================================
-- Use quando quiser fechar a porta de criação das contas iniciais ANTES das
-- duas contas serem criadas (ou como reforço depois do encerramento
-- automático, que já acontece na segunda criação).
--
-- Efeito: a porta (`admin-bootstrap`) passa a responder 410/"encerrada" para
-- qualquer tentativa. Não apaga contas, não altera a allowlist, não toca no
-- login nem na MFA, não desativa a loja nem o painel.
--
-- Depois de rodar, apague também o segredo no Supabase (Edge Functions →
-- Secrets → SETUP_ADMIN_CODE, ou `supabase secrets unset SETUP_ADMIN_CODE`).
-- Sem o segredo, nem um código válido abre a porta.
-- ============================================================================

update public.app_settings
   set value = 'false'::jsonb,
       updated_at = now()
 where key = 'admin_bootstrap_enabled';

-- Conferência (somente leitura):
--   select public.bootstrap_admin_status();
--   -- esperado: {"created": N, "enabled": false, "remaining": ...}
--   select count(*) from public.admin_users;  -- nunca diminui por este script
