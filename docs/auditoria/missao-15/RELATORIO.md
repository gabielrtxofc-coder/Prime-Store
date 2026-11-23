# Missão 15 — Endurecimento de segurança

**Data:** 2026-11-22 · **Branch:** `arena/8411465f-prime-store` (base `234e14d`) ·
**Commit final:** `c276d5e` · **PR:** #15 ·
**Projetos:** produção `audsosvbdybifvxsmqpi` · sandbox `eorlmqolbknrplvdbbtl`

> **Estado da entrega:** 664 testes verdes (168 de interface + 496 de banco e
> unidade) · CI verde em `c276d5e` (push e PR) · Vercel Preview `success` em
> `c276d5e` · working tree limpo. As migrações **não foram aplicadas em
> produção**; as pendências de operador estão em `DEPENDENCIAS-HUMANAS.md`
> (P6 e **P7**).

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
- **Funções:** 32 `public`; `anon` executa **zero**. `authenticated` executa
  **24** antes da 0046, com **três finalidades distintas** — não uma só:
  - **22 funções administrativas** — chamadas pela Edge Function `admin-api`;
    cada uma valida o chamador por `assert_admin()` = usuário em `admin_users`
    **e** sessão em AAL2;
  - **`is_admin`** — função de **consulta**. Não lança exceção: devolve
    `false` quando o chamador não é administrador (checagem de `auth.uid()`
    contra a allowlist, com AAL2). É o que o painel usa para decidir se
    mostra a interface, e é o que os testes chamam de `anon` para provar que a
    resposta é `permission denied`;
  - **`admin_stock_summary()`** — **órfã**: zero chamadas no código de
    produção. É a **única das 24 cuja permissão foi revogada** (pela 0046).
    Continua executável por `postgres` (dono) e `service_role` (diagnóstico).

  Afirmar que "as 24 passam por `assert_admin()`" é impreciso: `is_admin` não
  autoriza nada — só informa — e a órfã sequer tem caminho de chamada.
  A matriz função a função está em `ADVISORS.md` §Grupo 3.
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

Resultados definitivos, commit final **`c276d5e`**:

| Suíte | Resultado |
| --- | --- |
| `npx tsc -b` | 0 erros |
| `npm test` (frontend, jsdom) | **168/168** em 24 arquivos |
| `npm run test:db` (PostgreSQL 18.6 real) | **496/496** em 40 arquivos |
| **Total de testes** | **664** (168 + 496) |
| `npm run bundle:functions` | 10/10 funções empacotam |
| `npm audit --omit=dev` | 0 vulnerabilidades |
| CI (push + PR) | **verde** em `c276d5e` |
| Vercel Preview | **success** em `c276d5e` |
| Produção, `pg_net` antes/depois | CORS negado → liberado; origem estranha → continua negada |

Novo arquivo de teste: `tests/unit/hardening_borda.test.ts` (**24 casos**) —
teto de corpo (incluindo `Content-Length` mentiroso e stream sem fim), teto de
linhas de CSV, lista de permissão de `VITE_*`, a rede de segurança de CORS e a
**configuração de segurança do site** (`vercel.json`/`index.html`): HSTS/XFO/
nosniff/Referrer/Permissions presentes, CSP sem `unsafe-inline`/`unsafe-eval`,
`connect-src` restrito a `self` + Supabase, `no-store` nas rotas sensíveis e um
guarda que falha se aparecer estilo inline no `src/`.

---

## 7-bis. Histórico da contagem de testes (por que existem números antigos)

> **Esta seção é registro histórico, não resultado.** Os números que valem são
> os do §7: **168 + 496 = 664** no commit `c276d5e`. Tudo abaixo descreve como
> a contagem evoluiu e por que documentos anteriores traziam 457/465/475.

A Missão 15.1 encontrou duas contagens diferentes para `test:db` em documentos
da própria missão (**457** no §7 e `docs/PROGRESSO.md`; **465** na execução real
sobre `ed4e818`). Nenhuma das duas estava "inventada": a diferença tem causa
identificada e não indica teste perdido ou desativado.

