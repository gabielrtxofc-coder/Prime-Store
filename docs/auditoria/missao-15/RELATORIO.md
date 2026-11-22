# Missão 15 — Endurecimento de segurança

**Data:** 2026-11-22 · **Branch:** `arena/8411465f-prime-store` (base `234e14d`) ·
**Projetos:** produção `audsosvbdybifvxsmqpi` · sandbox `eorlmqolbknrplvdbbtl`

> **Classificação: ENDURECIMENTO APLICADO, com bloqueios de operador restantes.**
> Um defeito **crítico de produção** foi encontrado e corrigido durante a
> auditoria (CORS fechado → loja inutilizável no domínio real). O restante é
> endurecimento de borda, cabeçalhos de segurança, configuração de Auth e
> documentação do mapa de acesso. Nada do que exige segredo, domínio ou decisão
> comercial foi inventado: está listado em
> [`DEPENDENCIAS-HUMANAS.md`](./DEPENDENCIAS-HUMANAS.md).

---

## 1. Como a auditoria foi feita

| Fonte | O que foi lido |
| --- | --- |
| Repositório | 47 migrações, 10 Edge Functions + `_shared/*`, `src/`, `tests/`, `scripts/`, `vercel.json`, `vite.config.ts`, `index.html`, `supabase/config.toml` |
| Banco de produção (somente leitura) | catálogo de tabelas, privilégios de função (local **e** remoto), RLS, `pg_proc.prosrc` de `create_purchase_request`, `app_settings`, `cron.job`, `net._http_response`, `vault.secrets` (nomes e comprimento, nunca valores) |
| Management API (conector) | `list_migrations`, `get_auth_config`, `list_secrets`, `list_edge_functions` |
| Vercel (conector) | projeto, domínios, variáveis de ambiente, último deploy de produção |
| Chamada HTTP real de dentro do projeto | `pg_net` → `catalog` com `Origin` real, **antes e depois** da correção de CORS |

Toda verificação de escrita foi feita **em produção apenas no que é configuração
de plataforma** (secrets de Edge Function, Auth). Nenhum DDL, nenhum dado de
negócio, nenhuma migração nova foi aplicada. O banco de produção está **vazio**
(0 produtos, 0 unidades, 0 pedidos, 0 administradores, 0 usuários), então não
havia dado a preservar nem a corromper.

---

## 2. Achado crítico — loja bloqueada por CORS em produção

**Severidade: crítica (disponibilidade total).** Encontrado **antes** de qualquer
alteração, reproduzido com requisição real.

O projeto de produção não tinha `ALLOWED_ORIGINS` nem `STORE_URL` entre os
secrets das Edge Functions. O código de `_shared/cors.ts` **fecha por padrão**
(`STORE_URL` cai no default `http://localhost:5173`), então:

```
POST /functions/v1/catalog
Origin: https://prime-store-gilt.vercel.app

→ 200, Access-Control-Allow-Origin: (ausente), Vary: Accept-Encoding, Origin
```

O corpo vinha correto (`{"products":[],...}`), mas **sem o cabeçalho de origem
o navegador descarta a resposta**: catálogo, checkout, acompanhamento e entrega
ficavam inutilizáveis no domínio real. O smoke test de servidor não pegou porque
`fetch` sem `Origin` (servidor a servidor) não precisa de CORS.

**Correção aplicada (produção):**

| Secret | Valor |
| --- | --- |
| `STORE_URL` | `https://prime-store-gilt.vercel.app` |
| `ALLOWED_ORIGINS` | `https://prime-store-gilt.vercel.app` |
| `RATE_LIMIT_SECRET` | gerado (32 bytes aleatórios, nunca impresso em log) |

**Prova depois da correção** (mesma chamada `pg_net`):

```
→ 200, Access-Control-Allow-Origin: https://prime-store-gilt.vercel.app
    Access-Control-Allow-Headers: authorization, x-client-info, apikey, content-type
```

**Contraprova (origem estranha continua bloqueada):**

```
Origin: https://atacante.example  →  allow_origin: (nulo)
```

O domínio foi confirmado no conector da Vercel: `prime-store-gilt.vercel.app` é
o **único** domínio do projeto `prime-store`, atribuído ao deploy de produção do
commit `234e14d`. A Vercel também tem um projeto QA isolado em `preview`
(`sxsjfhtjtubuslmkeiiu.supabase.co`) — se esse preview precisar chamar produção,
ele entra em `ALLOWED_ORIGINS`, nunca em `*`.

