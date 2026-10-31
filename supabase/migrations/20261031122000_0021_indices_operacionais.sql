-- ============================================================================
-- 0021 — ÍNDICES PARA AS CONSULTAS REAIS DA OPERAÇÃO
-- ============================================================================
-- O Performance Advisor apontou a chave estrangeira sem índice:
--   public.stock_units.import_batch_id
-- Sem ele, excluir/atualizar um lote de importação varre a tabela inteira de
-- unidades — que é justamente a maior tabela do sistema.
--
-- Nenhum índice é removido: o projeto ainda não tem tráfego suficiente para
-- afirmar que um índice "nunca é usado". Índices só são adicionados onde há
-- consulta real declarada no código (ver comentários ao lado).

-- FK + listagem de unidades por lote de importação
create index if not exists stock_units_import_batch_idx
  on public.stock_units (import_batch_id)
  where import_batch_id is not null;

-- Busca de unidades vendidas por pedido (usada na entrega e no painel)
create index if not exists stock_units_sold_order_idx
  on public.stock_units (sold_order_id)
  where sold_order_id is not null;

-- Listagem de unidades por produto + status (painel: estoque disponível/reservado)
create index if not exists stock_units_product_status_idx
  on public.stock_units (product_id, status);

-- Consulta pública de disponibilidade (view public_catalog agrupa por produto/status)
create index if not exists stock_units_available_idx
  on public.stock_units (product_id)
  where status = 'available';

-- Pedidos por chave de idempotência já existem (orders_idempotency_key_key).
-- Eventos por pedido já existem (order_events_order_idx).
-- Pagamentos por pedido já existem (payments_order_idx).
