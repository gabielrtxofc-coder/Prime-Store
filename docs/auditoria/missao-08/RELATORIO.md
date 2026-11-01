# Missão 08 — Funcionalidade completa da loja (sem pagamento e sem painel administrativo)

Data: 01/11/2026
Branch: `arena/08e7eb3e-prime-store` (o ambiente exige branch fixa; o nome
`arena/missao-08-...` pedido no enunciado não pode ser criado)
Base: `f6f3405` (Missão 07 aprovada)
Commits desta missão: `62b5061` (backend, banco, testes e diagnóstico) e o
commit do frontend integrado (ver seção 13)
Sandbox usado: projeto Supabase `prime-store-sandbox` — `eorlmqolbknrplvdbbtl`
(sa-east-1). Produção **não** foi tocada.

> Resumo em uma frase: a loja passou a registrar **solicitações de compra**
> reais no banco (um pedido com vários itens, número `PS-XXXXXX`, estado
> `requested` / `not_required`), com catálogo, produto, carrinho, finalização,
> confirmação e acompanhamento todos ligados ao backend — sem Mercado Pago,
> sem cobrança, sem painel administrativo e **sem declarar a loja pronta para
> produção**.

---

## 1. Diagnóstico inicial

Levantamento feito antes de qualquer edição (detalhado em
`docs/auditoria/missao-08/DIAGNOSTICO.md`), sobre o commit `f6f3405`:

| Área | Situação encontrada | Consequência para a missão |
| --- | --- | --- |
| Catálogo | `src/data/products.ts` era um array **estático** de produtos fictícios; a Edge Function `catalog` já existia e funcionava, mas a vitrine pública não a usava como fonte obrigatória. | Reconstruir a camada de dados do catálogo (proibido array fictício). |
| Páginas de produto | Liam o array estático (preço, descrição e disponibilidade do arquivo). | Religar ao backend; o preço exibido passou a vir do servidor. |
| Carrinho | Existia com `localStorage`, mas guardava o objeto de produto inteiro e não detectava item que ficou indisponível nem divergência de preço. | Reescrever a persistência para `{productId, quantity, priceCents}` e recalcular contra o catálogo vivo. |
| Finalização | Só existia o checkout **com cobrança** (`/checkout` → Mercado Pago PIX ou aprovação demonstrativa). Não havia como "finalizar sem pagar". | Criar fluxo novo de solicitação; preservar o checkout de cobrança. |
| Pedido no banco | `orders` descrevia **um** produto por pedido (`product_id`, `quantity`, `unit_price_cents`, `total_cents` com CHECK `total_cents = unit_price_cents * quantity`), estado `pending_payment`, e exigia reserva de estoque com expiração. | Migração mínima: vários itens por pedido, estados `requested`/`not_required`, sem reserva. |
| Acompanhamento | `get_order_status` já exigia token privado (bom), mas não devolvia itens; `GET /pagamento` era o único caminho de consulta na UI. | Acrescentar itens e nome do solicitante; criar consulta por número + código. |
| Confirmação | `/pedido-confirmado` mostrava um registro **em memória** do checkout demonstrativo. | Passou a redirecionar para a confirmação real do servidor. |
| Administração | `admin-api`, `AdminPage`, TOTP, permissões — completos e funcionais, com `verify_jwt: true`. | Ficaram **fora** da experiência pública; código preservado, rota `/admin` removida do roteador. |
| Pagamento | `create-order`, `mp-webhook`, `demo-payment` funcionando no sandbox. | Não foram alterados nem republicados; nenhuma dependência deles no fluxo novo. |

Integrações incompletas identificadas: (a) catálogo do backend sem consumidor
público; (b) carrinho sem vínculo com disponibilidade real; (c) nenhuma rota
que transformasse carrinho em pedido sem cobrança; (d) confirmação sem
persistência; (e) acompanhamento dependente do identificador longo do pedido e
do token, sem porta de entrada amigável.

---

## 2. Funcionalidades que já existiam e foram preservadas

- Edge Functions `catalog`, `create-order`, `mp-webhook`, `demo-payment`,
  `delivery`, `admin-api` — código intacto, sem republicação e sem alteração de
  contrato (o `catalog` e o `order-status` foram apenas reaproveitados).
