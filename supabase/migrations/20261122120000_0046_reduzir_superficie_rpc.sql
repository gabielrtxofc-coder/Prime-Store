-- ============================================================================
-- 20261122120000_0046 — Redução da superfície RPC (Missão 15.2)
-- ============================================================================
-- SUBSTITUI a versão escrita na Missão 15.1, que tinha TRÊS defeitos:
--
--   1. ASSINATURAS INVENTADAS. A versão anterior usava
--      `net.http_post(text, jsonb, jsonb, text, integer)` e
--      `net.http_delete(text, jsonb, jsonb, integer)`. O catálogo real
--      (pg_net 0.20.4, projeto audsosvbdybifvxsmqpi) diz:
--        net.http_post(text, jsonb, jsonb, jsonb, integer)      <- 4º é jsonb
--        net.http_get(text, jsonb, jsonb, integer)
--        net.http_delete(text, jsonb, jsonb, integer, jsonb)    <- 5 argumentos
--      O REVOKE anterior teria falhado com "function does not exist" em
--      produção. (O bloco que capturava `undefined_function` escondia isso.)
--
--   2. REVOGAÇÃO SEM POSSE. `net.*` e o schema `net` pertencem a
--      `supabase_admin`. O `postgres` de produção NÃO é superusuário
--      (`rolsuper = false`) e NÃO é membro de `supabase_admin`. Nesse cenário,
--      `REVOKE ... FROM PUBLIC` não levanta exceção e NÃO altera a ACL —
--      é um no-op silencioso. Comprovado em laboratório (tests/db/29):
--        ACL antes  = {=X/owner, owner=X/owner, plain=X/owner}
--        ACL depois = {=X/owner, owner=X/owner, plain=X/owner}
--      Ou seja: mesmo com as assinaturas certas, a versão anterior não teria
--      revogado nada em produção.
--
--   3. QUEBRARIA O WORKER. O EXECUTE que o `postgres` tem sobre `net.http_post`
--      vem SÓ do `PUBLIC`. Ele não é dono e não tem GRANT nominal. Revogar de
--      `PUBLIC` (se fosse possível) tiraria a capacidade do próprio cron job
--      `prime-store-wyvi-worker`, que roda como `postgres`, de enfileirar HTTP.
--
-- ---------------------------------------------------------------------------
-- DECISÃO TÉCNICA
-- ---------------------------------------------------------------------------
-- Como o dono é `supabase_admin` e a migração roda como `postgres`, NÃO é
-- possível revogar privilégio na extensão `pg_net` a partir do repositório.
-- A migração então:
--
--   (a) executa REVOKE somente quando a sessão realmente tem poder para isso
--       (`é dono` OU `superusuário`) — sem exceções engolidas;
--   (b) VERIFICA o resultado por `has_function_privilege` e FALHA explícita
--       (`raise exception`) se a ACL continuar aberta, em vez de registrar
--       sucesso falso;
--   (c) quando a sessão não pode revogar, emite `raise warning` nomeando o
--       dono e a consulta de diagnóstico — a pendência fica visível, não
--       escondida;
--   (d) executa a parte que SEMPRE importa e que é de nossa posse:
--       `REVOKE EXECUTE ON FUNCTION public.admin_stock_summary()`
--       (dono `postgres` em produção, confirmado por consulta).
--
-- Idempotente e sem dependência de assinatura escrita à mão: os alvos de
-- `pg_net` são descobertos em `pg_proc`/`pg_namespace` por nome, e a
-- assinatura aplicada é a do próprio catálogo (`p.oid::regprocedure`).
--
-- Compatibilidade: em ambiente sem `pg_net` (local/CI, onde
-- `bootstrap_local.sql` não instala a extensão) os blocos de descoberta são
-- vazios e a migração conclui sem erro.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. `admin_stock_summary()` — órfã, sem nenhum chamador em código de produção.
--    Continua executável por `postgres` (dono) e `service_role` (diagnóstico);
--    deixa de ser alcançável por `authenticated` pelo PostgREST.
--    Aridade `()` confirmada no catálogo, não presumida.
-- ----------------------------------------------------------------------------
revoke execute on function public.admin_stock_summary() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. `pg_net` — descoberta dinâmica das assinaturas reais.
-- ----------------------------------------------------------------------------
do $$
declare
  v_ext_instalada  boolean;
  v_schema_dono    text;
  v_posso_revogar  boolean;
  v_nomes          text[] := array['http_post', 'http_get', 'http_delete'];
  v_alvos          text[] := array[]::text[];
  v_esperadas      int;
  v_abertas        text[] := array[]::text[];
  v_reg            record;
  v_acl            text;
