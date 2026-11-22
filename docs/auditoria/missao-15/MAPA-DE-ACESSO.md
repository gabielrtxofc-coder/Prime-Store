# Missão 15 — Mapa de acesso (produção)

Projeto `audsosvbdybifvxsmqpi`. Levantamento por consulta direta ao catálogo do
PostgreSQL e à Management API, em 2026-11-22. Nenhum valor de segredo foi lido
ou registrado — apenas existência, nome e comprimento.

Este documento responde a uma pergunta só: **quem consegue ler ou escrever o
quê, e por qual caminho.** O código dos handlers está em
`supabase/functions/`; as funções SQL em `supabase/migrations/`.

---

## 1. Superfícies expostas na internet

| Superfície | Autenticação | Quem usa | Proteção |
| --- | --- | --- | --- |
| `POST /functions/v1/catalog` | `apikey` público (anon) | vitrine | CORS por lista + rate limit 120/min |
| `POST /functions/v1/create-order` | anon | checkout | CORS + 10/min + preço/estoque no banco |
| `POST /functions/v1/order-request` | anon | solicitação sem pagamento | CORS + 10/min + validação 1–10 itens |
| `POST /functions/v1/order-status` | anon + `client_token` | acompanhamento | CORS + 60/min + prova de posse (hash) |
| `POST /functions/v1/delivery` | anon + token de entrega | página privada | CORS + 30/min + hash SHA-256 |
| `POST /functions/v1/wyvi-webhook` | assinatura HMAC do provedor | WyviPay | assinatura + idade do `ts` + dedup |
| `POST /functions/v1/admin-api` | JWT **+ allowlist + AAL2** | painel | `assert_admin()` + rate limit |
| `POST /functions/v1/wyvi-worker` | JWT interno (Vault) | cron | segredo no Vault, URL derivada do JWT |
| `GET /` (Vercel) | — | qualquer | CSP/HSTS/XFO novos (missão 15) |
| `/entrega/:token`, `/pedido/:id` | token na URL | comprador | `no-store` + `no-referrer` |

`mp-webhook` e `demo-payment` **não estão implantadas** em produção.

---

## 2. Banco — três camadas

**Camada 1 — GRANT.** `anon` e `authenticated` não têm privilégio de tabela,
sequência ou schema (`public`, `vault`, `cron`) em nenhuma tabela do domínio.
`public_catalog` também não é `GRANT`ada. Logo, o PostgREST não serve linha
alguma, mesmo que alguém tente `/rest/v1/orders`.

**Camada 2 — RLS.** RLS habilitado em **todas** as tabelas do domínio, **sem
nenhuma policy**. Sem policy e sem `BYPASSRLS`, o resultado é negação total
para qualquer papel que não seja dono/superuser. É redundante com a camada 1 de
propósito: se um `GRANT` for reintroduzido por engano, a RLS ainda nega.

**Camada 3 — funções.** Toda operação passa por função `SECURITY DEFINER` com
`search_path` fixo. `anon` executa **zero** funções. `authenticated` executa
apenas as 22 `admin_*` e `is_admin`, e **cada uma** começa por
`assert_admin()`, que exige (a) `auth.uid()` presente em `admin_users` e (b)
sessão em AAL2 (TOTP verificado). Um JWT roubado em AAL1 não lê nem escreve
nada administrativo.

---

## 3. Segredos

| Onde | Nome | Para quê | Quem lê |
| --- | --- | --- | --- |
| Vault | `prime_store_encryption_key` | chave mestra AES-256-GCM (44 chars base64) | `get_secret_material`, só `service_role` |
| Vault | `wyvi_worker_jwt` | invocar o worker pelo cron | `pg_net` (job), só no banco |
| Edge secret | `WYVI_API_KEY` | criar cobrança | `create-order` |
| Edge secret | `WYVI_WEBHOOK_SECRET` | verificar webhook | `wyvi-webhook` |
| Edge secret | `STORE_URL`, `ALLOWED_ORIGINS` | CORS + link de entrega | todas (missão 15) |
| Edge secret | `RATE_LIMIT_SECRET` | HMAC do sujeito de rate limit | todas (missão 15) |
| Edge secret | `SUPABASE_*` | runtime | runtime |

`PRIME_ENCRYPTION_KEY` **não** foi criada: o Vault já tem a chave e
`_shared/deps.ts` consulta o Vault quando a variável não existe. Criar uma
segunda chave dividiria o material criptográfico em duas fontes — pior, não
melhor. A ordem de precedência (variável → Vault → falha fechada) está
documentada em `docs/seguranca.md`.

Nenhum segredo é impresso em log, resposta HTTP ou relatório. O sujeito de rate
limit é `HMAC(segredo, IP)` truncado: o IP nunca é gravado.

---

## 4. Caminhos de leitura de credencial de estoque

Credencial de cliente (e-mail/senha do produto vendido) é o dado mais sensível
do sistema. Só existem **dois** caminhos de decifra:

1. `delivery` — exige token de entrega válido, pedido pago/aprovado e entrega
   ativa.
2. `admin-api` → `stock.list` com `includeCredentials` — exige AAL2 e grava
   evento de auditoria.

Consultas públicas jamais trazem `account_email_enc`, `account_password_enc`,
`cost_cents`, `credential_fingerprint` ou ids de unidade. Nenhum RPC devolve
ciphertext do link de entrega; o único é `get_delivery_token_enc`, restrito a
`service_role` e com prova de posse.

---

## 5. Idempotência e anti-sequestro (produção verificada)

`create_purchase_request` em produção (`pg_proc.prosrc`, md5
`f259ff9c…`) compara a lista de itens pedida com a gravada e levanta
`idempotency_conflict` **antes** de qualquer escrita. Só um replay idêntico
rotaciona `client_token_hash` — e nesse caso quem tem a chave já podia consultar
o pedido. Uma requisição divergente não altera token nem revela dados do
pedido original.

---

## 6. O que continua fora do nosso controle (plataforma)

- `net` e `cron` concedem `USAGE` a `PUBLIC` por padrão do Supabase; `REVOKE`
  nessas extensões é no-op silencioso no modelo gerenciado (documentado em
  `docs/limitacoes-e-pendencias.md`). Não há caminho de `net`/`cron` para dado
  de negócio: as funções de `net` só enfileiram HTTP, e `cron.job` só mostra
  nome/agenda de jobs que o próprio projeto criou.
- Toda a defesa de banco acima é **verificação por consulta**, não substitui os
  Advisors do painel (que exigem o painel logado).
