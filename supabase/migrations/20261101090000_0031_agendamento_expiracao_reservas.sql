-- ============================================================================
-- 0031 — EXECUÇÃO AUTOMÁTICA DA EXPIRAÇÃO DE RESERVAS (missão 07, etapa 02)
-- ============================================================================
-- Problema herdado da missão 06: `expire_overdue_reservations` só roda quando
-- alguém acessa o catálogo, cria um pedido ou consulta um pedido. Com a loja
-- parada, uma reserva vencida continua segurando a unidade por tempo
-- indeterminado — e o produto aparece como esgotado para o próximo visitante.
--
-- Solução: agendar a MESMA função (nenhuma regra de negócio é duplicada) pelo
-- mecanismo oficial do Supabase, `pg_cron`, a cada minuto. A reserva tem janela
-- de 30 minutos, então 1 minuto é o menor intervalo útil e não gera pressão
-- perceptível no banco (a varredura usa índice parcial e `FOR UPDATE SKIP
-- LOCKED`).
--
-- Compatibilidade: `pg_cron` não existe em todos os ambientes (o PostgreSQL
-- local usado nos testes não o oferece). Por isso a migração é **no-op** quando
-- a extensão não está disponível: nada quebra, e o agendamento é feito quando o
-- banco tiver o recurso. O fallback preguiçoso (catálogo/pedido/consulta)
-- continua funcionando em qualquer ambiente.
--
-- Concorrência: `expire_overdue_reservations` já é segura por linha
-- (`FOR UPDATE SKIP LOCKED` + verificação de `status`), e o wrapper abaixo
-- adiciona um advisory lock para que duas execuções agendadas não se sobreponham
-- e não disputem o mesmo lote.
--
-- Observabilidade: `job_health` guarda o estado do último ciclo (sucesso, falha,
-- quantidade devolvida, código SQLSTATE da falha). É uma tabela interna, sob
-- RLS e sem acesso para `anon`/`authenticated`. O código de erro é o SQLSTATE —
-- nunca a mensagem completa, para não vazar detalhe de dados.

-- ---------------------------------------------------------------------------
-- 1. Estado observável do trabalho periódico
-- ---------------------------------------------------------------------------
create table if not exists public.job_health (
  job_name text primary key,
  last_run_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_processed integer,
  consecutive_failures integer not null default 0,
  last_error_code text,
  updated_at timestamptz not null default now(),
  constraint job_health_job_name_length check (length(job_name) between 3 and 80),
  constraint job_health_failures_non_negative check (consecutive_failures >= 0)
);

comment on table public.job_health is
  'Estado do último ciclo de cada trabalho periódico (expiracao de reservas). Tabela interna: RLS ligada, sem políticas, acesso apenas por funcoes SECURITY DEFINER.';
comment on column public.job_health.last_error_code is
  'SQLSTATE da última falha (nunca a mensagem completa), para diagnóstico sem vazar dados.';

alter table public.job_health enable row level security;

revoke all on public.job_health from public;
do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on public.job_health from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on public.job_health to service_role';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Wrapper de execução (mesma lógica, com trava e registro de falha)
-- ---------------------------------------------------------------------------
create or replace function public.run_reservation_expiry(p_source text default 'cron')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_released integer;
  v_error text;
  v_result jsonb;
begin
  -- Uma execução por vez, sem bloquear: se o ciclo anterior ainda está rodando,
  -- este apenas reporta `skipped` (não duplica devolução de estoque).
  if not pg_try_advisory_xact_lock(hashtext('prime_store.expire_overdue_reservations')) then
    insert into public.job_health as j (job_name, last_run_at, last_processed, updated_at)
    values ('expire_overdue_reservations', now(), 0, now())
    on conflict (job_name) do update
      set last_run_at = excluded.last_run_at,
          last_processed = 0,
          updated_at = now();
    return jsonb_build_object('result', 'skipped', 'source', left(coalesce(p_source, 'unknown'), 40));
  end if;

  begin
    v_released := public.expire_overdue_reservations(null);

    insert into public.job_health as j (
      job_name, last_run_at, last_success_at, last_processed, consecutive_failures, last_error_code, updated_at
    )
    values ('expire_overdue_reservations', now(), now(), v_released, 0, null, now())
    on conflict (job_name) do update
      set last_run_at = excluded.last_run_at,
          last_success_at = excluded.last_success_at,
          last_processed = excluded.last_processed,
          consecutive_failures = 0,
          last_error_code = null,
          updated_at = now();

    v_result := jsonb_build_object(
      'result', 'ok',
      'released_units', v_released,
      'source', left(coalesce(p_source, 'unknown'), 40)
    );
  exception when others then
    -- Só o SQLSTATE vai para a tabela: mensagem de erro pode conter valor de
    -- coluna e não é necessária para diagnosticar.
    v_error := sqlstate;
    insert into public.job_health as j (
      job_name, last_run_at, last_processed, consecutive_failures, last_error_code, updated_at
    )
    values ('expire_overdue_reservations', now(), 0, 1, v_error, now())
    on conflict (job_name) do update
      set last_run_at = excluded.last_run_at,
          last_processed = 0,
          consecutive_failures = j.consecutive_failures + 1,
          last_error_code = excluded.last_error_code,
          updated_at = now();

    v_result := jsonb_build_object('result', 'failed', 'error_code', v_error);
  end;

  return v_result;
end;
$$;

comment on function public.run_reservation_expiry(text) is
  'Executa expire_overdue_reservations com trava de concorrência e registro em job_health. Chamada pelo pg_cron (a cada minuto) ou manualmente pelo backend.';

-- ---------------------------------------------------------------------------
-- 3. Privilégios: só o backend executa (padrão negar, igual às 0022/0029)
-- ---------------------------------------------------------------------------
revoke all on function public.run_reservation_expiry(text) from public;

do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on function public.run_reservation_expiry(text) from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.run_reservation_expiry(text) to service_role';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Agendamento (somente onde o pg_cron existe)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
    exception when others then
      -- Sem permissão/suporte: não é erro fatal, o fallback continua valendo.
      raise notice 'pg_cron nao pode ser habilitado (%): expiracao automatica fica pendente', sqlerrm;
    end;
  end if;

  if exists (select 1 from pg_namespace where nspname = 'cron') then
    if not exists (select 1 from cron.job where jobname = 'prime-store-expire-reservations') then
      perform cron.schedule(
        'prime-store-expire-reservations',
        '* * * * *',
        $cron$select public.run_reservation_expiry('cron')$cron$
      );
    end if;
  else
    raise notice 'pg_cron ausente: expiracao automatica nao agendada; fallback em catalog/create-order/order-status';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Verificação embutida
-- ---------------------------------------------------------------------------
do $$
begin
  if not has_function_privilege('service_role', 'public.run_reservation_expiry(text)', 'execute') then
    raise exception 'service_role precisa executar run_reservation_expiry';
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon', 'public.run_reservation_expiry(text)', 'execute') then
    raise exception 'anon nao pode executar run_reservation_expiry';
  end if;
end;
$$;
