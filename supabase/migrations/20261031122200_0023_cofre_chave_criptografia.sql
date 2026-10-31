-- ============================================================================
-- 0023 — CHAVE DE CRIPTOGRAFIA NO COFRE (VAULT)
-- ============================================================================
-- As credenciais de estoque são cifradas com AES-256-GCM nas Edge Functions.
-- A chave NUNCA pode estar no código, no repositório, no `.env` versionado nem
-- em logs.
--
-- Estratégia, em ordem de precedência (ver `_shared/config.ts`):
--   1. variável de ambiente `PRIME_ENCRYPTION_KEY` da Edge Function, se existir
--      (recomendado: `supabase secrets set`);
--   2. segredo guardado no Supabase Vault, lido por uma função SECURITY DEFINER
--      restrita a `service_role` — usada quando o operador ainda não configurou
--      as secrets das funções.
--
-- Este arquivo cria o segredo com valor gerado DENTRO do banco
-- (`gen_random_bytes(32)`), portanto o valor nunca transita por arquivos,
-- relatórios ou logs. Para trocar a chave depois, use `vault.update_secret`
-- e re-cifre as credenciais (não há re-cifragem automática na V1).

do $$
begin
  -- Em bancos locais (sem Supabase Vault) este bloco é ignorado.
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'vault' and p.proname = 'create_secret'
  ) then
    if not exists (select 1 from vault.secrets where name = 'prime_store_encryption_key') then
      perform vault.create_secret(
        encode(extensions.gen_random_bytes(32), 'base64'),
        'prime_store_encryption_key',
        'AES-256-GCM das credenciais de estoque e dos tokens de entrega (uso exclusivo da Edge Function)'
      );
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Leitura do material secreto (somente service_role)
-- ---------------------------------------------------------------------------
create or replace function public.get_secret_material(p_name text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret text;
begin
  if p_name is null or p_name !~ '^[a-z0-9_]{3,64}$' then
    raise exception 'invalid_secret_name' using errcode = '22023';
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = p_name
  limit 1;

  if v_secret is null then
    raise exception 'secret_not_found' using errcode = 'P0002';
  end if;

  return v_secret;
end;
$$;

comment on function public.get_secret_material(text) is
  'Leitura de segredo do Supabase Vault restrita ao backend (service_role). Nunca exposta a anon/authenticated.';

revoke all on function public.get_secret_material(text) from public, anon, authenticated;
grant execute on function public.get_secret_material(text) to service_role;
