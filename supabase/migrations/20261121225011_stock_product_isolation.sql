-- ============================================================================
-- 20261121225011 — Isolamento de estoque por produto (Missão 13)
-- ============================================================================
-- Problema: nada impedia que uma credencial de um produto fosse asociada a
-- outro produto — no lote de importação, na reserva de um pedido ou na
-- entrega. Um pedido de produto A podia receber credenciais do produto B.
--
-- O que esta migração faz (código idêntico ao aplicado no Sandbox
-- `eorlmqolbknrplvdbbtl` em 2026-11-21):
--   1. `stock_product_matches_order(order, product)`: confere se o produto
--      consta no pedido — via `order_items` (pedidos multiproduto) ou, na
--      ausência de itens, via `orders.product_id` (formato antigo).
--   2. Três funções de guarda executadas por gatilhos BEFORE INSERT/UPDATE:
--      - `stock_units`: lote de importação e pedido de venda devem ser do
--        mesmo produto da unidade;
--      - `stock_reservation_units`: a unidade reservada deve pertencer a um
--        produto do pedido da reserva;
--      - `delivery_units`: a unidade entregue deve pertencer a um produto
--        do pedido da entrega.
--   3. `admin_stock_summary_by_product()`: resumo administrativo por produto
--      (total, disponível, reservada, vendida, desativada, última reposição
--      e situação empty/low/ok) com totais gerais. SECURITY DEFINER +
--      `assert_admin()`: somente administrador autorizado consulta.
--   4. Privilégios: EXECUTE revogado de PUBLIC em todas as funções novas;
--      `admin_stock_summary_by_product` fica execute-only para
--      `authenticated` (a autorização fina é do `assert_admin` no banco) —
--      anon e público não alcançam.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Compatibilidade produto x pedido (multiproduto e formato antigo)
-- ----------------------------------------------------------------------------
create or replace function public.stock_product_matches_order(p_order_id uuid, p_product_id uuid)
returns boolean
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM public.order_items oi
      WHERE oi.order_id = p_order_id
    )
    THEN EXISTS (
      SELECT 1
      FROM public.order_items oi
      WHERE oi.order_id = p_order_id
        AND oi.product_id = p_product_id
    )
    ELSE EXISTS (
      SELECT 1
      FROM public.orders o
      WHERE o.id = p_order_id
        AND o.product_id = p_product_id
    )
  END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Guardas executadas pelos gatilhos
-- ----------------------------------------------------------------------------
create or replace function public.guard_stock_unit_product_links()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
DECLARE
  v_batch_product_id uuid;
BEGIN
  IF NEW.import_batch_id IS NOT NULL THEN
    SELECT ib.product_id
      INTO v_batch_product_id
      FROM public.import_batches ib
     WHERE ib.id = NEW.import_batch_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'stock_import_batch_not_found'
        USING ERRCODE = '23503';
    END IF;

    IF v_batch_product_id <> NEW.product_id THEN
      RAISE EXCEPTION 'stock_import_product_mismatch'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.sold_order_id IS NOT NULL
     AND NOT public.stock_product_matches_order(NEW.sold_order_id, NEW.product_id) THEN
    RAISE EXCEPTION 'stock_unit_order_product_mismatch'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

create or replace function public.guard_stock_reservation_product_links()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
DECLARE
  v_order_id uuid;
  v_product_id uuid;
BEGIN
  SELECT sr.order_id
    INTO v_order_id
    FROM public.stock_reservations sr
   WHERE sr.id = NEW.reservation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stock_reservation_not_found'
      USING ERRCODE = '23503';
  END IF;

  SELECT su.product_id
    INTO v_product_id
    FROM public.stock_units su
   WHERE su.id = NEW.stock_unit_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stock_unit_not_found'
      USING ERRCODE = '23503';
  END IF;

  IF NOT public.stock_product_matches_order(v_order_id, v_product_id) THEN
    RAISE EXCEPTION 'stock_reservation_product_mismatch'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

create or replace function public.guard_delivery_unit_product_links()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
DECLARE
  v_order_id uuid;
  v_product_id uuid;
BEGIN
  SELECT d.order_id
    INTO v_order_id
    FROM public.deliveries d
   WHERE d.id = NEW.delivery_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery_not_found'
      USING ERRCODE = '23503';
  END IF;

  SELECT su.product_id
    INTO v_product_id
    FROM public.stock_units su
   WHERE su.id = NEW.stock_unit_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stock_unit_not_found'
      USING ERRCODE = '23503';
  END IF;

  IF NOT public.stock_product_matches_order(v_order_id, v_product_id) THEN
    RAISE EXCEPTION 'delivery_unit_product_mismatch'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Resumo administrativo de estoque por produto