- CORS por origem permitida, limite de requisições (`consume_rate_limit`),
  validação de payload, criptografia de credenciais, entrega com token,
  webhook com assinatura HMAC, expiração de reservas agendada.
- RLS em `products`, `stock_units`, `orders`, `order_events`, `deliveries`,
  `admin_*`; RPCs com `revoke all ... from public, anon, authenticated` e
  `grant execute ... to service_role`.
- Checkout de cobrança completo (`PaymentCheckoutPage`), página de pagamento
  PIX (`PaymentPage`), página de entrega (`DeliveryPage`) e todas as telas e
  testes administrativos — movidos para fora do roteador público, **não
  apagados**.
- Identidade visual, componentes (`SiteHeader`, `SiteFooter`, `ProductCard`,
  `ProductArtwork`, `OrderSummary`, `EmptyState`, `Icon`), tipografia, paleta e
  CSS base.
- 198 testes anteriores de frontend/banco/Edge Functions — nenhum removido.

---

## 3. Funcionalidades corrigidas

1. **Vitrine com dados fictícios** — `src/data/products.ts` foi excluído do
   repositório. Nenhuma tela monta produto, preço ou disponibilidade sem o
   backend: se o backend não responde, a UI mostra erro com "Tentar novamente".
2. **Carrinho desalinhado do banco** — o carrinho guardava cópia do produto e
   nunca reconciliava. Agora `CartContext` observa o catálogo e recalcula
   linhas, itens indisponíveis e mudanças de preço.
3. **Item esgotado ainda solicitável** — a finalização valida contra o catálogo
   vivo e o servidor revalida disponibilidade no ato do registro.
4. **Confirmação sem persistência** — a confirmação passou a ser o pedido
   gravado no banco, reaberta por `order_id` + código privado.
5. **Consulta frágil** — `get_order_status` devolvia só o produto principal;
   agora devolve `items[]`, `items_count` e `buyer_name`, mantendo todos os
   campos anteriores (redefinição compatível).
6. **Preço divergente** — a UI avisa quando o preço do produto mudou desde que
   entrou no carrinho e o total oficial é sempre o calculado pelo servidor.
7. **Selos enganosos** — o selo "DEMO" dos cards foi substituído por
   `CATÁLOGO ONLINE` / `DISPONÍVEL` / `INDISPONÍVEL`.
8. **Bug de regressão encontrado nos testes** — `catalogService` zerava o
   snapshot ao falhar, esvaziando o carrinho e quebrando a retentativa com a
   mesma chave de idempotência; passou a manter o último snapshot como cache.

---

## 4. Funcionalidades implementadas

- **Catálogo dinâmico** (`CatalogPage`): busca, filtro por categoria, contagem,
  ordenação, estado de carregamento, vazio, erro de conexão, indisponível
  marcado e bloqueado para solicitação.
- **Página de produto** (`ProductPage`): imagem/artwork, descrição, preço,
  disponibilidade, validade de acesso, instruções, quantidade limitada por
  `max_quantity_per_order`, além de aviso de que nada é pago nesta fase.
- **Carrinho** (`CartPage` + `CartContext` + `lib/cart.ts`): adicionar,
  remover, aumentar, diminuir, subtotal/total, contagem total, identificação de
  indisponíveis/removidos, bloqueio de quantidades inválidas, persistência em
  `localStorage` (`prime-store-cart-v2`).
- **Finalização sem pagamento** (`CheckoutPage`): revisão do carrinho, dados do
  solicitante (nome e e-mail — só o necessário), envio com chave de
  idempotência e token de cliente, tratamento de erro por campo, bloqueio de
  envio duplicado.
- **Confirmação** (`OrderStatusPage` em `/pedido/:identifier`): número do
  pedido, itens, quantidades, valor registrado, data, estado atual e a
  mensagem obrigatória "Seu pedido foi recebido e aguarda confirmação. Nenhum
  pagamento foi realizado."
- **Acompanhamento** (`TrackingPage` em `/acompanhar`): número `PS-XXXXXX` +
  código privado; código errado e pedido inexistente devolvem a mesma resposta.
- **Backend**: migração `0033`, RPC `create_purchase_request`,
  `purchase_request_summary`, `get_order_status` (com itens) e
  `get_order_status_by_reference`; Edge Function `order-request`; `order-status`
  aceitando `{reference}` além de `{order_id}`.