| Commit | `tests/unit/hardening_borda.test.ts` | `test:db` | Observação |
|---|---|---|---|
| `234e14d` (base) | não existia | 441 | ponto de partida |
| `34b0102` | **17** casos reais | **458** | teto de corpo/CSV/env |
| `b065c55` | 17 casos | 458 | **§7 e PROGRESSO escritos aqui como "441 + 16 = 457"** |
| `9b5f378` | **24** casos (+7 guardas de CSP) | **465** | contagem mudou **depois** dos documentos |
| `ed4e818` | 24 casos | **465** | execução registrada da Missão 15.1 |
| Missão 15.1 | 24 casos | **475** | +7 (`tests/db/28`) +3 (`tests/db/22`) |
| Missão 15.2 | 24 casos | **496** | +10 (`tests/db/29`) +11 (`tests/db/30`) |

**Causa raiz — dois erros de um caso cada, não um teste perdido.**

O documento afirmava "441 + 16 = 457". O arquivo `hardening_borda.test.ts`
nunca teve 16 casos: no commit `34b0102` ele define **17** blocos `it(`
(16 nos quatro `describe` originais + 1 acrescentado em `CORS`), sem
`it.each`, sem `it.skip`/`todo` e sem `describe` condicional — ou seja,
17 casos reportados. Os 441 + 17 = **458** já eram a contagem real quando o
texto foi escrito, e a linha "457" carregou um erro de aritmética de 1.

Depois, `9b5f378` acrescentou 7 guardas de CSP (17 → 24) sobre um documento já
defasado, produzindo 441 + 24 = **465**. Foi esse número que a execução da
Missão 15.1 mediu em `ed4e818`.

A cadeia fecha por dois caminhos independentes:

```
441 + 17 = 458  → +7 = 465  → +10 = 475   (contagem a partir dos 17 reais)
475 − 10 − 7 = 458                        (retrocedendo a partir da medição)
```

Ambos chegam a **458** em `b065c55`. O "16" dos documentos era o erro; o
"457" era o "441 + 16" dele. Não houve teste removido, desativado ou pulado —
e a base de 441 em `234e14d` está correta. Os números canônicos abaixo são
todos **medidos**, e a contagem por inspeção estática de `it(` **não** é usada
como prova: em `tests/db` ela subconta (322 blocos para 475 casos) porque
vários arquivos geram casos dentro de laços.

**Números canônicos — Missão 15.2, commit `c276d5e`, execução de 2026-11-22:**

| Suíte | Resultado | Como foi obtido |
|---|---|---|
| `npm run typecheck` | **0 erros** | execução local, exit 0 |
| `npm test` (frontend) | **168/168** em 24 arquivos | execução local |
| `npm run test:db` | **496/496** em **40 arquivos** | execução local, PostgreSQL 18.6 em `127.0.0.1:55432`, rodado **duas vezes** com o mesmo resultado |
| `npm run build` | **OK**, 538 ms | execução local |
| `npm run bundle:functions` | **10/10** | execução local |
| `npm audit --omit=dev` | **0 vulnerabilidades** | execução local |
| `npm run test:e2e` | **não executável no sandbox** | `Chromium não encontrado` (`checkout.ts:30`) — **executa no CI** |

Total local: **168 + 496 = 664** provas.

### CI (a evidência que o sandbox não pode dar)

O `npm run test:e2e` não roda aqui, e o PostgreSQL do CI é o serviço
`postgres:18` do Docker — não o embutido. Por isso o CI não é redundante: é a
única execução que prova o pacote inteiro num ambiente diferente do meu.

| Run | Commit | Resultado | Passos |
|---|---|---|---|
| `45094216403` (push) | **`c276d5e`** | **success** | 11/11, incluindo E2E |
| `45094220192` (pull_request) | **`c276d5e`** | **success** | 11/11 |

Execuções anteriores (`36fee8f`: runs `44990193925` e `44990197938`;
`0e868fd`: `44989979102` e `44989982504`) também passaram, mas **não são o
resultado final** — o commit final é `c276d5e`.

Passos verificados: Typecheck · Suíte frontend · **Suíte de banco (PostgreSQL
real)** · Bundle · Chromium · **Jornada Chromium + WyviPay simulada**.

> O E2E verde no CI é a prova que faltava: a jornada de checkout com
> PostgreSQL real e WyviPay simulada passa, então as correções desta missão não
> tocaram o caminho de compra.

### Vercel Preview

| Item | Valor |
|---|---|
| Check na PR #15 | **pass** (`Vercel` e `Vercel Preview Comments`) |
| Deployment | `7988152607`, ambiente `Preview`, ref `c276d5e` |
| Estado | `success` — "Deployment has completed" |
| URL | `https://prime-store-6w2xg8d64-gabielrtxofc-9229s-projects.vercel.app` |