---

## 3. Configuração de Auth de produção (antes → depois)

| Item | Antes | Depois | Por quê |
| --- | --- | --- | --- |
| `site_url` | `http://localhost:3000` | `https://prime-store-gilt.vercel.app` | Links de recuperação/confirmação apontavam para a máquina do dev |
| `uri_allow_list` | *(vazia)* | produção + `localhost:5173`/`127.0.0.1:5173` | Redirects permitidos de forma explícita |
| `disable_signup` | `false` | **`true`** | Loja não tem cadastro público; qualquer pessoa criava usuário no Auth |
| `mailer_autoconfirm` | `false` | `false` (mantido) | Confirmação de e-mail continua obrigatória |
| TOTP (`mfa_totp_*`) | habilitado | habilitado (mantido) | AAL2 do painel |
| `password_min_length` | 6 | **6 (não alterado)** | A API do conector não expõe o campo; ver pendência P4 |

**Efeito colateral registrado (não escondido):** a chamada de atualização zerou
`security_captcha_provider`, `sms_provider` e `rate_limit_email_sent`. Nenhum
tinha valor configurado (CAPTCHA desligado, SMS nunca configurado, sem SMTP), e
o conector não aceita esses campos. Nenhum controle de segurança foi perdido;
o que estava em `null` continua em `null`.

---

## 4. Mapa de acesso (produção, confirmado por consulta)

Documento completo: [`MAPA-DE-ACESSO.md`](./MAPA-DE-ACESSO.md).

Resumo:

- **Tabelas:** RLS habilitado em todas, **zero policies**, `anon`/`authenticated`
  sem nenhum `GRANT` de tabela. Nenhuma leitura direta pelo PostgREST.
- **Funções:** 32 `public`; `anon` executa **zero**; `authenticated` executa
  apenas as 22 `admin_*` + `is_admin`, todas passando por
  `assert_admin()` = usuário em `admin_users` **e** sessão em AAL2.
- **Schemas de extensão:** `vault` e `cron` sem `USAGE` para `anon`/
  `authenticated`; `vault.decrypted_secrets` e as funções
  `get_secret_material`/`get_delivery_token_enc` inacessíveis a ambos.
  `net`/`cron` expõem `USAGE`/`SELECT` herdados de `PUBLIC` — limitação de
  plataforma já documentada (`docs/limitacoes-e-pendencias.md`), sem caminho
  para dado de negócio.
- **`search_path`:** fixo em todas as definer (`definer_without_search_path=0`).
- **`create_purchase_request` (produção):** corpo conferido em `pg_proc.prosrc`.
  Contém a correção anti-sequestro da **0039/0039b** — compara os itens
  pedidos com os gravados e levanta `idempotency_conflict` **antes** de tocar em
  `client_token_hash`. A rotação do token só acontece em replay **idêntico**.
  A dúvida aberta da fase anterior está fechada.
- **Edge Functions implantadas (8):** `catalog`, `create-order`, `order-request`,
  `order-status`, `delivery`, `wyvi-webhook`, `admin-api` (JWT), `wyvi-worker`
  (JWT). `mp-webhook` e `demo-payment` **não estão implantadas** — decisão
  coerente com a produção (ver §6).

---

## 5. Código endurecido

| # | Arquivo | Antes | Agora | Teste |
| --- | --- | --- | --- | --- |
| 1 | `_shared/http.ts` | `await request.json()` sem teto: corpo de centenas de MB alocado antes de qualquer recusa | `readBodyText()` corta em **4 MB durante a leitura** (não confia no `Content-Length`) → `413 payload_too_large` | `hardening_borda.test.ts` |
| 2 | `_shared/handlers/mpWebhook.ts`, `wyviWebhook.ts` | `await request.text()` sem teto | mesmo leitor com teto; a assinatura continua sobre os bytes crus | idem |
| 3 | `_shared/csv.ts` | limites por campo, **sem teto de linhas**: CSV de 2 MB ≈ 60 mil linhas, todas cifradas e enviadas num RPC | `MAX_IMPORT_ROWS = 5000`; excedente marca `truncated` e a prévia informa; o commit **recusa** com `413 import_too_large` em vez de importar parte em silêncio | idem |
| 4 | `src/lib/publicEnv.ts` | `{...buildEnv, ...process.env}`: qualquer nome de `process.env` legível pelo bundle | lista de permissão **`VITE_*`** nos dois lados | idem |
| 5 | `vercel.json` | **nenhum** cabeçalho de segurança | CSP (sem inline em script nem estilo), HSTS (2 anos, preload), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP; `no-store` em `/entrega`, `/pedido`, `/admin`; cache imutável em `/assets` | 7 testes de configuração |
| 6 | `index.html` | descrição dizia "sem processamento de pagamentos reais" (falso: há WyviPay) | texto correto + `meta referrer=no-referrer` (defesa em profundidade) | — |
| 7 | `vite.config.ts` | `allowedHosts: true` (qualquer `Host`) | lista explícita (`localhost`, `.localhost`, `.e2b.app`, `.e2b.dev`) + `PRIME_DEV_ALLOWED_HOSTS` | — |