begin
  select exists (select 1 from pg_extension where extname = 'pg_net')
    into v_ext_instalada;

  if not v_ext_instalada then
    raise notice 'pg_net ausente neste ambiente — nada a revogar (esperado em local/CI).';
    return;
  end if;

  select pg_get_userbyid(n.nspowner)
    into v_schema_dono
    from pg_namespace n
   where n.nspname = 'net';

  -- Descobre as assinaturas REAIS pelo catálogo (nunca por literal digitado).
  for v_reg in
    select p.oid,
           p.oid::regprocedure::text as assinatura,
           pg_get_userbyid(p.proowner) as dono
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'net'
       and p.proname = any (v_nomes)
     order by p.proname, p.oid::regprocedure::text
  loop
    v_alvos := v_alvos || v_reg.assinatura;
  end loop;

  v_esperadas := cardinality(v_nomes);

  if cardinality(v_alvos) = 0 then
    -- Extensão instalada mas nenhuma das três funções públicas: é uma
    -- anomalia real e precisa ser investigada, não ignorada.
    raise exception
      'pg_net instalada, mas nenhuma de % foi encontrada no schema net. '
      'Investigação necessária: a versão da extensão pode ter renomeado as funções.',
      v_nomes;
  end if;

  if cardinality(v_alvos) <> v_esperadas then
    raise warning
      'pg_net: esperava % funções (%), encontrei %: %. Prosseguindo com as encontradas.',
      v_esperadas, v_nomes, cardinality(v_alvos), v_alvos;
  end if;

  -- Tem poder de revogar? Só o dono do schema ou um superusuário.
  -- `rolsuper` vive em `pg_roles`, não em `pg_namespace`.
  v_posso_revogar := (
    select coalesce(r.rolsuper, false)
           or pg_has_role(current_user, pg_get_userbyid(n.nspowner), 'USAGE')
      from pg_namespace n
      join pg_roles r on r.rolname = current_user
     where n.nspname = 'net'
  );

  raise notice 'pg_net: dono do schema = %, sessão = %, pode revogar = %, alvos = %',
    v_schema_dono, current_user, v_posso_revogar, v_alvos;

  if not v_posso_revogar then
    -- NÃO finge sucesso. Registra a limitação e a consulta que comprova.
    raise warning
      'pg_net é de % e esta sessão (%) não é dona nem superusuária: '
      'REVOKE seria um no-op silencioso (ACL inalterada). Nenhuma revogação aplicada. '
      'A superfície exige ação do proprietário (supabase_admin).',
      v_schema_dono, current_user;
  else
    -- Revoga por assinatura descoberta. Inclui PUBLIC (o GRANT padrão da
    -- extensão) e os papéis de usuário final.
    for v_reg in
      select p.oid, p.oid::regprocedure::text as assinatura
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'net'
         and p.proname = any (v_nomes)
    loop
      execute format('revoke execute on function %s from public', v_reg.assinatura);
      execute format('revoke execute on function %s from anon', v_reg.assinatura);
      execute format('revoke execute on function %s from authenticated', v_reg.assinatura);
    end loop;

    -- Verificação REAL: nenhum papel de usuário final pode executar, e a
    -- ACL não pode mais conter concessão a PUBLIC.
    --
    -- `grantee = 0` é PUBLIC. Comparar o texto da ACL com um LIKE '%X/%'
    -- daria falso positivo em toda concessão nominal (`postgres=X/postgres`
    -- contém '=X/'), então a checagem é por `aclexplode`, não por string.
    for v_reg in
      select p.oid, p.oid::regprocedure::text as assinatura, coalesce(p.proacl::text, '') as acl
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'net'
         and p.proname = any (v_nomes)
    loop
      if has_function_privilege('anon', v_reg.oid, 'execute')
         or has_function_privilege('authenticated', v_reg.oid, 'execute')
         or exists (
              select 1
                from aclexplode(coalesce(
                       (select p2.proacl from pg_proc p2 where p2.oid = v_reg.oid),
                       acldefault('f', (select p3.proowner from pg_proc p3 where p3.oid = v_reg.oid))
                     )) a
               where a.grantee = 0
                 and a.privilege_type = 'EXECUTE'
            ) then
        v_abertas := v_abertas || (v_reg.assinatura || ' [' || v_reg.acl || ']');
      end if;
    end loop;

    if cardinality(v_abertas) > 0 then
      raise exception
        'REVOKE aplicado mas a ACL continua aberta — investigar (não silenciar): %',
        v_abertas;
    end if;

    raise notice 'pg_net: EXECUTE revogado de PUBLIC/anon/authenticated nas funções %', v_alvos;
  end if;

  -- USAGE no schema: não é revogável por esta sessão pelo mesmo motivo.
  -- Registra-se apenas para que a decisão do proprietário seja informada.
  if has_schema_privilege('anon', 'net', 'usage')
     or has_schema_privilege('authenticated', 'net', 'usage') then
    raise warning
      'schema net: USAGE ainda concedido a anon/authenticated (ACL de %). '
      'Não é alcançável pelo PostgREST hoje (db-schemas = public), mas exige '
      'ação do proprietário para fechar.', v_schema_dono;
  end if;
end
$$;
