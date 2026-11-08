-- ============================================================================
-- 0034 — NÚCLEO MULTI-PRODUTO E ENTREGA POR ITEM
-- ============================================================================
-- Objetivo da missão: o pedido passa a ser processado de ponta a ponta sem
-- intervenção humana, com vários produtos no mesmo pedido, reserva por item,
-- uma única transação e entrega agrupada por produto.
--
-- O que NÃO é reescrito (decisão explícita, ver docs/auditoria/automacao-entregas):
--   * `reserve_stock_units` continua sendo a reserva de item único;
--   * `consume_reservation`, `release_order_reservation` e
--     `expire_overdue_reservations` continuam valendo — todos operam por
--     `order_id`, não por produto, então já servem a pedidos multi-item;
--   * `create_order` (fluxo de cobrança de um produto) permanece intacto.
--
-- O que é construído aqui, de forma aditiva:
--   1. `parse_request_items`      — normaliza e valida a lista de itens;
--   2. `order_required_units`     — quantas unidades cada produto do pedido
--                                   exige (itens reais ou pedido legado);
--   3. `reserve_stock_units_multi`— UMA reserva por pedido com N itens,
--                                   produtos travados em ordem crescente de id
--                                   (sem deadlock) e unidades com `skip locked`;
--   4. `create_order_multi`       — cria pedido + itens + reserva na MESMA
--                                   transação: falha em um item não deixa nada;
--   5. `allocate_late_units_multi`/`allocate_late_units_for_order`
--                                 — alocação tardia (PIX aprovado depois de a
--                                   reserva vencer), por item e sem parcialidade;
--   6. `create_order_delivery`    — cria a entrega e vincula as unidades,
--                                   validando produto e quantidade de cada item;
--   7. `internal_confirm_payment` — mecanismo INTERNO de confirmação de
--                                   pagamento para testes isolados: desligado por
--                                   padrão, só `service_role`, nunca chamado por
--                                   nenhuma Edge Function pública;
--   8. `apply_payment_status`     — redefinição preservando todo o comportamento
--                                   atual; a criação da entrega e a alocação
--                                   tardia passam a usar as funções por item.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Normalização dos itens
-- ---------------------------------------------------------------------------
-- Recebe o array cru enviado pelo backend (`[{product_id, quantity}, ...]`) e
-- devolve a mesma lista, validada, sem repetição de produto e ordenada por
-- `product_id`. A ordenação é o que garante que dois checkouts simultâneos
-- travem os produtos na MESMA ordem e não entrem em deadlock.
create or replace function public.parse_request_items(
  p_items jsonb,
  p_max_items integer default 10
)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_element jsonb;
  v_product_id uuid;
  v_quantity integer;
  v_seen uuid[] := '{}';
  v_accumulated jsonb := '[]'::jsonb;
  v_normalized jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_items' using errcode = '22023';
  end if;

  if jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > coalesce(p_max_items, 10) then
    raise exception 'invalid_items' using errcode = '22023';
  end if;

  for v_element in select e from jsonb_array_elements(p_items) as e loop
    if jsonb_typeof(v_element) <> 'object' then
      raise exception 'invalid_items' using errcode = '22023';
    end if;

    begin
      v_product_id := (v_element ->> 'product_id')::uuid;
      v_quantity := (v_element ->> 'quantity')::integer;
    exception
      when others then
        raise exception 'invalid_items' using errcode = '22023';
    end;

    if v_quantity is null or v_quantity < 1 then
      raise exception 'invalid_quantity' using errcode = '22023';
    end if;

    if v_product_id = any (v_seen) then
      raise exception 'duplicate_item' using errcode = '22023';
    end if;

    v_seen := v_seen || v_product_id;
    v_accumulated := v_accumulated || jsonb_build_array(
      jsonb_build_object('product_id', v_product_id, 'quantity', v_quantity)
    );
  end loop;

  select coalesce(jsonb_agg(entry order by (entry ->> 'product_id')), '[]'::jsonb)
    into v_normalized
  from jsonb_array_elements(v_accumulated) as entry;

  return v_normalized;
end;
$$;

comment on function public.parse_request_items(jsonb, integer) is
  'Valida e normaliza a lista de itens de um pedido: sem item repetido, quantidade >= 1, ordenada por product_id (ordem global de trava).';