- **Testes novos**: `tests/db/15_solicitacao_sem_pagamento.test.ts` (12),
  `tests/db/16_order_request_http.test.ts` (8), `src/pages/catalogBackend.test.tsx`
  (5), `src/App.test.tsx` reescrito (30) e `src/lib/cart.test.ts` ampliado (11).

---

## 5. Alterações no frontend

| Arquivo | O que mudou |
| --- | --- |
| `src/services/catalogService.ts` (172 linhas) | Repositório único do catálogo, sempre backend: `refresh/ensureLoaded/getCategories/getState/getSnapshot/setSnapshot/subscribe/reset`; estados `live / loading / error / not_configured`; mantém o último snapshot em caso de erro (cache de exibição). |
| `src/context/CatalogContext.tsx` (91) | Adaptador com `useSyncExternalStore` — `products`, `categories`, `status`, `error`, `lastSyncedAt`, `reload`. |
| `src/data/categories.ts` (30) | Apenas rótulos de categoria; nenhum dado de produto. |
| `src/lib/cart.ts` (156) | Regras puras: `getCartLines`, totais, indisponíveis, divergência de preço, limites de quantidade. |
| `src/context/CartContext.tsx` (195) | Persistência `{productId, quantity, priceCents}`, reconciliação com o catálogo via `useSyncExternalStore`, `unavailableItems`, `priceChanges`. |
| `src/pages/HomePage.tsx` (180) / `CatalogPage.tsx` (159) | Vitrine e catálogo dinâmicos, estados de carregamento/vazio/erro, indisponível bloqueado. |
| `src/pages/ProductPage.tsx` (172) | Detalhe alimentado pelo backend; preço e disponibilidade do servidor. |
| `src/pages/CartPage.tsx` (120) | Edição de quantidades, remoção, avisos de indisponível e de preço alterado. |
| `src/pages/CheckoutPage.tsx` (337) | **Novo** fluxo de solicitação sem pagamento (etapas 04 da missão). |
| `src/services/requestService.ts` (220) | **Novo**: `createPurchaseRequest`, `getRequestStatus`, `isNotFoundError`, `isOrderId`, `isOrderReference`, comprovantes (`prime-store.request-receipts.v1`), `buildTrackingLink`, `readCodeFromHash`. |
| `src/pages/OrderStatusPage.tsx` (305) | Confirmação e acompanhamento reais, por `order_id` + código guardado no navegador. |
| `src/pages/TrackingPage.tsx` (99) | **Nova** porta de entrada por número + código. |
| `src/pages/OrderConfirmedPage.tsx` (33) | Passou a encaminhar para `/pedido/:id`. |
| `src/App.tsx` | Rotas públicas: `/`, `/produtos`, `/produto/:slug`, `/carrinho`, `/checkout`, `/pedido/:identifier`, `/acompanhar`, `/pedido-confirmado`, `/faq`, `/ajuda`, `/sobre`, `/termos`, `/privacidade`, `/reembolsos`, `*`. |
| `src/pages/demo/PaymentCheckoutPage.tsx` | Checkout de cobrança preservado fora do roteador público. |
| `src/components/*`, `src/data/{faqs,siteConfig}.ts`, `src/styles.css` | Textos sem promessa de pagamento, selos de disponibilidade, 59 blocos/linhas novas de CSS responsivo (`900px`, `700px`). |
| `src/data/products.ts` | **Removido** (array fictício). |

Nenhuma biblioteca nova foi adicionada; nenhuma chave secreta existe no
frontend (só a URL e a chave pública do backend, via `VITE_*`).

---

## 6. Alterações no backend (Edge Functions)

- **`order-request` (nova, publicada como v1)**
  `POST /order-request` → `{items: [{product_id, quantity}], buyer_name,
  buyer_email, client_token?, idempotency_key?}`. Valida 1–10 itens, UUID v4,
  quantidade 1–20, nome 2–120 caracteres e e-mail; gera token de 32 bytes
  quando o cliente não manda e envia **apenas o hash SHA-256** para o banco.
  Responde `201 {order, client_token, idempotent_replay}` (ou `200` no replay).
  Erros mapeados: `422` payload inválido, `409` estoque/limite/idempotência,
  `404` produto inexistente/indisponível, `429` limite de requisições.
  **Não** exige `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` nem qualquer variável de
  pagamento.
