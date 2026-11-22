-- Substitui o destino fixo da 0044. O JWT legado guardado pelo OPERADOR
-- identifica o projeto (claim ref). Nunca aceite host fornecido pelo cliente.
-- Em instalação nova, aplique as migrations antes de provisionar o JWT.
DO $$
BEGIN
  IF to_regclass('cron.job') IS NULL OR to_regclass('net.http_request_queue') IS NULL
     OR to_regclass('vault.decrypted_secrets') IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT FROM vault.decrypted_secrets WHERE name = 'wyvi_worker_jwt') THEN
    IF EXISTS (SELECT FROM cron.job WHERE jobname = 'prime-store-wyvi-worker') THEN
      PERFORM cron.unschedule('prime-store-wyvi-worker');
    END IF;
    RAISE NOTICE 'Worker sem JWT no Vault: provisionar e executar novamente o bloco 0045.';
    RETURN;
  END IF;
  -- cron.schedule com o mesmo nome substitui o job do mesmo owner.
  PERFORM cron.schedule('prime-store-wyvi-worker', '* * * * *', $job$
    WITH token AS (SELECT decrypted_secret AS jwt FROM vault.decrypted_secrets WHERE name = 'wyvi_worker_jwt'),
    payload AS (SELECT jwt, translate(split_part(jwt, '.', 2), '-_', '+/') AS b64 FROM token),
    claims AS (SELECT jwt, convert_from(decode(rpad(b64, ((length(b64)+3)/4)*4, '='), 'base64'), 'UTF8')::jsonb AS c FROM payload)
    SELECT net.http_post(url := 'https://' || (c->>'ref') || '.supabase.co/functions/v1/wyvi-worker',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || jwt), body := '{}'::jsonb)
    FROM claims WHERE c->>'ref' ~ '^[a-z]{20}$' AND c->>'role' = 'service_role'
  $job$);
END;
$$;
