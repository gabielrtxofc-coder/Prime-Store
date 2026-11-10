# Registro de progresso

> Atualizado em 2026-11-09. Este arquivo existe para que outra sessão consiga
> retomar o trabalho sem depender do histórico de conversa.

## Missão 08 (reconciliação Supabase) — migrações aplicadas; funções/smoke BLOQUEADOS

Relatório completo: [`missao-08-reconciliacao-supabase.md`](./missao-08-reconciliacao-supabase.md).

- **Aplicadas no remoto** (aditivas, via `create_migration` 2026-11-09 17:14–17:16Z):
  `m08_0034_pedidos_multiproduto`, `m08_0035_pagamento_multiproduto`,
  `m08_0036_entrega_multiproduto`, `m08_0037_bloqueio_solicitacao_sem_pagamento`,
  `m08_0038_motivos_ajuste_estoque`. 0033 preservada (já aplicada ×2 no histórico);
  0030 confirmada no histórico (`grants_rls_public_catalog`).
- **Verificação pós-aplicação:** 20/20 tabelas com RLS; 0 policies; 0 grants
  anon/authenticated; 61 funções SECURITY DEFINER com `search_path` fixo; 23 funções de
  `authenticated` (só `admin_*` + `is_admin`); dados inalterados (products 2, orders 8,
  stock_units 27, admin_users 0); cron ativo, 0 falhas; cofre com chave AES-256-GCM de
  32 bytes íntegra; `internal_confirmation_enabled=false`.
- **BLOCKED (honestamente):** republicação de `admin-api` no remoto (ferramentas de
  função sem efeito nesta sessão; rede para `*.supabase.co` inalcançável) — a ação
  `stock.setStatus` remota ficaria quebrada após a 0038 e está inalcançável
  (`auth.users=0`); smoke HTTP (sem rede/anon key); verificação de backup (conector sem
  ferramenta); provisionamento dos 2 admins (faltam dados reais).
- **Corrigido:** contagem "9 funções" → 8 (docs M06/PROGRESSO); `bundle-functions.mjs`
  com `charset: 'utf8'`.
- **Classificação:** **PARCIAL** (local OK: `npm test` 127/127; bundles 8/8; test:db
  293/293 @ `c644e1e`). `main` intacta; PR #2 intacto; tag de segurança intacta.

## Missão 07 (ativação operacional) — parte local CONCLUÍDA; remota BLOQUEADA

Relatório completo: [`missao-07-ativacao-operacional.md`](./missao-07-ativacao-operacional.md).

- **Bloqueio raiz (remoto):** app Supabase `disabled` nesta conversa + rede para
  `*.supabase.co` inalcançável. Migrações 0033→0038 **não** aplicadas no real;
  nenhuma Edge Function publicada; nenhum admin real provisionado; nenhuma
  evidência de produção. Para concluir: ligar o app Supabase nesta conversa.
- **Entregue e verificado localmente (commit `f046a82`):**
  - diálogos de confirmação (confirmação explícita) para TODA ação destrutiva do
    painel (ativar/desativar produto, desativar/reativar unidade, importar CSV,
    revogar/rotacionar entrega, disputas, reembolsos, liberar reservas) — foco
    inicial em Cancelar, Esc/fundo cancelam, anti-duplo-clique;
  - migração **0038** — motivos categorizados de ajuste de estoque
    (enum `stock_adjustment_reason`; desativação exige motivo; `other` exige nota
    ≥ 5 chars; reativação limpa), gateway 422 estáveis, UI com seleção obrigatória;
  - resiliência: auth fora do ar → **503 `auth_unavailable`** (falha fechada);
    queda total do banco comprovada sem vazar internos; `is_admin` fail-closed;
  - **testes:** 127/127 unit + **293/293** (PG local, 38 migrações do zero);
    typecheck limpo; build OK; bundles 8/8 auto-contidos;
  - re-auditoria: 0 tabelas sem RLS, 0 funções para anon, allowlist exata para
    authenticated, 0 segredos em 247 arquivos, zero arquivos de pagamento no diff.
