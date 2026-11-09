-- ============================================================================
-- Provisionamento de administrador (executar com a service role, no SQL Editor
-- do projeto Supabase). NUNCA rode isto no frontend nem versione UUIDs reais.
-- ============================================================================
-- 1) Obtenha autorização e dados reais: nome de exibição e e-mail de cada admin.
-- 2) Crie os usuários reais em Authentication → Users com senha forte, confirme
--    o e-mail conforme política e copie os UUIDs.
-- 3) Substitua os marcadores abaixo (nunca use UUID fictício) e execute com
--    privilégios administrativos no SQL Editor do projeto correto.
-- 4) Cada pessoa entra em /admin e cadastra seu próprio TOTP; verifique AAL2.

-- Descomente e substitua os dois registros somente quando houver autorização:
-- insert into public.admin_users (user_id, display_name, role, is_active)
-- values
--   ('<UUID_REAL_ADMIN_1>', '<NOME_REAL_ADMIN_1>', 'owner', true),
--   ('<UUID_REAL_ADMIN_2>', '<NOME_REAL_ADMIN_2>', 'admin', true)
-- on conflict (user_id) do update
--   set display_name = excluded.display_name,
--       role = excluded.role,
--       is_active = true;

-- Conferência (esperam-se somente os administradores autorizados):
select user_id, display_name, role, is_active, created_at
from public.admin_users
order by created_at;

-- Revogar acesso (sem apagar o histórico de auditoria):
-- update public.admin_users set is_active = false where user_id = '<uuid>';
