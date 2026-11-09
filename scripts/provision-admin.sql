-- Provisionamento de administrador (executar no SQL Editor do projeto correto,
-- com a sessão service_role, somente após criar uma conta REAL no Supabase Auth).
-- Nunca execute no frontend; nunca versione UUIDs, nomes ou e-mails reais.
--
-- Procedimento:
-- 1) Authentication -> Users -> Add user/Invite user com o e-mail real aprovado.
--    Use senha forte e envie convite/redefinição pelo fluxo seguro do projeto.
-- 2) Copie o UUID Auth e o nome de exibição autorizado.
-- 3) Substitua os DOIS marcadores abaixo pelos valores reais antes de executar.
--    Os marcadores têm formato inválido para UUID de propósito: o script falha
--    fechado se for executado sem edição.
-- 4) Faça login em /admin. O primeiro acesso deve cadastrar TOTP; não compartilhe
--    segredo nem código TOTP com o operador.
-- 5) Confirme acesso a `session` e leitura administrativa após MFA AAL2.
--
-- Repita o INSERT para cada administrador real autorizado. Não use dados fictícios.

insert into public.admin_users (user_id, display_name, role, is_active)
values
  ('<REAL_AUTH_USER_UUID>'::uuid, '<REAL_DISPLAY_NAME>', 'owner', true)
on conflict (user_id) do update
  set display_name = excluded.display_name,
      role = excluded.role,
      is_active = true;

-- Exemplo de segunda conta, preencher e executar separadamente após aprovação:
-- insert into public.admin_users (user_id, display_name, role, is_active)
-- values ('<REAL_AUTH_USER_UUID>'::uuid, '<REAL_DISPLAY_NAME>', 'admin', true)
-- on conflict (user_id) do update
--   set display_name = excluded.display_name, role = excluded.role, is_active = true;

-- Conferência: compare UUIDs/nome com as contas reais autorizadas.
select user_id, display_name, role, is_active, created_at
from public.admin_users
order by created_at;

-- Revogar acesso (preserva histórico de auditoria):
-- update public.admin_users set is_active = false where user_id = '<REAL_AUTH_USER_UUID>';