- **Pendente de entrada humana:** ligar o app Supabase; dados reais dos 2 admins
  (nome + e-mail Auth) para o provisionamento com TOTP.
- **Classificação:** CONCLUÍDA (local) / BLOQUEADA (remota) / **PARCIAL (geral)**.
  `main` intacta (`8f37527`); PR #2 draft; sem deploy; sem merge.

## Missão 06 (painel operacional) — auditoria completa, um defeito corrigido

Relatório completo: [`missao-06-painel-operacional.md`](./missao-06-painel-operacional.md).

- **Auditoria do Supabase/banco:** 22 tabelas com RLS; anon/authenticated sem GRANT
  em tabela; acesso só por funções `SECURITY DEFINER`; `assert_admin()` com AAL2;
  ENUMs de pedido/pagamento/estoque/entrega; estoque por unidades (sem contador);
  histórico = `admin_audit_log` + `order_events` + trigger de preço.
- **Corrigido (defeito real):** `admin-api` aceitava `from`/`to` arbitrários e
  `limit`/`offset` via `Number()` — valores inválidos viravam erro 500 do PostgreSQL.
  Agora `optionalIsoTimestamp` (422) e `boundedInt` (faixa segura) em
  `orders.list`, `stock.list` e `audit.list`. Nada mudou no caminho feliz.
- **Novo:** `tests/db/20_admin_api_http.test.ts` (12 casos): 401/400/422/503 estáveis,
  CRUD de produto e `stock.add` **por HTTP persistidos no banco real** (trigger de
  preço e auditoria verificados por SQL; duplicado → 409).
- **Resultado:** `npm test` 118/118; `npm run test:db` **276/276** (+12); typecheck
  limpo; build OK; 8 funções empacotam; 54/54 telas do painel sem estouro nas 9
  larguras; loja pública inalterada.
- **Fora desta missão (dependência externa):** rede para `*.supabase.co` (ausente no
  ambiente), provisionamento dos dois administradores, chave `PRIME_ENCRYPTION_KEY`
  e decisão de pagamentos (loja vende solicitação sem pagamento; WyviPay não
  implementada). `main` intacta; PR #2 draft; sem deploy.

## Missão 06 (revisão independente) — bordas do fluxo corrigidas

Relatório completo: [`auditoria/missao-06/RELATORIO.md`](./auditoria/missao-06/RELATORIO.md).

- **Corrigido — estoque preso:** `catalog` não expirava reservas vencidas e o
  botão de compra esgotado impedia o cliente de gerar o tráfego que liberava a
  reserva. O handler agora chama `expire_overdue_reservations` antes de ler a
  disponibilidade (falha só loga). Ao vivo: reserva envelhecida + **um**
  `GET /catalog` → pedido `expired`, unidade devolvida ao estoque.
- **Corrigido — checkout morto:** replay idempotente de pedido
  `failed`/`expired`/`cancelled` respondia `200` com `payment: null`; o
  navegador limpava o carrinho e abria uma tela sem saída. Agora responde `409
  previous_attempt_closed` e o checkout renova chave + token e repete uma vez.
  Ao vivo: `409` confirmado depois do deploy (`create-order` v6).
- **Corrigido — capabilities do modo demo:** `GET /demo-payment` consultava só o
  segredo do ambiente; passou a exigir também `demo_payments_enabled` no banco.
- **Mantido de propósito:** `mp-webhook` aceita notificação sem assinatura
  quando falta `MP_WEBHOOK_SECRET` (comportamento coberto por teste da Missão
  04; o handler reconfere o pagamento no provedor). Registrado como pendência.
