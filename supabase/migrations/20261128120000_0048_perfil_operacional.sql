-- ============================================================================
-- 20261128120000_0048 — PERFIL OPERACIONAL (e-mail + senha, sem TOTP)
-- ============================================================================
-- PROBLEMA
-- --------
-- Todo acesso ao painel exigia AAL2 (TOTP). As duas contas administrativas de
-- produção nunca concluíram o cadastro do autenticador (0 fatores verificados)
-- e, por isso, a operação cotidiana da loja (consultar produtos e repor
-- estoque) ficava travada atrás de uma exigência pensada para operações
-- privilegiadas.
--
-- DECISÃO
-- -------
-- Separar dois perfis, ambos decididos NO BANCO:
--
--   operacional ... allowlist `operator_users`; basta sessão autenticada
--                   (e-mail + senha, AAL1). Executa SOMENTE as funções `ops_*`.
--   administrativo  allowlist `admin_users` + AAL2 (inalterado). Executa as
--                   funções `admin_*`, que continuam chamando `assert_admin()`.
--
-- O perfil operacional PODE:
--   * consultar produtos (sem custo, sem margem, sem histórico de preço);
--   * alterar estoque: cadastrar unidade, importar CSV, desativar com motivo
--     categorizado e reativar unidade;
--   * atualizar informações operacionais de produto (lista fechada de campos)
--     e ativar/desativar produto.
--
-- O perfil operacional NÃO PODE (não existe função `ops_*` para isso, e as
-- `admin_*` continuam exigindo allowlist administrativa + AAL2):
--   * ver credenciais decifradas, fingerprints ou ciphertext do estoque;
--   * ver pedidos, compradores, pagamentos, reembolsos, disputas ou entregas;
--   * ver indicadores financeiros, custo, margem ou trilha de auditoria;
--   * alterar preço, custo, slug, categoria ou criar produtos;
--   * gerenciar usuários, perfis ou configurações (`app_settings`);
--   * ler ou escrever qualquer tabela diretamente (sem GRANT + RLS sem policy).
--
-- O QUE NÃO MUDA
-- --------------
--   * `assert_admin()`, `is_admin()` e todas as `admin_*` ficam intactas;
--   * `admin_users` não é alterada — nenhuma conta é criada, removida ou
--     rebaixada por esta migração;
--   * nenhuma linha de dados existente é alterada.
--
-- Provisionamento: a migração NÃO insere ninguém em `operator_users` (nunca
-- versionamos UUID real). O passo é operacional: `scripts/provision-operator.sql`.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Allowlist do perfil operacional
-- ----------------------------------------------------------------------------
create table if not exists public.operator_users (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid,
  constraint operator_users_display_name_check
    check (char_length(btrim(display_name)) between 2 and 80)
);

comment on table public.operator_users is
  'Allowlist do perfil OPERACIONAL (e-mail + senha, sem TOTP). Só autoriza as funções ops_*. '
  'Gerida apenas por service_role (SQL Editor); nenhum papel de cliente lê ou escreve.';

drop trigger if exists operator_users_set_updated_at on public.operator_users;
create trigger operator_users_set_updated_at
  before update on public.operator_users
  for each row execute function public.set_updated_at();

-- Camada 1 (GRANT): cliente não toca a tabela. Camada 2 (RLS): habilitada e
-- SEM policy — mesmo que um GRANT escape no futuro, nenhuma linha é servida.
-- Isso também impede autopromoção: não há caminho do JWT até esta tabela.
-- (Sem FORCE: as funções SECURITY DEFINER pertencem ao dono da tabela, como
-- em todas as demais tabelas do domínio.)
alter table public.operator_users enable row level security;
revoke all on public.operator_users from public, anon, authenticated;
grant all on public.operator_users to service_role;