O preview está atrás do SSO da Vercel, então **não é possível verificar o
conteúdo servido** a partir deste sandbox (que também não tem saída de rede
para o domínio). O que está comprovado é o que a Vercel reporta: o build
concluiu com sucesso no commit final. Não trato a página de login do SSO como
resposta da aplicação.

A suíte cresceu em **+21 casos** nesta missão: 10 em
`tests/db/29_pg_net_permissoes.test.ts` (migração 0046 sobre topologia real) e
11 em `tests/db/30_bootstrap_admin.test.ts` (migração 0047). A base anterior
era 475 (ver §7-bis, registro histórico).

Artefatos do `build` desta execução: `index-D4nn5bjy.js` (324,49 kB / gzip
98,99 kB), `AdminPage-DYdJJtCo.js` (330,28 kB / gzip 82,94 kB),
`index-yyjqS_BQ.css` (119,93 kB / gzip 23,87 kB).

**Sobre o E2E:** o comando falha neste sandbox por ausência de Chromium — a
falha é de **ambiente**, não de produto, e o script não tem fallback que reduza
asserções (por desenho). A evidência de E2E é o **passo 11 do CI**, "Jornada
Chromium + PostgreSQL + WyviPay simulada", que executou com Chromium real e
passou. Não registro o E2E local como aprovado; registro o que ele é.

---

## 7-ter. Achado novo — deriva de schema em produção (`bootstrap_admin_*`)

Descoberto ao escrever os testes de auto-promoção (Tarefa 02). **Produção tem
duas funções que não existem em nenhuma migração versionada:**

| Função | `SECURITY DEFINER` | ACL | Migration |
|---|---|---|---|
| `bootstrap_admin_register(uuid, text, text)` | sim | `postgres`, `service_role` | **nenhuma** |
| `bootstrap_admin_status()` | sim | `postgres`, `service_role` | **nenhuma** |

`grep -r bootstrap_admin_register supabase/migrations/` → **0 arquivos**.
Elas foram criadas fora do controle de versão (provavelmente pelo SQL Editor).
É a mesma classe de problema das Edge Functions presas a commit fixo: o banco
de produção é a única fonte de verdade desse pedaço.

### O que essas funções fazem

`bootstrap_admin_register` insere em `admin_users` (a allowlist) e incrementa um
contador em `app_settings`; `bootstrap_admin_status` apenas lê o estado. O
desenho é **autolimitado e fechado por padrão**:

- exige `app_settings.admin_bootstrap_enabled = true` (ausente → `false`);
- permite no máximo **2** administradores, depois vira `false` sozinho;
- a ACL **não inclui** `anon` nem `authenticated` — só `postgres` e
  `service_role`, que é papel de backend;
- hoje produção tem **0 administradores**, então o bootstrap nunca foi aberto.

### Impacto classificado

**Não é escalada de privilégio de usuário final.** Sem `EXECUTE` para
`authenticated`, nenhum JWT comum alcança a função pelo PostgREST — a barreira
é de privilégio, não de validação de corpo. O risco real é outro:

1. **Reprodutibilidade:** recriar o banco a partir das migrações **não** recria
   essas funções. Um restore de produção por migração perde o provisionamento.
2. **Revisão:** funções `SECURITY DEFINER` que escrevem na allowlist existem
   fora do diff — não passam por revisão de código nem pela suíte local.

### O que foi feito (somente leitura + prova)

- testes travando que **nenhum** `bootstrap_admin%` é executável por
  `authenticated`, tolerante à ausência da função (o banco local não a tem);
- teste provando que **0** funções executáveis por `authenticated` escrevem em
  `public.admin_users`;
- registro aqui e em `DEPENDENCIAS-HUMANAS.md` para o operador decidir entre
  versionar o DDL (`pg_dump --schema-only` dessas duas funções) ou removê-las.

### Resolvido na Missão 15.2 — migração `0047`

A pendência deixou de ser aberta. A investigação de origem concluiu:

| Verificação | Resultado |
|---|---|
| `git log -S 'bootstrap_admin_register' --all` | só commits desta missão (documentação); histórico disponível começa em 2026-11-21 |
| `supabase/migrations/` | **0 arquivos** mencionam `admin_bootstrap` |
| `scripts/provision-admin.sql` | documenta o fluxo manual (SQL Editor) em `app_settings`/`admin_users` |
| Timestamp em produção | **um só**: 2026-11-20 14:44:33 UTC para as duas chaves |