- **Testes:** `npx tsc -b` limpo, `npx vitest run` **70/70** (9 arquivos),
  `test:db` **148/148** (12 arquivos, PostgreSQL 18.6 local), `vite build` OK.
  Novos: `tests/db/10_auditoria_missao06.test.ts` (9) e
  `src/pages/checkoutRetry.test.tsx` (2); ambos falham no código anterior.
- **Supabase:** publicadas `catalog` v6 e `create-order` v6. Nenhuma migração,
  grant ou credencial alterada; `demo-payment` segue v3.
- **Produção:** **não pronta** (pagamento real, administradores, modo demo
  desligado, domínio/CORS, expiração agendada e limite de abuso pendentes).

## Missão 05 (revisão final da V1) — segurança fechada, produção pendente

Relatório completo: [`auditoria/missao-05/RELATORIO.md`](./auditoria/missao-05/RELATORIO.md).

- **Corrigido — catálogo público:** a view `public_catalog` era legível por `anon`
  no PostgREST. Migração `0030` aplica `security_invoker = true` e revoga
  `SELECT` de `anon`/`authenticated` (mantém `service_role`). Ao vivo:
  `GET /rest/v1/public_catalog` → `401 42501`; `GET /functions/v1/catalog` →
  `200` com 2 produtos.
- **Corrigido — CORS:** nenhuma função responde mais `*`. Novo
  `_shared/cors.ts` compara o `Origin` com a lista `ALLOWED_ORIGINS` +
  `STORE_URL`; as 7 funções foram reimplantadas (`catalog` v5, `create-order` v5,
  `order-status` v4, `delivery` v4, `demo-payment` v3, `mp-webhook` v4,
  `admin-api` v4). Origem estranha recebe `204` sem `Access-Control-Allow-Origin`.
- **Investigado — estoque:** a diferença vinha da semeadura de demonstração
  (+5 unidades fictícias por produto) e de 1 venda de teste, não de perda de
  dados. Ledger fecha: mensal 14 (11 disponíveis + 3 vendidas), avulso 13.
- **Testes:** `npm run typecheck` limpo, `npm test` **68/68**, `npm run test:db`
  **139/139** (11 arquivos) com PostgreSQL 17.11 real local, `npm run build` OK.
  Novo `tests/db/09_modo_demonstrativo.test.ts` (10) cobre as migrações
  `0026`–`0029`, inclusive `demo_real_stock_blocked`.
- **Verificado ao vivo:** catálogo → pedido (`PS-Q56ZCP`) → reserva de 30 min →
  aprovação simulada → entrega decifrada; `404` para token inválido; `409` ao
  reaprovar; `0` eventos de Mercado Pago.
- **Produção:** **não pronta**. Faltam pagamento real validado, administradores
  cadastrados, modo demonstrativo desligado e domínio final em
  `STORE_URL`/`ALLOWED_ORIGINS`.

## Missão 04 (integração frontend ↔ backend) — V1 funcional no sandbox

Relatório completo: [`auditoria/missao-04/RELATORIO.md`](./auditoria/missao-04/RELATORIO.md).

- **Ligado de ponta a ponta:** catálogo (`catalog`), pedido (`create-order`),
  acompanhamento (`order-status`), entrega (`delivery`) e aprovação simulada
  (`demo-payment`) — todos verificados por HTTP real no sandbox.
- **Novo no banco (0026–0029):** coluna `products.is_demo`, `payment_mode` no
  pedido, `demo_payments_enabled` em `app_settings`, RPC de aprovação simulada,
  semeadura de unidades fictícias com limite próprio e privilégios restritos.
- **Nova Edge Function:** `demo-payment` (7ª), com três travas (segredo, lista de
  refs permitidas, `app_settings`) e recusa de estoque real
  (`demo_real_stock_blocked`); reaproveita `apply_payment_status('approved')`.
