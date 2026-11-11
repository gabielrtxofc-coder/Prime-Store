# Missão 14 — Primeiro deploy privado (Vercel Preview)

**Status: BLOQUEADA** (execução autônoma até o limite técnico).

Ambiente preparado, protegido e validado; **o deploy Preview não foi concluído**
porque a única rota de deploy disponível ficou bloqueada por limite de API do
GitHub na integração Vercel↔GitHub. Nenhum conteúdo da loja foi publicado em
nenhum endereço, público ou privado. `main` e o banco permanecem intactos.

Data da execução: 2026-11-11 (UTC).

---

## 1. Estado do repositório

| Item | Valor |
| --- | --- |
| Repositório oficial | `gabielrtxofc-coder/Prime-Store` (GitHub, público) |
| `main` (intacta) | `d1d48239a45058e800094fc170e73bc2b97fff3b` — confirmado em `git ls-remote` |
| Branch publicada | `arena/b2b66379-prime-store` |
| Commit publicado | `cd03201c8aa1dc17fbe9d0d170c826a7ee66a10c` (push confirmado no remoto) |
| PRs abertos | nenhum |
| PRs integrados | #1 a #5, todos `MERGED` |
| Branches remotas fora da `main` | existem branches `arena/*` antigas, **todas sem commit que não esteja na `main`** (`git log origin/main..origin/<branch>` vazio) |

O único commit desta missão é `cd03201` (configuração de deploy, sem mudança
funcional). Ele parte exatamente de `d1d4823`, o commit da Missão 13 já
integrado. Não houve merge, push na `main` nem alteração de histórico.

## 2. Estado da Vercel

| Item | Valor |
| --- | --- |
| Time | `gabielrtxofc-9229's projects` (`team_MTazL7wh6ICDJvbEZLg4x4fW`), plano Hobby |
| Projeto | `prime-store` — `prj_pVhaf3jVffFX24OK5GjAZNZz4vvC` (criado nesta missão) |
| Framework | Vite (estático, sem funções serverless) |
| Instalação | `npm ci` |
| Build | `npm run build` (`tsc -b && vite build`) |
| Saída | `dist` |
| Deploy automático por Git | **desativado** (`gitProviderOptions.createDeployments: disabled`) — nenhum push dispara deploy |
| Ambiente usado | nenhum deploy concluído (0 deployments na conta) |
| Endereço Preview | **não existe** |

Endereços do projeto (verificados por HTTP): `prime-store-gilt.vercel.app`
(alias de produção) e qualquer preview retornam `404 DEPLOYMENT_NOT_FOUND`.
Não há loja publicada em lugar algum.

### Configuração adicionada ao repositório

`vercel.json` — framework/instalação/build/saída explícitos, rewrite de SPA
(`/(.*) → /index.html`) para as rotas do `BrowserRouter` (`/produtos`,
`/produto/:slug`, `/entrega/:token`, `/admin`…), cache imutável para `/assets`
e cabeçalhos `X-Content-Type-Options`, `Referrer-Policy` e `X-Frame-Options`.
Não contém variável, segredo ou integração de pagamento.

## 3. Segurança

### Proteção de acesso na Vercel

| Verificação | Resultado |
| --- | --- |
| Vercel Authentication | **ATIVA** e herdada do padrão do time em todos os projetos novos |
| Escopo atual do projeto | `ssoProtection.deploymentType = all_except_custom_domains` (**Standard Protection**) |
| Escopo exigido pela missão | `all` (**All Deployments**) — **NÃO configurado** |
| Motivo | O conector Vercel disponível não expõe ferramenta para alterar Deployment Protection (somente leitura; `update_project` aceita apenas `name/framework/build/install/output/root` e o próprio schema rejeita o campo `ssoProtection`). O sandbox não tem egress para `api.vercel.com`, então a API/CLI não podem ser usadas. |
| Contraprova | `PATCH /v9/projects/{id}` com `{"ssoProtection":{"deploymentType":"all"}}` é o caminho documentado — depende de token, **não solicitado** por política |

Observação técnica relevante: como o projeto **não tem domínio de produção**
(nenhum deploy de produção jamais existiu) e o deploy automático por Git está
desligado, o alias `prime-store-gilt.vercel.app` não serve conteúdo. A
consequência prática é que, hoje, não há endereço público expondo a loja.