-- ----------------------------------------------------------------------------
-- 2. Guardas
-- ----------------------------------------------------------------------------
-- assert_operator(): sessão autenticada + allowlist operacional ativa.
-- Não exige AAL2 de propósito: é o objetivo do perfil. Não é executável por
-- clientes (só é chamada de dentro das funções ops_*).
create or replace function public.assert_operator()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  perform 1 from public.operator_users where user_id = v_uid and is_active;
  if not found then
    raise exception 'not_operator' using errcode = '42501';
  end if;

  return v_uid;
end;
$$;

-- is_operator(): consulta booleana sem efeito colateral (usada por `session`).
create or replace function public.is_operator()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return false;
  end if;
  return exists (select 1 from public.operator_users where user_id = v_uid and is_active);
end;
$$;

-- Auditoria do perfil operacional: mesma trilha administrativa, com o rótulo
-- do operador e `profile = operational` no metadado. Interna (sem EXECUTE).
create or replace function public.log_operator_action(
  p_action text,
  p_entity_type text default null,
  p_entity_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_label text;
begin
  select display_name into v_label from public.operator_users where user_id = v_uid;

  insert into public.admin_audit_log (actor_user_id, actor_label, action, entity_type, entity_id, metadata)
  values (
    v_uid,
    v_label,
    p_action,
    p_entity_type,
    p_entity_id,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('profile', 'operational')
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Sessão operacional
-- ----------------------------------------------------------------------------
create or replace function public.ops_session()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_operator();
  v_label text;
begin
  select display_name into v_label from public.operator_users where user_id = v_actor;
  return jsonb_build_object('user_id', v_actor, 'display_name', v_label, 'profile', 'operational');
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. Produtos — leitura sem dados comerciais sensíveis
-- ----------------------------------------------------------------------------
create or replace function public.ops_list_products(
  p_search text default null,
  p_include_inactive boolean default true
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_operator();
  v_result jsonb;
begin
  -- Sem cost_cents, margin_cents, created_by/updated_by e histórico de preço.
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.name), '[]'::jsonb)
    into v_result
  from (
    select
      p.id, p.slug, p.name, p.category_id, c.label as category_label,
      p.price_cents,
      p.is_active, p.is_featured, p.max_quantity_per_order,
      p.access_validity_label,
      p.short_description, p.description, p.instructions, p.conditions,
      p.image_url, p.updated_at,
      coalesce(s.available_units, 0) as available_units,
      coalesce(s.reserved_units, 0) as reserved_units,
      coalesce(s.sold_units, 0) as sold_units,
      coalesce(s.disabled_units, 0) as disabled_units
    from public.products p
    join public.product_categories c on c.id = p.category_id
    left join (
      select product_id,
             count(*) filter (where status = 'available') as available_units,
             count(*) filter (where status = 'reserved') as reserved_units,
             count(*) filter (where status = 'sold') as sold_units,
             count(*) filter (where status = 'disabled') as disabled_units
      from public.stock_units
      group by product_id
    ) s on s.product_id = p.id
    where p.archived_at is null
      and (coalesce(p_include_inactive, true) or p.is_active)
      and (
        p_search is null or btrim(p_search) = ''
        or p.name ilike '%' || btrim(p_search) || '%'
        or p.slug ilike '%' || btrim(p_search) || '%'
      )
  ) t;

  return v_result;
end;
$$;

-- Projeção única devolvida pelas escritas de produto (nunca custo/autoria).
create or replace function public.ops_product_projection(p_product public.products)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p_product.id,
    'slug', p_product.slug,
    'name', p_product.name,
    'category_id', p_product.category_id,
    'price_cents', p_product.price_cents,
    'is_active', p_product.is_active,
    'is_featured', p_product.is_featured,
    'max_quantity_per_order', p_product.max_quantity_per_order,
    'access_validity_label', p_product.access_validity_label,
    'short_description', p_product.short_description,
    'description', p_product.description,
    'instructions', p_product.instructions,
    'conditions', to_jsonb(p_product.conditions),
    'image_url', p_product.image_url,
    'updated_at', p_product.updated_at
  );
