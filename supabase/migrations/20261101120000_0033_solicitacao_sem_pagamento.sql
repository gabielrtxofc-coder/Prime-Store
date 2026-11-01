-- ============================================================================
-- 0033 — SOLICITAÇÃO DE PEDIDO SEM PAGAMENTO (missão 08)
-- ============================================================================
-- Contexto: a loja passa a registrar a SOLICITAÇÃO de compra do visitante sem
-- qualquer integração financeira. O fluxo de cobrança existente (create_order,
-- payments, Mercado Pago, modo demonstrativo) NÃO é alterado: continua íntegro
-- para a fase seguinte.
--
-- O modelo atual de `orders` descreve UM produto por pedido
-- (`product_id`, `quantity`, `unit_price_cents`, `total_cents` com CHECK
-- `total_cents = unit_price_cents * quantity`). Um carrinho real tem vários
-- itens, então:
--
--   * `order_items` guarda uma linha por produto, com o preço unitário vigente
--     no momento do registro (fonte de verdade para o valor da solicitação);
--   * `orders` continua com o resumo (quantidade total e total em centavos), e
--     o CHECK de coerência passa a admitir pedidos de vários itens
--     (`items_count > 1`), mantendo a regra exata para pedido de item único.
--
-- Estados:
--   * `order_status.requested`  — solicitação recebida, aguardando confirmação
--                                 (não existe cobrança nem venda);
--   * `payment_status.not_required` — nenhum pagamento se aplica.
--
-- Estoque: a solicitação NÃO reserva e NÃO baixa unidades. A disponibilidade é
-- conferida no ato do registro (e o pedido guarda a quantidade pedida), porque
-- não há confirmação comercial nesta fase — reservar por tempo faria a
-- solicitação "expirar" sozinha pelo agendador da migração 0031. Nenhuma venda
-- é registrada: `paid_at` continua nulo e `delivery_status` continua `not_ready`.
--
-- Privacidade: nome e e-mail do solicitante ficam em `orders.buyer_name` /
-- `orders.buyer_email`, protegidos por RLS (nenhum GRANT para anon/authenticated)
-- e só são devolvidos por `get_order_status`, que exige o token privado.

-- ---------------------------------------------------------------------------
-- 1. Estados novos
-- ---------------------------------------------------------------------------
-- `alter type ... add value` é seguro no PostgreSQL 12+; os valores passam a ser
-- usados apenas em tempo de execução (nenhum default/DML nesta migração usa os
-- rótulos novos, o que seria proibido na mesma transação).
alter type public.order_status add value if not exists 'requested';
alter type public.payment_status add value if not exists 'not_required';

-- ---------------------------------------------------------------------------
-- 2. Contato do solicitante (somente o fluxo sem pagamento preenche)
-- ---------------------------------------------------------------------------
alter table public.orders add column if not exists buyer_name text;
alter table public.orders add column if not exists buyer_email text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.orders'::regclass and conname = 'orders_buyer_name_check'
  ) then
    alter table public.orders
      add constraint orders_buyer_name_check check (buyer_name is null or length(btrim(buyer_name)) between 2 and 120);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.orders'::regclass and conname = 'orders_buyer_email_check'
  ) then
    alter table public.orders
      add constraint orders_buyer_email_check check (buyer_email is null or buyer_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');
  end if;
end
$$;

comment on column public.orders.buyer_name is
  'Nome informado pelo solicitante no fluxo sem pagamento. Dado pessoal: RLS ligada, sem acesso publico.';

-- ---------------------------------------------------------------------------
-- 3. Itens da solicitação
-- ---------------------------------------------------------------------------
alter table public.orders add column if not exists items_count integer not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.orders'::regclass and conname = 'orders_items_count_check'
  ) then
    alter table public.orders
      add constraint orders_items_count_check check (items_count between 1 and 20);
  end if;
end
$$;

-- A igualdade total = unitário × quantidade continua obrigatória para pedidos de
-- um item (fluxo de cobrança, inalterado). Para vários itens, o valor correto é
-- a soma de `order_items.subtotal_cents`, verificada pela função de criação.
alter table public.orders drop constraint if exists orders_total_matches_unit_price;
alter table public.orders
  add constraint orders_total_matches_unit_price
  check (total_cents = unit_price_cents * quantity or items_count > 1);

create table if not exists public.order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  product_name text not null,
  product_slug text not null,
  quantity integer not null,
  unit_price_cents integer not null,
  subtotal_cents integer not null,
  created_at timestamptz not null default now(),
  constraint order_items_quantity_check check (quantity between 1 and 20),
  constraint order_items_unit_price_check check (unit_price_cents > 0),
  constraint order_items_subtotal_check check (subtotal_cents = unit_price_cents * quantity),
  constraint order_items_name_check check (length(btrim(product_name)) between 1 and 200),
  constraint order_items_slug_check check (length(btrim(product_slug)) between 1 and 200),
  constraint order_items_unique_product unique (order_id, product_id)
);

