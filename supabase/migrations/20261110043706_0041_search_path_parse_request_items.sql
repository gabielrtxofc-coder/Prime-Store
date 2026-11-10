-- ============================================================================
-- 0041 — SEARCH_PATH FIXO EM parse_request_items (SEGURANÇA)
-- ============================================================================
-- Alerta do Supabase Security Advisor (`function_search_path_mutable`) aberto
-- em 10/11/2026 para `public.parse_request_items(jsonb, integer)`: a função
-- foi criada (migração 0034) com `language plpgsql` SEM `set search_path`,
-- deixando o caminho de busca herdado do chamador.
--
-- A função NÃO é SECURITY DEFINER e NÃO tem EXECUTE para `anon`/`authenticated`
-- (revoke na própria 0034) — o risco é baixo, mas corrigir é correto e não
-- depende de concessão nova: o search_path fixo fecha a superfície de
-- resolução de nomes para qualquer papel que venha a executá-la (o backend
-- via service_role e as funções internas que a chamam).
--
-- A correção é cirúrgica: `alter function ... set search_path` muda APENAS o
-- parâmetro de configuração da função. Não toca no corpo/lógica, não muda
-- assinatura, não cria nem revoga privilégio algum (ACL preservada por
-- construção), não altera immutable/security definer.
--
-- Aplicada remotamente na Missão 12 como `m12_0041_search_path_parse_request_items`
-- (versão efetiva 20261110043706); corpo remoto conferido por md5 de
-- `pg_get_functiondef` byte-idêntico ao local. Este arquivo foi reconstruído na
-- Missão 13 com o SQL exato da aplicação (o arquivo anterior da Missão 12
-- perdeu-se com a recriação do workspace; ver relatório M13, §limitações).
-- ============================================================================

alter function public.parse_request_items(jsonb, integer)
  set search_path = public, pg_temp;

comment on function public.parse_request_items(jsonb, integer) is
  'Valida e normaliza a lista de itens de um pedido: sem item repetido, quantidade >= 1, ordenada por product_id (ordem global de trava). search_path fixo em public, pg_temp (migração 0041, segurança).';
