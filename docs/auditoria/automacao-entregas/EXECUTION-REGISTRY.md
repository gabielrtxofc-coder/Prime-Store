# Registro de execução — Automação de pedidos e entrega digital

> Branch: `arena/e7e73e28-prime-store` · commit de origem `41f626b`.
> Objetivo: o pedido percorre o ciclo inteiro (registro → reserva → confirmação
> válida → venda → entrega) sem intervenção humana. A única atividade
> administrativa continua sendo cadastrar/atualizar produtos.
>
> Estados: **PASS** (executada e validada com evidência) · **FAIL** (executada,
> falhou) · **BLOCKED** (impedida por dependência externa comprovada) ·
> **NOT RUN** (não executada). Nenhuma linha PASS existe sem comando, teste ou
> artefato verificável associado.

## Ambiente de validação

| Item | Estado |
| --- | --- |
| PostgreSQL local | `embedded-postgres@18.6.0-beta.19` — **devDependency apenas** (nunca entra no bundle da loja), porta 55432, dados em `/tmp/prime-store-pgdata` |
| Script | `node scripts/local-db.mjs start\|stop\|status` (`npm run db:local`) |
| Migrações recriadas do zero em cada arquivo de teste | **35** (`0001`–`0036`, incluindo as duas novas) |
| Baseline anterior às mudanças | `npm run test:db` → 218/218 em 18 arquivos · `npx vitest run` → 75/75 |
| Estado final | `npm run test:db` → **255/255 em 20 arquivos** · `npx vitest run` → **79/79 em 10 arquivos** |

### Arquivos desta missão

| Arquivo | Papel |
| --- | --- |
| `supabase/migrations/20261108120000_0034_pedidos_multiproduto.sql` | núcleo multi-item: itens, reserva por item, criação atômica, entrega por item, confirmação interna, ajustes de constraint |
| `supabase/migrations/20261108121000_0035_pagamento_multiproduto.sql` | `apply_payment_status` por item (alocação tardia + entrega validada) |
| `supabase/migrations/20261108122000_0036_entrega_multiproduto.sql` | `resolve_delivery` devolve grupos por produto, preservando o formato anterior |
| `supabase/functions/_shared/handlers/delivery.ts` | decifra e agrupa as credenciais por produto no servidor |
| `src/pages/DeliveryPage.tsx` + `src/services/orderService.ts` + `src/styles.css` | entrega multi-produto na interface, revelar/copiar individual |
| `src/App.tsx` | rota `/entrega/:token` publicada (a credencial continua sendo só o token privado) |
| `tests/db/17_pedidos_multiproduto.test.ts` | 35 testes de banco (G2–G10) |
| `tests/db/18_jornada_multiproduto_http.test.ts` | 2 testes de integração (Edge Function + PostgreSQL real + credenciais cifradas) |
| `src/pages/deliveryMultiItem.test.tsx` | 4 testes de interface da entrega multi-produto |

---

## FASE 1 — Automação do processamento de pedidos

### Grupo 1 — Reconhecimento e integridade

| # | Tarefa | Estado | Evidência |
| --- | --- | --- | --- |
| 1 | Confirmar branch e commit de origem | **PASS** | `git rev-parse --abbrev-ref HEAD` → `arena/e7e73e28-prime-store`; `git log -1 --oneline` → `41f626b` |
| 2 | Integridade da árvore de trabalho | **PASS** | `git status --porcelain` vazio no início; nenhum commit anterior perdido (`git reset --hard origin/...`) |
| 3 | Mapear funções de criação de pedidos | **PASS** | 53 funções extraídas de `pg_proc`: `create_order` (mono-item, `0011`), `create_purchase_request` (multi-item sem pagamento, `0033`), `create_order_multi` (novo) |
| 4 | Mapear funções de atualização de estado | **PASS** | `apply_payment_status`, `attach_payment`, `release_order_reservation`, `expire_overdue_reservations`, `consume_reservation`, `allocate_late_units`, `admin_resolve_dispute`, `admin_resolve_refund` — todas lidas antes de alterar |
| 5 | Relação produto ↔ pedido | **PASS** | `orders.product_id/quantity/unit_price_cents` (legado) + `order_items` com `unique(order_id, product_id)`; `order_required_units(p_order)` resolve os dois formatos |
| 6 | Reserva de unidades | **PASS** | `reserve_stock_units` (item único) + `reserve_stock_units_multi` (N itens, UMA reserva, produtos travados em ordem crescente de id) |
| 7 | Liberação de reservas | **PASS** | `release_order_reservation` / `expire_overdue_reservations` operam por `order_id` — já cobriam multi-item; validado nos testes de expiração |
| 8 | Testes existentes — baseline | **PASS** | `npm run test:db` → 218/218 (18 arquivos); `npx vitest run` → 75/75; `npx tsc -b` limpo |

