-- ============================================================================
-- 0036 — ENTREGA MULTI-PRODUTO NO ACESSO PRIVADO
-- ============================================================================
-- `resolve_delivery` continua sendo a única porta de leitura de credencial, com
-- as mesmas proteções (hash do token, entrega ativa, pedido pago e pronto) e o
-- mesmo efeito colateral (contador de visualizações). O que muda é a forma:
--
--   * `items`     — um grupo por produto, com instruções, validade e as
--                   unidades daquele produto;
--   * `product`   — primeiro item, mantido para o cliente antigo;
--   * `units`     — todas as unidades em lista plana, mantida para o cliente
--                   antigo.
--
-- A ordem dos grupos é determinística (`product_name`, `product_id`) para que
-- duas leituras da mesma entrega devolvam exatamente o mesmo payload.
-- ============================================================================

create or replace function public.resolve_delivery(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_delivery public.deliveries;
  v_order public.orders;
  v_product public.products;
  v_items jsonb;
  v_units jsonb;
  v_first jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'delivery_not_found' using errcode = 'P0002';
  end if;

  select * into v_delivery from public.deliveries where token_hash = p_token_hash;
  if not found then
    raise exception 'delivery_not_found' using errcode = 'P0002';
  end if;

  if v_delivery.status = 'revoked' then
    raise exception 'delivery_revoked' using errcode = 'P0002';
  end if;

  select * into v_order from public.orders where id = v_delivery.order_id;

  if v_order.status <> 'paid'
     or v_order.payment_status <> 'approved'
     or v_order.delivery_status <> 'ready' then
    raise exception 'delivery_unavailable' using errcode = 'P0002';
  end if;

  select * into v_product from public.products where id = v_order.product_id;

  -- Grupos por produto + lista plana (compatibilidade).
  v_items := public.delivery_items_json(v_delivery.id);

  if v_items is null or jsonb_array_length(v_items) = 0 then
    raise exception 'delivery_unavailable' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(unit_json order by unit_index), '[]'::jsonb)
    into v_units
  from (
    select unit_json, unit_index
      from (
        select jsonb_array_elements(it -> 'units') as unit_json,
               row_number() over () as unit_index
          from jsonb_array_elements(v_items) as it
      ) flat
  ) ordered;

  v_first := v_items -> 0;

  update public.deliveries
     set view_count = view_count + 1,
         last_viewed_at = now()
   where id = v_delivery.id;

  return jsonb_build_object(
    'delivery_id', v_delivery.id,
    'order_id', v_order.id,
    'reference', v_order.reference,
    'created_at', v_delivery.created_at,
    'items_count', jsonb_array_length(v_items),
    'items', v_items,
    'product', jsonb_build_object(
      'id', v_first -> 'product_id',
      'name', v_first -> 'product_name',
      'slug', v_first -> 'product_slug',
      'instructions', v_first -> 'instructions',
      'access_validity_label', v_first -> 'access_validity_label',
      'access_validity_days', v_first -> 'access_validity_days'
    ),
    'units', v_units
  );
end;
$$;

comment on function public.resolve_delivery(text) is
  'Resolve a entrega pelo hash do token privado e devolve as credenciais agrupadas por produto (items), com product/units mantidos para o cliente antigo.';

revoke all on function public.resolve_delivery(text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.resolve_delivery(text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.resolve_delivery(text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.resolve_delivery(text) to service_role';
  end if;
end
$$;