- **Frontend:** catálogo e disponibilidade reais, quantidade limitada pelo
  estoque, tela de pagamento com polling de 5 s, bloco "Modo de demonstração"
  (sem PIX falso) e link privado de entrega; painel admin com modo demonstrativo
  local claramente rotulado, sem atalhos no backend.
- **Testes:** 67 de frontend, typecheck e build limpos. `npm run test:db` não rodava
  neste ambiente (sem binários de PostgreSQL); a verificação equivalente foi
  feita por HTTP contra as funções publicadas. (Na missão 05 a suíte de banco
  passou a rodar localmente com PostgreSQL embutido.)
- **Pendências:** e-mails dos administradores (provisionamento real),
  `MP_ACCESS_TOKEN`/`MP_WEBHOOK_SECRET` (pagamento real), desligar o modo
  demonstrativo antes de qualquer uso que não seja sandbox.

## Missão 03 (hardening e integridade) — concluída, com 3 bloqueios externos

Estado detalhado em [`auditoria/missao-03/REGISTRO.md`](./auditoria/missao-03/REGISTRO.md);
relatório com evidências em [`auditoria/missao-03/RELATORIO.md`](./auditoria/missao-03/RELATORIO.md).

- **Corrigido na raiz:** sequestro de pedido por chave de idempotência repetida;
  chargeback tratado como reembolso concluído; 3 funções sem `search_path`;
  `token_enc` devolvido pelo RPC de status; chave de criptografia fora do ambiente versionado.
- **Novo:** índice da FK `stock_units.import_batch_id`; remoção de 3 índices
  redundantes (`0025`); `admin_resolve_dispute`;
  status `disputed` no painel e nos indicadores.
- **Banco:** 25 migrações no repositório, **23 aplicadas** no sandbox
  `eorlmqolbknrplvdbbtl`; invariantes re-medidos (41 `SECURITY DEFINER`, 0 sem
  `search_path`, 0 executáveis por `anon`, 0 tabelas sem RLS).
- **Edge Functions:** 6 implantadas e `ACTIVE` (`catalog`, `create-order`,
  `order-status`, `delivery`, `mp-webhook`, `admin-api`).
- **Testes:** 115 de banco + 57 de frontend, typecheck e build limpos.

Bloqueado por dependência externa (nada declarado como validado):
`MP_ACCESS_TOKEN`/`MP_WEBHOOK_SECRET` de teste; e-mails dos dois administradores;
egress de rede para invocar as funções e reexecutar os Advisors do painel.

## Missão 09 — Fechamento operacional (2026-11-09)

**Estado geral: PARCIAL — não pronta para lançamento e sem merge.** Relatório completo: [`missao-09-fechamento-operacional.md`](missao-09-fechamento-operacional.md).

Concluído e comprovado:
- Supabase `eorlmqolbknrplvdbbtl` correto; migrações 0034–0038 no histórico remoto; 8 Edge Functions remotas; RLS em 20/20 tabelas.
- Assinatura remota `admin_set_stock_unit_status(uuid,text,text,text)` conferida; código local de `admin-api` já usa os parâmetros pós-0038, mantém JWT de usuário/AAL2 e bundles sem credenciais.
- Contagens de dados batem com as referências; `max_items_per_order=10`, `internal_confirmation_enabled=false`; pagamentos não foram alterados.
- `npm test` 127/127; `npm run test:db` 294/294; bundle 8/8; typecheck e build aprovados.
- Smoke de Edge Functions restringido a chamadas sem escrita; script de provisionamento agora deixa SQL de inserção comentado até haver UUIDs/nome reais.

Ainda pendente/bloqueado:
- `admin-api` remota permanece v4, `verify_jwt=true`; não há confirmação de publicação corrigida.
- Smoke HTTP externo não foi executado (conector não oferece invocação e faltou credencial pública utilizável no ambiente).
- Backup/PITR não pode ser consultado pelo conector; estado **não confirmado**.
- `auth.users=0`, `admin_users=0`; provisionamento real e TOTP dependem do operador.
- PR #2 continua draft e aponta para `arena/66cda9f6-prime-store`, mas a sessão foi vinculada à branch fixa `arena/529cc4db-prime-store`; alterações desta sessão não atualizam aquele PR automaticamente.
- Tag `safety/m07-start-cd87b3d` não apareceu nas tags consultadas do remoto; precisa de esclarecimento, sem recriação automática.

