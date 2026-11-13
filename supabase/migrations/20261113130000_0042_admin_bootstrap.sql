-- ============================================================================
-- 0042 — CONFIGURAÇÃO INICIAL TEMPORÁRIA DO PAINEL ADMINISTRATIVO
-- ============================================================================
-- Contexto: a loja vai ao ar sem nenhuma conta administrativa (auth.users = 0,
-- admin_users = 0, verificado). O proprietário precisa criar as DUAS contas
-- previstas pelo próprio painel, sem que isso abra um cadastro público de
-- administradores.
--
-- Regras de projeto deste mecanismo (temporário, auto-encerrável):
--
--   1. DESLIGADO POR PADRÃO. `admin_bootstrap_enabled` nasce `false`. Quem
--      liga é o operador, explicitamente, via SQL controlado — nunca uma
--      migração. Esta migração apenas cria a estrutura.
--   2. NO MÁXIMO DUAS CONTAS. `admin_bootstrap_created_count` só anda para
--      frente; com count >= 2 a criação é recusada e a chave é apagada para
--      `false` na mesma transação (encerramento automático, Fase 5).
--   3. DECISÃO NO BANCO. A função `bootstrap_admin_register` trava as duas
--      linhas de configuração (`FOR UPDATE`), confere a permissão e insere na
--      allowlist `admin_users` atomicamente. Não existe caminho pelo navegador
--      para conceder papel de administrador: o handler da Edge Function só
--      executa esta função com a service role, depois de validar um código
--      que vive exclusivamente em segredo do servidor.
--   4. SOMENTE SERVICE_ROLE. Nenhuma destas funções é executável por
--      `public`, `anon` ou `authenticated`. A criação real do usuário (senha)
--      acontece na Supabase Auth pelo próprio proprietário através da Edge
--      Function `admin-bootstrap`; aqui fica só a allowlist e a auditoria.
--   5. AUDITADO. Cada criação grava `admin_bootstrap.created` em
--      `admin_audit_log` (ator, papel e quantas vagas restam). Senha e e-mail
--      NUNCA entram no log.
--   6. MFA PRESERVADO. Nada aqui concede sessão AAL2 por si só: cada conta
--      entra com a própria senha e cadastra o TOTP no primeiro acesso, como já
--      acontecia com o provisionamento manual.
-- ============================================================================

insert into public.app_settings (key, value, description)
values
  (
    'admin_bootstrap_enabled',
    'false'::jsonb,
    'Habilita TEMPORARIAMENTE a criação inicial das duas contas administrativas. Desliga automaticamente quando a segunda conta é criada. Nunca ligar fora da janela de configuração inicial.'
  ),
  (
    'admin_bootstrap_created_count',
    '0'::jsonb,
    'Quantas contas foram criadas pelo procedimento de configuração inicial (máximo 2, monotônico).'
  )
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Estado da configuração inicial (leitura barata para a Edge Function)
-- ---------------------------------------------------------------------------
create or replace function public.bootstrap_admin_status()
returns jsonb
language plpgsql
stable
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

comment on function public.bootstrap_admin_status() is
  'Estado da configuração inicial temporária (enabled/created/remaining). Somente service_role.';

-- ---------------------------------------------------------------------------
-- 2. Registro atômico de uma conta administrativa inicial
-- ---------------------------------------------------------------------------
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

  -- Trava as duas linhas de configuração na mesma ordem (count primeiro,
  -- enabled depois) para que execuções concorrentes não ultrapassem o teto.
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
    -- Encerramento/limite. Se a chave foi religada manualmente com o teto já
    -- batido, apaga a chave AQUI e retorna normalmente (em vez de levantar
    -- exceção): assim o encerramento fica gravado; uma exceção desfaria o
    -- próprio desligamento. Nenhum usuário ou allowlist é tocado.
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
    -- ENCERRAMENTO AUTOMÁTICO: a segunda conta existe; a porta se fecha.
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

comment on function public.bootstrap_admin_register(uuid, text, text) is
  'Registra atomicamente uma das DUAS contas administrativas iniciais na allowlist. Encerra a configuração inicial ao atingir 2. Somente service_role.';

-- ---------------------------------------------------------------------------
-- 3. Privilégios: negar para todos, exceto service_role
-- ---------------------------------------------------------------------------
revoke all on function public.bootstrap_admin_status() from public, anon, authenticated;
revoke all on function public.bootstrap_admin_register(uuid, text, text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.bootstrap_admin_status() to service_role';
    execute 'grant execute on function public.bootstrap_admin_register(uuid, text, text) to service_role';
  end if;
end;
$$;
