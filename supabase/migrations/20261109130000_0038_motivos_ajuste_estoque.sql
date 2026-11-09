-- ============================================================================
-- 0038 — MOTIVOS CATEGORIZADOS DE AJUSTE DE ESTOQUE (missão 07 · T037)
-- ============================================================================
-- Toda DESATIVAÇÃO de unidade (o "ajuste" de estoque do painel) passa a
-- exigir um motivo categorizado, com nota livre opcional. Sem exclusão física
-- e sem mudança de regra de negócio: unidade desativada continua fora do
-- catálogo e reativação continua possível — apenas agora fica registrado POR
-- QUE a unidade saiu de circulação.
--
--   * coluna nova em stock_units: status_reason (enum) + status_reason_note;
--   * admin_set_stock_unit_status ganha p_reason/p_note (com padrões seguros):
--       - status = 'disabled'  → p_reason OBRIGATÓRIO e no conjunto do enum;
--         razão 'other' exige nota com pelo menos 5 caracteres;
--       - status = 'available' → motivo é limpo (reativação não carrega pena);
--   * auditoria registra o motivo no metadado 'stock_unit_status_changed';
--   * admin_list_stock passa a devolver status_reason/status_reason_note.
--
-- Nenhuma linha existente é alterada (colunas nascem NULL/'').
-- Nenhuma regra de venda, reserva, pagamento ou entrega é tocada.
-- ============================================================================

CREATE TYPE public.stock_adjustment_reason AS ENUM (
  'inventory_adjustment',   -- ajuste de inventário (contagem física divergiu)
  'invalid_credential',     -- credencial inválida / já usada / expirada
  'compromised_credential', -- credencial comprometida (suspeita de vazamento)
  'duplicate_import',       -- importada em duplicidade
  'data_correction',        -- correção de cadastro / produto errado
  'other'                   -- outro motivo (nota obrigatória)
);

ALTER TABLE public.stock_units
  ADD COLUMN status_reason public.stock_adjustment_reason,
  ADD COLUMN status_reason_note text NOT NULL DEFAULT ''
    CONSTRAINT stock_units_status_reason_note_check CHECK (char_length(status_reason_note) <= 300);

-- Assinatura nova (uuid, text, text, text): a antiga (uuid, text) é removida
-- para não deixar duas versões chamáveis com semânticas diferentes.
DROP FUNCTION public.admin_set_stock_unit_status(uuid, text);

CREATE FUNCTION public.admin_set_stock_unit_status(
  p_stock_unit_id uuid,
  p_status text,
  p_reason text DEFAULT NULL,
  p_note text DEFAULT ''
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_unit public.stock_units;
  v_reason public.stock_adjustment_reason;
  v_note text := btrim(coalesce(p_note, ''));
begin
  if p_status not in ('available', 'disabled') then
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
    -- Reativação: motivo é limpo — unidade volta ao catálogo sem "pena".
    v_reason := null;
    v_note := '';
  end if;

  select * into v_unit from public.stock_units where id = p_stock_unit_id for update;
  if not found then
    raise exception 'stock_unit_not_found' using errcode = 'P0002';
  end if;

  if v_unit.status not in ('available', 'disabled') then
    raise exception 'stock_unit_not_toggleable' using errcode = 'P0001';
  end if;

  update public.stock_units
     set status = p_status::public.stock_unit_status,
         status_reason = v_reason,
         status_reason_note = v_note
   where id = p_stock_unit_id;

  perform public.log_admin_action('stock_unit_status_changed', 'stock_unit', v_unit.id::text,
    jsonb_build_object('from', v_unit.status, 'to', p_status, 'reason', v_reason, 'note', nullif(v_note, '')));

  return jsonb_build_object('id', v_unit.id, 'status', p_status, 'reason', v_reason, 'note', v_note);
end;
$$;

-- Mantém o modelo de privilégios da 0014/0022: admin_* executável pelo
-- painel autenticado (sempre com assert_admin() interno) e pelo servidor.
revoke execute on function public.admin_set_stock_unit_status(uuid, text, text, text) from public, anon;
grant execute on function public.admin_set_stock_unit_status(uuid, text, text, text) to authenticated, service_role;

-- admin_list_stock passa a expor o motivo (mesma assinatura; corpo novo).
CREATE OR REPLACE FUNCTION public.admin_list_stock(p_product_id uuid DEFAULT NULL::uuid, p_status text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_include_credentials boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := public.assert_admin();
  v_items jsonb;
  v_total integer;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
begin
  select count(*) into v_total
  from public.stock_units su
  where (p_product_id is null or su.product_id = p_product_id)
    and (p_status is null or su.status::text = p_status)
    and (
      p_search is null or btrim(p_search) = ''
      or su.notes ilike '%' || btrim(p_search) || '%'
      or su.credential_fingerprint like btrim(p_search) || '%'
    );

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc), '[]'::jsonb)
    into v_items
  from (
    select
      su.id, su.product_id, p.name as product_name, su.status, su.notes,
      su.credential_fingerprint,
      su.import_batch_id, su.sold_order_id, su.sold_at, su.created_at, su.updated_at,
      su.status_reason, su.status_reason_note,
      case when p_include_credentials then encode(su.account_email_enc, 'base64') end as email_enc,
      case when p_include_credentials then encode(su.account_password_enc, 'base64') end as password_enc,
      r.expires_at as reservation_expires_at,
      r.order_id as reservation_order_id
    from public.stock_units su
    join public.products p on p.id = su.product_id
    left join public.stock_reservation_units sru
      on sru.stock_unit_id = su.id and sru.released_at is null
    left join public.stock_reservations r
      on r.id = sru.reservation_id and r.status = 'active'
    where (p_product_id is null or su.product_id = p_product_id)
      and (p_status is null or su.status::text = p_status)
      and (
        p_search is null or btrim(p_search) = ''
        or su.notes ilike '%' || btrim(p_search) || '%'
        or su.credential_fingerprint like btrim(p_search) || '%'
      )
    order by su.created_at desc
    limit v_limit offset greatest(coalesce(p_offset, 0), 0)
  ) t;

  if p_include_credentials then
    perform public.log_admin_action('stock_credentials_listed', 'stock_unit', null,
      jsonb_build_object('product_id', p_product_id, 'count', jsonb_array_length(v_items)));
  end if;

  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', coalesce(p_offset, 0));
end;
$$;