Não declarar pronto para lançamento até a publicação, smoke real, backup, admins/TOTP e reconciliação de branch/PR serem comprovados. Nenhuma migração reaplicada, nenhum dado real alterado, nenhuma integração de pagamento ativada e nenhum merge executado.

## Missão 02 (backend) — histórico

### Banco de dados (`supabase/migrations`, 16 arquivos na missão 02)

- `0001` tipos/enums · `0002` fundação/configuração · `0003` administração ·
  `0004` catálogo/produtos · `0005` estoque · `0006` pedidos/reservas ·
  `0007` pagamentos · `0008` entregas · `0009` integridade/índices ·
  `0010` view pública · `0011` funções de núcleo · `0012` funções admin ·
  `0013` triggers · `0014` RLS/grants · `0015` comentários · `0016` seeds.
- 17 tabelas, 41 funções, 6 enums, 1 view pública, RLS em todas as tabelas.
- Aplicado e verificado no projeto sandbox `prime-store-sandbox`
  (`eorlmqolbknrplvdbbtl`): 17 tabelas, 17 com RLS habilitado, 41 funções com
  as mesmas assinaturas do repositório, 5 categorias e 3 parâmetros
  (`reservation_minutes`, `pix_expiry_minutes`, `max_quantity_per_order`),
  0 unidades de estoque e 0 administradores (dependem de ação externa).
  Nenhuma função pública ficou com EXECUTE para `PUBLIC`/`anon`.
- Verificação de privilégios executada no projeto remoto (resultado real):

```
anon lê stock_units ................ false
anon lê orders ..................... false
anon executa create_order .......... false
anon executa get_catalog ........... false
authenticated executa admin_* ...... true
authenticated executa apply_payment_status ... false
public_catalog ..................... 2 linhas, 0 disponíveis (sem estoque)
setting_int(reservation_minutes) ... 30
setting_int(pix_expiry_minutes) .... 30
```

- Histórico remoto: as migrações foram aplicadas pelo conector do Supabase com
  nomes lógicos (`foundation`, `admin_authorization`, `products_catalog`, …) e o
  repositório consolidou os mesmos objetos em 16 arquivos ordenados. A paridade
  foi conferida por assinaturas de função, contagem de tabelas/RLS e view.

### Edge Functions (`supabase/functions`)

- `_shared/`: `crypto`, `http`, `config`, `rest`, `mercadopago`, `csv`,
  `validation`, `mappers`, `deps` + handlers.
- Endpoints: `catalog`, `create-order`, `order-status`, `delivery`, `mp-webhook`,
  `admin-api` (17 ações administrativas).
- Bundle autocontido: `node scripts/bundle-functions.mjs` → `.local/functions-build/`.

### Frontend

- `src/services/backend/` (config, http, catálogo), `orderService`,
  `adminAuth`, `adminApi`.
- Catálogo real com fallback local (`catalogService` + `useCatalog`).
- Checkout de produto único → `create-order` → `/pagamento` (QR, copia-e-cola,
  polling, contagem regressiva) → `/entrega/:token`.
- Painel `/admin` (carregado sob demanda): login, TOTP, visão geral, produtos,
  estoque (incluindo importação CSV com prévia), pedidos.
- Novas rotas e estilos; bundle dividido (público ~278 kB, admin ~257 kB).

### Testes

- `npm run test:db` → **70/70** (6 arquivos: banco, handlers e unitários).
- `npm test` → **57/57** (frontend, jsdom). `npm run test:all` → **127/127**.
- `npx tsc -b` e `npm run build` sem erros.