### Teste de privacidade

| Teste | Resultado |
| --- | --- |
| Acesso anônimo ao alias de produção | `404 DEPLOYMENT_NOT_FOUND` (nada exposto) |
| Acesso anônimo a host de preview do projeto | `404 DEPLOYMENT_NOT_FOUND` (sem deploy) |
| Acesso autenticado | não aplicável — não há deploy para validar |
| Conclusão | **inconclusivo para o critério da missão** (não há endereço a testar). Não declarei privacidade de um endereço que não existe. |

### Variáveis de ambiente

- Vercel: **nenhuma** variável criada (`list_env_vars` vazio). Não copiei nada
  de produção para Preview.
- Supabase (leitura): o projeto tem segredos de runtime das Edge Functions
  (nomes: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`, `SUPABASE_DB_URL`,
  `SUPABASE_JWKS`, `DEMO_PAYMENT_ENABLED`, `DEMO_ALLOWED_PROJECT_REFS`,
  `STORE_URL`, `ALLOWED_ORIGINS`). Nenhum valor foi impresso nem alterado.
- Verificação por hash (sem revelar valores): `STORE_URL = http://localhost:5173`;
  `DEMO_PAYMENT_ENABLED = true`; `DEMO_ALLOWED_PROJECT_REFS = eorlmqolbknrplvdbbtl`.
  Ou seja, o modo de pagamento demonstrativo está ligado **no sandbox** apoiado
  pelas três travas previstas no projeto (segredo + ref do projeto + flag no
  banco). Nenhuma chave de provedor de pagamento (`MP_*`/`WYVI_*`) está presente.

### Supabase

| Item | Valor |
| --- | --- |
| Projeto | `prime-store-sandbox` — ref `eorlmqolbknrplvdbbtl`, região `sa-east-1`, `ACTIVE_HEALTHY` |
| É o mesmo banco de produção? | **Sim** — existe **um único** projeto Supabase na conta; não há separação produção/preview |
| Operações executadas | **somente leitura** (`list_projects`, `list_secrets`, `list_api_keys`) |
| Escritas, migrações, seeds, criação de usuários | **nenhuma** |
| Testes que tocariam o banco | **nenhum** — a suíte de banco usou PostgreSQL local descartável (ver §4) |

Consequência registrada, conforme exigido: **qualquer** ambiente Preview usa o
mesmo banco do sandbox. Sem variáveis configuradas no Preview, a loja sobe sem
backend. E `ALLOWED_ORIGINS` nas Edge Functions é uma lista fechada (origem
exata), então um preview em `*.vercel.app` só conseguiria chamar o backend
depois de incluir essa origem manualmente — decisão que exige cautela porque o
banco é o mesmo.

### Chaves e segredos

- Nenhum `.env` versionado: o `.gitignore` cobre `.env` e `.env.*` e só libera
  `.env.example` / `.env.functions.example` (placeholders). Confirmado com
  `git ls-files`.
- Nenhuma chave privada no código: a varredura não encontrou JWT, `service_role`
  ou token de provedor em `src/`; o frontend só lê `VITE_*` públicos
  (URL do Supabase, chave `anon`, base das funções e flags).
- Nenhum valor de segredo foi impresso neste relatório.

### Pagamentos

Não configurei nada, não usei chave de produção, não disparei cobrança,
transferência ou webhook. Nenhuma configuração comercial/financeira foi tocada.

## 4. Testes

| Verificação | Comando | Resultado |
| --- | --- | --- |
| Instalação limpa | `npm ci` | OK — 142 pacotes, 0 vulnerabilidades |
| Testes de frontend | `npm test` | **136/136** (18 arquivos) |
| Testes de banco/back-end | `npm run test:db` (PostgreSQL local em `127.0.0.1:55432`) | **308/308** (26 arquivos) |
| Verificação de tipos | `npm run typecheck` | OK, 0 erros |
| Build de produção | `npm run build` | OK — `dist/` com 4 arquivos (JS/CSS/HTML) |
| Config de deploy | `vercel.json` | válido |

Sobre `test:db`: na primeira tentativa o PostgreSQL local não estava no ar e o
comando falhou em 23 arquivos (não reportei “aprovado” por ter iniciado). Subi o
banco embutido do projeto (`npm run db:local`) e repeti: 308/308. **O banco do
Supabase não foi tocado em nenhum momento.**

O smoke das Edge Functions (`npm run smoke:functions`) não foi executado: ele
exige saída de rede para o Supabase, indisponível neste sandbox.

## 5. Alterações

- `vercel.json` (novo) — configuração de deploy descrita no §2.
- `docs/missao-14-primeiro-deploy-preview.md` (este arquivo).
- Commit: `cd03201` na branch `arena/b2b66379-prime-store` (push feito).
- Nenhum PR aberto (não é necessário; nada foi integrado à `main`).
- Nenhuma alteração funcional.

### Incidente registrado (não escondido)

Durante a Fase 6, o conector só aceita `target` como `production`, `staging` ou
ambiente customizado — **não aceita `preview`**, e um deploy por arquivos sem
`target` foi criado como **produção**. Era um placeholder explícito (“Esta
implantação não contém a loja”), sem qualquer código da Prime Store; foi
**excluído imediatamente** (`dpl_7AfbcGf8kH8PjXKuj81aCvuk4WDN`) e a conta
voltou a 0 deployments (confirmado por listagem e por HTTP 404 no alias). Não
houve exposição da loja, mas o evento entra no relatório.

## 6. Pendências manuais (dependem de ação humana)

São poucas e todas curtas. A ordem importa:

1. **Ativar All Deployments** — Vercel → projeto `prime-store` → *Settings* →
   *Deployment Protection* → *Vercel Authentication* → escopo **All
   Deployments** → *Save*. (Recurso gratuito em todos os planos; o conector não
   expõe essa configuração e o sandbox não tem egress para a API.)
2. **Conectar o repositório e publicar um Preview** — *Settings* → *Git* →
   conectar `gabielrtxofc-coder/Prime-Store` e selecionar a branch
   `arena/b2b66379-prime-store` (ou rodar `vercel` no projeto local escolhendo
   **Preview**). O deploy automático por Git está desligado de propósito; se
   quiser, ligue-o depois, mantendo **Production Branch** apontando para uma
   branch que não seja a de trabalho.
3. **Validar a privacidade** — abrir a URL do Preview numa janela anônima: o
   esperado é a tela de login da Vercel; depois, autenticado, a loja deve
   carregar.
4. **Decidir as variáveis do Preview** — nada foi configurado. Se quiser a loja
   funcionando de verdade no Preview, defina `VITE_BACKEND_ENABLED`,
   `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` (somente valores públicos) e
   inclua a origem do Preview em `ALLOWED_ORIGINS` no Supabase. Lembre que o
   banco é o mesmo: leia antes do §3 (Supabase).
5. **Retry do deploy por Git** — o bloqueio é de cota de API do GitHub usada
   pela integração da Vercel, que não expõe o tempo de reset. Costuma liberar ao
   longo do dia; nada no repositório precisa mudar.

## 7. Situação dos critérios finais

| Critério | Situação |
| --- | --- |
| Repositório correto identificado | ✅ |
| Branch validada | ✅ (`arena/b2b66379-prime-store`, commit `cd03201`) |
| `main` preservada | ✅ `d1d4823`, intocada |
| Testes aprovados | ✅ 136/136 + 308/308 |
| Build aprovado | ✅ |
| Deploy Preview concluído | ❌ bloqueado (cota GitHub na integração) |
| Vercel Authentication ativa | ⚠️ ativa em Standard Protection; All Deployments pendente |
| Acesso não autorizado bloqueado | ⚠️ não aplicável (nenhum deploy) |
| Acesso autorizado confirmado | ❌ não aplicável |
| Nenhuma alteração no banco | ✅ só leitura |
| Nenhum pagamento real | ✅ |
| Nenhuma chave privada exposta | ✅ |
| Relatório final entregue | ✅ |

**Conclusão: BLOQUEADA.** O ambiente está pronto, os testes e o build passam, a
`main` está intacta e não há nada publicado — mas o endereço Preview privado
que a missão pede ainda não existe. Os cinco passos do §6 fecham a missão.