**Sobre a CSP escolhida:**

```
default-src 'self'; script-src 'self'; style-src 'self';
img-src 'self' data: https:; font-src 'self';
connect-src 'self' https://*.supabase.co wss://*.supabase.co;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none';
upgrade-insecure-requests
```

- `script-src 'self'` **sem** `'unsafe-inline'`/`'unsafe-eval'`: o build não tem
  script inline, e o Vite gera um único módulo estático. É a diretiva que mais
  importa contra XSS.
- `style-src 'self'` **sem** `'unsafe-inline'`: varredura do `src/` mostra
  **zero** `style={...}`, zero `.style.` e zero `dangerouslySetInnerHTML` — o
  projeto estiliza só por classe CSS. Um teste de regressão
  (`hardening_borda.test.ts`) falha se um estilo inline aparecer, porque nesse
  dia a política precisaria de `style-src-attr` de novo.
- `img-src ... https:` é intencional: `AdminProducts` aceita URL de imagem
  externa, decisão funcional pré-existente. Imagem não executa script.
- `connect-src` só para `*.supabase.co` (REST + Auth). Não há Realtime no
  código, por isso `wss` não é necessário — se um dia for, a diretiva precisa
  ser revista junto.

Verificação: o bundle antigo e o novo não têm `eval`/`new Function` de nosso
código, nenhum `<style>` inline, nenhuma fonte/asset externo (Inter e monospace
caem nas fontes do sistema). Limite honesto: **não há navegador neste sandbox**
para carregar a página sob a CSP; o risco residual é uma asset do Vite que eu
não tenha previsto, e o primeiro deploy com CSP precisa ser conferido no console
do navegador (D3).

---

## 6. O que foi verificado e está correto (sem ação)

- **Demo-payment desligado em produção por três travas independentes:** função
  não implantada, `DEMO_PAYMENT_ENABLED` ausente, `app_settings.demo_payments_enabled
  = false`. Mesmo ligada no banco, a função não existe; mesmo implantada, o
  secret falta. `demo_approve_payment` ainda exige produto `is_demo` **e**
  todas as unidades reservadas `is_demo` (`demo_real_stock_blocked`).
- **Admin bootstrap fechado:** `admin_users` com 0 linhas, `is_admin` falso para
  qualquer sessão. O caminho de provisionamento é manual e documentado.
- **Cron:** `expire-reservations` e `wyvi-worker` a cada minuto; a URL do worker
  é derivada do JWT guardado no Vault (`ref`), nunca de entrada do cliente.
- **Rate limit:** janela fixa alinhada ao relógio, sujeito = `HMAC(segredo, IP)`
  truncado (`/64` para IPv6), falha aberta **deliberada** e registrada
  (`rate_limit.unavailable`) — um contador quebrado não pode derrubar a vitrine.
  Com `RATE_LIMIT_SECRET` configurado, o sujeito não depende mais da
  `service_role`.
- **Assinatura de webhook:** comparação em tempo constante, idade máxima de 24 h
  e tolerância de 5 min no `ts`, conversão determinística de ms.
- **Segredos no repositório:** 0 ocorrências de `wy_test_/wy_live_`, `whsec_`,
  `eyJ...`, `sk_live_`, `AKIA...` ou URL de banco com senha. `npm audit`: **0
  vulnerabilidades**. Nenhum `.env` versionado.
- **Entrega:** token de 32 bytes, banco guarda só hash + ciphertext; resposta
  `410` para token inválido (não revela existência); nada gravado no navegador
  além do necessário.

---

## 7. Verificação automatizada

