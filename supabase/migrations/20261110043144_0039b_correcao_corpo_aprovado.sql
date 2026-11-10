-- ============================================================================
-- 0039 — REPLAY SEGURO DA SOLICITAÇÃO DE COMPRA SEM PAGAMENTO
-- ============================================================================
-- Correção de contrato identificada na auditoria da Missão 11, alinhando
-- `create_purchase_request` (migração 0033) às garantias que `create_order`
-- (0017) e `create_order_multi` (0034) já oferecem:
--
--   1. MESMA chave + itens DIFERENTES → antes: replay silencioso devolvia o
--      pedido original (outros itens) e ainda rotacionava o token de consulta
--      para o chamador; agora: `idempotency_conflict` (409 no gateway), sem
--      alterar token e sem revelar dados do pedido existente.
--   2. Corrida com a mesma chave (duas requisições simultâneas): antes: o
--      perdedor repetia o INSERT até esgotar as tentativas e recebia o erro
--      cru `unique_violation` (500); agora: reaplica as mesmas regras do
--      replay (idêntica → devolve o pedido; divergente → conflito).
--
-- O comportamento APROVADO permanece intacto: requisição idêntica continua
-- fazendo replay sem duplicar pedido nem itens, e continua rotacionando o
-- token de consulta quando o cliente perdeu o código da tentativa (teste
-- "replay rotaciona o código" da Missão 08 segue verde, sem alteração).
--
-- Nenhuma regra de preço, disponibilidade, limite, privacidade ou estado é
-- tocada. Nenhuma coluna muda. A migração apenas redefinir o corpo da função
-- (CREATE OR REPLACE preserva privilégios e comentário são atualizados).
--
-- ESTA MIGRAÇÃO NÃO FOI APLICADA AO SUPABASE REMOTO pela Missão 11 (limite
-- absoluto: sem escrita em produção). Aplicação remota é tarefa do operador,
-- junto com as demais pendências de deploy.
-- ============================================================================

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
  v_requested_items jsonb;
  v_stored_items jsonb;
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

  -- 3. Replay idempotente: mesma chave devolve a mesma solicitação SOMENTE
  -- quando a requisição é idêntica (mesmos itens). Qualquer divergência vira
  -- `idempotency_conflict` — o mesmo contrato de `create_order` (0017) e de
  -- `create_order_multi` (0034): nunca devolver um pedido com outros itens e
  -- nunca revelar dados do pedido original a quem enviou parâmetros diferentes.
  -- A rotação do token continua valendo para a requisição IDÊNTICA (quem tem a
  -- chave já podia consultar aquele pedido e pode ter perdido o token da
  -- tentativa); uma requisição divergente não altera token algum.
  if p_idempotency_key is not null then
    select * into v_order from public.orders where idempotency_key = p_idempotency_key;
    if found then
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'product_id', (e ->> 'product_id')::uuid,
            'quantity', (e ->> 'quantity')::integer
          ) order by (e ->> 'product_id')::uuid
        ),
        '[]'::jsonb
      ) into v_requested_items
      from jsonb_array_elements(p_items) as e;

      select coalesce(
        jsonb_agg(
          jsonb_build_object('product_id', oi.product_id, 'quantity', oi.quantity)
          order by oi.product_id
        ),
        '[]'::jsonb
      ) into v_stored_items
      from public.order_items oi
      where oi.order_id = v_order.id;

      if v_requested_items is distinct from v_stored_items then
        raise exception 'idempotency_conflict' using errcode = 'P0001';
      end if;

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
        -- Corrida com outra requisição da MESMA chave: aplica exatamente as
        -- regras do replay acima (idêntica → devolve o pedido original com
        -- rotação de token; divergente → idempotency_conflict). Antes desta
        -- correção a função apenas repetia o INSERT, atingia o limite e
        -- devolvia o erro cru de unique_violation (500) para o perdedor.
        if p_idempotency_key is not null then
          select * into v_order from public.orders where idempotency_key = p_idempotency_key;
          if found then
            select coalesce(
              jsonb_agg(
                jsonb_build_object(
                  'product_id', (e ->> 'product_id')::uuid,
                  'quantity', (e ->> 'quantity')::integer
                ) order by (e ->> 'product_id')::uuid
              ),
              '[]'::jsonb
            ) into v_requested_items
            from jsonb_array_elements(p_items) as e;

            select coalesce(
              jsonb_agg(
                jsonb_build_object('product_id', oi.product_id, 'quantity', oi.quantity)
                order by oi.product_id
              ),
              '[]'::jsonb
            ) into v_stored_items
            from public.order_items oi
            where oi.order_id = v_order.id;

            if v_requested_items is distinct from v_stored_items then
              raise exception 'idempotency_conflict' using errcode = 'P0001';
            end if;

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
  'Registra a solicitacao de compra de um carrinho sem nenhuma cobranca: valida itens, precos e disponibilidade no banco, grava orders (status requested / payment not_required) e order_items. Nao reserva estoque, nao cria pagamento e nao libera entrega. Replay idempotente somente para a mesma identidade e os mesmos itens; divergencia gera idempotency_conflict (migração 0039).';
