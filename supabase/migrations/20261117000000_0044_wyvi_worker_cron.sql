-- ============================================================================
-- 0044 — WYVIPAY III: agendamento persistente do `wyvi-worker` (pg_cron +
--         pg_net + Vault) e hardening dos privilégios de fila/cron/vault
-- ============================================================================
-- Contexto: o webhook grava eventos na fila `payment_events`, mas o
-- processamento até aqui dependia de o comprador voltar a consultar
-- `/order-status` (poll) ou de um operador disparar o worker. Um cliente que
-- paga e fecha a página jamais seria confirmado a tempo.
--
-- O que esta migração faz:
--   1. Habilita `pg_cron`/`pg_net` quando disponíveis (padrão da 0031: em
--      ambientes sem as extensões o job é pulado com NOTICE — CI/local não
--      quebram e o fallback de poll permanece).
--   2. Agenda o job `prime-store-wyvi-worker` a cada minuto, chamando
--      `https://eorlmqolbknrplvdbbtl.supabase.co/functions/v1/wyvi-worker`
--      via `net.http_post`. O Bearer JWT service_role é lido DO VAULT em
--      tempo de execução (`vault.decrypted_secrets` nome
--      `wyvi_worker_jwt`) — o SQL agendado (gravado em `cron.job` e em
--      `cron.job_run_details`) NUNCA contém o segredo, apenas a referência.
--      Provisão do segredo (fora do repo, valor nunca versionado):
--        select vault.create_secret('<service_role_jwt>', 'wyvi_worker_jwt', ...);
--   3. Fecha privilégios documentados como abertos pela própria doc oficial
--      do pg_net: a fila `net.http_request_queue` guarda os CABEÇALHOS da
--      requisição (com o Authorization) de forma legível por papéis com
--      LOGIN enquanto a requisição não sai. `anon`/`authenticated` (e
--      `public`) perdem acesso a schemas, tabelas, funções e sequências de
--      `net`, `cron` e `vault` — nenhum cliente do navegador alcança esses
--      objetos; quem agenda é o próprio banco (postgres) e o worker valida
--      o papel `service_role` dentro do handler.
--
-- Arquitetura de autenticação do worker (revisada contra a doc oficial
-- "Authorization headers"/"Securing Edge Functions" de 22/10/2026):
--   * `verify_jwt = true` permanece LIGADO: a plataforma valida o JWT
--     (legacy HS256 é aceito) antes de o código executar;
--   * dentro do handler o papel `service_role` é exigido de novo
--     (`isServiceRole`) — duas camadas, nenhuma desligada;
--   * a chamada cron usa `Authorization: Bearer <jwt-do-vault>`, o formato
--     que o mecanismo aceita. O modo `auth: 'secret'` (apikey
--     `sb_secret_…` + verify_jwt=false) foi AVALIADO e descartado porque o
--     valor das chaves `sb_secret_…` é mascarado em toda API de gestão
--     (list/get/create devolvem `sb_secret_XXXX••••`), tornando impossível
--     provisioná-lo no Vault sem participação manual do responsável — e
--     enviar `sb_secret_…` como Bearer para uma validação de claim
--     `role=service_role` não funcionaria (sb_secret não é JWT).
-- ============================================================================

do $$
declare
  v_schema text;
begin
  -- ---------------------------------------------------------------------
  -- 1. Extensões (compatível com CI/local: availability primeiro, depois
  --    create protegido — mesmo padrão da migração 0031).
  -- ---------------------------------------------------------------------
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
    exception when others then
      raise notice 'pg_cron nao pode ser habilitado (%): wyvi-worker fica dependente do poll de order-status', sqlerrm;
    end;
  end if;

  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    begin
      create extension if not exists pg_net;
    exception when others then
      raise notice 'pg_net nao pode ser habilitado (%): chamada cron do wyvi-worker indisponivel aqui', sqlerrm;
    end;
  end if;

  -- ---------------------------------------------------------------------
  -- 2. Job do worker (somente com cron + net + vault E o segredo já
  --    provisionado; sem esses elementos o NOTICE explica o que falta).
  -- ---------------------------------------------------------------------
  if to_regclass('cron.job') is not null
     and to_regclass('net.http_request_queue') is not null
     and to_regclass('vault.decrypted_secrets') is not null then
    if not exists (
      select 1 from vault.decrypted_secrets where name = 'wyvi_worker_jwt'
    ) then
      raise notice 'wyvi-worker NAO agendado: segredo wyvi_worker_jwt ausente no Vault (provisione antes de reexecutar a migracao)';
    elsif not exists (
      select 1 from cron.job where jobname = 'prime-store-wyvi-worker'
    ) then
      perform cron.schedule(
        'prime-store-wyvi-worker',
        '* * * * *',
        $cron$select net.http_post(
          url := 'https://eorlmqolbknrplvdbbtl.supabase.co/functions/v1/wyvi-worker',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (
              select decrypted_secret from vault.decrypted_secrets where name = 'wyvi_worker_jwt'
            )
          ),
          body := '{}'::jsonb
        ) as request_id$cron$
      );
      raise notice 'job prime-store-wyvi-worker agendado: a cada minuto via pg_cron+pg_net (Vault na execucao)';
    end if;
  else
    raise notice 'pg_cron/pg_net/vault indisponiveis aqui: wyvi-worker nao agendado nesta migracao (fallback: poll de order-status)';
  end if;

  -- ---------------------------------------------------------------------
  -- 3. Hardening de privilégios (ciclo de vida do segredo no pg_net).
  --    Remove do CLIENTE (public/anon/authenticated) tudo que expõe os
  --    cabeçalhos da fila, o SQL dos jobs ou o conteúdo do Vault. Papéis
  --    de servidor (postgres, service_role) e o próprio agendador do
  --    pg_cron não são afetados.
  -- ---------------------------------------------------------------------
  foreach v_schema in array array['net', 'cron', 'vault'] loop
    if to_regnamespace(v_schema) is not null then
      execute format('revoke usage on schema %I from public, anon, authenticated', v_schema);
      execute format('revoke all on all tables in schema %I from public, anon, authenticated', v_schema);
      execute format('revoke all on all sequences in schema %I from public, anon, authenticated', v_schema);
      execute format('revoke all on all functions in schema %I from public, anon, authenticated', v_schema);
    end if;
  end loop;
end;
$$;