-- ----------------------------------------------------------------------------
create or replace function public.admin_stock_summary_by_product()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public.assert_admin();

  SELECT jsonb_build_object(
    'products',
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'product_id', p.id,
          'product_name', p.name,
          'slug', p.slug,
          'is_active', p.is_active,
          'archived_at', p.archived_at,
          'total_units', COALESCE(s.total_units, 0),
          'available_units', COALESCE(s.available_units, 0),
          'reserved_units', COALESCE(s.reserved_units, 0),
          'sold_units', COALESCE(s.sold_units, 0),
          'disabled_units', COALESCE(s.disabled_units, 0),
          'last_restocked_at', s.last_restocked_at,
          'stock_health',
            CASE
              WHEN COALESCE(s.available_units, 0) = 0 THEN 'empty'
              WHEN COALESCE(s.available_units, 0) <= 2 THEN 'low'
              ELSE 'ok'
            END
        )
        ORDER BY p.name, p.id
      ),
      '[]'::jsonb
    ),
    'totals',
    jsonb_build_object(
      'total_units', COALESCE(sum(COALESCE(s.total_units, 0)), 0),
      'available_units', COALESCE(sum(COALESCE(s.available_units, 0)), 0),
      'reserved_units', COALESCE(sum(COALESCE(s.reserved_units, 0)), 0),
      'sold_units', COALESCE(sum(COALESCE(s.sold_units, 0)), 0),
      'disabled_units', COALESCE(sum(COALESCE(s.disabled_units, 0)), 0)
    )
  )
  INTO v_result
  FROM public.products p
  LEFT JOIN LATERAL (
    SELECT
      count(*) AS total_units,
      count(*) FILTER (WHERE su.status = 'available') AS available_units,
      count(*) FILTER (WHERE su.status = 'reserved') AS reserved_units,
      count(*) FILTER (WHERE su.status = 'sold') AS sold_units,
      count(*) FILTER (WHERE su.status = 'disabled') AS disabled_units,
      max(su.created_at) AS last_restocked_at
    FROM public.stock_units su
    WHERE su.product_id = p.id
  ) s ON true;

  RETURN v_result;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Gatilhos de isolamento (idempotentes)
-- ----------------------------------------------------------------------------
drop trigger if exists trg_stock_units_product_isolation on public.stock_units;
create trigger trg_stock_units_product_isolation
  before insert or update of product_id, import_batch_id, sold_order_id
  on public.stock_units
  for each row execute function public.guard_stock_unit_product_links();

drop trigger if exists trg_stock_reservation_units_product_isolation on public.stock_reservation_units;
create trigger trg_stock_reservation_units_product_isolation
  before insert or update of reservation_id, stock_unit_id
  on public.stock_reservation_units
  for each row execute function public.guard_stock_reservation_product_links();

drop trigger if exists trg_delivery_units_product_isolation on public.delivery_units;
create trigger trg_delivery_units_product_isolation
  before insert or update of delivery_id, stock_unit_id
  on public.delivery_units
  for each row execute function public.guard_delivery_unit_product_links();

-- ----------------------------------------------------------------------------
-- 5. Privilégios: nada novo fica executável por anon/público
-- ----------------------------------------------------------------------------
revoke execute on function public.stock_product_matches_order(uuid, uuid) from public;
revoke execute on function public.guard_stock_unit_product_links() from public;
revoke execute on function public.guard_stock_reservation_product_links() from public;
revoke execute on function public.guard_delivery_unit_product_links() from public;
revoke execute on function public.admin_stock_summary_by_product() from public;

-- A função administrativa pode ser chamada por usuários autenticados, mas o
-- assert_admin() dentro dela bloqueia quem não é administrador (e anon nem
-- chega a ter EXECUTE).
grant execute on function public.admin_stock_summary_by_product() to authenticated;

-- service_role é o papel do backend (Edge Functions): mantém EXECUTE nas
-- funções novas, como em todas as demais funções públicas do projeto. Os
-- gatilhos continuam sendo disparados apenas pelo próprio banco.
grant execute on function public.stock_product_matches_order(uuid, uuid) to service_role;
grant execute on function public.guard_stock_unit_product_links() to service_role;
grant execute on function public.guard_stock_reservation_product_links() to service_role;
grant execute on function public.guard_delivery_unit_product_links() to service_role;
grant execute on function public.admin_stock_summary_by_product() to service_role;
