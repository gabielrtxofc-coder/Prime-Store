-- ============================================================================
-- SEGURANÇA: RLS, privilégios de tabela e execução de funções
-- ============================================================================
-- Modelo de acesso da Prime Store:
--   * anon/authenticated NÃO têm acesso direto a nenhuma tabela do schema
--     public. RLS está habilitado em todas elas e não há policies: mesmo que
--     um GRANT futuro escape, a leitura continua negada.
--   * O único ponto de leitura pública é a view public.public_catalog.
--   * Toda escrita/consulta de negócio passa por funções SECURITY DEFINER
--     chamadas pelas Edge Functions com a service role (servidor).
--   * O painel administrativo chama as funções admin_* com o JWT do usuário
--     (authenticated). A autorização real acontece em assert_admin()
--     (allowlist + AAL2), nunca no navegador.
--   * service_role é a única role com acesso amplo e NUNCA é exposta ao
--     frontend.

-- ---------------------------------------------------------------------------
-- 1. Row Level Security em todas as tabelas
-- ---------------------------------------------------------------------------
alter table public.app_settings                 enable row level security;
alter table public.admin_users                  enable row level security;
alter table public.admin_audit_log              enable row level security;
alter table public.product_categories           enable row level security;
alter table public.products                     enable row level security;
alter table public.product_price_history        enable row level security;
alter table public.import_batches               enable row level security;
alter table public.stock_units                  enable row level security;
alter table public.orders                       enable row level security;
alter table public.order_events                 enable row level security;
alter table public.stock_reservations           enable row level security;
alter table public.stock_reservation_units      enable row level security;
alter table public.payments                     enable row level security;
alter table public.payment_events               enable row level security;
alter table public.deliveries                   enable row level security;
alter table public.delivery_units               enable row level security;
alter table public.refund_requests              enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Privilégios de schema, tabela e sequência
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- A view pública é o único objeto de leitura liberado ao cliente anônimo.
grant select on public.public_catalog to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Execução de funções
-- ---------------------------------------------------------------------------
-- Remove o EXECUTE implícito que o Postgres concede a PUBLIC em toda função
-- nova. Sem isso, `anon` conseguiria chamar funções administrativas via
-- PostgREST apenas conhecendo o nome.
revoke execute on all functions in schema public from public, anon, authenticated;

-- Servidor (Edge Functions) usa service_role para todas as funções.
grant execute on all functions in schema public to service_role;

-- Cliente público NÃO chama funções diretamente: o fluxo de compra/entrega
-- passa sempre pelas Edge Functions (service_role), que validam o payload,
-- aplicam idempotência e nunca devolvem credenciais sem pagamento aprovado.

-- Painel administrativo: funções admin_* + is_admin, sempre com JWT do
-- usuário. assert_admin() valida allowlist e AAL2 antes de qualquer efeito.
grant execute on function public.is_admin(boolean) to authenticated;
grant execute on function public.admin_list_products(text, boolean) to authenticated;
grant execute on function public.admin_get_product(uuid) to authenticated;
grant execute on function public.admin_create_product(jsonb) to authenticated;
grant execute on function public.admin_update_product(uuid, jsonb) to authenticated;
grant execute on function public.admin_set_product_active(uuid, boolean) to authenticated;
grant execute on function public.admin_list_stock(uuid, text, text, integer, integer, boolean) to authenticated;
grant execute on function public.admin_stock_summary() to authenticated;
grant execute on function public.admin_stock_fingerprints(uuid) to authenticated;
grant execute on function public.admin_add_stock_unit(uuid, text, text, text, text, uuid) to authenticated;
grant execute on function public.admin_update_stock_unit(uuid, text, text, text, text) to authenticated;
grant execute on function public.admin_set_stock_unit_status(uuid, text) to authenticated;
grant execute on function public.admin_import_stock_units(uuid, jsonb, jsonb, text) to authenticated;
grant execute on function public.admin_list_orders(text, text, text, timestamptz, timestamptz, boolean, integer, integer) to authenticated;
grant execute on function public.admin_get_order(uuid) to authenticated;
grant execute on function public.admin_indicators() to authenticated;
grant execute on function public.admin_list_refund_requests(text) to authenticated;
grant execute on function public.admin_resolve_refund(uuid, text, text) to authenticated;
grant execute on function public.admin_revoke_delivery(uuid, text) to authenticated;
grant execute on function public.admin_rotate_delivery_token(uuid, text, text) to authenticated;
grant execute on function public.admin_audit_log(integer) to authenticated;
grant execute on function public.admin_expire_reservations() to authenticated;

-- Nenhuma função interna (apply_payment_status, create_order helpers,
-- assert_admin etc.) é executável por anon/authenticated.

-- ---------------------------------------------------------------------------
-- 4. Default privileges: tabelas futuras não nascem com GRANT para o cliente
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