comment on table public.order_items is
  'Itens de uma solicitacao de pedido (um por produto), com o preco unitario vigente no registro. Tabela interna: RLS ligada, sem politicas, apenas service_role.';

create index if not exists order_items_order_idx on public.order_items (order_id);

alter table public.order_items enable row level security;

revoke all on public.order_items from public;
do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on public.order_items from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert on public.order_items to service_role';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Registro da solicitação
-- ---------------------------------------------------------------------------
create or replace function public.create_purchase_request(
  p_items jsonb,
  p_buyer_name text,
  p_buyer_email text,
  p_client_token_hash text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_product public.products;
  v_product_id uuid;
  v_quantity integer;
  v_items_count integer := 0;
  v_total_quantity integer := 0;
  v_total_cents integer := 0;
  v_first_product public.products;
  v_first_unit_price integer;
  v_available integer;
  v_order public.orders;
  v_reference text;
  v_attempt integer := 0;
  v_max_quantity integer := public.setting_int('max_quantity_per_order', 20);
  v_max_items constant integer := 10;
  v_result jsonb;
begin
  -- 1. Identidade da solicitação (mesmo contrato do fluxo de cobrança).
  if p_client_token_hash is null or p_client_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_client_token' using errcode = '22023';
  end if;

  if p_idempotency_key is not null
     and (length(p_idempotency_key) < 8 or length(p_idempotency_key) > 128) then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;

  if p_buyer_name is null or length(btrim(p_buyer_name)) < 2 then
    raise exception 'invalid_buyer_name' using errcode = '22023';
  end if;

  if p_buyer_email is null or p_buyer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_buyer_email' using errcode = '22023';
  end if;

  -- 2. Forma dos itens: 1..10 produtos distintos, quantidade dentro do limite.
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_items' using errcode = '22023';
  end if;

  if jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > v_max_items then
    raise exception 'invalid_items' using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_items) as e
     group by (e ->> 'product_id')
    having count(*) > 1
  ) then
    raise exception 'duplicate_item' using errcode = '22023';
  end if;

  -- 3. Replay idempotente: mesma chave devolve a mesma solicitação (e rotaciona
  -- o token de consulta, como no fluxo de cobrança — quem tem a chave já podia
  -- consultar aquele pedido).
  if p_idempotency_key is not null then
    select * into v_order from public.orders where idempotency_key = p_idempotency_key;
    if found then
      if v_order.client_token_hash <> p_client_token_hash then
        update public.orders
           set client_token_hash = p_client_token_hash
         where id = v_order.id
         returning * into v_order;
      end if;

      return jsonb_build_object(
        'order', public.purchase_request_summary(v_order),
        'idempotent_replay', true
      );
    end if;
  end if;

  -- 4. Preços e disponibilidade SEMPRE vêm do banco. Percorre os itens em ordem
  -- de id para que dois checkouts simultâneos não se bloqueiem em ordens opostas.
  for v_item in
    select e
      from jsonb_array_elements(p_items) as e
     order by (e ->> 'product_id')
  loop
    begin
      v_product_id := (v_item ->> 'product_id')::uuid;
      v_quantity := coalesce((v_item ->> 'quantity')::integer, 0);
    exception
      when others then
        raise exception 'invalid_items' using errcode = '22023';
    end;

    if v_quantity < 1 then
      raise exception 'invalid_quantity' using errcode = '22023';
    end if;

    select * into v_product from public.products where id = v_product_id for update;

    if not found or v_product.archived_at is not null or not v_product.is_active then
      raise exception 'product_unavailable' using errcode = 'P0002';
    end if;

    if v_quantity > v_product.max_quantity_per_order then
      raise exception 'quantity_above_product_limit'
        using errcode = '22023',
              detail = v_product.max_quantity_per_order::text;
    end if;

    v_total_quantity := v_total_quantity + v_quantity;

    if v_total_quantity > v_max_quantity then
      raise exception 'quantity_above_product_limit'
        using errcode = '22023',
              detail = v_max_quantity::text;
    end if;

    if v_items_count = 0 then
      v_first_product := v_product;
      v_first_unit_price := v_product.price_cents;
    end if;

    v_items_count := v_items_count + 1;
    v_total_cents := v_total_cents + (v_product.price_cents * v_quantity);
  end loop;

  -- 5. Disponibilidade conferida no ato do registro (sem reservar nada).
  perform public.expire_overdue_reservations(null);

  for v_item in select e from jsonb_array_elements(p_items) as e
  loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;

    select count(*) into v_available
      from public.stock_units
     where product_id = v_product_id and status = 'available';

    if v_available < v_quantity then
      raise exception 'insufficient_stock'
        using errcode = 'P0001',
              detail = v_available::text;
    end if;
  end loop;

  -- 6. Cria o pedido. `quantity`/`unit_price_cents` guardam o resumo; o valor
  -- oficial de cada item está em `order_items`.
  loop
    v_attempt := v_attempt + 1;
    v_reference := public.generate_order_reference();
    begin
      insert into public.orders (
        reference, product_id, product_name, quantity,
        unit_price_cents, total_cents, status, payment_status, delivery_status,
        client_token_hash, idempotency_key, reservation_expires_at,
        buyer_name, buyer_email, items_count
      )
      values (
        v_reference, v_first_product.id, v_first_product.name, v_total_quantity,
        v_first_unit_price, v_total_cents, 'requested', 'not_required', 'not_ready',
        p_client_token_hash, p_idempotency_key, now(),
        btrim(p_buyer_name), btrim(p_buyer_email), v_items_count
      )
      returning * into v_order;
      exit;
    exception
      when unique_violation then
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
  from jsonb_array_elements(p_items) as e
  join public.products p on p.id = (e ->> 'product_id')::uuid;

  -- 7. O valor do pedido precisa ser exatamente a soma dos itens registrados.
  if (select sum(subtotal_cents) from public.order_items where order_id = v_order.id) is distinct from v_order.total_cents then
    raise exception 'order_total_mismatch' using errcode = 'P0001';
  end if;

  insert into public.order_events (order_id, event_type, actor, metadata)
  values (
    v_order.id,
    'request_created',
    'customer',
    jsonb_build_object(
      'items_count', v_items_count,
      'total_quantity', v_total_quantity,
      'payment_required', false
    )
  );

  v_result := jsonb_build_object(
    'order', public.purchase_request_summary(v_order),
    'idempotent_replay', false
  );
  return v_result;
