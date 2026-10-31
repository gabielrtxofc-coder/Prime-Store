# Missão 04 — Integração do frontend com o backend

Relatório de execução. Escopo: fazer o frontend já existente operar sobre o
backend já construído (Supabase sandbox + Edge Functions), com pagamento
**simulado** apenas no sandbox. Sem novo planejamento, sem expansão de
infraestrutura, sem deploy de produção.

- Projeto Supabase: `prime-store-sandbox` — ref `eorlmqolbknrplvdbbtl` (único projeto tocado)
- Branch: `arena/a81a96ef-prime-store` (nada foi enviado para `main`)
- Data: 2026-10-31

---

## 1. O que passou a funcionar

| # | Critério da missão | Situação | Onde |
|---|---|---|---|
| 1 | Catálogo vindo do backend | ✅ | `catalog` → `catalogAdapter` → `CatalogContext` |
| 2 | Disponibilidade real | ✅ | `availableUnits` do servidor; card e página de produto |
| 3 | Criação de pedido pelo backend | ✅ | `create-order` (idempotência + client token já existentes) |
| 4 | Reserva de estoque por 30 min | ✅ | `app_settings.reservation_minutes = 30` |
| 5 | Acompanhamento por `order-status` | ✅ | polling de 5 s em `PaymentPage` |
| 6 | Aprovação simulada (sandbox) | ✅ | Edge Function `demo-payment` |
| 7 | Entrega pelas regras normais | ✅ | `apply_payment_status('approved')` → `resolve_delivery` |
| 8 | Reconsulta por link privado | ✅ | `/entrega/:token` → `delivery` |
| 9 | Painel admin conectado | ⚠️ preparado, sem conta real | `admin-api` intacto + modo demonstrativo local |
| 10 | Identidade visual e estados | ✅ | `styles.css`, estados de carregamento/erro/expiração |

Nada de PIX fictício é exibido: quando o pedido é de demonstração o `payment` é
`null` e a tela mostra apenas o bloco de simulação.

---

## 2. Modo de pagamento demonstrativo (fase D)

### Como o servidor decide

O modo só existe se **as três condições** forem verdadeiras, sempre conferidas na
Edge Function (nunca no navegador):

1. segredo `DEMO_PAYMENT_ENABLED=true` no projeto;
2. `DEMO_ALLOWED_PROJECT_REFS` contém a ref do projeto atual;
3. chave `demo_payments_enabled=true` em `app_settings`.

Fora disso a função responde `404` — inclusive em qualquer projeto de produção
para o qual o código venha a ser copiado sem os segredos.

Além disso, `demo-payment` só atua sobre pedidos cujo produto/unidade seja
`is_demo = true`. Tentativa de simular aprovação em estoque real é recusada com
`demo_real_stock_blocked`.

### Fluxo

```
POST /demo-payment { action: 'approve', order_id, client_token }
  → valida posse do pedido (client_token) + estado + reserva válida
  → registra o pagamento com provider 'demo'
  → chama o MESMO apply_payment_status(id, 'approved')
  → consome as unidades reservadas, gera entrega e link privado
  → devolve { demo, result, order_status, payment_status, delivery_status }
```

O navegador **não** altera estado de pedido: só envia a prova de posse. Não há
botão que faça `update` em tabela alguma.

### Como desligar

```sql
update app_settings set value = 'false'::jsonb where key = 'demo_payments_enabled';
```
e remover/zerar o segredo `DEMO_PAYMENT_ENABLED`. Instruções no rodapé de
`scripts/enable-demo-mode.sql`. O frontend também esconde a simulação quando o
servidor informa `demo_enabled: false`.

---

## 3. Contratos verificados por HTTP real (sandbox)

Chamadas feitas de dentro do sandbox (o ambiente local não tem egress para
`*.supabase.co`), via extensão `http` no schema auxiliar `verif`, contra as
funções publicadas:

| Chamada | Resultado |
|---|---|
| `GET /catalog` | `200`; dois produtos demo com `isDemo: true`, `availableUnits` 4 e 3 |
| `GET /demo-payment` | `200` `{"demo_enabled":true,"mode":"demo"}` |
| `POST /create-order` (mensal, qty 1) | `201`; pedido `2bdfa275-1e27-4e4e-a75b-fb09fb766feb`, ref `PS-DL28KM`, `pending_payment`, `payment_mode:"demo"`, `payment:null` |
| `POST /demo-payment` `approve` | `200` `{demo:true,result:"approved",order_status:"paid",payment_status:"approved",delivery_status:"ready"}` |
| `POST /order-status` | `paid` / `approved` / `ready`, `delivery.url` absoluta |
| `POST /delivery` (token do link) | `200`; 1 unidade, e-mail mascarado, senha presente |
| `POST /demo-payment` repetido | `409 demo_order_not_payable` |
| `POST /order-status` com `client_token` de outro pedido | `404 not_found` |

Essas respostas são a única evidência aceita aqui como "validado": nenhum mock
local foi usado para afirmar integração.

---

## 4. Frontend

