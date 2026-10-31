-- ============================================================================
-- 0025 — REMOÇÃO DE ÍNDICES REDUNDANTES (achado da verificação de performance)
-- ============================================================================
-- A auditoria de índices desta missão comparou *definições*, não nomes. Três
-- índices são estritamente redundantes: cada busca que os usaria é atendida por
-- outro índice sobre exatamente as mesmas colunas (e mesmos predicados).
-- Manter os dois só dobra o custo de escrita e o espaço.
--
-- Justificativa item a item:
--
--   stock_units_sold_order_idx      == stock_units_order_idx
--     Ambos: btree (sold_order_id) WHERE sold_order_id IS NOT NULL.
--     O primeiro foi criado por engano na migração 0021 (o segundo já existia
--     desde a 0009). Removemos o duplicado novo.
--
--   stock_units_product_status_idx  == stock_units_status_idx
--     Ambos: btree (product_id, status). Mesmo caso: criado por engano na 0021.
--
--   deliveries_order_idx (0009)     ⊂ deliveries_order_id_key
--     `deliveries.order_id` é único, e o índice único já atende toda busca por
--     order_id. Não existe consulta que use o índice simples sem poder usar o
--     único.
--
-- O índice que a auditoria realmente pedia — stock_units.import_batch_id — foi
-- criado e permanece (stock_units_import_batch_idx).
--
-- Não removemos nenhum índice apenas por "estar sem uso": decisão registrada no
-- relatório. Estes três são removidos por redundância de definição, que é
-- verificável sem tráfego de produção.

drop index if exists public.stock_units_sold_order_idx;
drop index if exists public.stock_units_product_status_idx;
drop index if exists public.deliveries_order_idx;

comment on index public.stock_units_import_batch_idx is
  'FK stock_units.import_batch_id — criado na 0021, mantido (índice que faltava).';
comment on index public.stock_units_available_idx is
  'Disponibilidade por produto na ordem de venda (product_id, created_at, id) WHERE status=available.';
comment on index public.stock_units_status_idx is
  'Listagem operacional por produto + status (absorve o antigo stock_units_product_status_idx).';
comment on index public.stock_units_order_idx is
  'Unidades vendidas por pedido (absorve o antigo stock_units_sold_order_idx).';
