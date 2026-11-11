# Missão 14 — Primeiro deploy privado (Preview na Vercel, protegido)

**Data:** 2026-11-11 · **Repositório:** `gabielrtxofc-coder/Prime-Store`
**Branch publicada:** `arena/4cd168c1-prime-store` · **Commit exato:** `10cc7b8afd37d1f47ae22b77efa3d8aad708eeb6`
**Projeto Supabase (inalterado):** `eorlmqolbknrplvdbbtl` (prime-store-sandbox, região sa-east-1)

> **CLASSIFICAÇÃO GERAL: BLOQUEADA.**
> Toda a preparação verificável foi concluída (reconhecimento, auditoria de
> segurança, correção de deploy, suíte completa e build), mas **nenhum deploy
> foi criado** e **o endereço de Preview não existe**. A Vercel recusou três
> tentativas de criação do deployment com **HTTP 429 — "GitHub API rate limit
> exceeded"** (limite da integração GitHub↔Vercel, não da sessão), e a proteção
> "All Deployments" não pode ser aplicada pelo conector disponível.
> **Não há URL pública a divulgar, e nenhuma foi divulgada.**

---

## 1. Estado do repositório

| Item | Valor verificado |
| --- | --- |
| Repositório oficial | `gabielrtxofc-coder/Prime-Store` (`id` numérico `1438803943`, público, default `main`, permissão da sessão ADMIN) |
| `main` — commit | `d1d48239a45058e800094fc170e73bc2b97fff3b` (2026-11-10 03:35:45 -0300, merge do PR #5) — **intacto, byte a byte**, antes e depois desta missão |
| `main` — recebeu push? | **NÃO.** `git ls-remote` ao final: `refs/heads/main = d1d4823…` (inalterado) |
| Branch publicada | `arena/4cd168c1-prime-store` → `10cc7b8afd37d1f47ae22b77efa3d8aad708eeb6` (antes: `d1d4823`, idêntico à `main`) |
| Commits desta missão | **1** — `10cc7b8` `chore(deploy): adiciona vercel.json com fallback SPA e cabeçalhos básicos` (1 arquivo, +22 linhas) |
| PRs | Os 5 PRs do histórico estão **MERGED**; nenhum aberto. Nenhum PR novo foi aberto (não solicitado nesta missão) |

### 1.1 Reconhecimento completo (FASE 1)

- **Todas as branches remotas** (16) foram baixadas de novo (`git fetch
  --unshallow +refs/heads/*`) porque o clone local era *shallow* de 1 commit —
  a verificação anterior ("só existe `main`") era **artefato do clone raso** e
  foi corrigida aqui.
- Branches com commits **não integrados** à `main`:

| Branch | Commits fora da `main` | Conteúdo | Situação |
| --- | --- | --- | --- |
| `arena/b2b66379-prime-store` | 1 (`cd03201`, 2026-11-11 12:51Z) | `vercel.json` (+22) | **parcialmente aproveitada** (ver §5) |
| `arena/a81a96ef-prime-store` | 10 | feature Missão 03/04 (`609b493`…): *todas* as 30 migrações e todo o `src` já estão na `main` em versão posterior | superada |
| `arena/aa4e6a29-prime-store` | 1 | fechamento M09 (docs + scripts) — conteúdo reconstruído na M13 | superada |
| `arena/3b67fee3-prime-store` | 1 | `docs/missao-10-reconciliacao-final.md` | já presente na `main` (arquivo existe); merge commit `f1b060e` está na `main` |
| `arena/4d7b2f32-prime-store` | 1 | `docs/auditoria/missao-08-wyvipay/RELATORIO.md` (816 linhas) | **arquivo ausente na `main`** (ver Pendência 6.5) |

- **Funcionalidades aprovadas nas missões anteriores, conferidas na árvore
  publicada:** painel `/admin` com chunk sob demanda + login + TOTP/AAL2;
  catálogo/checkout/solicitação sem pagamento; entrega privada por token;
  8 Edge Functions empacotáveis; 42 migrações versionadas. Nada regrediu
  (suíte completa verde, §4).
- **Stack:** Vite 8.3.5 + React 18 + TypeScript 5.7 + Vitest 5; npm
  (`package-lock.json`, lockfileVersion 3); `engines.node = ^22.22.2 ||
  ^24.15.0 || >=26.0.0` (sandbox: Node 22.22.3, ✅).
- **Projeto Vercel:** `prime-store` = `prj_pVhaf3jVffFX24OK5GjAZNZz4vvC`,
  time `team_MTazL7wh6ICDJvbEZLg4x4fW` (hobby). ⚠️ **Não há git link
  configurado** (`gitProviderOptions.createDeployments = "disabled"`,
  `gitComments` sem repo, **0 GitHub Deployments**, **0 environments**, **0
  check-runs** no repositório, **0 webhooks** acessíveis). Ou seja: o projeto
  **não está conectado** ao repositório correto — o deploy só existe por
  criação explícita via API/conector.

## 2. Estado da Vercel

| Item | Valor |
| --- | --- |
| Projeto | `prime-store` (`prj_pVhaf3jVffFX24OK5GjAZNZz4vvC`), time `gabielrtxofc-9229s-projects`, plano hobby |
| Framework / preset | `vite` |
| Install / Build / Output | `npm ci` / `npm run build` / `dist` |
| Root directory | vazio (raiz do repositório) |
| Node.js do projeto | `26.x` (compatível com `engines`) |
| Domínios | `prime-store-gilt.vercel.app` (domínio de **produção** do projeto) |
| Deployments existentes | **0** (`list_deployments` → lista vazia; `hasDeployments: false`) |
| Variáveis de ambiente | **0** cadastradas (nenhum alvo: production/preview/development) |
| Histórico | 2026-11-11: projeto criado, **1 deploy de produção** feito pelo painel, **apagado** no mesmo minuto (eventos `uev_3GKbn4`, `uev_V09TPfOq`). Nenhuma criação posterior |
| Git link | **ausente** (ver §1.1) |
| Endereço de Preview desta missão | **NÃO EXISTE** |

### 2.1 Por que o deploy não foi criado (registro honesto)

1. `create_deployment` (git_source `github`/`ref: arena/4cd168c1-prime-store`/`repoId: 1438803943`,
   `target: null`, projeto `prj_pVhaf3jVffFX24OK5GjAZNZz4vvC`) →
   **429 Too Many Requests**: *"GitHub API rate limit exceeded"* — a API da
   Vercel precisa consultar o GitHub em nome da integração e essa cota está
   esgotada (a cota da **sessão** está intacta: 4999/5000).
2. Repetido após **5 minutos de espera** (mesmo payload e variação de
   `git_source`/`project`) → **mesmo 429**. A janela de reset não é informada
   pela Vercel; o limite de repositório (por hora) pode levar até ~1 hora.
3. Egress do sandbox para `api.vercel.com`, `vercel.com` e
   `*.vercel.app` está **bloqueado** (`SSL_ERROR_SYSCALL`, HTTP 000), e não há
   token/CLI da Vercel no ambiente — portanto não existe caminho alternativo
   por CLI para criar o deployment daqui.
4. **Risco adicional descoberto (impede usar a CLI como atalho):** a Vercel
   documenta que **o primeiro deployment de um projeto novo é SEMPRE de
   produção**, mesmo sem `--prod`, com `--target=preview`, ou a partir de
   branch que não é a de produção — e ele é construído com as variáveis de
   **Production**. Este projeto tem 0 deployments ⇒ o próximo deployment é,
   por definição, "o primeiro". Criar via CLI "sem --prod" **seria** um deploy
   de produção. Por isso a única tentativa feita foi pela API com `target`
   omitido (Preview), e nenhuma tentativa por CLI foi realizada.

## 3. Segurança

### 3.1 Proteção de deployment (Vercel Authentication)

| Item | Estado verificado |
| --- | --- |
| Time (padrão para novos projetos) | `ssoProtection.deploymentType = all_except_custom_domains` (**Standard Protection**, não "All Deployments") |
| Projeto `prime-store` | `ssoProtection.deploymentType = all_except_custom_domains` (Standard Protection). Vercel Authentication **está ligada**, escopo **Standard** — cobre preview e deployment URLs, **não** garante o domínio de produção |
| Escopo exigido pela missão | **All Deployments** (`deploymentType: "all"`) — **NÃO configurado** |
| Ferramenta disponível | O conector Vercel expõe 40 ferramentas; **nenhuma** altera `ssoProtection` (`update_project` aceita apenas nome/framework/build/install/output/root). A API pública aceita `ssoProtection` (`PATCH /v9/projects`), mas `api.vercel.com` é **inalcançável** do sandbox e não há token local |
| Plano | O escopo "All Deployments" com Vercel Authentication está **incluído no Hobby** (docs: *"Vercel Authentication for All Deployments … do not require a paid add-on"*) — a limitação é de ferramenta, não de plano |

**Consequência:** a missão exige "All Deployments" confirmado antes de
publicar. Não foi possível configurar nem confirmar. → **BLOQUEADA**
(instrução manual em §6.1).

### 3.2 Teste de privacidade sem autenticação

| Alvo | Resultado |
| --- | --- |
| Endereço de Preview desta missão | inexistente — **nada a testar** |
| `prime-store-gilt.vercel.app` (domínio de produção do projeto) | `fetch_page` → **404 `DEPLOYMENT_NOT_FOUND`** (`iad1::pqbrz-…`): o projeto não serve nenhum conteúdo hoje |

Não existe hoje nenhuma superfície pública servindo a Prime Store a partir da
Vercel. Isso é **estado verificado**, não promessa.

### 3.3 Segredos e chaves

Varredura própria (16 padrões: JWT, `sb_secret_`, `sbp_`, `APP_USR-`, chave
privada PEM, tokens GitHub/Vercel/Stripe/AWS/Google/Slack, URL de Postgres com
senha, atribuições genéricas de segredo):

- **Árvore publicada** (256 arquivos de texto de 282 rastreados): **0**
  achados reais. As 17 ocorrências brutas foram todas conferidas linha a linha:
  URL de Postgres **de teste local** (`postgres:postgres@127.0.0.1`), literais
  fictícios de teste (`'SEGREDO-DE-TESTE'`, `'senha-super-secreta'`,
  `'segredo-ficticio-do-webhook'`) e **leituras** de configuração no servidor
  (`deps.config.mercadoPagoAccessToken` etc.).
- **Histórico completo** (59 commits de todas as branches e tags; 96.715
  linhas adicionadas): **0** segredos, **0** arquivos `.env` reais (apenas
  `.env.example` e `.env.functions.example`), **0** chaves privadas.
- **Bundle de produção** (`dist/`): 0 JWT, 0 `APP_USR-`, 0
  `service_role`/`SERVICE_ROLE`, 0 `PRIME_ENCRYPTION_KEY`, 0 `MP_*`, 0 ref do
  projeto Supabase, 0 URL de Postgres, 0 source maps. A única ocorrência de
  `sb_secret_` é uma **constante da biblioteca** `@supabase/functions-js` que
  **detecta** chaves secretas para recusá-las no navegador.
- **Chave de criptografia das credenciais:** não está em env nem no código; vem
  do **Supabase Vault** (`scripts/…/0023`), lida por função restrita a
  `service_role`. Nenhum `PRIME_ENCRYPTION_KEY` nos 11 secrets do projeto.
- `.gitignore` cobre `.env`, `.env.*` (com exceção dos dois exemplos),
  `.local/`, `node_modules/`, `dist/`, `supabase/.temp/`.
- ⚠️ `.vercel/project.json` **não** está no `.gitignore` (não existe hoje; se
  a CLI for usada, adicionar `.vercel/` antes de commitar).

### 3.4 Superfície administrativa e dados

- `/admin` não expõe dado privado por si: o chunk `AdminPage-*.js` é público
  (é só a interface); a autorização real é `admin-api` (JWT) + `assert_admin()`
  (allowlist + AAL2) no banco. **Nenhuma conta de admin existe** (`auth.users =
  0`, `admin_users = 0`) — não há login administrativo possível hoje.
- Nenhum e-mail/UUID/telefone real versionado: todos os e-mails do repositório
  são fictícios (`@exemplo.com`, `comprador@teste.com`, placeholders
  `<EMAIL_REAL_ADMIN_1@dominio.com>`). `siteConfig.supportContact` é vazio.
- **Supabase (somente leitura):** único projeto = `prime-store-sandbox`
  (`eorlmqolbknrplvdbbtl`). **É o mesmo projeto de produção/sandbox** (não há
  segundo projeto). 42 migrações registradas, **8/8 Edge Functions ACTIVE**
  (admin-api v5 `verify_jwt=true`; demais v5–v8 `false`), 11 secrets
  inventariados **por nome** (sem `MP_*`, sem `WYVI_*`, sem
  `PRIME_ENCRYPTION_KEY`).
- **Baseline de dados preservado** (SELECT de contagem): `products 2`,
  `orders 8`, `stock_units 27`, `payments 3`, `deliveries 3`,
  `admin_users 0`, `auth.users 0` — idêntico ao congelado na M12/M13.
  **Nenhuma escrita, migração, seed ou criação de usuário foi feita.**

### 3.5 Pagamentos

Nenhuma referência a WyviPay em código (só em `docs/`). Nenhuma chave de
produção, nenhum `MP_ACCESS_TOKEN` configurado ⇒ `create-order` responde 503
`payment_not_configured`; o modo demonstrativo exige 3 travas simultâneas.
**Nada foi ativado ou alterado.**

### 3.6 Variáveis de ambiente na Vercel (0 cadastradas) — impacto real

A loja **funciona sem nenhuma variável**: cai no modo demonstração (catálogo
local, sem rede). Consequências por recurso, para quando o operador configurar
(§6.2):

| Variável | Alvo | Efeito de estar ausente |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Preview | catálogo/checkout/painel usam dados locais |
| `VITE_SUPABASE_ANON_KEY` | Preview | idem (chave **pública**, pode ir ao bundle) |
| `VITE_BACKEND_ENABLED` | Preview | deve ser `true` para sair do modo demonstração |
| `VITE_BACKEND_URL` | Preview | opcional (default `${VITE_SUPABASE_URL}/functions/v1`) |
| `VITE_ADMIN_DEMO` | Preview | **manter `false`/ausente** aqui: existem contas de admin reais a criar e o painel demonstrativo usa dados fictícios |

⚠️ **CORS das Edge Functions:** com o frontend na Vercel, `ALLOWED_ORIGINS`
(secret do Supabase) precisa incluir a origem do Preview, sem o que o navegador
bloqueia as respostas. **Não alterei o secret** (autorização não cobre mudar
secrets e a origem exata só existe depois do deploy) → instrução em §6.3.

## 4. Testes e verificações (executados de fato)

### 4.1 Baseline antes da alteração (`main` = `d1d4823`)

| Verificação | Comando | Resultado |
| --- | --- | --- |
| Instalação limpa | `npm ci` | exit 0 · 142 pacotes · **0 vulnerabilidades** |
| Integridade da árvore | `npm ls --all` | exit 0 · 0 `missing/invalid/extraneous` |
| Auditoria (todas / produção) | `npm audit` · `npm audit --omit=dev` | **0** e **0** |
| Typecheck | `npm run typecheck` | exit 0 |
| Testes de frontend | `npm test` | **136/136** (18 arquivos) |
| Testes de banco/back-end | `npm run test:db` (PostgreSQL **local** 127.0.0.1:55432, migrações do zero) | **308/308** (26 arquivos) |
| Build de produção | `npm run build` | exit 0 · 4 arquivos · 656 KB |
| Bundle das Edge Functions | `npm run bundle:functions` | **8/8** |

### 4.2 Depois da alteração (árvore publicada `10cc7b8`)

| Verificação | Resultado |
| --- | --- |
| `vercel.json` é JSON válido | ✅ (7 chaves; rewrite e headers lidos pelo Node) |
| Semântica do rewrite (arquivo existente vence; senão `index.html`) | ✅ `/`, `/produtos`, `/produto/piano-digital`, `/admin`, `/entrega/token-inexistente`, `/faq`, `/checkout` → `200` servindo `index.html`; `/assets/*.js|.css` → `200` servidos como arquivo, com `Cache-Control: public, max-age=31536000, immutable` |
| Headers declarados | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` em todas as rotas |
| `npm run typecheck` | exit 0 |
| `npm test` | **136/136** |
| `npm run test:db` (PostgreSQL **local**) | **308/308** |
| `npm run build` | exit 0 (mesmos 4 arquivos) |
| `npm run bundle:functions` | **8/8** |
| `npm audit` | **0 vulnerabilidades** |

> O servidor de validação do rewrite é um `http.createServer` local que
> reproduz a precedência documentada da Vercel (arquivo do build antes da
> rewrite) — **não** é a Vercel. A validação definitiva só ocorre com o deploy.

### 4.3 O que NÃO foi executado (e por quê)

- `npm run test:all` — redundante (é a soma de `test:db` + `test`).
- Testes que tocam o Supabase remoto: **proibidos** pela missão e, além disso,
  o egress para `*.supabase.co` está bloqueado no sandbox.
- `npm run smoke:functions`: exige rede para `*.supabase.co` e credencial anon
  (ausentes no sandbox); continua sendo tarefa da máquina do operador.
- Deploy/Preview, teste de acesso sem autenticação e teste com conta
  autorizada: **não executáveis** sem deployment.

## 5. Alterações

| Arquivo | Mudança | Motivo (indispensável ao deploy) |
| --- | --- | --- |
| `vercel.json` (**novo**, +22 linhas) | `framework: vite`, `installCommand: npm ci`, `buildCommand: npm run build`, `outputDirectory: dist`, rewrite de SPA `"/((?!assets/).*)" → "/index.html"` e 3 cabeçalhos | O repositório **não tinha nenhuma configuração de hospedagem**; é uma SPA com `BrowserRouter` (17 rotas: `/produtos`, `/admin`, `/entrega/:token`…). Sem o fallback, qualquer acesso direto a `/admin` — exatamente o que os administradores farão — responde **404** antes de o app carregar. Reference: documentação Vercel (SPA sem fallback = 404 em refresh/entrada direta) |

- Base comparativa: a branch `arena/b2b66379` (não mesclada) propunha um
  `vercel.json` equivalente. Aproveitei o conteúdo necessário (framework,
  install/build/output, rewrite de SPA, cache de `/assets`, cabeçalhos
  `nosniff`/`Referrer-Policy`/`X-Frame-Options`) e **corrigi um risco** dela:
  a rewrite original (`"/(.*)"`) capturava **também** `/assets/*`, o que
  mascara 404 de asset como `200 text/html` (e quebra o cache imutável do
  bundle); a minha exclui `/assets/` explicitamente.
- **Nenhuma mudança funcional**: 0 alterações em `src/`, `supabase/`, `tests/`,
  `scripts/`. Nenhuma variável, segredo, integração ou configuração de banco
  tocada.
- Commit: `10cc7b8afd37d1f47ae22b77efa3d8aad708eeb6` na branch
  `arena/4cd168c1-prime-store` (push feito **somente** dessa branch).

## 6. Pendências manuais (o que realmente precisa de um humano)

> Nesta ordem. Nada abaixo foi feito por mim.

**6.1 — Ativar a proteção no escopo exigido (fazer ANTES do deploy)**
1. Painel da Vercel → projeto `prime-store` → **Settings → Deployment
   Protection**.
2. Em **Vercel Authentication**, escolher **All Deployments** (não "Standard
   Protection") e **Save**.
3. Conferir no painel que o texto passa a indicar *all deployments* — é essa a
   evidência que a missão exige. (Na API: `PATCH /v9/projects/{id}?teamId=…`
   com `{"ssoProtection":{"deploymentType":"all"}}`; disponível no plano Hobby,
   mas sem ferramenta no conector e com `api.vercel.com` inacessível daqui.)

**6.2 — Criar o deployment de Preview (depois de 6.1)**
- O motivo do bloqueio foi cota da integração GitHub↔Vercel (429). Opções:
  1. **Painel → projeto `prime-store` → Deployments → "Deploy" escolhendo a
     branch `arena/4cd168c1-prime-store`** — evita a criação por API;
  2. **Conectar o repositório** em Settings → Git (hoje não há git link) e
     fazer push de um commit na branch `arena/4cd168c1-prime-store`;
  3. **CLI na sua máquina** — ⚠️ **somente com o projeto já tendo um deployment
     de produção**, porque a Vercel força o **primeiro** deployment a ser de
     produção; use `vercel deploy --target=preview` (ou `gitBranch` da branch)
     e confirme no painel o rótulo **Preview**.
  - **Nunca** `vercel --prod`, nunca promover Preview para Production, nunca
    apontar domínio.
- Atalho alternativo (recriar o deployment de Preview pela API, se preferir
  que eu tente de novo mais tarde): a mesma chamada de `create_deployment`
  com `git_source: {"type":"github","ref":"arena/4cd168c1-prime-store","repoId":"1438803943"}`,
  `target: null`, projeto `prj_pVhaf3jVffFX24OK5GjAZNZz4vvC`.

**6.3 — Variáveis de ambiente (Preview) e CORS**
- Na Vercel → Settings → Environment Variables, alvo **Preview** (e nunca
  Production sem decisão explícita): `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY` (chave **pública**), `VITE_BACKEND_ENABLED=true`.
  Não copiar `SUPABASE_SERVICE_ROLE_KEY`, `PRIME_ENCRYPTION_KEY`, `MP_*` para
  o frontend em nenhuma hipótese.
- No Supabase → Edge Functions → Secrets: acrescentar a origem exata do
  Preview (ex.: `https://prime-store-<hash>-<time>.vercel.app`) em
  `ALLOWED_ORIGINS`, **sem** remover as atuais. Sem isso o navegador bloqueia
  as chamadas por CORS (sintoma: `OPTIONS` 204 sem `access-control-allow-origin`).
- **Aviso registrado:** o projeto Vercel tem **0 variáveis**. Se o deploy de
  Preview for criado sem 6.3, a loja abre em **modo demonstração** (catálogo
  local) e não haverá login/admin real — o que é inofensivo, mas não serve para
  "continuar a configuração".

**6.4 — Teste de privacidade obrigatório (depois de 6.2)**
- Abrir a URL de Preview em **janela anônima sem sessão Vercel** → deve
  aparecer a tela de login da Vercel ("Authentication Required"), **não** a
  loja. Se a loja abrir, o deploy deve ser **removido** e a missão tratada como
  bloqueada.
- Abrir a mesma URL logado na conta `gabielrtxofc-9229` → deve abrir a loja.
- Registrar print/horário dos dois testes.

**6.5 — Dívida histórica encontrada (não corrigida aqui, sem relação com o deploy)**
- `docs/auditoria/missao-08-wyvipay/RELATORIO.md` (816 linhas) existe **apenas**
  na branch `arena/4d7b2f32-prime-store`; a `main` tem só `DIAGNOSTICO.md` e
  `DEPENDENCIAS-HUMANAS.md` nessa pasta. Decidir se o relatório deve ser
  recuperado (branch/PR próprios) — não fiz porque não é necessário ao deploy.
- `.vercel/` deveria entrar no `.gitignore` **antes** de qualquer uso da CLI.

---

## Apêndice A — Checklist da missão

| Critério | Estado |
| --- | --- |
| Repositório correto identificado | ✅ `gabielrtxofc-coder/Prime-Store`, `id 1438803943` |
| Branch validada com o trabalho aprovado | ✅ `arena/4cd168c1-prime-store` @ `10cc7b8` |
| `main` preservada | ✅ `d1d4823` antes e depois; nenhum push |
| Testes apropriados passando | ✅ 136/136 (frontend) + 308/308 (banco local) |
| Build passando | ✅ `tsc -b && vite build` (local = comando da Vercel) |
| Deploy de Preview realizado | ❌ **bloqueado** — 429 da integração GitHub↔Vercel |
| Vercel Authentication em "All Deployments" | ❌ **não configurável** pelo conector (hoje: Standard Protection) |
| Acesso não autorizado bloqueado (testado) | ❌ sem deployment para testar |
| Acesso autorizado confirmado | ❌ idem |
| Nenhuma alteração de banco | ✅ 0 escrita; contagens idênticas ao baseline |
| Nenhum pagamento real | ✅ 0 ativação; `MP_*` inexistente |
| Nenhuma chave privada exposta | ✅ árvore, histórico e bundle limpos |
| Relatório final entregue | ✅ este documento |

**Conclusão:** **BLOQUEADA** — bloqueios externos e reais (cota GitHub da
integração Vercel + ausência de ferramenta para o escopo "All Deployments"),
sem nenhum atalho inseguro tomado. Preparação 100% concluída e reexecutável
assim que os dois itens de §6.1 e §6.2 forem resolvidos.
