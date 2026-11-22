-- ============================================================================
-- 20261122120000_0046 — Redução da superfície RPC (Missão 15.1)
-- ============================================================================
-- Motivação: a revisão das 24 funções SECURITY DEFINER executáveis por
-- `authenticated` (Advisor `*_security_definer_function_executable`) mostrou
-- que 22 são de fato chamadas pela Edge Function `admin-api`, que repassa o
-- JWT do administrador e, portanto, depende do EXECUTE de `authenticated`.
-- Duas não são:
--
--   1. `admin_stock_summary()` — criada na 0012, recebeu EXECUTE na 0014 e
--      NUNCA foi chamada por nenhuma camada (nem `admin-api`, nem frontend,
--      nem teste). Substituída por `admin_stock_summary_by_product()` na 0045.
--      Manter EXECUTE para `authenticated` numa função sem chamador só amplia
--      superfície: qualquer JWT válido alcança o RPC pelo PostgREST.
--
--   2. `net.http_post/http_get/http_delete` — a extensão `pg_net` é declarada
--      com `GRANT EXECUTE ... TO PUBLIC` (comportamento da distribuição, não
--      escolha do projeto). O único consumidor legítimo é o pg_cron, que roda
--      como `postgres` (jobid 3, `prime-store-wyvi-worker`) e é superusuário —
--      revogar de PUBLIC/anon/authenticated não o afeta. Hoje o schema `net`
--      não está exposto pelo PostgREST (`db-schemas` = `public`), então o
--      caminho não é alcançável; esta revogação é defesa em profundidade para
--      o dia em que `net` for adicionado a `db-schemas` (ex.: para depurar
--      filas pelo Studio).
--
-- O que esta migração NÃO faz:
--   - não revoga nada das 22 funções usadas pelo painel (isso quebraria o
--     admin, cujo EXECUTE é justamente o que permite o `rpcForUser`);
--   - não move a extensão `pg_net` (schema gerenciado pela plataforma; mover
--     não é suportado e o Advisor continuaria apontando);
--   - não altera `search_path` nem o corpo de nenhuma função.
--
-- Compatibilidade: o bloco de `pg_net` é condicional. Ambientes local/CI não
-- instalam `pg_net` (bootstrap_local.sql não a cria), e um `revoke` direto em
-- função inexistente abortaria a migração e derrubaria a suíte inteira.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. `admin_stock_summary()` — sem chamador: fecha para usuário final.
--    Continua executável por `postgres` e `service_role` (diagnóstico).
-- ----------------------------------------------------------------------------
revoke execute on function public.admin_stock_summary() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. `pg_net` — fecha a superfície HTTP para papéis de usuário final.
--    `postgres` (dono do cron) mantém EXECUTE por ser superusuário.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_net') then
    revoke execute on function net.http_post(text, jsonb, jsonb, text, integer)
      from public, anon, authenticated;
    revoke execute on function net.http_get(text, jsonb, jsonb, integer)
      from public, anon, authenticated;

    -- `http_delete` mudou de assinatura entre versões da extensão; o bloco
    -- protege a migração de falhar num ambiente com versão diferente.
    begin
      revoke execute on function net.http_delete(text, jsonb, jsonb, integer)
        from public, anon, authenticated;
    exception
      when undefined_function then
        raise notice 'net.http_delete(text, jsonb, jsonb, integer) ausente — nada a revogar';
    end;
  else
    raise notice 'pg_net ausente neste ambiente — revogação condicional ignorada';
  end if;
end
$$;
