-- ============================================================================
-- Provisionamento de administrador (executar com a service role, no SQL Editor
-- do projeto Supabase). NUNCA rode isto no frontend nem versione UUIDs reais.
-- ============================================================================
-- 1) Crie o usuário em Authentication → Users (e-mail e senha fortes) e copie o UUID.
-- 2) Substitua os valores abaixo e execute.
-- 3) Peça ao administrador para entrar em /admin e cadastrar o TOTP no primeiro acesso.

insert into public.admin_users (user_id, display_name, role, is_active)
values
  ('00000000-0000-4000-8000-000000000000', 'Proprietário', 'owner', true)
on conflict (user_id) do update
  set display_name = excluded.display_name,
      role = excluded.role,
      is_active = true;

-- O mesmo comando para o segundo administrador:
-- insert into public.admin_users (user_id, display_name, role, is_active)
-- values ('<uuid>', 'Natanael', 'admin', true)
-- on conflict (user_id) do update set is_active = true;

-- Conferência: deve retornar as duas contas ativas.
select user_id, display_name, role, is_active, created_at
from public.admin_users
order by created_at;

-- Revogar acesso (sem apagar o histórico de auditoria):
-- update public.admin_users set is_active = false where user_id = '<uuid>';