### Grupo 2 — Estrutura dos pedidos

| # | Tarefa | Estado | Evidência |
| --- | --- | --- | --- |
| 9 | Estrutura única multi-produto | **PASS** | `create_order_multi` grava 1 pedido + N `order_items`; teste "registra um pedido com vários produtos" |
| 10 | Quantidade por produto | **PASS** | `order_items.quantity` + CHECK 1..20; teste confere 2 e 1 por item |
| 11 | Preço registrado por item | **PASS** | `order_items.unit_price_cents/subtotal_cents`; teste "ignora preço vindo do cliente" (envia `unit_price_cents: 1`, grava 7990) |
| 12 | Total = soma dos itens | **PASS** | `order_total_mismatch` se divergir; teste compara `sum(subtotal_cents)` com `orders.total_cents` |
| 13 | Existência de todos os produtos | **PASS** | `product_not_found` (P0002); teste com UUID inexistente |
| 14 | Produto desativado/arquivado | **PASS** | `product_archived` / `product_unavailable`; teste cobre os dois e confirma que nenhum pedido foi criado |
| 15 | Limites de quantidade | **PASS** | `max_quantity_per_order` por produto + teto total 20; `quantity_above_product_limit` |
| 16 | Produto duplicado | **PASS** | `parse_request_items` → `duplicate_item`; teste com o mesmo produto duas vezes |

### Grupo 3 — Processamento automático

| # | Tarefa | Estado | Evidência |
| --- | --- | --- | --- |
| 17 | Mecanismo interno de pedidos múltiplos | **PASS** | `create_order_multi` (1 chamada para N produtos), testado com 2 e com 10 produtos |
| 18 | Transação única | **PASS** | pedido + itens + reserva na mesma transação da função `security definer`; nenhum `commit` intermediário |
| 19 | Falha em um item não deixa parcial | **PASS** | teste "falta de estoque em um item não deixa pedido, itens nem reserva parciais": 0 pedidos, 0 reservas, estoque intacto |
| 20 | Reserva por item | **PASS** | `stock_reservation_units` agrupado por produto confere 3 e 2 unidades |
| 21 | Quantidade exata | **PASS** | mesma asserção: reservado == solicitado por produto |
| 22 | Nenhuma unidade compartilhada | **PASS** | índice `stock_reservation_units_live_unique (stock_unit_id) WHERE released_at IS NULL` + teste de duplicidade = 0 |
| 23 | Concorrência não vende unidade inexistente | **PASS** | teste "duas compras simultâneas nunca usam a mesma unidade" (1 sucesso, 1 `insufficient_stock`) |
| 24 | Ordem de processamento sem deadlock | **PASS** | 1ª/2ª passadas ordenadas por `product_id`; teste com os dois produtos em ordem invertida sob concorrência — nenhum `40P01` |

### Grupo 4 — Estados e recuperação

| # | Tarefa | Estado | Evidência |
| --- | --- | --- | --- |
| 25 | Controle de estados | **PASS** | `pending_payment → paid` só via `apply_payment_status`; `refund_pending` quando falta estoque; `expired`/`failed` na liberação |
| 26 | Pedido sem pagamento permanece sem pagamento | **PASS** | teste "pedido sem confirmação permanece sem pagamento e sem entrega" (`pending_payment`/`pending`/`not_ready`, 0 entregas) |
| 27 | Só confirmação válida inicia compra paga | **PASS** | `internal_confirm_payment` desligada por padrão; teste "confirmação interna desligada por padrão não processa nada" |
| 28 | Mesma confirmação não processada duas vezes | **PASS** | teste "processa uma única vez": replay → `already_applied`, 1 entrega, 2 unidades vendidas |
| 29 | Reservas liberadas ao encerrar sem pagamento | **PASS** | teste "tentativa encerrada sem pagamento devolve o estoque de cada item" (status `failed`, tudo `available`) |
| 30 | Expiração automática | **PASS** | `expire_overdue_reservations` devolve 4 unidades de 2 produtos; pedido vai a `expired` |
| 31 | Nova tentativa não duplica pedido | **PASS** | teste "nova tentativa depois de expirar": 2 pedidos, 1 reserva ativa, sem duplicação |
| 32 | Recuperação segura de falha no meio | **PASS** | teste "recuperação depois de interrupção não cria segunda entrega": pedido pago sem entrega é recriado; 1 entrega, 1 unidade, `delivery_recovered` registrado |

