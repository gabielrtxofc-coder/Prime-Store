-- ============================================================================
-- 0020 — SEARCH_PATH FIXO EM TODAS AS FUNÇÕES
-- ============================================================================
-- O Security Advisor apontou três funções com `search_path` mutável:
--   * public.generate_order_reference()
--   * public.set_updated_at()
--   * public.products_record_price_change()
--
-- `search_path` mutável permite que um objeto em outro schema (por exemplo um
-- schema criado por um usuário) seja resolvido antes do esperado. Todas as
-- funções passam a fixar `search_path = public, pg_temp`, que é o padrão já
-- usado pelas funções SECURITY DEFINER desde a 0011/0012.
--
-- `pg_temp` fica por último de propósito: o schema temporário da sessão é
-- sempre verificado por último, então nada em `public` pode ser "sequestrado".

alter function public.generate_order_reference() set search_path = public, pg_temp;
alter function public.set_updated_at() set search_path = public, pg_temp;
alter function public.products_record_price_change() set search_path = public, pg_temp;

-- Garantia de que nenhuma outra função fique sem configuração explícita.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proconfig is null
  loop
    execute format('alter function %s set search_path = public, pg_temp', r.signature);
  end loop;
end;
$$;
