-- ============================================================================
-- 0040 — admin_list_orders expõe items_count (pedidos multiproduto)
-- ============================================================================
-- Auditoria da Missão 11 (Tarefa 009): desde a migração 0033 os pedidos de
-- carrinho gravam `orders.items_count` (total de produtos distintos), e
-- `admin_get_order` já devolve a coluna (é `to_jsonb(o)`), mas
-- `admin_list_orders` (última definição: 0019, anterior à 0033) não a
-- selecionava. Consequência: na lista do painel um pedido com 5 produtos
-- aparece idêntico a um de produto único, com o nome do primeiro produto —
-- o frontend nem recebia o campo (`items_count` opcional sempre indefinido).
--
-- Mudança: uma coluna a mais no SELECT de itens (mesma assinatura, mesmo
-- corpo, mesmos privilégios; CREATE OR REPLACE preserva grants). Nenhuma
-- regra de filtro, ordenação, paginação ou autorização muda.
--
-- ESTA MIGRAÇÃO NÃO FOI APLICADA AO SUPABASE REMOTO pela Missão 11 (limite
-- absoluto: sem escrita em produção). Aplicação remota é tarefa do operador.
-- ============================================================================

create or replace function public.admin_list_orders(
  p_search text default null,
  p_status text default null,
  p_payment_status text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_problem_only boolean default false,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_admin();
  v_items jsonb;
  v_total integer;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  select count(*) into v_total
  from public.orders o
  where (p_status is null or o.status::text = p_status)
    and (p_payment_status is null or o.payment_status::text = p_payment_status)
    and (p_from is null or o.created_at >= p_from)
    and (p_to is null or o.created_at <= p_to)
    and (
      not p_problem_only
      or o.status in ('refund_pending', 'failed', 'disputed')
      or o.payment_status in ('amount_mismatch', 'charged_back')
    )
    and (
      p_search is null or btrim(p_search) = ''
      or o.reference ilike '%' || btrim(p_search) || '%'
      or o.product_name ilike '%' || btrim(p_search) || '%'
    );

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc), '[]'::jsonb)
    into v_items
  from (
    select
      o.id, o.reference, o.product_id, o.product_name, o.quantity,
      o.items_count,
      o.unit_price_cents, o.total_cents, o.status, o.payment_status,
      o.delivery_status, o.created_at, o.paid_at, o.reservation_expires_at,
      d.id as delivery_id, d.status as delivery_link_status,
      (select count(*) from public.refund_requests rr
        where rr.order_id = o.id and rr.status in ('pending', 'authorized')) as open_refund_requests
    from public.orders o
    left join public.deliveries d on d.order_id = o.id
    where (p_status is null or o.status::text = p_status)
      and (p_payment_status is null or o.payment_status::text = p_payment_status)
      and (p_from is null or o.created_at >= p_from)
      and (p_to is null or o.created_at <= p_to)
      and (
        not p_problem_only
        or o.status in ('refund_pending', 'failed', 'disputed')
        or o.payment_status in ('amount_mismatch', 'charged_back')
      )
      and (
        p_search is null or btrim(p_search) = ''
        or o.reference ilike '%' || btrim(p_search) || '%'
        or o.product_name ilike '%' || btrim(p_search) || '%'
      )
    order by o.created_at desc
    limit v_limit offset greatest(coalesce(p_offset, 0), 0)
  ) t;

  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', coalesce(p_offset, 0));
end;
$$;