### Grupo 5 — Proteção e validação

| # | Tarefa | Estado | Evidência |
| --- | --- | --- | --- |
| 33 | Função interna inacessível a visitante | **PASS** | `revoke all ... from public, anon, authenticated` nas 13 funções novas; teste `has_function_privilege` = [] e `runAs(role: 'anon')` → `42501` |
| 34 | Sem dado privado em resposta pública | **PASS** | 0 ocorrências de `account_password_enc` em função não-admin (teste existente `08` passou a cobrir `delivery_items_json`, que ganhou guarda de estado) |
| 35 | Eventos registrados | **PASS** | `order_created`, `payment_approved`, `delivery_created`, `internal_payment_confirmed`, `delivery_recovered`; teste confere a sequência |
| 36 | Erros sem credencial | **PASS** | teste "nenhuma mensagem de erro carrega credencial ou ciphertext" |
| 37 | Proteções existentes funcionando | **PASS** | `tests/db/08_privilegios_funcoes.test.ts` (13 asserções de privilégio) e `06_hardening` seguem verdes |
| 38 | Compatibilidade com pedido mono-item | **PASS** | testes "pedido de um produto continua entregando como antes" e "pedido sem itens usa a alocação tardia por item" |
| 39 | Suíte de pedido/estoque/concorrência/repetição/recuperação | **PASS** | `npm run test:db` → 255/255 em 20 arquivos (0 falhas, 0 ignorados) |
| 40 | Portão da Fase 1 | **PASS** | todas as 39 anteriores em PASS, com suíte de banco integral verde |

---

## FASE 2 — Entrega digital automática

### Grupo 6 — Organização das entregas

| # | Tarefa | Estado | Evidência |
| --- | --- | --- | --- |
| 41 | Auditar entregas e relação pedido↔item↔unidade | **PASS** | `deliveries(order_id unique)` → `delivery_units(delivery_id, stock_unit_id unique)` → `stock_units.product_id`; sem coluna de item, o vínculo é derivado por produto |
| 42 | Formato multi-item | **PASS** | `delivery_items_json` devolve um grupo por produto |
| 43 | Grupo de entrega por item | **PASS** | teste "acesso privado devolve vários produtos": 2 grupos |
| 44 | Quantidade correta por grupo | **PASS** | `quantity` = `count(*)` das unidades do produto (2 e 1) |
| 45 | Unidade pertence ao produto | **PASS** | `delivery_foreign_unit` se houver unidade fora dos itens + asserção de produtos estranhos = 0 |
| 46 | Unidade não entregue em dois pedidos | **PASS** | `delivery_units_unique_unit` + teste que tenta inserir a unidade de A em B → `23505` |
| 47 | Compatibilidade com entrega mono-produto | **PASS** | `resolve_delivery` mantém `product` e `units`; testes de banco + teste de interface "formato antigo de um produto só" |
| 48 | Entrega única por pedido | **PASS** | `deliveries_order_id_key` + teste "nunca recebe uma segunda entrega" (`created: false`) |

### Grupo 7 — Geração e proteção

| # | Tarefa | Estado | Evidência |
| --- | --- | --- | --- |
| 49 | Uma entrega principal por pedido | **PASS** | `create_order_delivery` é idempotente por `order_id`; tabela tem UNIQUE |
| 50 | Todos os itens na mesma entrega | **PASS** | um único `delivery_id` para todos os produtos; teste de integração HTTP confirma 2 grupos na mesma entrega |
| 51 | Acesso privado seguro | **PASS** | token 256 bits → só `sha256` no banco; `resolve_delivery` exige hash de 64 hex; teste de token inválido/formato inválido → 404 |
| 52 | Armazenar só hash do código | **PASS** | `deliveries.token_hash` (`^[0-9a-f]{64}$`) + `token_enc` cifrado; nenhum token em claro |
| 53 | Não pago não gera acesso | **PASS** | `create_order_delivery` exige `paid/approved/ready` (`order_not_deliverable`); teste G7 |
| 54 | Revogada não acessa | **PASS** | `delivery_revoked` em `resolve_delivery` e em `delivery_items_json`; testes de banco e HTTP |
| 55 | Código inválido não acessa | **PASS** | hash desconhecido → `delivery_not_found` (P0002) |
| 56 | Credencial revelada só no servidor | **PASS** | `delivery.ts` decifra com a chave mestra; resposta não contém `email_enc`/`password_enc` (asserção no teste HTTP) |

### Grupo 8 — Liberação automática