## Arquivos criados/modificados nesta missão

```
supabase/config.toml                          (novo)
supabase/local/bootstrap_local.sql            (novo, somente local)
supabase/migrations/*.sql                     (16 arquivos)
supabase/functions/**                          (6 funções + _shared)
scripts/bundle-functions.mjs                  (novo)
tests/db/{helpers,pgRpc,0*.test.ts}           (novo)
tests/unit/{crypto_csv_mp.test.ts,fakeMp.ts}  (novo)
src/services/backend/*                        (novo)
src/services/{catalogService,orderService,adminAuth,adminApi}.ts
src/pages/{PaymentPage,DeliveryPage}.tsx      (novo)
src/pages/admin/*                             (novo)
src/hooks/useCatalog.ts, src/lib/{links,format}.ts
src/App.tsx, src/types.ts, src/pages/CheckoutPage.tsx, src/data/faqs.ts
src/styles.css
.env.example, package.json, package-lock.json
docs/*                                        (novo)
```

## Problemas encontrados e correções

| Problema | Correção |
| --- | --- |
| `anon`/`authenticated` sem USAGE no schema `public` (schema recriado pelo bootstrap) | `grant usage on schema public` na migração `0014` |
| `create_order`, `get_catalog`, `resolve_delivery` acessíveis por `anon` | Nenhuma função é executável por `anon`; cliente passa sempre pelas Edge Functions |
| Handler administrativo usava cliente com a service role (auth.uid() nulo) | `rpcForUser(authorization)` — RPC com o JWT do usuário |
| `bytea` retornado do PostgREST em hex | Funções devolvem `encode(...,'base64')` |
| Migration de grants criada depois das funções de catálogo (`admin_stock_fingerprints` ficou pública) | Regras consolidadas em `0014` (revoke global + concessões explícitas) |
| `resolve_delivery` devolvia credenciais de pedido não pago em cenário artificial | Teste garante negação para pedido não pago |
| Frontend: link de entrega absoluto quebrava roteamento interno | `deliveryPath()` mantém sempre a rota `/entrega/:token` |

## Pendências

