-- ============================================================================
-- Provisionamento do PERFIL OPERACIONAL (e-mail + senha, sem TOTP)
-- ============================================================================
--
-- Inclui contas EXISTENTES do Supabase Auth na allowlist operacional
-- (`public.operator_users`). Executar como service_role / SQL editor, DEPOIS
-- da migração 0048 (perfil operacional).
--
-- Garantias:
--   * NÃO cria, apaga nem altera contas do Auth (auth.users).
--   * NÃO altera `admin_users` (allowlist administrativa) nem `mfa_required`.
--   * NÃO remove fatores TOTP. O acesso administrativo completo continua
--     exigindo a verificação em duas etapas, exatamente como antes.
--   * Idempotente: rodar de novo não duplica nada (ON CONFLICT DO NOTHING).
--
-- As duas contas abaixo são as contas administrativas atuais da loja
-- (Proprietário e Administrador). Com este script elas passam a ter, além do
-- acesso administrativo (TOTP), o acesso operacional diário só com e-mail +
-- senha: estoque e informações de produto.
--
-- Para revogar o acesso operacional de alguém (sem apagar a conta):
--   update public.operator_users set is_active = false where user_id = '<uuid>';
-- ============================================================================

begin;

insert into public.operator_users (user_id, display_name, is_active, created_by)
select u.id, v.display_name, true, null
  from (values
    ('84e44688-e71e-4818-b25d-f2a62864bffd'::uuid, 'Proprietário Prime Store'),
    ('fbe0d5af-e6ff-48c0-a7cb-b75a0dc449c4'::uuid, 'Administrador Prime Store')
  ) as v(user_id, display_name)
  join auth.users u on u.id = v.user_id
on conflict (user_id) do nothing;

-- Conferência (não exibe e-mail completo).
select o.user_id,
       o.display_name,
       o.is_active,
       regexp_replace(u.email, '^(.{3}).*(@.*)$', '\1***\2') as email_mascarado,
       exists (select 1 from public.admin_users a where a.user_id = o.user_id and a.is_active) as tambem_admin
  from public.operator_users o
  join auth.users u on u.id = o.user_id
 order by o.created_at;

commit;