$$;

-- ----------------------------------------------------------------------------
-- 5. Produtos — atualização operacional (lista FECHADA de campos)
-- ----------------------------------------------------------------------------
-- Qualquer chave fora da lista é RECUSADA (não ignorada em silêncio): o
-- cliente sabe exatamente o que o perfil não pode fazer, e a tentativa não
-- altera nada. Preço, custo, slug, categoria, validade em dias e campos
-- visuais continuam exclusivos do perfil administrativo.
create or replace function public.ops_update_product(p_product_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_operator();
  v_allowed constant text[] := array[
    'name', 'short_description', 'description', 'instructions', 'conditions',
    'image_url', 'access_validity_label', 'max_quantity_per_order',
    'is_featured', 'is_active'
  ];
  v_forbidden text[];
  v_keys text[];
  v_product public.products;
begin
  if p_product_id is null then
    raise exception 'product_not_found' using errcode = 'P0002';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  select array_agg(k order by k) into v_keys from jsonb_object_keys(p_payload) as k;
  if v_keys is null then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  select array_agg(k order by k) into v_forbidden
  from unnest(v_keys) as k
  where not (k = any (v_allowed));

  if v_forbidden is not null then
    raise exception 'operator_field_not_allowed'
      using errcode = '42501', detail = array_to_string(v_forbidden, ',');
  end if;

  if p_payload ? 'conditions' and jsonb_typeof(p_payload -> 'conditions') <> 'array' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  update public.products p
     set name = coalesce(nullif(btrim(p_payload ->> 'name'), ''), p.name),
         short_description = coalesce(p_payload ->> 'short_description', p.short_description),
         description = coalesce(p_payload ->> 'description', p.description),
         instructions = coalesce(p_payload ->> 'instructions', p.instructions),
         conditions = case when p_payload ? 'conditions'
                           then coalesce((select array_agg(value) from jsonb_array_elements_text(p_payload -> 'conditions') as value), '{}'::text[])
                           else p.conditions end,
         image_url = case when p_payload ? 'image_url'
                          then nullif(btrim(coalesce(p_payload ->> 'image_url', '')), '')
                          else p.image_url end,
         access_validity_label = coalesce(p_payload ->> 'access_validity_label', p.access_validity_label),
         max_quantity_per_order = coalesce((p_payload ->> 'max_quantity_per_order')::integer, p.max_quantity_per_order),
         is_featured = coalesce((p_payload ->> 'is_featured')::boolean, p.is_featured),
         is_active = coalesce((p_payload ->> 'is_active')::boolean, p.is_active),
         updated_by = v_actor
   where p.id = p_product_id
     and p.archived_at is null
   returning * into v_product;

  if not found then
    raise exception 'product_not_found' using errcode = 'P0002';
  end if;

  perform public.log_operator_action('product_updated', 'product', v_product.id::text,
    jsonb_build_object('fields', to_jsonb(v_keys)));

  return public.ops_product_projection(v_product);
end;
$$;

create or replace function public.ops_set_product_active(p_product_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_operator();
  v_product public.products;
begin
  if p_active is null then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  update public.products
     set is_active = p_active, updated_by = v_actor
   where id = p_product_id
     and archived_at is null
   returning * into v_product;

  if not found then
    raise exception 'product_not_found' using errcode = 'P0002';
  end if;

  perform public.log_operator_action(
    case when p_active then 'product_activated' else 'product_deactivated' end,
    'product', v_product.id::text, '{}'::jsonb
  );

  return public.ops_product_projection(v_product);
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. Estoque — resumo e listagem SEM credenciais e SEM vínculo com pedidos
-- ----------------------------------------------------------------------------
create or replace function public.ops_stock_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_operator();
  v_result jsonb;
begin
  select jsonb_build_object(
    'products',
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'product_id', p.id,
          'product_name', p.name,
          'slug', p.slug,
          'is_active', p.is_active,
          'archived_at', p.archived_at,
          'total_units', coalesce(s.total_units, 0),
          'available_units', coalesce(s.available_units, 0),
          'reserved_units', coalesce(s.reserved_units, 0),
          'sold_units', coalesce(s.sold_units, 0),
          'disabled_units', coalesce(s.disabled_units, 0),
          'last_restocked_at', s.last_restocked_at,
          'stock_health',
            case
              when coalesce(s.available_units, 0) = 0 then 'empty'
              when coalesce(s.available_units, 0) <= 2 then 'low'
              else 'ok'
            end
        )
        order by p.name, p.id
      ),
      '[]'::jsonb
    ),
    'totals',
    jsonb_build_object(
      'total_units', coalesce(sum(coalesce(s.total_units, 0)), 0),
      'available_units', coalesce(sum(coalesce(s.available_units, 0)), 0),
      'reserved_units', coalesce(sum(coalesce(s.reserved_units, 0)), 0),
      'sold_units', coalesce(sum(coalesce(s.sold_units, 0)), 0),
      'disabled_units', coalesce(sum(coalesce(s.disabled_units, 0)), 0)
    )
  )
  into v_result
  from public.products p
  left join lateral (
    select
      count(*) as total_units,
      count(*) filter (where su.status = 'available') as available_units,
      count(*) filter (where su.status = 'reserved') as reserved_units,
      count(*) filter (where su.status = 'sold') as sold_units,
      count(*) filter (where su.status = 'disabled') as disabled_units,
      max(su.created_at) as last_restocked_at
    from public.stock_units su
    where su.product_id = p.id
  ) s on true
  where p.archived_at is null;

  return v_result;