end;
$$;

comment on function public.create_purchase_request(jsonb, text, text, text, text) is
  'Registra a solicitacao de compra de um carrinho sem nenhuma cobranca: valida itens, precos e disponibilidade no banco, grava orders (status requested / payment not_required) e order_items. Nao reserva estoque, nao cria pagamento e nao libera entrega.';

-- ---------------------------------------------------------------------------
-- 5. Resumo reutilizável (usado na criação e no replay)
-- ---------------------------------------------------------------------------
create or replace function public.purchase_request_summary(p_order public.orders)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
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
    'buyer_name', p_order.buyer_name,
    'created_at', p_order.created_at,
    'items', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'product_id', i.product_id,
                 'product_name', i.product_name,
                 'product_slug', i.product_slug,
                 'quantity', i.quantity,
                 'unit_price_cents', i.unit_price_cents,
                 'subtotal_cents', i.subtotal_cents
               )
               order by i.id
             )
        from public.order_items i
       where i.order_id = p_order.id
    ), '[]'::jsonb)
  );
$$;

comment on function public.purchase_request_summary(public.orders) is
  'Resumo da solicitacao (pedido + itens) no formato consumido pela Edge Function order-request.';

-- ---------------------------------------------------------------------------
-- 6. Acompanhamento: itens e nome do solicitante no estado do pedido
--    (redefinição de 0028 preservando todos os campos existentes; apenas
--     adiciona items_count, buyer_name e items)
-- ---------------------------------------------------------------------------
create or replace function public.get_order_status(
  p_order_id uuid,
  p_client_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_payment public.payments;
  v_delivery public.deliveries;
  v_product public.products;
  v_units_available integer;
begin
  if p_order_id is null or p_client_token_hash is null then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and client_token_hash = p_client_token_hash;

  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  perform public.expire_overdue_reservations(v_order.product_id);

  select * into v_order from public.orders where id = p_order_id;

  select * into v_payment
  from public.payments
  where order_id = v_order.id
  order by created_at desc
  limit 1;

  select * into v_delivery from public.deliveries where order_id = v_order.id;

  select * into v_product from public.products where id = v_order.product_id;

  select count(*) into v_units_available
  from public.stock_units
  where product_id = v_order.product_id and status = 'available';

  return jsonb_build_object(
    'order_id', v_order.id,
    'reference', v_order.reference,
    'status', v_order.status,
    'payment_status', v_order.payment_status,
    'delivery_status', v_order.delivery_status,
    'quantity', v_order.quantity,
    'unit_price_cents', v_order.unit_price_cents,
    'total_cents', v_order.total_cents,
    'created_at', v_order.created_at,
    'paid_at', v_order.paid_at,
    'reservation_expires_at', v_order.reservation_expires_at,
    -- Solicitação sem pagamento: itens e contato do solicitante. Nulos/vazios
    -- nos pedidos criados pelo fluxo de cobrança.
    'items_count', v_order.items_count,
    'buyer_name', v_order.buyer_name,
    'items', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'product_id', i.product_id,
                 'product_name', i.product_name,
                 'product_slug', i.product_slug,
                 'quantity', i.quantity,
                 'unit_price_cents', i.unit_price_cents,
                 'subtotal_cents', i.subtotal_cents
               )
               order by i.id
             )
        from public.order_items i
       where i.order_id = v_order.id
    ), '[]'::jsonb),
    'product', jsonb_build_object(
      'id', v_product.id,
      'slug', v_product.slug,
      'name', v_product.name,
      'instructions', v_product.instructions,
      'access_validity_label', v_product.access_validity_label,
      'is_demo', coalesce(v_product.is_demo, false)
    ),
    'payment', case when v_payment.id is null then null else jsonb_build_object(
      'method', v_payment.method,
      'provider', v_payment.provider,
      'provider_payment_id', v_payment.provider_payment_id,
      'status', v_payment.status,
      'status_detail', v_payment.status_detail,
      'amount_cents', v_payment.amount_cents,
      'qr_code', case when v_order.payment_status in ('pending', 'in_process') then v_payment.qr_code else null end,
      'qr_code_base64', case when v_order.payment_status in ('pending', 'in_process') then v_payment.qr_code_base64 else null end,
      'ticket_url', case when v_order.payment_status in ('pending', 'in_process') then v_payment.ticket_url else null end,
      'expires_at', v_payment.expires_at
    ) end,
    'delivery', case when v_delivery.id is null then null else jsonb_build_object(
      'id', v_delivery.id,
      'status', v_delivery.status,
      'link_ready', v_delivery.status = 'active' and v_delivery.token_enc is not null,
      'created_at', v_delivery.created_at,
      'revoked_at', v_delivery.revoked_at
    ) end,
    'availability', jsonb_build_object('available_units', v_units_available)
  );