**Conclusão:** bootstrap de **operação manual documentada**, não componente de
plataforma nem artefato gerenciado. A migração
`20261122130000_0047_versionar_bootstrap_admin.sql` recria as duas funções com a
definição lida do catálogo de produção (via `pg_proc.prosrc`, somente leitura),
mais os dois registros de `app_settings`, com:

- `SECURITY DEFINER` + `search_path = public, pg_temp` (mesmo padrão do projeto);
- `EXECUTE` **apenas** para `postgres` e `service_role` — nunca `anon`/`authenticated`;
- janela **fechada por padrão** (`admin_bootstrap_enabled = false`);
- autolimite de 2 administradores + auditoria em `admin_audit_log`.

Provado por `tests/db/30_bootstrap_admin.test.ts` (**11 casos**), incluindo que o
banco recriado por migrações passa a conter as duas funções e que um usuário
comum continua recebendo `permission denied`.

> Nota de método: a definição foi **copiada**, não reinventada. O corpo é
> idêntico ao que produção executa; o que a migração acrescenta é versionamento,
> `search_path` explícito e a garantia de que a janela nasce fechada.

---

## 7-quater. O defeito da 0046 que a 15.1 não viu (e por que os testes passaram)

A versão da 0046 entregue na 15.1 passou em todos os testes e **não teria
funcionado em produção**. Três erros independentes, todos fora do alcance da
suíte anterior:

| # | Defeito | Como se manifestaria em produção |
|---|---|---|
| 1 | Assinaturas escritas à mão e **erradas**: `net.http_post(text,jsonb,jsonb,**text**,integer)` e `net.http_delete(text,jsonb,jsonb,integer)` | `ERROR: function does not exist` no `db push` |
| 2 | `REVOKE` executado por `postgres`, que **não é dono** de `net.*` nem superusuário (`rolsuper = false`) | **no-op silencioso**: ACL idêntica antes/depois, sem exceção |
| 3 | `REVOKE ... FROM PUBLIC` removeria a única via pela qual o `postgres` executa `net.http_post` | o cron `prime-store-wyvi-worker` perderia a capacidade de enfileirar |

**Por que a suíte não pegou:** o banco local não instala `pg_net`
(`bootstrap_local.sql` não a cria), então o bloco inteiro era pulado pelo
`if exists (select 1 from pg_extension …)`. O único caminho testado era
"ambiente sem a extensão" — que é justamente o caminho onde nada acontece.

**Correção estrutural (não apenas de SQL):**

1. `tests/db/29_pg_net_permissoes.test.ts` recria `net.http_post`/`http_get`/
   `http_delete` com as **assinaturas reais** lidas do catálogo de produção e
   entrega a posse a um papel separado — a topologia que expõe os defeitos 2 e 3.
2. A migração passou a **descobrir** os alvos em `pg_proc` (nunca assinatura
   digitada), a **checar se pode revogar** e a **verificar o resultado**
   (`has_function_privilege` + `aclexplode`, `grantee = 0`), levantando exceção
   se a ACL continuar aberta.
3. Quando a sessão não pode revogar, a migração **avisa** com o dono real e a
   ação necessária — a limitação fica no log, não debaixo do tapete.
4. Não há `WHEN OTHERS THEN NULL`: se `pg_net` existe e as funções não são
   encontradas, é **exceção**, não silêncio.

**Segundo erro de método, encontrado no CI (e mais grave que o primeiro).** A
primeira versão desta suíte registrava a extensão escrevendo
`pg_net.control` + `pg_net--0.20.4.sql` em
`node_modules/@embedded-postgres/.../sharedir/extension` e chamando
`CREATE EXTENSION`. Funcionava na máquina onde os arquivos foram escritos — e
**nunca** no CI, onde o PostgreSQL é o serviço `postgres:18` do Docker e o
`node_modules` é recém-instalado a cada execução. No runner, o
`CREATE EXTENSION` falhava, o erro estava engolido por
`.catch(() => undefined)` (**proibido nesta missão**), e as asserções falhavam
em cascata com `function net.http_post(...) does not exist` — o mesmo `42883`
que a 0046 corrigida existe para evitar.

A correção foi remover a dependência falsa nas duas pontas:

