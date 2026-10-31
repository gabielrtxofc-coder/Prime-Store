-- ============================================================================
-- 0029 — SEMEADURA DE ESTOQUE FICTÍCIO E PRIVILÉGIOS DO MODO DEMONSTRATIVO
-- ============================================================================
-- `demo_seed_stock` cria unidades com credenciais fictícias (já cifradas pela
-- Edge Function) para um produto marcado `is_demo`. Limite duro de 20 unidades
-- fictícias por produto. Nenhuma credencial real entra por este caminho.

-- ---------------------------------------------------------------------------
-- 8. Semeadura de estoque fictício (somente service_role, somente sandbox)
-- ---------------------------------------------------------------------------
create or replace function public.demo_seed_stock(
  p_product_id uuid,
  p_units jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.products;
  v_unit jsonb;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_existing integer;
  v_limit integer := 20;
begin
  if not public.demo_payments_enabled() then
    raise exception 'demo_disabled' using errcode = 'P0001';
  end if;

  select * into v_product from public.products where id = p_product_id;

  if not found or not v_product.is_active or v_product.archived_at is not null then
    raise exception 'product_unavailable' using errcode = 'P0002';
  end if;

  if not v_product.is_demo then
    raise exception 'demo_not_allowed' using errcode = 'P0001';
  end if;

  if p_units is null or jsonb_typeof(p_units) <> 'array' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  select count(*) into v_existing
  from public.stock_units
  where product_id = p_product_id and is_demo;

  if v_existing + jsonb_array_length(p_units) > v_limit then
    raise exception 'demo_seed_limit'
      using errcode = 'P0001', detail = v_limit::text;
  end if;

  for v_unit in select * from jsonb_array_elements(p_units) loop
    if v_unit->>'email_enc_b64' is null
       or v_unit->>'password_enc_b64' is null
       or coalesce(v_unit->>'fingerprint', '') !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid_payload' using errcode = '22023';
    end if;

    insert into public.stock_units (
      product_id, account_email_enc, account_password_enc,
      credential_fingerprint, notes, is_demo
    )
    values (
      p_product_id,
      decode(v_unit->>'email_enc_b64', 'base64'),
      decode(v_unit->>'password_enc_b64', 'base64'),
      v_unit->>'fingerprint',
      coalesce(v_unit->>'notes', 'Credencial fictícia de demonstração'),
      true
    )
    returning id into v_id;

    v_ids := array_append(v_ids, v_id);
  end loop;

  return jsonb_build_object('product_id', p_product_id, 'created', cardinality(v_ids));
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Privilégios (padrão negar; igual às migrações 0022/0024)
-- ---------------------------------------------------------------------------
revoke all on function public.demo_payments_enabled() from public;
revoke all on function public.demo_approve_payment(uuid, text, text, text) from public;
revoke all on function public.demo_seed_stock(uuid, jsonb) from public;

do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on function public.demo_payments_enabled() from %I', v_role);
      execute format('revoke all on function public.demo_approve_payment(uuid, text, text, text) from %I', v_role);
      execute format('revoke all on function public.demo_seed_stock(uuid, jsonb) from %I', v_role);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.demo_payments_enabled() to service_role';
    execute 'grant execute on function public.demo_approve_payment(uuid, text, text, text) to service_role';
    execute 'grant execute on function public.demo_seed_stock(uuid, jsonb) to service_role';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Token de preparação do estoque fictício (fica no Vault, nunca no código)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'vault' and p.proname = 'create_secret'
  ) then
    if not exists (select 1 from vault.secrets where name = 'demo_setup_token') then
      perform vault.create_secret(
        encode(extensions.gen_random_bytes(32), 'base64'),
        'demo_setup_token',
        'Prova exigida pela Edge Function demo-payment para semear estoque fictício no sandbox'
      );
    end if;
  end if;
end;
$$;
