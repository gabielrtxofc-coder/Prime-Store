-- ============================================================================
-- 0022 — FECHAMENTO DE PRIVILÉGIOS (idempotente e auto-mantido)
-- ============================================================================
-- Motivo: o PostgreSQL concede EXECUTE a PUBLIC em toda função nova. As
-- migrações 0017–0021 criam/substituem funções, então os privilégios são
-- reafirmados aqui, de forma dinâmica, para que o estado final não dependa da
-- ordem em que os arquivos foram escritos.
--
-- Modelo de acesso (inalterado desde a 0014, agora verificado):
--   anon ................ nenhum acesso a tabela; nenhuma função
--   authenticated ....... nenhum acesso a tabela; apenas admin_* + is_admin
--   service_role ........ acesso total (somente servidor / Edge Functions)
--   leitura pública ..... exclusivamente a view public.public_catalog
--
-- Toda função `admin_*` valida `assert_admin()` (allowlist + AAL2) internamente,
-- e `is_admin` é uma consulta booleana sem efeito colateral.

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Tabelas, views e sequências
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

grant select on public.public_catalog to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Funções: negar por padrão, conceder por classificação
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like 'admin\_%' or p.proname = 'is_admin')
  loop
    execute format('grant execute on function %s to authenticated', r.signature);
  end loop;
end;
$$;

-- Consulta pública (catálogo) permanece exclusivamente no servidor: o
-- navegador fala com a Edge Function `catalog`, que aplica validação e limites.

-- ---------------------------------------------------------------------------
-- 4. Objetos futuros não nascem expostos
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. RLS reafirmada (defesa em profundidade)
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  loop
    execute format('alter table public.%I enable row level security', r.relname);
  end loop;
end;
$$;
