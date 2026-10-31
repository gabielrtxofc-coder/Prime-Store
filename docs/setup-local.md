# Setup local

## Pré-requisitos

- Node.js 22.22+ (o `package.json` exige `^22.22.2 || ^24.15.0 || >=26`).
- PostgreSQL 15 ou superior **ou** Supabase CLI com Docker.
- Conta Supabase (sandbox) para publicar as migrações e as Edge Functions.

```bash
npm ci
```

## 1. Banco de dados local

O repositório não depende de Docker para testar: qualquer PostgreSQL 15+ serve.

```bash
# exemplo com binários do PostgreSQL no PATH
initdb -D /tmp/pgdata
postgres -D /tmp/pgdata -k /tmp/pgdata -p 5432 -c listen_addresses='' &
export DATABASE_URL='postgresql://postgres@/postgres?host=/tmp/pgdata'
```

O harness de testes (`tests/db/helpers.ts`) executa, nesta ordem:

1. `drop schema public cascade; drop schema auth cascade; create schema public;`
2. `supabase/local/bootstrap_local.sql` — **somente local**, recria o que o
   Supabase fornece por padrão (`roles anon/authenticated/service_role`, schema
   `auth`, `auth.users`, `auth.uid()/jwt()/role()`).
3. Todas as migrações de `supabase/migrations` em ordem alfabética.

> `bootstrap_local.sql` **nunca** deve ser executado no Supabase.

Com Supabase CLI a mesma sequência é feita por:

```bash
supabase start
supabase db reset      # aplica supabase/migrations
```

## 2. Aplicar as migrações no projeto Supabase (sandbox)

```bash
supabase link --project-ref <PROJECT_REF>
supabase db push
```

Alternativa sem CLI: enviar cada arquivo de `supabase/migrations` na ordem
alfabética pelo SQL Editor. As migrações são idempotentes na parte de dados
(`on conflict`), mas as tabelas usam `CREATE TABLE` simples: em banco vazio.

## 3. Edge Functions

```bash
supabase functions deploy catalog      --project-ref <REF>
supabase functions deploy create-order --project-ref <REF>
supabase functions deploy order-status --project-ref <REF>
supabase functions deploy delivery     --project-ref <REF>
supabase functions deploy mp-webhook   --no-verify-jwt --project-ref <REF>
supabase functions deploy admin-api    --project-ref <REF>
```

O `mp-webhook` é a única função com `--no-verify-jwt`: o Mercado Pago não envia
JWT do Supabase, e a autenticidade é validada pela assinatura `x-signature`.

Sem Supabase CLI, gere bundles autocontidos e cole no painel:

```bash
node scripts/bundle-functions.mjs   # saída em .local/functions-build/<slug>.ts
```

## 4. Segredos das Edge Functions

```bash
supabase secrets set --env-file .env.functions --project-ref <REF>
```

`.env.functions` (nunca versionar):

```
PRIME_ENCRYPTION_KEY=<base64 de 32 bytes>
STORE_URL=https://sua-loja.example
MP_ACCESS_TOKEN=TEST-...
MP_WEBHOOK_SECRET=...
MP_NOTIFICATION_URL=https://<REF>.supabase.co/functions/v1/mp-webhook
```

Gere a chave de criptografia com:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são injetadas automaticamente pelo
runtime do Supabase.

## 5. Frontend

```bash
cp .env.example .env      # preencha URL, chave anon e VITE_BACKEND_ENABLED=true
npm run dev
```

Sem `VITE_BACKEND_ENABLED=true` a aplicação permanece no **modo demonstração**
(catálogo local, checkout simulado) — é o modo usado pelos testes de UI.

## 6. Testes e verificações

```bash
npm test            # 57 testes de frontend (jsdom)
npm run test:db     # 70 testes de banco + unitários
npm run test:all    # tudo (127 testes)
npm run typecheck                         # tsc -b
npm run build                             # build de produção
```