- **`order-status` (v5)**: aceita `{order_id}` **ou** `{reference}` (`PS-XXXXXX`)
  + `client_token`; devolve `items[]`, `items_count`, `buyer_name`,
  `payment: null` e `delivery: null` para pedidos `requested`; continua
  reconciliando PIX quando há pagamento (fluxo antigo intacto).
- `catalog`, `create-order`, `mp-webhook`, `demo-payment`, `delivery`,
  `admin-api`: **não** foram alteradas nem republicadas.

---

## 7. Alterações no banco (migração mínima)

`supabase/migrations/20261101120000_0033_solicitacao_sem_pagamento.sql`
(618 linhas), aplicada no sandbox `eorlmqolbknrplvdbbtl`:

1. `order_status += 'requested'`, `payment_status += 'not_required'`
   (`add value if not exists`).
2. `orders.buyer_name`, `orders.buyer_email` (nulos, com CHECK de tamanho
   mínimo e comentários), `orders.items_count integer not null default 1`.
3. `public.order_items` — uma linha por produto com o preço vigente
   (`product_id`, `product_name`, `product_slug`, `quantity`, `unit_price_cents`,
   `subtotal_cents`), `check` de quantidade, unicidade por pedido, índice por
   `order_id`, RLS habilitada e **nenhum** grant para `anon`/`authenticated`.
4. CHECK `orders_total_matches_unit_price` relaxado: continua exato para pedido
   de item único e admite `items_count > 1` (o total passa a ser a soma de
   `order_items`, conferida dentro da função).
5. `public.create_purchase_request(p_items jsonb, p_buyer_name, p_buyer_email,
   p_client_token_hash, p_idempotency_key)` — recalcula tudo a partir de
   `products`/`stock_units`, ignora preço vindo do cliente, valida
   disponibilidade, grava pedido + itens + evento `request_created`, é
   idempotente pela chave e devolve `{order, idempotent_replay}`.
6. `public.purchase_request_summary(p_order public.orders)` — resumo
   reaproveitado na criação e no replay.
7. `get_order_status` redefinida (compatível, acrescenta `items`,
   `items_count`, `buyer_name`) e nova `get_order_status_by_reference`.
8. `revoke all ... from public, anon, authenticated` + `grant execute ... to
   service_role` em todas as funções novas.

Decisões de integridade:

- **Sem reserva e sem baixa de estoque** na solicitação. A disponibilidade é
  conferida no ato do registro e o pedido não "expira" sozinho pelo agendador
  da migração `0031` (que só age em `pending_payment`).
- **Nenhuma venda**: `paid_at` nulo, `delivery_status = 'not_ready'`, nenhum
  produto digital liberado, nenhum produto de demonstração pago.
- **Privacidade**: nome/e-mail do solicitante só saem por
  `get_order_status`/`get_order_status_by_reference`, que exigem o hash do
  token privado. Código errado e pedido inexistente produzem o mesmo
  "não encontrado".

---

## 8. Testes executados

| Suíte | Comando | Resultado |
| --- | --- | --- |
| Frontend (unitário + integração + jornada) | `npx vitest run` | **9 arquivos, 75 testes, todos verdes** |
| Banco + Edge Functions (Postgres local real) | `npm run test:db` | **18 arquivos, 218 testes, todos verdes** |
| TypeScript | `npx tsc -b` | limpo (sem `any` novo, sem `@ts-ignore`) |
| Build | `npx vite build` | OK — `index.html` 0,64 kB, CSS 67,95 kB (gzip 14,55 kB), JS 280,77 kB (gzip 84,22 kB) |
| Bundling das funções | `npm run bundle:functions` | 8 funções empacotadas |

Detalhe das suítes novas:

- `tests/db/15_solicitacao_sem_pagamento.test.ts` (12): contrato da função,
  preço do banco, `requested`/`not_required`, itens, idempotência, estoque
  intacto, RLS/grants de `order_items`, privacidade do token.
- `tests/db/16_order_request_http.test.ts` (8): HTTP real sobre a função
  empacotada (OPTIONS, 201, replay 200, 422, 409, 404, 429, 405), contra o
  Postgres real com todas as 33 migrações.