| Antes | Depois |
|---|---|
| migração age se `pg_extension` tem `pg_net` | migração age se as **funções** existem em `pg_proc` |
| teste inventa um arquivo de controle para "instalar" a extensão | teste cria os objetos reais, com as assinaturas reais |
| extensão "simulada" só existe na máquina de quem escreveu | roda em qualquer PostgreSQL, inclusive `postgres:18` |

Essa mudança é melhor para a migração também: um PostgreSQL com os objetos de
`net` mas sem a linha em `pg_extension` é justamente o caso que a versão antiga
ignorava. O gate agora é o objeto, não o registro.

Um efeito colateral instrutivo: a primeira versão da verificação usava
`p.proacl like '%X/%'`, que **toda** concessão nominal satisfaz
(`postgres=X/postgres` contém `=X/`). O teste pegou o falso positivo; a
checagem passou a usar `aclexplode` com `grantee = 0`.

---

## 8. Pendências que exigem o operador

Ver [`DEPENDENCIAS-HUMANAS.md`](./DEPENDENCIAS-HUMANAS.md). Em resumo: nenhum
administrador real, nenhuma chave de pagamento, e-mail de Auth sem SMTP,
primeiro deploy com CSP a conferir no console, tamanho mínimo de senha, e a
deriva de schema `bootstrap_admin_*` (§7-ter).

---

## 8-bis. Reconciliação das oito Edge Functions (Tarefa 01)

Cada uma das oito funções foi reconciliada por **oito atributos**: slug,
`version`, `updated_at` (produção), `verify_jwt` (produção × `config.toml` ×
esperado), formato do corpo, correspondência de código, smoke real e estado.
"Não bateu" não é aceito como resposta: onde há divergência, ela está nomeada
com causa e consequência.

### Tabela de reconciliação

| # | Função | ver | `updated_at` (UTC) | `verify_jwt` prod | `config.toml` | Coincide? | Smoke em produção |
|---|--------|-----|--------------------|-------------------|---------------|-----------|-------------------|
| 1 | `catalog` | 9 | 2026-11-22 01:58:54 | `false` | `false` | **sim** | GET 200 + ACAO exata |
| 2 | `order-request` | 9 | 2026-11-22 02:23:04 | `false` | `false` | **sim** | 404 `product_unavailable` + ACAO |
| 3 | `delivery` | 9 | 2026-11-22 02:26:24 | `false` | `false` | **sim** | 404 `not_found` + ACAO |
| 4 | `wyvi-webhook` | 9 | 2026-11-22 02:20:19 | `false` | `false` | **sim** | 401 `invalid_signature` |
| 5 | `create-order` | 9 | 2026-11-22 02:28:12 | `false` | `false` | **sim** | 404 `product_unavailable` + ACAO |
| 6 | `order-status` | 9 | 2026-11-22 02:29:44 | `false` | `false` | **sim** | 404 `not_found` + ACAO |
| 7 | `admin-api` | 9 | 2026-11-21 23:35:39 | `true` | `true` | **sim** | **não** — bundle anterior |
| 8 | `wyvi-worker` | 9 | 2026-11-22 00:53:59 | `true` | `true` | **sim** | **não** — bundle anterior |

Todos os oito slugs estão `ACTIVE`, todos em `version = 9`, e o `verify_jwt`
de produção coincide com `supabase/config.toml` nos oito casos. **Nenhuma
divergência de autorização.** As seis de borda externa estão no código desta
missão; as duas com `verify_jwt = true` estão em bundle **anterior**.

### Achado A — `version` não prova nada; `updated_at` prova

As oito estão em `version = 9`. O número é uniforme porque todo slug nasceu
junto no provisionamento e foi bumpado em bloco pelos deploys anteriores — ele
**não distingue** bundle novo de antigo. Quem distingue é `updated_at`:
`admin-api` (21/11 23:35) e `wyvi-worker` (22/11 00:54) são anteriores a todo o
hardening; as outras seis foram reimplantadas entre 01:58 e 02:29.

**Correção de fato registrada:** a versão anterior deste relatório afirmava que
`create-order` e `order-status` também ficavam para o deploy por CLI, e
repetia o bloco "o que fica para o deploy" duas vezes com listas diferentes
(uma dizendo duas funções, outra dizendo quatro). A lista correta é **duas**:
`admin-api` e `wyvi-worker`. As seis foram implantadas e verificadas.

### Achado B — `ezbr_sha256` não é hash do código