1. Deploy das 6 Edge Functions no projeto sandbox (bloqueio de rede local).
2. Criar 2 usuários no Supabase Auth + registrar UUIDs em `admin_users`.
3. Configurar secrets: `PRIME_ENCRYPTION_KEY`, `STORE_URL`,
   `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `MP_NOTIFICATION_URL`.
4. Executar o checklist de sandbox do Mercado Pago (`docs/mercado-pago.md`).

## Próxima ação sugerida

```bash
supabase link --project-ref eorlmqolbknrplvdbbtl
supabase db push
node scripts/bundle-functions.mjs
supabase functions deploy catalog create-order order-status delivery admin-api
supabase functions deploy mp-webhook --no-verify-jwt
```

Depois: criar os administradores, cadastrar 1 produto + 1 unidade de estoque pelo
painel e percorrer o fluxo de compra com uma conta de teste do Mercado Pago.

## Missão 10 — Reconciliação final (2026-11-09)

Relatório: [missao-10-reconciliacao-final.md](missao-10-reconciliacao-final.md).
M09 recuperada integralmente na branch fixa `arena/3b67fee3-prime-store`: único
commit exclusivo `1de28ddbc0f568ab5de26bcc67a3d8a36bf0a318`, cinco arquivos, sem
conflitos. Integração oficial será feita por PR intermediário para a branch
`arena/66cda9f6-prime-store`, mantendo PR #2 como único caminho à main.

Revalidação local: 127/127, 294/294, typecheck, build e bundles 8/8 aprovados;
audit sem vulnerabilidades. Nenhuma escrita Supabase. Conector desativado:
os resultados remotos M08/M09 são históricos, não revalidados nesta missão.
Correção da assinatura admin-api/0038 já existia desde M07. Deploy, HTTP real,
backup/PITR e admins reais/TOTP continuam pendentes; pagamentos congelados.
Estado do merge ainda pendente no momento deste registro pré-integração;
encerramento com SHAs e resultado efetivo será anexado ao PR #2.
**Não pronta para lançamento.**

## Missão 11 — Preparação autônoma de lançamento (2026-11-09)

Relatório: [missao-11-preparacao-autonoma.md](missao-11-preparacao-autonoma.md).
Branch `arena/6296b54a-prime-store` sobre `main` `0edf709`. Execução real em
9 grupos (A–I), todos **APROVADOS**; **prontidão de lançamento: 60%**
(preparação autônoma 100%; pendências 100% operacionais/humanas — §10 do
relatório).

- **Grupos A–C:** auditoria estrutural (40 migrações, 8 funções, 0 TODOs),
  reconciliação docs 08/09/10, inventário de pendências; adminApi auditado
  (4 argumentos de estoque = 0038, JWT do usuário via `rpcForUser`, AAL2,
  fail-closed); loja + ciclo de pedido + painel exercitados.
- **Grupo D (segurança):** varredura dinâmica nova em toda função `admin_*`
  (`tests/db/22`, 7 casos: fonte com `assert_admin`, anon sem EXECUTE, AAL1 →
  `mfa_required`, estranho AAL2 → `not_admin`, âncora da 0040) + payload do
  checkout travado (`src/services/requestService.test.ts`, 5 casos, nenhum
  campo de preço sai do navegador). +12 testes, 0 removidos/afrouxados.
- **Grupo E (visual):** Chromium headless real (puppeteer-core +
  @sparticuz/chromium), 8 larguras × 16 rotas = **160 checks, 0 falhas**;
  1 bug real corrigido (`/produto` a 320px — `styles.css` `minmax(0,1fr)` +
  `min-width:0`); evidências em `docs/missao-11-evidencia/` (JSON + 16 PNGs).
- **Grupo F (pagamentos/WyviPay):** novo `docs/wyvipay-integracao.md`
  sintetizado do RELATORIO M08 (endpoints apenas os citados, **zero
  implementação**); **R1** (cobrança multi-item) atualizado para
  **mitigado no banco** por `0034`/`0035` (resta ligar o handler); nota de
  bloqueio remoto da Missão 10 atualizada (conector supabase
  *conectado mas desligado* — nenhuma consulta remota na M11).
- **Grupo G (correções):** F1 demo local no painel; F2 teto de 10 itens no
  carrinho; F3 toasts/avisos de erro; F4 **migração `0039`**
  (`idempotency_conflict` estável + replay seguro na solicitação); F5
  regeneração de identidade pós-409 no checkout; **migração `0040`**
  (`admin_list_orders` passa a devolver `items_count`). **`0039`/`0040`
  criadas localmente, NÃO aplicadas remotamente — pendência do operador.**
- **Grupo H (suíte final):** `npm test` **136/136** (18 arq), `test:db`
  **304/304** (25 arq, PostgreSQL local em `.local/pgdata`, porta 55432),
  `tsc -b` 0, `vite build` 0, `bundle:functions` **8/8**,
  `npm audit --omit=dev` **0**. Baseline M11 era 127/127 e 294/294.
- **Grupo I:** relatório + este registro + commits organizados + PR para
  `main` **sem merge** (link anexado abaixo após a abertura).

Pendências críticas seguem inalteradas: publicação das 8 Edge Functions,
aplicação de `0039`/`0040` no real, admins reais + TOTP, backup/PITR,
tag M07, revisão jurídica, WyviPay D1–D11. **Não pronta para lançamento.**

**PR da Missão 11 (aberto, sem merge):** https://github.com/gabielrtxofc-coder/Prime-Store/pull/4
(origem `arena/6296b54a-prime-store` → `main`; 6 commits organizados por grupo).