-- ---------------------------------------------------------------------------
-- 2. Quantidade exigida por produto
-- ---------------------------------------------------------------------------
-- Pedidos novos têm `order_items`. Pedidos legados (criados por `create_order`)
-- não têm linha nenhuma: nesse caso a exigência é a do próprio pedido.
create or replace function public.order_required_units(p_order public.orders)
returns table (product_id uuid, product_name text, quantity integer, unit_price_cents integer)
language sql
stable
security definer
set search_path = 'public', 'pg_temp'
as $$
  select r.product_id, r.product_name, r.quantity, r.unit_price_cents
    from (
      select i.product_id, i.product_name,
             sum(i.quantity)::integer as quantity,
             max(i.unit_price_cents) as unit_price_cents
        from public.order_items i
       where i.order_id = p_order.id
       group by i.product_id, i.product_name
      union all
      select p_order.product_id, p_order.product_name,
             p_order.quantity, p_order.unit_price_cents
       where not exists (select 1 from public.order_items i where i.order_id = p_order.id)
    ) r
   order by r.product_id;
$$;

comment on function public.order_required_units(public.orders) is
  'Quantas unidades de cada produto o pedido exige. Pedido legado (sem order_items) devolve a própria linha do pedido.';

-- ---------------------------------------------------------------------------
-- 3. Itens do pedido em JSON (payload de retorno)
-- ---------------------------------------------------------------------------
create or replace function public.order_items_json(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = 'public', 'pg_temp'
as $$
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'product_id', i.product_id,
               'product_name', i.product_name,
               'product_slug', i.product_slug,
               'quantity', i.quantity,
               'unit_price_cents', i.unit_price_cents,
               'subtotal_cents', i.subtotal_cents
             )
             order by i.id
           ),
           '[]'::jsonb
         )
    from public.order_items i
   where i.order_id = p_order_id;
$$;

-- ---------------------------------------------------------------------------
-- 4. Reserva multi-item (UMA reserva por pedido)
-- ---------------------------------------------------------------------------
-- O índice `stock_reservations_one_active_per_order` permite apenas uma reserva
-- ativa por pedido. Por isso a reserva multi-item é UMA linha em
-- `stock_reservations` (quantity = soma das quantidades) com N linhas em
-- `stock_reservation_units` — uma por unidade física, de qualquer produto.
--
-- Atomicidade: qualquer item sem estoque levanta exceção e desfaz tudo — a
-- função nunca devolve estado parcial. Chamada de dentro de
-- `create_order_multi`, portanto faz parte da transação do pedido.
create or replace function public.reserve_stock_units_multi(
  p_order_id uuid,
  p_items jsonb,
  p_expires_at timestamp with time zone
)
returns uuid
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_entry jsonb;
  v_product_id uuid;
  v_quantity integer;
  v_total integer := 0;
  v_units uuid[];
  v_reservation_id uuid;
  v_updated integer;
  v_available integer;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'invalid_items' using errcode = '22023';
  end if;

  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'invalid_expiry' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.stock_reservations
     where order_id = p_order_id and status = 'active'
  ) then
    raise exception 'reservation_conflict'
      using errcode = 'P0001', detail = 'order already has an active reservation';
  end if;

  -- 1ª passada: trava os produtos em ordem crescente de id (ordem global) e
  -- confere a disponibilidade de TODOS os itens antes de tocar em qualquer
  -- unidade. Se um item não tiver estoque, nada foi alterado.
  for v_entry in
    select e from jsonb_array_elements(p_items) as e
     order by (e ->> 'product_id')
  loop
    v_product_id := (v_entry ->> 'product_id')::uuid;
    v_quantity := (v_entry ->> 'quantity')::integer;

    perform 1 from public.products where id = v_product_id for update;

    select count(*) into v_available
      from public.stock_units
     where product_id = v_product_id and status = 'available';

    if v_available < v_quantity then
      raise exception 'insufficient_stock'
        using errcode = 'P0001',
              detail = jsonb_build_object(
                         'product_id', v_product_id,
                         'requested', v_quantity,
                         'available', v_available
                       )::text;
    end if;

    v_total := v_total + v_quantity;
  end loop;

  insert into public.stock_reservations (order_id, status, quantity, starts_at, expires_at)
  values (p_order_id, 'active', v_total, now(), p_expires_at)
  returning id into v_reservation_id;

  -- 2ª passada: seleciona as unidades. `skip locked` não transforma contenção em
  -- erro: quem chega depois pega as unidades livres restantes.
  for v_entry in
    select e from jsonb_array_elements(p_items) as e
     order by (e ->> 'product_id')
  loop
    v_product_id := (v_entry ->> 'product_id')::uuid;
    v_quantity := (v_entry ->> 'quantity')::integer;

    select array_agg(id order by id) into v_units
    from (
      select id
        from public.stock_units
       where product_id = v_product_id
         and status = 'available'
       order by created_at, id
       limit v_quantity
       for update skip locked
    ) candidate;

    if v_units is null or array_length(v_units, 1) < v_quantity then
      raise exception 'insufficient_stock'
        using errcode = 'P0001',
              detail = jsonb_build_object(
                         'product_id', v_product_id,
                         'requested', v_quantity,
                         'available', coalesce(array_length(v_units, 1), 0)
                       )::text;
    end if;

    insert into public.stock_reservation_units (reservation_id, stock_unit_id)
    select v_reservation_id, unnest(v_units);

    update public.stock_units
       set status = 'reserved'
     where id = any (v_units) and status = 'available';
    get diagnostics v_updated = row_count;

    -- O índice único parcial em `stock_reservation_units` já impede a mesma
    -- unidade em duas reservas vivas; esta checagem cobre o caso de alguém ter
    -- marcado a unidade como vendida entre a leitura e a escrita.
    if v_updated <> v_quantity then
      raise exception 'reservation_conflict'
        using errcode = 'P0001',
              detail = format('product %s: expected %s units, updated %s',
                              v_product_id, v_quantity, v_updated);
    end if;
  end loop;

  return v_reservation_id;