`wyvi-worker` expõe `ezbr_sha256 =
64e9b63dd0f709e466fab005239188ff2e2f2403aefc093113b722be2b700e6b`, e o bundle
local tem sha256 `ab553d5bec72…` — hashes diferentes. **Isso não é divergência
de código**: `ezbr_sha256` é o digest do **eszip** (o arquivo comprimido que
embala os fontes), não do `.ts` empacotado. Comparar os dois seria comparar
coisas diferentes. Nenhum juízo de "código diferente" pode ser feito por esse
campo, e por isso ele não é usado como prova aqui.

### Achado C — commit não é build: a data do commit engana

A primeira leitura sugeria que `catalog` (01:58:54) era anterior ao commit do
teto (`34b0102`, 02:01:33) e portanto **estaria sem o teto de corpo**. A
inspeção do corpo implantado desmente a conclusão:

- o corpo implantado **usa** `readJsonOrEmpty`;
- `readJsonOrEmpty` **não existe** em `234e14d` (base) — ele nasceu em
  `34b0102`, quando `http.ts` passou a ter `MAX_REQUEST_BODY_BYTES`;
- logo, o bundle implantado em `catalog` contém código novo.

Explicação: o horário de um commit é o da **criação**, não o do build do
bundle. O empacotamento usado no deploy foi gerado do working tree já com a
correção, antes de o commit ser fechado (o commit ficou **17 minutos mais
novo** que a árvore de onde o bundle saiu). Consequência: "data do deploy <
data do commit" **não** é evidência de bundle antigo. É preciso inspecionar
símbolos, e a inspeção mostra que o teto está lá.

### Achado D — `wyvi-worker` implantada é eszip de fontes, não bundle

O corpo de `catalog` é um **JS inline autocontido** (começa em
`// Edge Function: catalog - bundle gerado por scripts/bundle-functions.mjs`).
O de `wyvi-worker` começa em `ESZIP2.3` e contém os `.ts` **crus**
(`import { createDeps } from '../_shared/deps.ts';`).

São **dois caminhos de deploy diferentes** — CLI/eszip para `wyvi-worker`,
inline para as demais. Isso importa para o operador: o próximo
`supabase functions deploy` reescreve `wyvi-worker` no formato eszip a partir
de `supabase/functions/wyvi-worker/index.ts`, e o conteúdo passa a bater com os
fontes deste commit. Nada no runtime atual depende do bundle inline.

### Correspondência de código nas duas pendentes

Para `admin-api` e `wyvi-worker` a comparação byte a byte é **impossível** com
os instrumentos disponíveis: `get_edge_function` devolve o corpo **truncado**
(o resultado do conector é cortado no meio, deterministicamente), e não há
`supabase` CLI autenticada no sandbox. O que se pode afirmar, e se afirma:

| Função | O que o bundle implantado tem | O que o commit tem | Risco |
|---|---|---|---|
| `admin-api` | `readBodyText`, leitor comum, sem teto de linha de CSV | teto de 4 MiB + `MAX_IMPORT_ROWS` + `truncated`/`import_too_large` | corpo grande é lido inteiro antes de falhar |
| `wyvi-worker` | eszip de fontes anteriores; `withCors` ausente | fontes com o hardening atual | sem CORS (é chamada só por cron/`service_role`) |

Nenhuma das duas perde **funcionalidade** por esperar: ambas têm
`verify_jwt = true`, então não são alcançáveis por visitante; `wyvi-worker` só
é chamada pelo cron (job 3, como `postgres`) e pelo `order-status`;
`admin-api` exige JWT de administrador e a checagem (`assert_admin`, ou
`is_admin` quando a intenção é só consultar) roda **no banco** — inalterada
pela 15.2. O risco aqui é de **recurso** (corpo grande), não de autorização.

### Smoke real (produção, via `pg_net`, respostas de `net._http_response`)

```
GET  catalog        Origin do site        → 200 + ACAO = origem exata
GET  catalog        Origin atacante.example → 200 SEM ACAO  (negado)
POST order-request  corpo normal           → 404 product_unavailable + ACAO
POST delivery       sem token              → 404 not_found + ACAO
POST wyvi-webhook   assinatura falsa       → 401 invalid_signature
POST create-order   produto inexistente    → 404 product_unavailable + ACAO
POST order-status   token curto            → 404 not_found + ACAO
POST catalog        corpo de 4,2 MB        → 413 payload_too_large
```