end;
$$;

create or replace function public.ops_list_stock(
  p_product_id uuid default null,
  p_status text default null,
  p_search text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_operator();
  v_items jsonb;
  v_total integer;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if p_status is not null and p_status not in ('available', 'reserved', 'sold', 'disabled') then
    raise exception 'invalid_status_filter' using errcode = '22023';
  end if;

  select count(*) into v_total
  from public.stock_units su
  where (p_product_id is null or su.product_id = p_product_id)
    and (p_status is null or su.status::text = p_status)
    and (p_search is null or btrim(p_search) = '' or su.notes ilike '%' || btrim(p_search) || '%');

  -- Nunca: account_email_enc, account_password_enc, credential_fingerprint,
  -- sold_order_id, reservation order id (vínculo com compradores).
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc), '[]'::jsonb)
    into v_items
  from (
    select
      su.id, su.product_id, p.name as product_name, su.status, su.notes,
      su.import_batch_id, su.sold_at, su.created_at, su.updated_at,
      su.status_reason, su.status_reason_note,
      r.expires_at as reservation_expires_at
    from public.stock_units su
    join public.products p on p.id = su.product_id
    left join public.stock_reservation_units sru
      on sru.stock_unit_id = su.id and sru.released_at is null
    left join public.stock_reservations r
      on r.id = sru.reservation_id and r.status = 'active'
    where (p_product_id is null or su.product_id = p_product_id)
      and (p_status is null or su.status::text = p_status)
      and (p_search is null or btrim(p_search) = '' or su.notes ilike '%' || btrim(p_search) || '%')
    order by su.created_at desc
    limit v_limit offset v_offset
  ) t;

  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. Estoque — escrita (credencial chega CIFRADA pela Edge Function)