end;
$$;

comment on function public.reserve_stock_units_multi(uuid, jsonb, timestamptz) is
  'Reserva uma unidade de estoque por item em UMA reserva do pedido. Atomica: falta de estoque em qualquer item desfaz tudo.';

-- ---------------------------------------------------------------------------
-- 5. Criação do pedido multi-produto
-- ---------------------------------------------------------------------------
-- Mesmo contrato de identidade do fluxo de cobrança (token privado do cliente +
-- chave de idempotência) e mesmo resultado: pedido `pending_payment` com
-- unidades já reservadas. A diferença é aceitar N produtos, com preço e
-- disponibilidade lidos SEMPRE do banco.
create or replace function public.create_order_multi(
  p_items jsonb,
  p_idempotency_key text,
  p_client_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_items jsonb;
  v_entry jsonb;
  v_product public.products;
  v_products public.products[] := '{}';
  v_quantities integer[] := '{}';
  v_first public.products;
  v_items_count integer := 0;
  v_total_quantity integer := 0;
  v_total_cents integer := 0;
  v_existing public.orders;
  v_order public.orders;
  v_reference text;
  v_attempt integer := 0;
  v_reservation_id uuid;
  v_reservation_minutes integer := public.setting_int('reservation_minutes', 30);
  v_max_quantity integer := public.setting_int('max_quantity_per_order', 20);
  v_max_items integer := public.setting_int('max_items_per_order', 10);
  v_payload jsonb;
begin
  if p_client_token_hash is null or p_client_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_client_token' using errcode = '22023';
  end if;

  if p_idempotency_key is not null and p_idempotency_key !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;

  v_items := public.parse_request_items(p_items, v_max_items);

  -- Replay idempotente: MESMA chave + MESMO token + MESMOS itens devolve o
  -- mesmo pedido. Qualquer divergência é conflito e não cria pedido novo.
  if p_idempotency_key is not null then
    select * into v_existing from public.orders where idempotency_key = p_idempotency_key;

    if found then
      if v_existing.client_token_hash <> p_client_token_hash then
        raise exception 'idempotency_conflict' using errcode = 'P0001';
      end if;

      if public.order_stored_items_json(v_existing.id) is distinct from v_items then
        raise exception 'idempotency_conflict' using errcode = 'P0001';
      end if;

      return public.order_summary_multi(v_existing) || jsonb_build_object('idempotent_replay', true);
    end if;
  end if;

  perform public.expire_overdue_reservations(null);

  -- Validação de cada item: existência, disponibilidade comercial, limites e
  -- preço vigente. Tudo em ordem de product_id (mesma ordem da reserva).
  for v_entry in select e from jsonb_array_elements(v_items) as e loop
    select * into v_product
      from public.products
     where id = (v_entry ->> 'product_id')::uuid
     for update;

    if not found then
      raise exception 'product_not_found'
        using errcode = 'P0002', detail = (v_entry ->> 'product_id');
    end if;

    if v_product.archived_at is not null then
      raise exception 'product_archived'
        using errcode = 'P0002', detail = (v_entry ->> 'product_id');
    end if;

    if not v_product.is_active then
      raise exception 'product_unavailable'
        using errcode = 'P0002', detail = (v_entry ->> 'product_id');
    end if;

    if (v_entry ->> 'quantity')::integer > v_product.max_quantity_per_order then
      raise exception 'quantity_above_product_limit'
        using errcode = '22023', detail = v_product.max_quantity_per_order::text;
    end if;

    v_total_quantity := v_total_quantity + (v_entry ->> 'quantity')::integer;
    v_total_cents := v_total_cents + (v_product.price_cents * (v_entry ->> 'quantity')::integer);

    if v_items_count = 0 then
      v_first := v_product;
    end if;

    v_items_count := v_items_count + 1;
    v_products := v_products || v_product;
    v_quantities := v_quantities || (v_entry ->> 'quantity')::integer;
  end loop;

  if v_total_quantity > v_max_quantity then
    raise exception 'quantity_above_product_limit'
      using errcode = '22023', detail = v_max_quantity::text;
  end if;

  -- Pedido + itens + reserva: uma transação. Se a reserva falhar (estoque
  -- insuficiente sob concorrência), o pedido e os itens também não existem.
  loop
    v_attempt := v_attempt + 1;
    v_reference := public.generate_order_reference();
    begin
      insert into public.orders (
        reference, product_id, product_name, quantity,
        unit_price_cents, total_cents, status, payment_status, delivery_status,
        client_token_hash, idempotency_key, reservation_expires_at, items_count
      )
      values (
        v_reference, v_first.id, v_first.name, v_total_quantity,
        v_first.price_cents, v_total_cents,
        'pending_payment', 'pending', 'not_ready',
        p_client_token_hash, p_idempotency_key,
        now() + make_interval(mins => v_reservation_minutes),
        v_items_count
      )
      returning * into v_order;
      exit;
    exception
      when unique_violation then
        if p_idempotency_key is not null then
          select * into v_existing from public.orders where idempotency_key = p_idempotency_key;
          if found then
            if v_existing.client_token_hash <> p_client_token_hash
               or public.order_stored_items_json(v_existing.id) is distinct from v_items then
              raise exception 'idempotency_conflict' using errcode = 'P0001';
            end if;
            return public.order_summary_multi(v_existing) || jsonb_build_object('idempotent_replay', true);
          end if;
        end if;

        if v_attempt >= 5 then
          raise;
        end if;
    end;
  end loop;

  insert into public.order_items (
    order_id, product_id, product_name, product_slug,
    quantity, unit_price_cents, subtotal_cents
  )
  select
    v_order.id,
    p.id,
    p.name,
    p.slug,
    (e ->> 'quantity')::integer,
    p.price_cents,
    p.price_cents * (e ->> 'quantity')::integer
  from jsonb_array_elements(v_items) as e
  join public.products p on p.id = (e ->> 'product_id')::uuid;

  if (select sum(subtotal_cents) from public.order_items where order_id = v_order.id)
     is distinct from v_order.total_cents then
    raise exception 'order_total_mismatch' using errcode = 'P0001';
  end if;

  if (select count(*) from public.order_items where order_id = v_order.id) <> v_items_count then
    raise exception 'order_items_mismatch' using errcode = 'P0001';
  end if;

  v_reservation_id := public.reserve_stock_units_multi(
    v_order.id, v_items, v_order.reservation_expires_at
  );

  insert into public.order_events (order_id, event_type, actor, metadata)
  values (
    v_order.id,
    'order_created',
    'customer',
    jsonb_build_object(
      'reservation_id', v_reservation_id,
      'items_count', v_items_count,
      'quantity', v_total_quantity,
      'total_cents', v_total_cents,
      'reservation_expires_at', v_order.reservation_expires_at,
      'multi_item', v_items_count > 1,
      'idempotent', p_idempotency_key is not null
    )
  );

  v_payload := public.order_summary_multi(v_order);
  return v_payload || jsonb_build_object('idempotent_replay', false);
end;
$$;

comment on function public.create_order_multi(jsonb, text, text) is
  'Cria pedido com varios produtos, registra os itens com o preco do banco e reserva todas as unidades em uma unica transacao.';

-- JSON canônico dos itens gravados (usado para comparar replay de idempotência).
create or replace function public.order_stored_items_json(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = 'public', 'pg_temp'
as $$
  select coalesce(
           jsonb_agg(
             jsonb_build_object('product_id', i.product_id, 'quantity', i.quantity)
             order by i.product_id
           ),
           '[]'::jsonb
         )
    from public.order_items i
   where i.order_id = p_order_id;
$$;

-- Resumo do pedido multi-item (mesmo formato de `create_order` + itens).
create or replace function public.order_summary_multi(p_order public.orders)
returns jsonb
language sql
stable
security definer
set search_path = 'public', 'pg_temp'
as $$
  select jsonb_build_object(
    'order_id', p_order.id,
    'reference', p_order.reference,
    'status', p_order.status,
    'payment_status', p_order.payment_status,
    'delivery_status', p_order.delivery_status,
    'items_count', p_order.items_count,
    'quantity', p_order.quantity,
    'unit_price_cents', p_order.unit_price_cents,
    'total_cents', p_order.total_cents,
    'reservation_expires_at', p_order.reservation_expires_at,
    'created_at', p_order.created_at,
    'product', jsonb_build_object(
      'id', p_order.product_id,
      'name', p_order.product_name
    ),
    'items', public.order_items_json(p_order.id)
  );
$$;

-- ---------------------------------------------------------------------------
-- 6. Alocação tardia por item
-- ---------------------------------------------------------------------------
-- Caminho: PIX aprovado depois de a reserva vencer. Antes de vender qualquer
-- unidade, confere se TODOS os itens têm estoque; faltando um, devolve null e
-- quem chamou decide (hoje: pedido vai para `refund_pending` com reembolso).
create or replace function public.allocate_late_units_multi(
  p_order_id uuid,
  p_items jsonb
)
returns uuid[]
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_entry jsonb;
  v_product_id uuid;
  v_quantity integer;
  v_available integer;
  v_total integer := 0;
  v_units uuid[] := '{}';
  v_item_units uuid[];
  v_reservation_id uuid;
  v_updated integer;
  v_collected jsonb := '[]'::jsonb;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    return null;
  end if;

  -- Passada 1: trava os produtos e confere estoque de todo mundo.
  for v_entry in select e from jsonb_array_elements(p_items) as e order by (e ->> 'product_id') loop
    v_product_id := (v_entry ->> 'product_id')::uuid;
    v_quantity := (v_entry ->> 'quantity')::integer;

    perform 1 from public.products where id = v_product_id for update;

    select count(*) into v_available
      from public.stock_units
     where product_id = v_product_id and status = 'available';

    if v_available < v_quantity then
      return null;
    end if;

    v_total := v_total + v_quantity;
  end loop;

  -- Passada 2: seleciona e vende. Qualquer divergência aborta a transação
  -- inteira (inclusive as vendas já feitas).
  for v_entry in select e from jsonb_array_elements(p_items) as e order by (e ->> 'product_id') loop
    v_product_id := (v_entry ->> 'product_id')::uuid;
    v_quantity := (v_entry ->> 'quantity')::integer;

    select array_agg(id order by id) into v_item_units
    from (
      select id
        from public.stock_units
       where product_id = v_product_id
         and status = 'available'
       order by created_at, id
       limit v_quantity
       for update skip locked
    ) candidate;

    if v_item_units is null or array_length(v_item_units, 1) < v_quantity then
      raise exception 'late_allocation_conflict'
        using errcode = 'P0001',
              detail = format('product %s: expected %s units', v_product_id, v_quantity);
    end if;

    v_units := v_units || v_item_units;
    v_collected := v_collected || jsonb_build_array(
      jsonb_build_object('product_id', v_product_id, 'units', to_jsonb(v_item_units))
    );
  end loop;

  -- Reserva nasce consumida: não existe mais janela de pagamento.
  insert into public.stock_reservations (order_id, status, quantity, starts_at, expires_at, ended_at)
  values (p_order_id, 'consumed', v_total, now() - interval '1 minute', now(), now())
  returning id into v_reservation_id;

  insert into public.stock_reservation_units (reservation_id, stock_unit_id)
  select v_reservation_id, unnest(v_units);

  update public.stock_units
     set status = 'sold', sold_order_id = p_order_id, sold_at = now()
   where id = any (v_units) and status = 'available';
  get diagnostics v_updated = row_count;

  if v_updated <> v_total then
    raise exception 'late_allocation_conflict'
      using errcode = 'P0001',
            detail = format('expected %s units, updated %s', v_total, v_updated);
  end if;

  return v_units;
end;
$$;

-- Despacho: pedido legado usa `allocate_late_units` (comportamento aprovado);
-- pedido com itens usa a versão por item.
create or replace function public.allocate_late_units_for_order(p_order_id uuid)
returns uuid[]
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_order public.orders;
  v_items jsonb;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    return null;
  end if;

  select coalesce(
           jsonb_agg(jsonb_build_object('product_id', r.product_id, 'quantity', r.quantity)
                     order by r.product_id),
           '[]'::jsonb
         )
    into v_items
  from public.order_required_units(v_order) r;

  if jsonb_array_length(v_items) = 0 then
    return null;
  end if;

  if jsonb_array_length(v_items) = 1
     and not exists (select 1 from public.order_items where order_id = p_order_id) then
    return public.allocate_late_units(
      p_order_id,
      v_order.product_id,
      v_order.quantity
    );
  end if;

  return public.allocate_late_units_multi(p_order_id, v_items);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Entrega do pedido (vínculo unidade ↔ item)
-- ---------------------------------------------------------------------------
-- Uma única entrega por pedido (`deliveries_order_id_key`). Cada unidade vendida
-- é vinculada, e o vínculo só é aceito se a unidade pertence a um produto do
-- pedido e a soma das quantidades fechar exatamente com o que cada item exige.
-- Unidade já entregue em outro pedido não entra (`delivery_units_unique_unit`).
create or replace function public.create_order_delivery(
  p_order_id uuid,
  p_delivery_token_hash text,
  p_delivery_token_enc_b64 text
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_order public.orders;
  v_delivery public.deliveries;
  v_required record;
  v_expected integer;
  v_inserted integer;
  v_missing integer;
  v_groups jsonb;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  -- Idempotência: pedido já entregue devolve a mesma entrega, nunca uma segunda.
  select * into v_delivery from public.deliveries where order_id = p_order_id;
  if found then
    return jsonb_build_object(
      'delivery_id', v_delivery.id,
      'status', v_delivery.status,
      'created', false,
      'items', public.delivery_items_json(v_delivery.id)
    );
  end if;

  if p_delivery_token_hash is null or p_delivery_token_enc_b64 is null then
    raise exception 'delivery_token_required' using errcode = '22023';
  end if;

  if p_delivery_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_delivery_token_hash' using errcode = '22023';
  end if;

  if v_order.status <> 'paid'
     or v_order.payment_status <> 'approved'
     or v_order.delivery_status <> 'ready' then
    raise exception 'order_not_deliverable'
      using errcode = 'P0001', detail = v_order.status::text;
  end if;

  insert into public.deliveries (order_id, token_hash, token_enc)
  values (p_order_id, p_delivery_token_hash, decode(p_delivery_token_enc_b64, 'base64'))
  returning * into v_delivery;

  -- Só entram unidades efetivamente vendidas para ESTE pedido.
  insert into public.delivery_units (delivery_id, stock_unit_id)
  select v_delivery.id, su.id
    from public.stock_units su
   where su.sold_order_id = p_order_id
     and su.status = 'sold'
  on conflict do nothing;

  get diagnostics v_inserted = row_count;

  -- Validação por item: nenhum item pode ficar descoberto.
  for v_required in select * from public.order_required_units(v_order) loop
    v_expected := v_required.quantity;

    select count(*) into v_missing
      from public.delivery_units du
      join public.stock_units su on su.id = du.stock_unit_id
     where du.delivery_id = v_delivery.id
       and su.product_id = v_required.product_id;

    if v_missing <> v_expected then
      raise exception 'delivery_incomplete'
        using errcode = 'P0001',
              detail = jsonb_build_object(
                         'product_id', v_required.product_id,
                         'expected', v_expected,
                         'delivered', v_missing
                       )::text;
    end if;
  end loop;

  -- Nenhuma unidade de outro produto pode ter entrado na entrega.
  if exists (
    select 1
      from public.delivery_units du
      join public.stock_units su on su.id = du.stock_unit_id
     where du.delivery_id = v_delivery.id
       and su.product_id not in (
         select r.product_id from public.order_required_units(v_order) r
       )
  ) then
    raise exception 'delivery_foreign_unit' using errcode = 'P0001';
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object('product_id', r.product_id, 'quantity', r.quantity)
             order by r.product_id
           ),
           '[]'::jsonb
         )
    into v_groups
  from public.order_required_units(v_order) r;

  insert into public.order_events (order_id, event_type, actor, metadata)
  values (p_order_id, 'delivery_created', 'system',
          jsonb_build_object(
            'delivery_id', v_delivery.id,
            'units', v_inserted,
            'items', v_groups
          ));

  return jsonb_build_object(
    'delivery_id', v_delivery.id,
    'status', v_delivery.status,
    'created', true,
    'items', public.delivery_items_json(v_delivery.id)
  );
end;
$$;

-- Itens de uma entrega: um grupo por produto, com as unidades daquele produto.
-- Pedido legado (sem `order_items`) produz um único grupo.
-- Guarda de acesso: a função devolve ciphertext de credencial, então ela própria
-- recusa entrega inexistente, revogada ou de pedido não pago. Quem chama não
-- consegue usar o helper para contornar a checagem de estado de `resolve_delivery`.
create or replace function public.delivery_items_json(p_delivery_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_delivery public.deliveries;
  v_order public.orders;
  v_result jsonb;
begin
  if p_delivery_id is null then
    raise exception 'delivery_not_found' using errcode = 'P0002';
  end if;

  select * into v_delivery from public.deliveries where id = p_delivery_id;
  if not found then
    raise exception 'delivery_not_found' using errcode = 'P0002';
  end if;

  if v_delivery.status = 'revoked' then
    raise exception 'delivery_revoked' using errcode = 'P0002';
  end if;

  select * into v_order from public.orders where id = v_delivery.order_id;
  if not found
     or v_order.status <> 'paid'
     or v_order.payment_status <> 'approved'
     or v_order.delivery_status <> 'ready' then
    raise exception 'delivery_unavailable' using errcode = 'P0002';
  end if;

  select coalesce(
           jsonb_agg(group_json order by product_name, product_id),
           '[]'::jsonb
         )
    from (
      select
        su.product_id,
        coalesce(oi.product_name, p.name) as product_name,
        jsonb_build_object(
          'product_id', su.product_id,
          'product_name', coalesce(oi.product_name, p.name),
          'product_slug', coalesce(oi.product_slug, p.slug),
          'instructions', p.instructions,
          'access_validity_label', p.access_validity_label,
          'access_validity_days', p.access_validity_days,
          'quantity', count(*),
          'units', jsonb_agg(
                     jsonb_build_object(
                       'stock_unit_id', su.id,
                       'email_enc', encode(su.account_email_enc, 'base64'),
                       'password_enc', encode(su.account_password_enc, 'base64'),
                       'notes', su.notes
                     )
                     order by su.created_at, su.id
                   )
        ) as group_json
      from public.delivery_units du
      join public.stock_units su on su.id = du.stock_unit_id
      join public.deliveries d on d.id = du.delivery_id
      join public.orders o on o.id = d.order_id
      join public.products p on p.id = su.product_id
      left join public.order_items oi
             on oi.order_id = o.id and oi.product_id = su.product_id
     where du.delivery_id = p_delivery_id
     group by su.product_id, oi.product_name, oi.product_slug, p.name, p.slug,
              p.instructions, p.access_validity_label, p.access_validity_days
    ) grouped
    into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Confirmação interna de pagamento (mecanismo isolado)
-- ---------------------------------------------------------------------------
-- Existe para a validação automatizada do processamento pago sem provedor
-- financeiro. Proteções, todas obrigatórias:
--   * desligada por padrão (`internal_confirmation_enabled = false`);
--   * `service_role` apenas (revogada de public/anon/authenticated);
--   * exige o token privado do cliente (prova de posse do pedido);
--   * só age em pedido `pending_payment`;
--   * NÃO é chamada por nenhuma Edge Function — não existe rota pública.
create or replace function public.internal_confirm_payment(
  p_order_id uuid,
  p_client_token_hash text,
  p_delivery_token_hash text,
  p_delivery_token_enc_b64 text
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_order public.orders;
  v_enabled boolean := coalesce(
    (select value = 'true'::jsonb from public.app_settings
      where key = 'internal_confirmation_enabled'), false
  );
  v_result jsonb;
begin
  if not v_enabled then
    raise exception 'internal_confirmation_disabled' using errcode = 'P0001';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;

  -- Sem prova de posse, o pedido não existe (não vaza existência).
  if not found
     or p_client_token_hash is null
     or v_order.client_token_hash is distinct from p_client_token_hash then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  if v_order.status <> 'pending_payment' then
    raise exception 'order_not_pending'
      using errcode = 'P0001', detail = v_order.status::text;
  end if;

  if v_order.reservation_expires_at <= now() then
    raise exception 'reservation_expired' using errcode = 'P0001';
  end if;

  if p_delivery_token_hash is null or p_delivery_token_enc_b64 is null then
    raise exception 'delivery_token_required' using errcode = '22023';
  end if;

  v_result := public.apply_payment_status(
    p_order_id,
    'INTERNAL-' || v_order.reference,
    'approved',
    'internal_confirmation',
    v_order.total_cents,
    p_delivery_token_hash,
    p_delivery_token_enc_b64
  );

  update public.payments
     set provider = 'internal'
   where order_id = p_order_id
     and provider_payment_id = 'INTERNAL-' || v_order.reference;

  insert into public.order_events (order_id, event_type, actor, metadata)
  values (p_order_id, 'internal_payment_confirmed', 'system',
          jsonb_build_object('result', v_result));

  return v_result || jsonb_build_object('internal', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Ajustes estruturais exigidos pelo fluxo multi-item
-- ---------------------------------------------------------------------------

-- O teto de unidades por pedido agora é a soma dos itens: um carrinho de 10
-- produtos pode legitimamente passar de 20 unidades. `order_items` já limita
-- cada linha a 1..20 e `max_quantity_per_order` segue valendo por produto.
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.stock_reservations'::regclass
       and conname = 'stock_reservations_quantity_check'
  ) then
    alter table public.stock_reservations
      drop constraint stock_reservations_quantity_check;
  end if;

  alter table public.stock_reservations
    add constraint stock_reservations_quantity_check check (quantity between 1 and 200);
end
$$;

-- Reserva tardia nasce com `starts_at = now()` e `ended_at = now()`: a janela
-- continua válida, mas positiva (o CHECK exige expires_at > starts_at).
create or replace function public.allocate_late_units(p_order_id uuid, p_product_id uuid, p_quantity integer)
returns uuid[]
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_units uuid[];
  v_reservation_id uuid;
  v_updated integer;
begin
  perform 1 from public.products where id = p_product_id for update;

  select array_agg(id order by id) into v_units
  from (
    select id
    from public.stock_units
    where product_id = p_product_id
      and status = 'available'
    order by created_at, id
    limit p_quantity
    for update skip locked
  ) candidate;

  if v_units is null or array_length(v_units, 1) < p_quantity then
    return null;
  end if;

  -- Reserva já nasce consumida: não há janela de pagamento restante.
  insert into public.stock_reservations (order_id, status, quantity, starts_at, expires_at, ended_at)
  values (p_order_id, 'consumed', p_quantity, now() - interval '1 minute', now(), now())
  returning id into v_reservation_id;

  insert into public.stock_reservation_units (reservation_id, stock_unit_id)
  select v_reservation_id, unnest(v_units);

  update public.stock_units
     set status = 'sold', sold_order_id = p_order_id, sold_at = now()
   where id = any (v_units)
     and status = 'available';
  get diagnostics v_updated = row_count;

  if v_updated <> p_quantity then
    raise exception 'late_allocation_conflict'
      using errcode = 'P0001',
            detail = format('expected %s units, updated %s', p_quantity, v_updated);
  end if;

  return v_units;
end;
$$;

-- Provider da confirmação interna. A lista é fechada (não é texto livre) e
-- `internal` não é usado por nenhum provedor financeiro.
alter table public.payments drop constraint if exists payments_provider_check;
alter table public.payments
  add constraint payments_provider_check
  check (provider in ('mercado_pago', 'demo', 'internal'));

-- `quantity` do pedido é o total de unidades: passa de 20 em carrinhos grandes.
alter table public.orders drop constraint if exists orders_quantity_check;
alter table public.orders
  add constraint orders_quantity_check check (quantity between 1 and 200);

alter table public.app_settings
  add column if not exists updated_at timestamptz not null default now();

insert into public.app_settings (key, value, description)
values ('max_items_per_order', '10'::jsonb,
        'Teto de produtos distintos por pedido.')
on conflict (key) do nothing;

insert into public.app_settings (key, value, description)
values ('internal_confirmation_enabled', 'false'::jsonb,
        'Habilita a confirmacao INTERNA de pagamento (somente testes isolados). Nunca ligar em producao.')
on conflict (key) do nothing;

revoke all on function public.parse_request_items(jsonb, integer) from public;
revoke all on function public.order_required_units(public.orders) from public;
revoke all on function public.order_items_json(uuid) from public;
revoke all on function public.order_stored_items_json(uuid) from public;
revoke all on function public.order_summary_multi(public.orders) from public;
revoke all on function public.reserve_stock_units_multi(uuid, jsonb, timestamptz) from public;
revoke all on function public.create_order_multi(jsonb, text, text) from public;
revoke all on function public.allocate_late_units_multi(uuid, jsonb) from public;
revoke all on function public.allocate_late_units_for_order(uuid) from public;
revoke all on function public.create_order_delivery(uuid, text, text) from public;
revoke all on function public.delivery_items_json(uuid) from public;
revoke all on function public.internal_confirm_payment(uuid, text, text, text) from public;

do $$
declare
  v_role text;
  v_signature text;
  v_signatures text[] := array[
    'public.parse_request_items(jsonb, integer)',
    'public.order_required_units(public.orders)',
    'public.order_items_json(uuid)',
    'public.order_stored_items_json(uuid)',
    'public.order_summary_multi(public.orders)',
    'public.reserve_stock_units_multi(uuid, jsonb, timestamptz)',
    'public.create_order_multi(jsonb, text, text)',
    'public.allocate_late_units_multi(uuid, jsonb)',
    'public.allocate_late_units_for_order(uuid)',
    'public.create_order_delivery(uuid, text, text)',
    'public.delivery_items_json(uuid)',
    'public.internal_confirm_payment(uuid, text, text, text)'
  ];
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      for v_signature in select unnest(v_signatures) loop
        execute format('revoke all on function %s from %I', v_signature, v_role);
      end loop;
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    for v_signature in select unnest(v_signatures) loop
      execute format('grant execute on function %s to service_role', v_signature);
    end loop;
  end if;
end
$$;

comment on function public.internal_confirm_payment(uuid, text, text, text) is
  'Confirmacao INTERNA de pagamento para testes isolados: desligada por padrao, apenas service_role, exige token privado do cliente, sem rota publica.';