- `src/App.test.tsx` (30): backend simulado por `fetch`, jornada completa,
  indisponível, carrinho vazio, dados inválidos, falha de conexão, envio
  duplicado, reload da confirmação, código de outra pessoa.
- `src/pages/catalogBackend.test.tsx` (5): catálogo real, disponível ×
  indisponível, erro 500 sem dados fictícios, backend não configurado, detalhe.
- `src/lib/cart.test.ts` (11) e `src/context/CartContext.test.tsx` (2):
  quantidades, limites, remoção, reload, indisponível após adicionar,
  divergência de preço.
- `tests/db/14_regressao_missao07.test.ts` (18) foi **ajustado** (contagens de
  privilégios 21/20 por causa dos objetos novos) — nenhum privilégio foi
  afrouxado e nenhum teste antigo foi removido.

---

## 9. Resultado da jornada completa

Roteiro executado (automatizado em `src/App.test.tsx` e, no nível de dados,
contra o sandbox — seção 10):

1. **Acessar** `/` — home com destaques vindos do catálogo real.
2. **Catálogo** `/produtos` — 2 produtos do backend, busca e categorias.
3. **Abrir produto** `/produto/produto-exemplo-avulso` — preço do servidor,
   disponibilidade, limite por pedido.
4. **Adicionar ao carrinho** — contagem e subtotal atualizados.
5. **Adicionar outro produto** — duas linhas independentes.
6. **Alterar quantidades** (2 → 3 → 1) e **remover** item — totais recalculados.
7. **Revisar** `/carrinho` → **`/checkout`** — resumo com valores oficiais.
8. **Preencher** nome e e-mail → **enviar** — `POST /order-request`.
9. **Receber o número** — `/pedido/<uuid>` com `PS-XXXXXX`, itens, valor,
   data, estado "Solicitação recebida — aguardando confirmação" e a mensagem
   "Seu pedido foi recebido e aguarda confirmação. Nenhum pagamento foi
   realizado."
10. **Atualizar a página de confirmação** — dados recarregados do servidor.
11. **Consultar novamente** em `/acompanhar` com número + código — mesmo
    pedido.

Nenhuma etapa pede pagamento, cartão, PIX, conta ou aprovação administrativa.

---

## 10. Integração com o sandbox

Projeto `prime-store-sandbox` (`eorlmqolbknrplvdbbtl`), o mesmo das missões
anteriores. Nada foi publicado em produção.

**Publicado agora**

- Edge Function `order-request` — versão **1**, `verify_jwt: false`.
- Edge Function `order-status` — versão **5** (aceita `reference`).

**Banco (schema verificado por consulta)**

- `orders` já tem `buyer_name`, `buyer_email`, `items_count` (3 colunas).
- `public.order_items` existe com 9 colunas e RLS.
- `create_purchase_request`, `purchase_request_summary` e
  `get_order_status_by_reference` existem; enums contêm `requested` e
  `not_required`.

**Execução real no sandbox** (via SQL no projeto, usando os dois produtos reais
`f8c3c8f2…` — R$ 49,90, 13 unidades — e `23d8f61c…` — R$ 29,90, 11 unidades):

```
create_purchase_request(items = 2×avulso + 1×mensal, nome, e-mail, hash do token,
                        idempotency_key = 'missao08-sandbox-e2e-001')

→ order_id 643018c8-6f81-40ed-9570-d5c0211f8011
→ reference PS-S2SDYS
→ status requested · payment_status not_required · delivery_status not_ready
→ items_count 2 · quantity 3 · total_cents 12970 (9980 + 2990)
→ itens com unit_price_cents 4990 / 2990 lidos de products.price_cents
→ idempotent_replay false
```

Verificações seguintes, todas confirmadas:

