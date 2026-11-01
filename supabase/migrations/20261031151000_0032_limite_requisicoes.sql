-- ============================================================================
-- 0032 — LIMITE DE REQUISIÇÕES POR ORIGEM E POR ROTA (missão 07, etapa 03)
-- ============================================================================
-- Contexto: as rotas públicas (catalog, create-order, order-status, delivery,
-- demo-payment, admin-api) não tinham nenhum controle de volume. As Edge
-- Functions rodam em várias instâncias e cada uma tem memória independente, então
-- um contador em memória não serviria: o limite precisa viver no banco.
--
-- Desenho:
--   * tabela `rate_limit_counters` com chave (route, subject_hash, window_start);
--   * `consume_rate_limit` faz o incremento em UMA instrução atômica
--     (`insert ... on conflict do update`) — concorrência não perde contagem;
--   * janela fixa alinhada ao relógio (padrão 60s), o que devolve um
--     `retry_after` determinístico para o cabeçalho HTTP `Retry-After`;
--   * `subject_hash` é um HMAC do IP calculado na Edge Function (nunca o IP puro),
--     então não se armazena dado pessoal no banco;
--   * a rota é parte da chave: catálogo e checkout têm orçamentos independentes;
--   * tabela interna: RLS ligada, nenhuma política, `anon`/`authenticated` sem
--     qualquer privilégio. Só `service_role` (o backend) consome.
--
-- Nota sobre o webhook do provedor: ele NÃO usa este limite. O Mercado Pago
-- envia de vários IPs e reenvia notificações por até horas; bloquear por origem
-- poderia descartar uma aprovação legítima. A proteção do webhook é a assinatura
-- HMAC (migração 0031 não; ver handler mpWebhook) mais a deduplicação por
-- `payment_events.notification_id`.
--
-- Retenção: as janelas são curtas. `prune_rate_limit_counters` remove o que já
-- expirou; quando `pg_cron` existe, roda de hora em hora. O próprio
-- `consume_rate_limit` também faz uma limpeza oportunista da mesma chave.

-- ---------------------------------------------------------------------------
-- 1. Contadores
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limit_counters (
  route text not null,
  subject_hash text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint rate_limit_counters_pkey primary key (route, subject_hash, window_start),
  constraint rate_limit_counters_route_length check (length(route) between 3 and 60),
  constraint rate_limit_counters_subject_length check (length(subject_hash) between 16 and 128),
  constraint rate_limit_counters_hits_positive check (hits > 0)
);

comment on table public.rate_limit_counters is
  'Contadores de limite de requisicoes por rota e por sujeito pseudonimizado (HMAC do IP). Tabela interna: RLS ligada, sem politicas, apenas service_role.';
comment on column public.rate_limit_counters.subject_hash is
  'HMAC-SHA256 truncado do IP de origem, calculado na Edge Function. Nao permite reidentificar o cliente sem o segredo do servidor.';

create index if not exists rate_limit_counters_window_idx
  on public.rate_limit_counters (window_start);

alter table public.rate_limit_counters enable row level security;

revoke all on public.rate_limit_counters from public;
do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on public.rate_limit_counters from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.rate_limit_counters to service_role';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Consumo atômico
-- ---------------------------------------------------------------------------
create or replace function public.consume_rate_limit(
  p_route text,
  p_subject text,
  p_limit integer,
  p_window_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window integer := greatest(coalesce(p_window_seconds, 60), 1);
  v_limit integer := greatest(coalesce(p_limit, 60), 1);
  v_window_start timestamptz;
  v_hits integer;
  v_retry_after integer;
begin
  if p_route is null or length(p_route) < 3 or length(p_route) > 60 then
    raise exception 'invalid_route';
  end if;
  if p_subject is null or length(p_subject) < 16 or length(p_subject) > 128 then
    raise exception 'invalid_subject';
  end if;

  -- Janela fixa alinhada ao relógio: o fim da janela é o próprio Retry-After.
  v_window_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / v_window) * v_window
  );

  insert into public.rate_limit_counters as c (route, subject_hash, window_start, hits, updated_at)
  values (p_route, p_subject, v_window_start, 1, now())
  on conflict (route, subject_hash, window_start) do update
    set hits = c.hits + 1,
        updated_at = now()
  returning c.hits into v_hits;

  -- Segundos restantes até o fim da janela (nunca o instante absoluto).
  v_retry_after := greatest(
    1,
    ceil(extract(epoch from ((v_window_start + make_interval(secs => v_window)) - clock_timestamp())))::integer
  );

  -- Limpeza oportunista da própria chave (janelas antigas não servem para nada).
  delete from public.rate_limit_counters
   where route = p_route
     and subject_hash = p_subject
     and window_start < v_window_start - make_interval(secs => v_window * 2);

  return jsonb_build_object(
    'allowed', v_hits <= v_limit,
    'hits', v_hits,
    'limit', v_limit,
    'remaining', greatest(v_limit - v_hits, 0),
    'window_seconds', v_window,
    'retry_after_seconds', case when v_hits <= v_limit then 0 else v_retry_after end
  );
end;
$$;

comment on function public.consume_rate_limit(text, text, integer, integer) is
  'Incrementa e avalia o limite de requisicoes em uma unica instrucao atomica. Retorna allowed/hits/limit/remaining/retry_after_seconds.';

-- ---------------------------------------------------------------------------
-- 3. Limpeza periódica
-- ---------------------------------------------------------------------------
create or replace function public.prune_rate_limit_counters(p_max_age interval default '1 hour')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_removed integer;
begin
  delete from public.rate_limit_counters
   where window_start < clock_timestamp() - coalesce(p_max_age, interval '1 hour');
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Privilégios
-- ---------------------------------------------------------------------------
revoke all on function public.consume_rate_limit(text, text, integer, integer) from public;
revoke all on function public.prune_rate_limit_counters(interval) from public;

do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on function public.consume_rate_limit(text, text, integer, integer) from %I', v_role);
      execute format('revoke all on function public.prune_rate_limit_counters(interval) from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.consume_rate_limit(text, text, integer, integer) to service_role';
    execute 'grant execute on function public.prune_rate_limit_counters(interval) to service_role';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Agendamento da limpeza (quando pg_cron existe)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    if not exists (select 1 from cron.job where jobname = 'prime-store-rate-limit-prune') then
      perform cron.schedule(
        'prime-store-rate-limit-prune',
        '7 * * * *',
        $cron$select public.prune_rate_limit_counters(interval '1 hour')$cron$
      );
    end if;
  else
    raise notice 'pg_cron ausente: limpeza dos contadores depende de prune_rate_limit_counters manual';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Verificação embutida
-- ---------------------------------------------------------------------------
do $$
declare
  v_result jsonb;
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon', 'public.consume_rate_limit(text, text, integer, integer)', 'execute') then
    raise exception 'anon nao pode consumir limite';
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_table_privilege('anon', 'public.rate_limit_counters', 'SELECT') then
    raise exception 'rate_limit_counters exposta a anon';
  end if;

  -- Prova de funcionamento mínimo (executa como dono e descarta o efeito).
  v_result := public.consume_rate_limit('__selfcheck__', repeat('0', 32), 1000, 60);
  if (v_result->>'allowed')::boolean is not true then
    raise exception 'consume_rate_limit nao respondeu allowed=true no self-check';
  end if;
  delete from public.rate_limit_counters where route = '__selfcheck__';
end;
$$;
