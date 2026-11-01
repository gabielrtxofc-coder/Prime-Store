# Registro de progresso

> Atualizado em 2026-11-01. Este arquivo existe para que outra sessão consiga
> retomar o trabalho sem depender do histórico de conversa.

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