| Arquivo | Mudança |
|---|---|
| `src/services/orderService.ts` | tipos `payment_mode`, `demo_notice`, `product.is_demo`; `getDemoCapabilities()`, `approveDemoPayment()` |
| `src/services/backend/http.ts` | mensagens amigáveis para `demo_unavailable`, `demo_order_not_payable`, `demo_reservation_expired`, `demo_not_allowed` |
| `src/services/backend/catalogAdapter.ts`, `src/types.ts` | `isDemo` propagado do backend |
| `src/pages/PaymentPage.tsx` | polling de 5 s, contagem da reserva, PIX só quando existe `payment`, bloco **Modo de demonstração**, estado de falha terminal, link privado |
| `src/lib/cart.ts` | quantidade limitada também por `availableUnits` |
| `src/components/ProductCard.tsx` | disponibilidade real (`DISPONÍVEL` / `ESGOTADO` / unidade(s)), selo `DEMO` só para produto demo |
| `src/pages/ProductPage.tsx`, `src/pages/CheckoutPage.tsx` | preço/disponibilidade reais, aviso demo vs. real, textos do checkout |
| `src/services/adminDemoData.ts` (novo) | conjunto fictício + `demoAdminInvoke` (só em memória) |
| `src/services/adminAuth.ts` | sessão fictícia explícita; `adminInvoke` desvia para o conjunto local **somente** com `VITE_ADMIN_DEMO=true` e opt-in explícito |
| `src/pages/admin/AdminPage.tsx`, `AdminLogin.tsx` | botão "Ver painel em modo demonstração" + faixa permanente "nenhuma alteração é gravada no Supabase" |
| `src/styles.css` | estilos de `.demo-payment`, `.admin-demo-banner`, `.admin-login__demo` (borda tracejada, sem aparência de PIX real) |
| `vitest.config.ts` | `envDir` isolado: testes não herdam `.env.local` |

### Painel administrativo (fase G)

Sem conta administrativa provisionada (os e-mails oficiais não existem), o
painel real continua exigindo login + TOTP (`verify_jwt: true`, `assert_admin()`
inalterados). O que existe hoje é uma **visualização demonstrativa local**:

- precisa de `VITE_ADMIN_DEMO=true` **e** de um clique explícito;
- nenhuma chamada de rede; nenhuma escrita; recarregar a página volta ao login;
- faixa permanente na tela avisando que os dados são fictícios;
- nenhum atalho foi criado no backend.

---

## 5. Testes executados

| Suíte | Resultado |
|---|---|
| `npm run typecheck` | ✅ sem erros |
| `npm test` (frontend, jsdom) | ✅ **67 testes / 8 arquivos** |
| `npm run build` | ✅ `dist/` gerado |
| `npm run test:db` | ⚠️ **não executado neste ambiente** — o sandbox não tem binários de PostgreSQL (`initdb`/`pg_ctl`) e não há egress para baixá-los. Os 115 testes de banco passaram no commit `cdeb810`; as migrações 0026–0029 foram aplicadas no projeto remoto e validadas por HTTP real. |
| `npm run smoke:functions` | ⚠️ depende de egress local; a verificação equivalente foi feita de dentro do sandbox (tabela da seção 3) |

Novos testes desta missão:

- `src/pages/demoPayment.test.tsx` — 4 casos: painel visível e rotulado, clique
  chama `demo-payment` (uma vez) e libera o link após nova consulta, ausência do
  botão quando o servidor diz `demo_enabled: false`, erro do backend sem detalhe
  técnico.
- `src/pages/admin/adminDemo.test.tsx` — 5 casos: opt-in explícito, faixa de
  aviso, ações respondidas sem rede, logout, ausência de sessão presumida.
- `src/pages/catalogBackend.test.tsx` — 1 caso novo: produto demo com selo
  `DEMO`, produto real com quantidade real e esgotado sem botão de compra.

Classificação honesta do que foi validado:

- **Real (sandbox remoto):** catálogo, criação de pedido, aprovação simulada,
  acompanhamento, entrega por link, erros 409/404 — via HTTP contra as funções
  publicadas.
- **Simulado (frontend):** todas as asserções de tela usam `fetch` mockado.
- **Local:** typecheck, build, suíte jsdom.

---

## 6. Limitações e pendências

1. **Pagamento real não validado.** `MP_ACCESS_TOKEN` / `MP_WEBHOOK_SECRET`
   continuam ausentes; o código de Mercado Pago foi preservado sem alterações de
   contrato. Nenhuma cobrança real foi feita.
2. **Provisionamento de administradores** pendente dos e-mails oficiais. Até lá o
   painel real permanece inacessível (e protegido).
3. **Histórico de migrações**: o projeto sandbox registra **27** migrações em
   `supabase_migrations.schema_migrations` contra **29** arquivos no repositório.
   Os registros foram criados por nome em inglês (`foundation`,
   `admin_authorization`, …), agrupando alguns arquivos. A equivalência foi
   conferida pelos objetos resultantes: 17 tabelas, view `public_catalog`,
   47 funções, e a ausência de `stock_units_sold_order_idx` /
   `stock_units_product_status_idx` (removidos pela 0025) confirma que a 0021 e a
   0025 foram aplicadas. Não é possível, sem um PostgreSQL local, rodar
   `npm run test:db` para reconfirmar as 29 migrações linha a linha.
4. **Schema `verif`** (auxiliar de verificação HTTP) permanece no sandbox. Não é
   exposto ao público (`anon` não tem acesso) e não existe no repositório; pode
   ser removido com `drop schema verif cascade;` quando não for mais necessário.
5. **Sandbox com resíduos de teste**: um pedido demo pago (`PS-DL28KM`) consumiu
   uma unidade. Restam 6 unidades fictícias disponíveis (4 mensal, 2 avulso).
6. **Modo demonstrativo ligado no sandbox.** Antes de qualquer uso real é preciso
   desligar (`app_settings` + segredo), como descrito na seção 2. Nunca publicar
   em produção.
