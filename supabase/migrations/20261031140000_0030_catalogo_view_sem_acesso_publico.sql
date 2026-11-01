-- ============================================================================
-- 0030 — FECHA O ACESSO PÚBLICO DIRETO À VIEW DE CATÁLOGO
-- ============================================================================
-- Achado da revisão da missão 04 (alerta de segurança no catálogo público).
--
-- Problema concreto, reproduzido com a chave `anon` (que está embutida no
-- bundle do frontend, portanto é pública):
--
--   GET https://<projeto>.supabase.co/rest/v1/public_catalog?select=slug,available_units
--   apikey: <anon>
--   → 200 [{"slug":"produto-exemplo-mensal","available_units":12}, ...]
--
-- A view `public.public_catalog` foi criada sem `security_invoker`, então roda
-- com os privilégios do dono (postgres) e IGNORA as políticas de RLS de
-- `products`, `product_categories` e `stock_units`. Com `select` concedido a
-- `anon`, qualquer pessoa com a chave pública lia o catálogo — e a contagem de
-- estoque — direto pelo PostgREST, sem passar pela Edge Function.
--
-- Por que isso importa mesmo sendo "catálogo público":
--   * a superfície ficava fora do contrato aplicacional (a loja usa a Edge
--     Function `catalog` → RPC `get_catalog`), sem rate limit, sem os campos
--     sanitizados pelo mapper e sem a possibilidade de filtrar por ambiente;
--   * a agregação sobre `stock_units` ocorre dentro de um contexto de dono: hoje
--     só expõe contagem, mas qualquer coluna agregada nova herdaria o mesmo
--     bypass silenciosamente;
--   * é exatamente o padrão que o linter do Supabase sinaliza como
--     "security definer view" — o alerta tratado nesta missão.
--
-- Correção (sem tocar em nenhuma funcionalidade aprovada da loja):
--   1. a view passa a ser `security_invoker` — RLS volta a valer para quem lê;
--   2. o acesso direto de `anon`/`authenticated` é revogado: quem precisa do
--      catálogo usa a Edge Function `catalog`;
--   3. `service_role` (usado apenas no servidor) mantém a leitura;
--   4. `get_catalog` continua funcionando: é SECURITY DEFINER com
--      `search_path` fixo e lê a view como o dono (postgres), que tem os
--      privilégios das tabelas de base.
--
-- Reversão consciente, se um dia o catálogo voltar a ser lido direto pelo
-- PostgREST: NÃO basta conceder `select` de novo. Seria necessário conceder
-- privilégio por coluna nas tabelas de base e criar políticas de RLS para
-- `anon` (produtos ativos, categorias ativas e contagem de unidades) — ou seja,
-- reabrir a superfície de forma explícita e revisada.

alter view public.public_catalog set (security_invoker = true);

revoke all on public.public_catalog from anon;
revoke all on public.public_catalog from authenticated;

comment on view public.public_catalog is
  'View interna do catálogo (security_invoker). Lida por get_catalog/Edge Function; sem acesso direto para anon/authenticated. Não expõe custo, credenciais nem identificadores internos.';

-- ---------------------------------------------------------------------------
-- Verificação embutida: falha a migração se a view continuar sendo definer
-- ou se `anon` ainda conseguir ler.
-- ---------------------------------------------------------------------------
do $$
declare
  v_invoker text;
begin
  select option_value into v_invoker
  from pg_options_to_table((select c.reloptions from pg_class c
                             join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'public' and c.relname = 'public_catalog'))
  where option_name = 'security_invoker';

  if coalesce(v_invoker, 'false') <> 'true' then
    raise exception 'public_catalog continua sem security_invoker';
  end if;

  if has_table_privilege('anon', 'public.public_catalog', 'SELECT')
     or has_table_privilege('authenticated', 'public.public_catalog', 'SELECT') then
    raise exception 'public_catalog ainda legível por anon/authenticated';
  end if;

  if not has_table_privilege('service_role', 'public.public_catalog', 'SELECT') then
    raise exception 'service_role perdeu acesso à view de catálogo';
  end if;
end;
$$;