-- ----------------------------------------------------------------------------
create or replace function public.ops_add_stock_unit(
  p_product_id uuid,
  p_email_enc_b64 text,
  p_password_enc_b64 text,
  p_fingerprint text,
  p_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_operator();
  v_unit public.stock_units;
begin
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_fingerprint' using errcode = '22023';
  end if;

  if coalesce(p_email_enc_b64, '') = '' or coalesce(p_password_enc_b64, '') = '' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  if char_length(coalesce(p_notes, '')) > 500 then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  if not exists (select 1 from public.products where id = p_product_id and archived_at is null) then
    raise exception 'product_not_found' using errcode = 'P0002';
  end if;

  begin
    insert into public.stock_units (
      product_id, account_email_enc, account_password_enc, credential_fingerprint,
      notes, created_by
    )
    values (p_product_id, decode(p_email_enc_b64, 'base64'), decode(p_password_enc_b64, 'base64'),
            p_fingerprint, coalesce(p_notes, ''), v_actor)
    returning * into v_unit;
  exception
    when unique_violation then
      raise exception 'duplicate_credential' using errcode = '23505';
  end;

  perform public.log_operator_action('stock_unit_added', 'stock_unit', v_unit.id::text,
    jsonb_build_object('product_id', p_product_id));

  return jsonb_build_object('id', v_unit.id, 'status', v_unit.status, 'created_at', v_unit.created_at);
end;
$$;

create or replace function public.ops_set_stock_unit_status(
  p_stock_unit_id uuid,
  p_status text,
  p_reason text default null,
  p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_operator();
  v_unit public.stock_units;
  v_reason public.stock_adjustment_reason;
  v_note text := btrim(coalesce(p_note, ''));
begin
  if p_status is null or p_status not in ('available', 'disabled') then
    raise exception 'invalid_status_change' using errcode = '22023';
  end if;

  if char_length(v_note) > 300 then
    raise exception 'invalid_reason_note' using errcode = '22023';
  end if;

  if p_status = 'disabled' then
    if p_reason is null or btrim(p_reason) = '' then
      raise exception 'adjustment_reason_required' using errcode = '22023';
    end if;
    begin
      v_reason := btrim(p_reason)::public.stock_adjustment_reason;
    exception when invalid_text_representation then
      raise exception 'invalid_adjustment_reason' using errcode = '22023';
    end;
    if v_reason = 'other' and char_length(v_note) < 5 then
      raise exception 'adjustment_reason_note_required' using errcode = '22023';
    end if;
  else
    v_reason := null;
    v_note := '';
  end if;

  select * into v_unit from public.stock_units where id = p_stock_unit_id for update;
  if not found then
    raise exception 'stock_unit_not_found' using errcode = 'P0002';
  end if;

  -- Unidades reservadas ou vendidas pertencem a um pedido: fora do alcance
  -- do perfil operacional (e do administrativo, pela mesma regra).
  if v_unit.status not in ('available', 'disabled') then
    raise exception 'stock_unit_not_toggleable' using errcode = 'P0001';
  end if;

  update public.stock_units
     set status = p_status::public.stock_unit_status,
         status_reason = v_reason,
         status_reason_note = v_note
   where id = p_stock_unit_id;

  perform public.log_operator_action('stock_unit_status_changed', 'stock_unit', v_unit.id::text,
    jsonb_build_object('from', v_unit.status, 'to', p_status, 'reason', v_reason, 'note', nullif(v_note, '')));

  return jsonb_build_object('id', v_unit.id, 'status', p_status, 'reason', v_reason, 'note', v_note);
end;
$$;

create or replace function public.ops_import_stock_units(
  p_product_id uuid,
  p_rows jsonb,
  p_rejected jsonb default '[]'::jsonb,
  p_file_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $_$
declare
  v_actor uuid := public.assert_operator();
  v_batch public.import_batches;
  v_row jsonb;
  v_imported integer := 0;
  v_duplicates integer := 0;
  v_invalid integer := 0;
  v_failures jsonb := '[]'::jsonb;
  v_total integer := 0;
begin
  if not exists (select 1 from public.products where id = p_product_id and archived_at is null) then
    raise exception 'product_not_found' using errcode = 'P0002';
  end if;

  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_rejected, '[]'::jsonb)) <> 'array' then
    raise exception 'invalid_rows' using errcode = '22023';
  end if;

  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 5000 then
    raise exception 'import_too_large' using errcode = '22023';
  end if;

  insert into public.import_batches (product_id, file_name, created_by)
  values (p_product_id, left(coalesce(p_file_name, ''), 200), v_actor)
  returning * into v_batch;

  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    v_total := v_total + 1;
    begin
      if coalesce(v_row ->> 'fingerprint', '') !~ '^[0-9a-f]{64}$' then
        raise exception 'invalid_fingerprint' using errcode = '22023';
      end if;

      insert into public.stock_units (
        product_id, account_email_enc, account_password_enc, credential_fingerprint,
        notes, import_batch_id, created_by
      )
      values (
        p_product_id,
        decode(v_row ->> 'email_enc', 'base64'),
        decode(v_row ->> 'password_enc', 'base64'),
        v_row ->> 'fingerprint',
        left(coalesce(v_row ->> 'notes', ''), 500),
        v_batch.id,
        v_actor
      );
      v_imported := v_imported + 1;
    exception
      when unique_violation then
        v_duplicates := v_duplicates + 1;
        v_failures := v_failures || jsonb_build_object(
          'row_number', (v_row ->> 'row_number')::integer,
          'reason', 'duplicate_credential'
        );
      when others then
        v_invalid := v_invalid + 1;
        v_failures := v_failures || jsonb_build_object(
          'row_number', (v_row ->> 'row_number')::integer,
          'reason', 'invalid_row'
        );
    end;
  end loop;

  for v_row in select * from jsonb_array_elements(coalesce(p_rejected, '[]'::jsonb))
  loop
    v_total := v_total + 1;
    v_invalid := v_invalid + 1;
    v_failures := v_failures || jsonb_build_object(
      'row_number', (v_row ->> 'row_number')::integer,
      'reason', coalesce(v_row ->> 'reason', 'invalid_row')
    );
  end loop;

  update public.import_batches
     set total_rows = v_total,
         accepted_rows = v_imported,
         rejected_rows = v_total - v_imported
   where id = v_batch.id;

  perform public.log_operator_action('stock_imported', 'import_batch', v_batch.id::text,
    jsonb_build_object(
      'product_id', p_product_id,
      'total', v_total,
      'imported', v_imported,
      'duplicates', v_duplicates,
      'invalid', v_invalid
    ));

  return jsonb_build_object(
    'batch_id', v_batch.id,
    'total_rows', v_total,
    'imported', v_imported,
    'duplicates', v_duplicates,
    'invalid', v_invalid,
    'failures', v_failures
  );
end;
$_$;

-- ----------------------------------------------------------------------------
-- 8. Privilégios: negar por padrão, conceder por classificação
-- ----------------------------------------------------------------------------
-- Internas (só chamadas de dentro de outras funções): nenhum cliente executa.
revoke all on function public.assert_operator() from public, anon, authenticated;
revoke all on function public.log_operator_action(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.ops_product_projection(public.products) from public, anon, authenticated;
grant execute on function public.assert_operator() to service_role;
grant execute on function public.log_operator_action(text, text, text, jsonb) to service_role;
grant execute on function public.ops_product_projection(public.products) to service_role;

-- Painel operacional: ops_* + is_operator, sempre com o JWT do usuário.
-- Cada ops_* começa por assert_operator(); anon não executa nenhuma.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like 'ops\_%' or p.proname = 'is_operator')
      and p.proname <> 'ops_product_projection'
  loop
    execute format('revoke all on function %s from public, anon', r.signature);
    execute format('grant execute on function %s to authenticated, service_role', r.signature);
  end loop;
end;
$$;

comment on function public.assert_operator() is
  'Garante sessão autenticada + allowlist operacional ativa (sem exigir AAL2). Interna: SQLSTATE 28000/42501.';
comment on function public.is_operator() is
  'true quando auth.uid() está ativo em operator_users. Sem efeito colateral.';
comment on function public.ops_update_product(uuid, jsonb) is
  'Atualização operacional de produto. Campos fora da lista fechada => operator_field_not_allowed (42501).';