| # | Tarefa | Estado | Evidência |
| --- | --- | --- | --- |
| 57 | Liberar todas as unidades de cada item | **PASS** | 3 unidades de 2 produtos vinculadas na mesma confirmação |
| 58 | Liberação integral | **PASS** | `delivery_incomplete` se algum item ficar descoberto; teste confere `sold` == entregue |
| 59 | Sem entrega parcial se faltar estoque | **PASS** | teste "falta de estoque para um item bloqueia a entrega inteira": `approved_without_stock`, 0 entregas, 0 vendas |
| 60 | Entrega só após confirmação válida | **PASS** | a entrega nasce dentro de `apply_payment_status`, ramo `approved` |
| 61 | Recuperação após interrupção | **PASS** | ramo `already_applied` recria a entrega via `create_order_delivery` com evento `delivery_recovered` |
| 62 | Nova tentativa não cria segunda entrega | **PASS** | teste "nunca recebe uma segunda entrega" |
| 63 | Revogação bloqueia todos os produtos | **PASS** | teste "revogação bloqueia todos os produtos do pedido" (banco + HTTP) |
| 64 | Eventos de entrega registrados | **PASS** | `delivery_created` com `units` e `items`, `delivery_recovered`, `delivery_revoked` |

### Grupo 9 — Experiência do cliente

| # | Tarefa | Estado | Evidência |
| --- | --- | --- | --- |
| 65 | Backend devolve vários produtos na mesma entrega | **PASS** | `delivery.ts` devolve `items[]` + `items_count`; teste HTTP com 2 produtos |
| 66 | Tipos/serviços do frontend | **PASS** | `DeliveryItemGroup`/`DeliveryPayload.items` em `orderService.ts`; `tsc -b` limpo |
| 67 | Nome do produto | **PASS** | cada grupo traz `product_name`; teste de interface |
| 68 | Credenciais por produto | **PASS** | grupos com `units` próprias; teste confere e-mails/senhas decifrados por produto |
| 69 | Instruções específicas | **PASS** | `instructions` vem do produto; teste "Instruções de Curso Piano" |
| 70 | Validade de acesso por produto | **PASS** | `access_validity_label`/`_days` por grupo; teste verifica "12 meses" |
| 71 | Revelar/ocultar/copiar individualmente | **PASS** | chave `produto:posição`; teste revela piano sem expor violão e copia unitariamente |
| 72 | Cliente reabre a entrega com o acesso privado | **PASS** | rota `/entrega/:token` publicada; teste HTTP lê 2× e `view_count ≥ 2` |

### Grupo 10 — Integridade

| # | Tarefa | Estado | Evidência |
| --- | --- | --- | --- |
| 73 | 1 produto / 1 unidade | **PASS** | teste "pedido de um produto e uma unidade percorre a jornada inteira" |
| 74 | Produto multi-unidade | **PASS** | 2 unidades do mesmo produto (fluxo legado + multi) |
| 75 | 2 produtos | **PASS** | jornada HTTP completa (2 produtos, 3 unidades) |
| 76 | 10 produtos | **PASS** | teste "10 produtos distintos no mesmo pedido" (20 unidades): 10 grupos |
| 77 | Falta de estoque em um item | **PASS** | G3 (criação) e G8 (pagamento tardio) |
| 78 | Tentativas simultâneas/repetidas/interrompidas/recuperadas | **PASS** | concorrência (2 e 3 transações), idempotência (`idempotency_key`), interrupção + recuperação |
| 79 | Não pagos / códigos inválidos / revogadas / acesso indevido | **PASS** | `requested`+`not_required` nunca entrega; token inválido 404; revogada bloqueada; `anon` → 42501 |
| 80 | Regressão final | **PASS** | `npm run test:db` → 255/255 (20 arquivos, inclui as 218 anteriores) · `npx vitest run` → 79/79 |

---

## Validação geral final

