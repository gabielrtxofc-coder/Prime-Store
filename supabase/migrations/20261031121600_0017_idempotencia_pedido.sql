-- ============================================================================
-- 0017 — IDEMPOTÊNCIA SEGURA NA CRIAÇÃO DE PEDIDO
-- ============================================================================
-- Correção de integridade identificada na auditoria da Missão 03.
--
-- Antes: se já existisse um pedido com a mesma `idempotency_key`, a função
-- SUBSTITUÍA `client_token_hash` pelo hash recebido. Qualquer requisição que
-- adivinhasse/reutilizasse a chave assumia o controle do pedido alheio — e,
-- portanto, do link de entrega e das credenciais.
--
-- Depois:
--   * mesma chave + mesmo token + mesmo produto/quantidade → replay do pedido
--     original (comportamento idempotente esperado);
--   * qualquer divergência (token, produto ou quantidade) → erro genérico
--     `idempotency_conflict`, sem revelar qual campo divergiu e sem expor dados
--     do pedido existente;
--   * o token de um pedido existente NUNCA é alterado;
--   * duas requisições simultâneas com a mesma chave: uma cria, a outra entra
--     no caminho de replay (ou recebe o conflito) via unique_violation.
--
-- A chave também passa a exigir entropia mínima (16 caracteres, URL-safe), o
-- que torna a colisão acidental/forçada inviável na prática.

create or replace function public.create_order(
  p_product_id uuid,
  p_quantity integer,
  p_idempotency_key text,
  p_client_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.products;
  v_order public.orders;
  v_existing public.orders;
  v_reservation_id uuid;
  v_available integer;
  v_reference text;
  v_attempt integer := 0;
  v_reservation_minutes integer := public.setting_int('reservation_minutes', 30);
  v_max_quantity integer := public.setting_int('max_quantity_per_order', 20);
  v_qty integer := p_quantity;
begin
  if p_client_token_hash is null or p_client_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_client_token' using errcode = '22023';
  end if;

  if v_qty is null or v_qty < 1 or v_qty > v_max_quantity then
    raise exception 'invalid_quantity' using errcode = '22023';
  end if;

  if p_idempotency_key is not null and p_idempotency_key !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;

  select * into v_product from public.products where id = p_product_id for update;

  if not found or v_product.archived_at is not null or not v_product.is_active then
    raise exception 'product_unavailable' using errcode = 'P0002';
  end if;

  if v_qty > v_product.max_quantity_per_order then
    raise exception 'quantity_above_product_limit'
      using errcode = '22023',
            detail = v_product.max_quantity_per_order::text;
  end if;

  -- ------------------------------------------------------------------------
  -- Replay idempotente: só existe quando a MESMA requisição se repete.
  -- ------------------------------------------------------------------------
  if p_idempotency_key is not null then
    select * into v_existing from public.orders where idempotency_key = p_idempotency_key;

    if found then
      -- Divergência de identidade ou de parâmetros comerciais: conflito
      -- controlado. Nenhum detalhe do pedido existente é revelado.
      if v_existing.client_token_hash <> p_client_token_hash
         or v_existing.product_id <> p_product_id
         or v_existing.quantity <> v_qty then
        raise exception 'idempotency_conflict' using errcode = 'P0001';
      end if;

      return jsonb_build_object(
        'order_id', v_existing.id,
        'reference', v_existing.reference,
        'status', v_existing.status,
        'payment_status', v_existing.payment_status,
        'delivery_status', v_existing.delivery_status,
        'quantity', v_existing.quantity,
        'unit_price_cents', v_existing.unit_price_cents,
        'total_cents', v_existing.total_cents,
        'reservation_expires_at', v_existing.reservation_expires_at,
        'idempotent_replay', true
      );
    end if;
  end if;

  perform public.expire_overdue_reservations(p_product_id);

  select count(*) into v_available
  from public.stock_units
  where product_id = p_product_id and status = 'available';

  if v_available < v_qty then
    raise exception 'insufficient_stock'
      using errcode = 'P0001',
            detail = v_available::text;
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_reference := public.generate_order_reference();
    begin
      insert into public.orders (
        reference, product_id, product_name, quantity,
        unit_price_cents, total_cents, status, payment_status, delivery_status,
        client_token_hash, idempotency_key, reservation_expires_at
      )
      values (
        v_reference, v_product.id, v_product.name, v_qty,
        v_product.price_cents, v_product.price_cents * v_qty,
        'pending_payment', 'pending', 'not_ready',
        p_client_token_hash, p_idempotency_key,
        now() + make_interval(mins => v_reservation_minutes)
      )
      returning * into v_order;
      exit;
    exception
      when unique_violation then
        -- Corrida com outra requisição: se o conflito foi na chave de
        -- idempotência, aplica exatamente as mesmas regras do replay.
        if p_idempotency_key is not null then
          select * into v_existing from public.orders where idempotency_key = p_idempotency_key;
          if found then
            if v_existing.client_token_hash <> p_client_token_hash
               or v_existing.product_id <> p_product_id
               or v_existing.quantity <> v_qty then
              raise exception 'idempotency_conflict' using errcode = 'P0001';
            end if;

            return jsonb_build_object(
              'order_id', v_existing.id,
              'reference', v_existing.reference,
              'status', v_existing.status,
              'payment_status', v_existing.payment_status,
              'delivery_status', v_existing.delivery_status,
              'quantity', v_existing.quantity,
              'unit_price_cents', v_existing.unit_price_cents,
              'total_cents', v_existing.total_cents,
              'reservation_expires_at', v_existing.reservation_expires_at,
              'idempotent_replay', true
            );
          end if;
        end if;

        if v_attempt >= 5 then
          raise;
        end if;
    end;
  end loop;

  v_reservation_id := public.reserve_stock_units(
    v_order.id, v_product.id, v_qty, v_order.reservation_expires_at
  );

  insert into public.order_events (order_id, event_type, actor, metadata)
  values (
    v_order.id,
    'order_created',
    'customer',
    jsonb_build_object(
      'reservation_id', v_reservation_id,
      'quantity', v_qty,
      'reservation_expires_at', v_order.reservation_expires_at,
      'idempotent', p_idempotency_key is not null
    )
  );

  return jsonb_build_object(
    'order_id', v_order.id,
    'reference', v_order.reference,
    'status', v_order.status,
    'payment_status', v_order.payment_status,
    'delivery_status', v_order.delivery_status,
    'quantity', v_order.quantity,
    'unit_price_cents', v_order.unit_price_cents,
    'total_cents', v_order.total_cents,
    'reservation_expires_at', v_order.reservation_expires_at,
    'product', jsonb_build_object(
      'id', v_product.id,
      'name', v_product.name,
      'slug', v_product.slug,
      'instructions', v_product.instructions,
      'access_validity_label', v_product.access_validity_label
    ),
    'idempotent_replay', false
  );
end;
$$;

comment on function public.create_order(uuid, integer, text, text) is
  'Cria pedido e reserva unidades com FOR UPDATE SKIP LOCKED. Replay idempotente somente para a mesma identidade (token) e os mesmos parâmetros; divergência gera idempotency_conflict e nunca altera o token do pedido existente.';

-- ---------------------------------------------------------------------------
-- Entropia mínima da chave de idempotência (defesa em profundidade)
-- ---------------------------------------------------------------------------
alter table public.orders drop constraint if exists orders_idempotency_key_check;
alter table public.orders
  add constraint orders_idempotency_key_check
  check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$');