| Suíte | Resultado |
| --- | --- |
| `npx tsc -b` | 0 erros |
| `npm test` (frontend, jsdom) | **168/168** |
| `npm run test:db` (PostgreSQL 18 real) | **457/457** (era 441; +16 desta missão) |
| `npm run bundle:functions` | 10/10 funções empacotam |
| `npm audit` | 0 vulnerabilidades |
| Produção, `pg_net` antes/depois | CORS negado → liberado; origem estranha → continua negada |

Novo arquivo de teste: `tests/unit/hardening_borda.test.ts` (**24 casos**) —
teto de corpo (incluindo `Content-Length` mentiroso e stream sem fim), teto de
linhas de CSV, lista de permissão de `VITE_*`, a rede de segurança de CORS e a
**configuração de segurança do site** (`vercel.json`/`index.html`): HSTS/XFO/
nosniff/Referrer/Permissions presentes, CSP sem `unsafe-inline`/`unsafe-eval`,
`connect-src` restrito a `self` + Supabase, `no-store` nas rotas sensíveis e um
guarda que falha se aparecer estilo inline no `src/`.

---

## 8. Pendências que exigem o operador

Ver [`DEPENDENCIAS-HUMANAS.md`](./DEPENDENCIAS-HUMANAS.md). Em resumo: nenhum
administrador real, nenhuma chave de pagamento, e-mail de Auth sem SMTP,
primeiro deploy com CSP a conferir no console, tamanho mínimo de senha.

---

## 8-bis. Estado de implantação das Edge Functions (proveniência)

O deploy anterior (v8 de `catalog`) era um **eszip que importa os fontes de
`raw.githubusercontent.com/<repo>/<sha>`** — ou seja, cada versão fica presa a um
commit do GitHub e só muda com novo deploy. Durante esta missão:

| Função | Versão | Corpo | Origem |
| --- | --- | --- | --- |
| `catalog` | **v9** | bundle **inline** e autocontido (0 imports) gerado por `scripts/bundle-functions.mjs` + `update_edge_function` | esta missão |
| demais 7 | inalteradas | eszip preso ao commit `cc421f8` | deploys anteriores |

**Por que só o `catalog` foi reimplantado:** é a única função cujo
comportamento visível mudou de forma verificável sem risco (GET + corpo com
teto) e serve de canário do novo leitor. As demais correções (teto no CSV do
`admin-api`, corpo cru dos webhooks, `order-request`) só passam a valer no
próximo `supabase functions deploy` feito a partir deste commit — que é o
caminho normal do projeto (CI + CLI). **Não reimplantei o `admin-api` pelo
conector**: o bundle tem ~48 KB, o limite prático de argumento da ferramenta é
bem menor, e uma falha no meio de um deploy administrativo é pior do que
esperar o deploy versionado.

Prova do canário (produção, `pg_net`):

```
GET  catalog  Origin: https://prime-store-gilt.vercel.app
→ 200, Access-Control-Allow-Origin: https://prime-store-gilt.vercel.app

POST order-request  corpo de 4,2 MB   (função ainda na v anterior)
→ 422 invalid_items   ← o corpo INTEIRO foi aceito e parseado: é exatamente
                        o custo que o teto novo remove
```

O deploy do `catalog` pelo conector usa o bundle inline; o arquivo em
`supabase/functions/` continua sendo a fonte. O próximo deploy por CLI a partir
deste commit produz o mesmo comportamento a partir dos fontes — nada depende do
bundle inline.

## 9. Arquivos alterados nesta missão

```
supabase/functions/_shared/http.ts                 (teto de corpo)
supabase/functions/_shared/handlers/mpWebhook.ts   (teto no corpo cru)
supabase/functions/_shared/handlers/wyviWebhook.ts (teto no corpo cru)
supabase/functions/_shared/handlers/adminApi.ts    (truncated / import_too_large)
supabase/functions/_shared/csv.ts                  (MAX_IMPORT_ROWS)
src/lib/publicEnv.ts                               (allowlist VITE_*)
vercel.json                                        (cabeçalhos + CSP)
index.html                                         (descrição + no-referrer)
vite.config.ts                                     (allowedHosts explícito)
tests/unit/hardening_borda.test.ts                 (novo, 16 testes)
docs/auditoria/missao-15/*                         (este relatório)
```

Configuração de plataforma (não versionada): secrets `STORE_URL`,
`ALLOWED_ORIGINS`, `RATE_LIMIT_SECRET` em produção; `site_url`,
`uri_allow_list` e `disable_signup` do Auth de produção.