| Verificação | Resultado |
| --- | --- |
| Replay com a mesma `idempotency_key` | `idempotent_replay = true`, **nenhum** pedido novo, `order_items` continua com 2 linhas, 1 único pedido com a chave |
| Estoque depois da solicitação | 24 unidades livres (13 + 11) — nada reservado nem baixado |
| `get_order_status_by_reference('PS-S2SDYS', hash)` | devolve `reference`, `status`, `payment_status` e **2 itens** |
| `get_order_status(order_id, hash)` | devolve `items[]` com nomes e subtotais, `buyer_name`, `availability`, `paid_at: null` |
| Código errado | 0 pedidos casam com o hash errado (a função responde "não encontrado") |
| `get_catalog()` | 2 produtos ativos, preços 2990/4990, 11 e 13 unidades — é esta a fonte da vitrine |
| Eventos do pedido | 1 evento (`request_created`) |

**Limitação registrada:** este ambiente de execução só tem saída de rede para
GitHub/npm/PyPI — chamadas HTTPS a `*.supabase.co` são bloqueadas. Por isso a
jornada HTTP contra a função **já publicada** não pôde ser disparada por `curl`
aqui. A cobertura equivalente foi feita em duas frentes: (a) os handlers
publicados foram exercitados por HTTP real (`tests/db/16`, 8 casos) contra um
Postgres com as mesmas 33 migrações; (b) as RPCs do sandbox foram executadas
diretamente no projeto, como mostra a tabela acima. Nenhuma variável de
ambiente, domínio, CORS ou segredo foi alterado.

---

## 11. Problemas encontrados e como foram resolvidos

| # | Problema | Resolução |
| --- | --- | --- |
| 1 | `orders` com CHECK `total_cents = unit_price_cents * quantity` impedia pedido de vários itens. | CHECK relaxado para `items_count > 1`, com a soma real conferida em `order_items` dentro da função. |
| 2 | `alter type ... add value` não pode usar o rótulo novo na mesma transação. | Migração só adiciona os valores; o uso acontece em tempo de execução das funções. |
| 3 | Funções do banco devolviam só o produto principal no acompanhamento. | Redefinição compatível de `get_order_status` + nova `get_order_status_by_reference`. |
| 4 | Carrinho esvaziava quando o catálogo falhava (`catalogService` limpava o snapshot). | Último snapshot mantido como cache de exibição, com o erro visível na UI; retentativa idempotente voltou a passar. |
| 5 | Comprovante gravado com `identifier` provisório (`ref:PS-…`) antes do número oficial. | Comprovante só é gravado depois da resposta do servidor; `/acompanhar` navega com `#codigo=`. |
| 6 | `OrderStatusPage` entrava em laço de consulta (dependência `page.kind` no effect). | Dependência removida com comentário justificando. |
| 7 | Testes que assumiam array estático e chave antiga de carrinho. | `App.test.tsx`, `cart.test.ts`, `CartContext.test.tsx` e `catalogBackend.test.tsx` reescritos com backend simulado e fixtures `AVULSO`/`MENSAL`/`ESGOTADO`. |
| 8 | `tests/db/14` contava privilégios fixos e quebrou com os objetos novos. | Contagens atualizadas (21/20); **nenhum** grant foi ampliado. |
| 9 | `create_migration` com SQL grande devolveu `version: null` e não persistiu o corpo. | Migração reduzida e sem comentários foi aplicada; **antes** de reaplicar, o schema foi consultado e confirmado — nenhuma reaplicação cega. |
| 10 | TLS bloqueado no ambiente de execução. | Limitação documentada na seção 10; evidência equivalente obtida por SQL no projeto + testes HTTP locais. |

---

## 12. Pendências restantes (conscientes)

1. **Confirmação comercial não existe** — o pedido fica em `requested` até que
   a loja confirme por um meio administrativo que, por decisão de escopo, não
   foi criado nesta missão. Sem isso, o estado não avança.
2. **Sem entrega nesta fase** — `delivery_status` permanece `not_ready` e nada
   é liberado; o produto digital só será entregue quando houver pagamento ou
   confirmação manual (fase futura).
3. **Frontend publicado não foi apontado para o sandbox neste ambiente** —
   falta rede de saída para `*.supabase.co`; a validação HTTP ficou nos testes
   locais com o mesmo código.
4. **E-mail de confirmação** não é enviado (não há serviço de e-mail
   configurado nesta missão).
5. **CORS/ALLOWED_ORIGINS** do sandbox segue como estava (não autorizado a
   alterar domínio/configuração definitiva).
6. **Sem estoque decrementado** por decisão de integridade: duas pessoas podem
   solicitar a última unidade e a loja decide na confirmação.