| # | Item | Estado | Evidência |
| --- | --- | --- | --- |
| 1 | Testes de banco | **PASS** | `npm run test:db` → 20 arquivos, 255 testes, 0 falhas |
| 2 | Testes de frontend | **PASS** | `npx vitest run` → 10 arquivos, 79 testes, 0 falhas |
| 3 | TypeScript | **PASS** | `npx tsc -b` sem saída (exit 0), inclusive `strict` |
| 4 | Build local (sem publicar) | **PASS** | `npm run build` → `dist/` 285 kB JS / 68 kB CSS, 65 módulos |
| 5 | Pacotes das funções | **PASS** | `npm run bundle:functions` → 8 funções empacotadas (`delivery`, `order-request`, …) |
| 6 | Integração | **PASS** | `tests/db/18_jornada_multiproduto_http.test.ts` (RPC real + WebCrypto + handler HTTP) |
| 7 | Nenhuma proteção removida | **PASS** | nenhum `revoke`/`grant` existente afrouxado; `08_privilegios_funcoes` e `06_hardening` verdes |
| 8 | Nenhuma credencial exposta | **PASS** | teste global de vazamento em `08` + asserções `not.toContain('email_enc')` nos testes novos |
| 9 | As duas jornadas funcionando juntas | **PASS** | solicitação sem pagamento (`requested`/`not_required`, sem entrega) + compra paga multi-item (entrega automática) |
| 10 | Registro final | **PASS** | `docs/auditoria/automacao-entregas/RELATORIO-FINAL.md` |

### Itens não executáveis neste ambiente (declarados, não maquiados)

| Item | Situação | Motivo |
| --- | --- | --- |
| `npm run smoke:functions` contra projeto remoto | **BLOCKED** | exige `SUPABASE_URL`/`SUPABASE_ANON_KEY` de um projeto publicado. Executado sem variáveis: encerra pedindo configuração (comportamento esperado). Nenhuma publicação foi feita, conforme a restrição da missão |
| Teste E2E em navegador real | **BLOCKED** | `playwright install chromium` não baixa neste container (falha de download). Cobertura equivalente mantida em jsdom (`src/pages/*.test.tsx`) |
| Confirmação de pagamento por provedor real | **BLOCKED por decisão** | WyviPay/Mercado Pago fora do escopo; o caminho usado é o mecanismo interno isolado (`internal_confirm_payment`), desligado por padrão |

---

## Decisões técnicas registradas

1. **`create_order` não foi reescrito.** O fluxo de cobrança de um produto
   continua idêntico; o multi-item vive em `create_order_multi`. Isso mantém as
   218 asserções anteriores válidas sem alterar contrato publicado.
2. **Uma reserva por pedido, N unidades.** O índice
   `stock_reservations_one_active_per_order` impede várias reservas ativas; por
   isso a reserva multi-item é uma linha com `quantity` = soma e N linhas por
   unidade física.
3. **Trava global por ordem de `product_id`.** Evita deadlock entre checkouts que
   enviam os mesmos produtos em ordens diferentes (validado sob concorrência).
4. **`apply_payment_status` preservado, com dois pontos trocados**: alocação
   tardia por item e criação de entrega validada. Para um item o comportamento é
   o anterior.
5. **`internal_confirm_payment` é o único caminho de confirmação criado.** Está
   desligado por padrão (`app_settings.internal_confirmation_enabled = false`),
   concedido apenas a `service_role`, exige o token privado do cliente e **não é
   chamado por nenhuma Edge Function** — não existe rota pública que aprove pedido.
6. **Ajustes de constraint justificados**: `stock_reservations.quantity` até 200 e
   `orders.quantity` até 200 (um carrinho de 10 produtos × 20 unidades não cabe em
   20); `payments.provider` aceita `internal` (lista fechada). Nenhuma constraint
   foi removida sem substituta.
7. **A entrega decifra no servidor.** O helper `delivery_items_json` devolve
   ciphertext, então ele próprio recusa entrega revogada ou de pedido não pago —
   descoberto pelo teste de proteção existente, que passou a cobri-lo.

## Problemas encontrados e corrigidos durante a execução

| # | Problema | Correção |
| --- | --- | --- |
| 1 | `delivery_items_json` (nova) devolvia credencial sem checar estado — o teste `08` reprovou | guarda de `delivery_not_found`/`delivery_revoked`/`delivery_unavailable` dentro da própria função |
| 2 | `allocate_late_units` falhava em `stock_reservations_window` (`starts_at = ended_at`) | janela positiva `starts_at = now() - 1min`, `expires_at = ended_at = now()` |
| 3 | `payments_provider_check` aceitava só `mercado_pago`/`demo` | lista fechada estendida com `internal` |
| 4 | `stock_reservations_quantity_check ≤ 20` quebrava carrinho de 10 × 2 | limite elevado a 200 (por item o teto continua 20) |
| 5 | `orders_quantity_check ≤ 20` idem | limite elevado a 200 |
| 6 | Página de entrega com heading duplicado quebrava teste existente | título de grupo só aparece com mais de um produto |
| 7 | Testes próprios usando `sha256Hex` (assíncrono) sem `await` | `await` corrigido |
| 8 | Token de teste da revogação abaixo da entropia mínima | token com entropia equivalente à real |