O último prova o teto **em produção**: 4,2 MB é recusado com **413**, não
processado (o teste unitário confirma o código: `MAX_REQUEST_BODY_BYTES`
levanta `ApiError(413, 'payload_too_large')`). Antes do deploy, o mesmo corpo
em `order-request` era aceito por inteiro e respondia 422 `invalid_items` só
depois de parsear tudo.

### Estado final

- **6 de 8** no código desta missão, com smoke real.
- **2 de 8** (`admin-api`, `wyvi-worker`) em bundle anterior, `verify_jwt=true`,
  sem exposição nova; alinhamento no próximo `supabase functions deploy` (ação
  do operador, proibida nesta missão).
- **0** divergências de `verify_jwt`.
- **0** funções em estado não-`ACTIVE`.

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
tests/unit/hardening_borda.test.ts                 (novo, 24 casos)
docs/auditoria/missao-15/*                         (este relatório)
```

### Adicionado pela Missão 15.1 (fechamento)

```
supabase/migrations/20261122120000_0046_reduzir_superficie_rpc.sql
tests/db/28_reducao_superficie_rpc.test.ts         (novo, 7 casos)
tests/db/22_admin_guardia_aal2.test.ts             (+3 casos: is_admin,
                                                    gatilho em auth.users,
                                                    escrita na allowlist)
docs/auditoria/missao-15/ADVISORS.md               (novo — Tarefa 03)
```

### Adicionado pela Missão 15.2

```
supabase/migrations/20261122120000_0046_reduzir_superficie_rpc.sql
    (REESCRITA — ver abaixo)
supabase/migrations/20261122130000_0047_versionar_bootstrap_admin.sql
    (novo — versiona bootstrap_admin_register/status lidos do catálogo)
tests/db/29_pg_net_permissoes.test.ts              (novo, 10 casos)
tests/db/30_bootstrap_admin.test.ts                (novo, 11 casos)
tests/db/helpers.ts                                (limpeza de resíduo de net)
tests/db/27_worker_schedule.test.ts                (substitutos sem depender
                                                    da ordem dos arquivos)
docs/auditoria/missao-15/*                         (ADVISORS, DEPENDENCIAS,
                                                    RELATORIO)
```

**O que a migração 0046 faz, definitivamente:**

| # | Comportamento | Como está provado |
|---|---|---|
| 1 | **Revoga `EXECUTE` da órfã `admin_stock_summary()`** de `PUBLIC`/`anon`/`authenticated`. Essa parte **funciona em produção**, porque a função pertence ao `postgres`. | `tests/db/29`, caso final; `postgres` e `service_role` preservados |
| 2 | **Descobre as funções reais de `pg_net`** em `pg_proc` pelo nome (`http_post`, `http_get`, `http_delete`) e aplica a assinatura do próprio catálogo (`oid::regprocedure`) — nunca um literal digitado. | casos B2/C/D; assinatura conferida contra o catálogo de produção |
| 3 | **Só revoga quando a sessão pode revogar** (dono do schema `net` ou superusuário). | casos B (sem posse) e B2 (com posse) |
| 4 | **Emite aviso explícito quando não pode revogar**, nomeando o dono real (`supabase_admin`) e a ação necessária — a pendência fica no log do `db push`, não é engolida. | caso B: ACL idêntica antes/depois, com `WARNING` |
| 5 | **Verifica o resultado** por `has_function_privilege` + `aclexplode` (`grantee = 0` = PUBLIC) e **levanta exceção** se a ACL continuar aberta. | caso B2 |
| 6 | **Não esconde falha**: sem `WHEN OTHERS THEN NULL`; se `net.*` existe e as três funções não aparecem, é exceção. | revisão do SQL + caso A |

**P7 permanece aberta:** aplicar a 0046 **não fecha `net.*` em produção**,
porque a sessão de migração (`postgres`) não é dona do schema nem superusuária
(`rolsuper = false`). O fechamento exige `supabase_admin` e é **ação
operacional pendente** — com o SQL exato em `DEPENDENCIAS-HUMANAS.md`. Não
está declarado como resolvido em nenhum lugar desta documentação.

Configuração de plataforma (não versionada): secrets `STORE_URL`,
`ALLOWED_ORIGINS`, `RATE_LIMIT_SECRET` em produção; `site_url`,
`uri_allow_list` e `disable_signup` do Auth de produção.