7. Repositório **não é produção**: sem hardening novo, sem backup, sem
   observabilidade, sem revisão de preços comerciais.

---

## 13. Arquivos e commits

**Commits desta missão** (branch `arena/08e7eb3e-prime-store`, sem merge na
`main`):

- `62b5061` — `feat(pedidos): solicitação de compra sem pagamento no banco e em
  nova Edge Function` (migração `0033`, `order-request`, `order-status`,
  `tests/db/15`, `tests/db/16`, ajuste de `tests/db/14`, `DIAGNOSTICO.md`).
- commit do frontend integrado — catálogo, produto, carrinho, checkout,
  confirmação, acompanhamento, roteador, textos, CSS e testes
  (`App.test.tsx`, `catalogBackend.test.tsx`, `cart.test.ts`, `CartContext.test.tsx`).

**Arquivos criados**: `docs/auditoria/missao-08/{DIAGNOSTICO,RELATORIO}.md`,
`supabase/migrations/20261101120000_0033_solicitacao_sem_pagamento.sql`,
`supabase/functions/order-request/index.ts`,
`supabase/functions/_shared/handlers/orderRequest.ts`,
`tests/db/15_solicitacao_sem_pagamento.test.ts`,
`tests/db/16_order_request_http.test.ts`, `src/services/catalogService.ts`,
`src/services/requestService.ts`, `src/data/categories.ts`,
`src/context/CatalogContext.tsx`, `src/pages/{CheckoutPage,OrderStatusPage,TrackingPage}.tsx`,
`src/pages/catalogBackend.test.tsx`.

**Arquivos alterados**: `src/App.tsx`, `src/App.test.tsx`, `src/types.ts`,
`src/lib/{cart,validation}.ts`, `src/context/{CartContext,CatalogContext}.tsx`,
`src/components/{OrderSummary,ProductArtwork,ProductCard,SiteHeader,SiteFooter}.tsx`,
`src/pages/{HomePage,CatalogPage,ProductPage,CartPage,OrderConfirmedPage}.tsx`,
`src/services/{orderService,catalogService}.ts`, `src/data/{faqs,siteConfig}.ts`,
`src/styles.css`, `src/pages/admin/AdminProducts.tsx`,
`supabase/functions/_shared/handlers/orderStatus.ts`,
`supabase/functions/_shared/validation.ts`, `tests/db/14_regressao_missao07.test.ts`.

**Movido**: `src/pages/CheckoutPage.tsx` → `src/pages/demo/PaymentCheckoutPage.tsx`.
**Removido**: `src/data/products.ts` (array fictício).
**Preservado sem alteração**: `pages/PaymentPage.tsx`, `pages/DeliveryPage.tsx`,
`pages/admin/*`, `create-order`, `mp-webhook`, `demo-payment`, `delivery`,
`admin-api`.

---

## 14. Avaliação final da experiência

O que funciona de ponta a ponta hoje: **catálogo → produto → carrinho (com
persistência e reconciliação) → finalização sem pagamento → pedido registrado
no banco com número único → confirmação → acompanhamento por número + código**.
Todos os dados exibidos vêm do backend; nenhuma tela inventa produto, preço ou
disponibilidade; nenhuma mensagem afirma pagamento aprovado, compra concluída
ou produto liberado.

Pontos fortes: estados de carregamento/vazio/erro bem separados, indisponível
bloqueado em todos os níveis (UI, validação e banco), valores sempre
recalculados no servidor, idempotência no envio, privacidade do pedido por
token (mensagem idêntica para código errado e pedido inexistente), interface
reaproveitando a identidade visual existente e testada em 900 px e 700 px de
largura.

Riscos e desconfortos honestos: sem confirmação comercial o pedido fica
parado em `requested` (por escopo); duas pessoas podem solicitar a última
unidade (por integridade); não há e-mail de confirmação, então perder o código
de acompanhamento significa perder o acesso ao pedido; a validação HTTP
contra o sandbox ficou limitada pela rede do ambiente de execução.

**Esta loja não está pronta para produção** e não foi declarada como tal:
faltam confirmação comercial, entrega, política real de estoque, e-mail,
revisão de conteúdo legal e o hardening de uma publicação de verdade.