end;
$$;

revoke all on function public.get_order_status(uuid, text) from public, anon, authenticated;
grant execute on function public.get_order_status(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6b. Consulta pelo número do pedido (PS-XXXXXX) + código privado
--     O número é curto e legível; o código (token do cliente) continua sendo a
--     prova de posse. Referência inexistente e código errado respondem o mesmo
--     erro, sem oráculo de existência.
-- ---------------------------------------------------------------------------
create or replace function public.get_order_status_by_reference(
  p_reference text,
  p_client_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
begin
  if p_reference is null
     or p_client_token_hash is null
     or p_reference !~ '^PS-[0-9A-Z]{6}$' then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  select id into v_order_id
  from public.orders
  where reference = p_reference;

  if v_order_id is null then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  return public.get_order_status(v_order_id, p_client_token_hash);
end;
$$;

comment on function public.get_order_status_by_reference(text, text) is
  'Consulta o pedido pelo numero (PS-XXXXXX) e o codigo privado do solicitante; delega para get_order_status.';

revoke all on function public.get_order_status_by_reference(text, text) from public, anon, authenticated;
grant execute on function public.get_order_status_by_reference(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Privilégios: só o backend (mesmo padrão de negação das migrações 0022/0029)
-- ---------------------------------------------------------------------------
revoke all on function public.create_purchase_request(jsonb, text, text, text, text) from public;
revoke all on function public.purchase_request_summary(public.orders) from public;
revoke all on function public.get_order_status_by_reference(text, text) from public;

do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on function public.create_purchase_request(jsonb, text, text, text, text) from %I', v_role);
      execute format('revoke all on function public.purchase_request_summary(public.orders) from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.create_purchase_request(jsonb, text, text, text, text) to service_role';
    execute 'grant execute on function public.purchase_request_summary(public.orders) to service_role';
    execute 'grant execute on function public.get_order_status_by_reference(text, text) to service_role';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Verificação embutida
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    if has_function_privilege('anon', 'public.create_purchase_request(jsonb, text, text, text, text)', 'execute') then
      raise exception 'anon nao pode registrar solicitacao';
    end if;
    if has_table_privilege('anon', 'public.order_items', 'SELECT') then
      raise exception 'order_items exposta a anon';
    end if;
    if has_function_privilege('anon', 'public.get_order_status_by_reference(text, text)', 'execute') then
      raise exception 'anon nao pode consultar por referencia';
    end if;
  end if;

  if not has_function_privilege('service_role', 'public.create_purchase_request(jsonb, text, text, text, text)', 'execute') then
    raise exception 'service_role precisa executar create_purchase_request';
  end if;

  if not exists (select 1 from pg_constraint where conrelid = 'public.order_items'::regclass and conname = 'order_items_subtotal_check') then
    raise exception 'order_items sem verificacao de subtotal';
  end if;
end
$$;
