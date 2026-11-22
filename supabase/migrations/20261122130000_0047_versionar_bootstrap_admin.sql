-- ============================================================================
-- 20261122130000_0047_versionar_bootstrap_admin.sql
-- ============================================================================
-- PROBLEMA
-- --------
-- Produção (`audsosvbdybifvxsmqpi`) tem duas funções que NÃO existem em
-- nenhuma migração versionada:
--
--   public.bootstrap_admin_register(uuid, text, text)
--   public.bootstrap_admin_status()
--
-- e também dois registros em `app_settings` (`admin_bootstrap_enabled = false`,
-- `admin_bootstrap_created_count = 0`, ambos de 2026-11-20 14:44:33 UTC).
--
-- Consequência: recriar o banco a partir das migrações NÃO reproduz o
-- provisionamento — o ambiente deixa de ser reprodutível e essas funções,
-- por serem SECURITY DEFINER e escreverem na allowlist `admin_users`, ficam
-- fora da revisão de código.
--
-- ORIGEM (o que foi possível provar)
-- ----------------------------------
--   * `git log -S 'bootstrap_admin_register' --all` → apenas os commits desta
--     própria missão (que só citam o nome em documentação). O histórico do
--     repositório disponível começa em 2026-11-21, DEPOIS da criação em
--     produção — não há como provar autoria pelo git.
--   * `supabase/migrations/` → 0 arquivos mencionam `admin_bootstrap`.
--   * Os dados em produção têm timestamp único (14:44:33 UTC) e o
--     `scripts/provision-admin.sql` (versionado) documenta o fluxo manual de
--     inserção em `app_settings`/`admin_users` pelo SQL Editor.
--
--   Conclusão: é **bootstrap criado por operação manual documentada**, não
--   componente de plataforma nem artefato gerenciado pelo Supabase. As duas
--   funções nunca passaram pelo versionamento.
--
-- O QUE ESTA MIGRAÇÃO FAZ
-- -----------------------
-- Recria as duas funções com a definição LIDA DO CATÁLOGO DE PRODUÇÃO
-- (`pg_proc.prosrc`, consulta somente leitura) e os dois registros de
-- `app_settings`, para que o banco recriado por migrações seja equivalente.
--
-- Não altera produção. É idempotente (`create or replace` + `on conflict`).
--
-- SEGURANÇA
-- ---------
--   * `SECURITY DEFINER` com `search_path` fixo (mesmo padrão do projeto);
--   * `EXECUTE` apenas para `postgres` e `service_role` — NUNCA `anon` nem
--     `authenticated`, que é o que impede auto-promoção por JWT comum;
--   * a função é autolimitada: exige `admin_bootstrap_enabled = true` (ausente
--     ⇒ `false`) e para de funcionar após 2 administradores;
--   * `service_role` é necessário porque o provisionamento roda no SQL Editor
--     com privilégio administrativo; não há ganho de segurança em restringir
--     mais do que produção já restringe.
--
-- Sobre o estado inicial: `admin_bootstrap_enabled` nasce **false**. Recriar o
-- banco por migrações NÃO abre uma janela de auto-provisionamento.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Estado em `app_settings` (fechado por padrão).
-- ----------------------------------------------------------------------------
insert into public.app_settings (key, value, description)
values
  ('admin_bootstrap_enabled', 'false'::jsonb,
   'Permite bootstrap_admin_register criar administradores (max. 2). Fecha sozinho.'),
  ('admin_bootstrap_created_count', '0'::jsonb,
   'Contador de administradores criados via bootstrap.')
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- 2. `bootstrap_admin_register` — corpo idêntico ao de produção.
-- ----------------------------------------------------------------------------
create or replace function public.bootstrap_admin_register(
  p_user_id uuid,
  p_display_name text,
  p_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := btrim(coalesce(p_display_name, ''));
  v_role text := lower(btrim(coalesce(p_role, '')));
  v_enabled boolean;
  v_count integer;
  v_remaining integer;
begin
  if p_user_id is null then
    raise exception 'invalid_user_id';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'invalid_display_name';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'invalid_role';
  end if;

  perform 1 from public.app_settings where key = 'admin_bootstrap_created_count' for update;
  perform 1 from public.app_settings where key = 'admin_bootstrap_enabled' for update;

  select coalesce(
    (select (s.value = 'true'::jsonb) from public.app_settings s where s.key = 'admin_bootstrap_enabled'),
    false
  ) into v_enabled;

  select coalesce(
    (select (s.value #>> '{}')::integer from public.app_settings s where s.key = 'admin_bootstrap_created_count'),
    0
  ) into v_count;

  if not v_enabled or v_count >= 2 then
    if v_enabled then
      update public.app_settings
        set value = 'false'::jsonb, updated_at = now()
        where key = 'admin_bootstrap_enabled';
    end if;
    return jsonb_build_object('ok', false, 'reason', 'bootstrap_closed', 'remaining', 0);
  end if;

  insert into public.admin_users (user_id, display_name, role, is_active, created_by)
  values (p_user_id, v_name, v_role, true, p_user_id);

  v_count := v_count + 1;
  v_remaining := 2 - v_count;

  update public.app_settings
    set value = to_jsonb(v_count), updated_at = now()
    where key = 'admin_bootstrap_created_count';

  if v_remaining <= 0 then
    update public.app_settings
      set value = 'false'::jsonb, updated_at = now()
      where key = 'admin_bootstrap_enabled';
  end if;

  insert into public.admin_audit_log (actor_user_id, actor_label, action, entity_type, entity_id, metadata)
  values (
    p_user_id,
    v_name,
    'admin_bootstrap.created',
    'admin_users',
    p_user_id::text,
    jsonb_build_object('role', v_role, 'remaining', v_remaining)
  );

  return jsonb_build_object('ok', true, 'remaining', v_remaining);
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. `bootstrap_admin_status` — leitura do estado, sem efeito colateral.
-- ----------------------------------------------------------------------------
create or replace function public.bootstrap_admin_status()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_enabled boolean;
  v_count integer;
begin
  select coalesce(
    (select (s.value = 'true'::jsonb) from public.app_settings s where s.key = 'admin_bootstrap_enabled'),
    false
  ) into v_enabled;

  select coalesce(
    (select (s.value #>> '{}')::integer from public.app_settings s where s.key = 'admin_bootstrap_created_count'),
    0
  ) into v_count;

  return jsonb_build_object(
    'enabled', v_enabled,
    'created', v_count,
    'remaining', greatest(0, 2 - v_count)
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. Privilégios: fechados para papéis de usuário final.
--    Produção tem exatamente `{postgres=X/postgres,service_role=X/postgres}`.
-- ----------------------------------------------------------------------------
revoke all on function public.bootstrap_admin_register(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.bootstrap_admin_status()
  from public, anon, authenticated;

grant execute on function public.bootstrap_admin_register(uuid, text, text)
  to service_role;
grant execute on function public.bootstrap_admin_status()
  to service_role;

comment on function public.bootstrap_admin_register(uuid, text, text) is
  'Provisiona administrador durante a janela de bootstrap (max. 2). service_role apenas. '
  'Versionada pela 0047 a partir do catálogo de produção.';
comment on function public.bootstrap_admin_status() is
  'Estado da janela de bootstrap (enabled/created/remaining). service_role apenas.';
