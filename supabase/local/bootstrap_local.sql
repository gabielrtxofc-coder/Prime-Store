-- =============================================================================
-- Bootstrap LOCAL (NÃO é uma migração de produção)
-- =============================================================================
-- Cria apenas o mínimo de infraestrutura que o Supabase já fornece:
--   * roles anon / authenticated / service_role
--   * schema auth + tabela auth.users + auth.uid() / auth.jwt() / auth.role()
--
-- Isso permite executar TODAS as migrações versionadas (supabase/migrations)
-- em um PostgreSQL comum, reproduzindo as regras de RLS/autorização.
-- Nunca execute este arquivo no Supabase: lá essas estruturas são gerenciadas
-- pela plataforma.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator nologin noinherit;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists auth.mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  factor_type text not null default 'totp',
  status text not null default 'unverified',
  friendly_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Equivalente ao helper do Supabase: lê as claims do JWT da requisição atual.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb;
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select auth.jwt() ->> 'role';
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
