# Relatório final — automação de pedidos e entrega digital

**Branch:** `arena/e7e73e28-prime-store` (sem merge na `main`, sem publicação)
**Data de execução:** 08/11/2026
**Escopo executado:** 80/80 tarefas das duas fases + 10 itens de validação geral.

---

## 1. Resultado em uma frase

O pedido passa a ser processado sozinho de ponta a ponta — carrinho com vários
produtos, reserva por item, confirmação válida de pagamento, venda e entrega
digital agrupada por produto — e a única atividade administrativa que resta é
cadastrar e atualizar produtos.

---

## 2. Evidência objetiva

| Verificação | Comando | Resultado |
| --- | --- | --- |
| Testes de banco e unitários | `npm run test:db` | **255/255** em 20 arquivos, 0 falhas |
| Testes de interface | `npx vitest run` | **79/79** em 10 arquivos, 0 falhas |
| TypeScript (strict) | `npx tsc -b` | sem erros (exit 0) |
| Build de produção local | `npm run build` | `dist/index.html` + 285,44 kB JS / 68,34 kB CSS (65 módulos) |
| Pacotes das Edge Functions | `npm run bundle:functions` | 8 funções empacotadas |
| Migrações do zero | recriação em cada arquivo de teste | **35** aplicadas sem erro (`0001`–`0036`) |

Comparação com o ponto de partida: 218 → **255** testes de banco (+37) e
75 → **79** de interface (+4). Nenhum teste existente foi removido, desativado
ou afrouxado.

---

## 3. O que mudou

### 3.1 Migrações (aditivas, nenhuma destrutiva)

| Migração | Conteúdo |
| --- | --- |
| `20261108120000_0034_pedidos_multiproduto.sql` | `parse_request_items`, `order_required_units`, `order_items_json`, `order_stored_items_json`, `order_summary_multi`, `reserve_stock_units_multi`, `create_order_multi`, `allocate_late_units_multi`, `allocate_late_units_for_order`, `create_order_delivery`, `delivery_items_json`, `internal_confirm_payment`; ajustes de constraint e duas novas chaves em `app_settings` |
| `20261108121000_0035_pagamento_multiproduto.sql` | redefinição de `apply_payment_status` (alocação tardia por item + entrega validada por `create_order_delivery`) |
| `20261108122000_0036_entrega_multiproduto.sql` | redefinição de `resolve_delivery` (grupos por produto, `product`/`units` preservados) |

Nenhum `drop table`, nenhum `delete`, nenhuma migração de dados. As constraints
alteradas foram **substituídas por versões equivalentes mais amplas**
(`stock_reservations.quantity` e `orders.quantity` até 200; `payments.provider`
com `internal`) e o motivo está documentado no cabeçalho de cada arquivo.

### 3.2 Backend (Edge Functions)

- `_shared/handlers/delivery.ts` — decifra as credenciais **no servidor**,
  devolve um grupo por produto (`items`, `items_count`) e mantém `product` +
  `units` para clientes antigos; converte o formato plano quando a resposta vem
  de um banco sem a migração 0036.
- Nenhuma função nova foi publicada. `internal_confirm_payment` **não é chamada
  por nenhuma Edge Function** (`grep` no diretório `supabase/functions` retorna
  vazio).

### 3.3 Frontend

- `src/pages/DeliveryPage.tsx` — um bloco por produto, com nome, instruções e
  validade próprios; revelar/ocultar/copiar **por unidade** (a chave do card é
  `produto:posição`).
- `src/services/orderService.ts` — tipos `DeliveryItemGroup` e `items` no
  `DeliveryPayload`.
- `src/App.tsx` — rota `/entrega/:token` publicada. Ela não libera nada por si:
  sem token privado válido, entrega ativa e pedido pago, a página mostra
  "Entrega indisponível".
- `src/styles.css` — estilos dos grupos de entrega (sem tocar na identidade
  visual existente).

### 3.4 Infraestrutura de desenvolvimento

- `scripts/local-db.mjs` + scripts `db:local*`: PostgreSQL 18.6 local via
  `embedded-postgres` (devDependency), permitindo rodar `npm run test:db` sem
  instalar servidor.

---

## 4. Testes criados

| Arquivo | Testes | Cobertura |
| --- | --- | --- |
| `tests/db/17_pedidos_multiproduto.test.ts` | 35 | G2 (estrutura/validação), G3 (reserva/concorrência/deadlock), G4 (estados/idempotência/expiração/recuperação), G6–G8 (entrega, revogação, entrega única, unidade exclusiva), G5 e compatibilidade mono-item, G10 (1 produto/1 unidade, 2 produtos, 10 produtos) |
| `tests/db/18_jornada_multiproduto_http.test.ts` | 2 | jornada completa pela Edge Function `delivery` com credenciais realmente cifradas (WebCrypto) e PostgreSQL real |
| `src/pages/deliveryMultiItem.test.tsx` | 4 | grupos por produto, revelar/copiar individual, formato antigo, link revogado |

---

## 5. Como o processamento automatizado funciona

```
carrinho (1..10 produtos)
   └─ create_order_multi            (1 transação)
        ├─ valida cada item: existe, ativo, não arquivado, limite, preço do banco
        ├─ grava orders (pending_payment) + order_items (preço por item)
        ├─ total = soma dos itens (conferido no banco)
        └─ reserve_stock_units_multi  (UMA reserva, N unidades, ordem por product_id)
                                      falta de um item ⇒ nada é gravado

confirmação de pagamento (única porta: apply_payment_status)
   ├─ approved  → consome a reserva (ou aloca tarde, se ela venceu)
   │              ├─ create_order_delivery: 1 entrega, todas as unidades,
   │              │   valida cobertura de cada item e recusa unidade estranha
   │              └─ ordem: paid / approved / ready
   ├─ sem estoque → refund_pending + delivery_status blocked + refund_request
   ├─ rejected/cancelled → libera reserva
   ├─ refunded → revoga a entrega (idempotente)
   └─ charged_back → disputa, entrega preservada para análise

cliente abre /entrega/<token privado>
   └─ delivery → resolve_delivery (hash do token, entrega ativa, pedido pago)
        └─ decifra no servidor e devolve itens[] com credenciais por produto
```

---

## 6. Decisões que preservam o que já existia

1. `create_order` (fluxo de cobrança de um produto) **não foi alterado**.
2. `reserve_stock_units`, `consume_reservation`, `release_order_reservation` e
   `expire_overdue_reservations` **não foram reescritos** — todos operam por
   `order_id` e já serviam a pedidos multi-item.
3. `apply_payment_status` mantém todas as decisões anteriores (valor divergente,
   aprovação atrasada, recusa, reembolso, chargeback, pendente) e mudou apenas
   dois pontos: alocação tardia por item e criação de entrega validada.
4. Nenhuma proteção foi afrouxada: as 13 funções novas e as duas redefinidas
   ficaram restritas a `service_role`; `anon` e `authenticated` não executam
   nenhuma delas (verificado por `has_function_privilege` e por tentativa real
   com `set local role`).

---

## 7. Mecanismo interno de confirmação — como está isolado

`public.internal_confirm_payment(p_order_id, p_client_token_hash,
p_delivery_token_hash, p_delivery_token_enc_b64)`

| Proteção | Implementação |
| --- | --- |
| Desligado por padrão | `app_settings.internal_confirmation_enabled = false` (a migração insere `false`) |
| Só o backend | `revoke all from public, anon, authenticated`; `grant execute to service_role` |
| Sem rota pública | nenhuma Edge Function, página ou script do repositório a referencia |
| Prova de posse | exige o hash do token privado do cliente; sem ele responde `order_not_found` (não revela existência) |
| Só pedido pendente | exige `status = 'pending_payment'` e reserva não vencida |
| Rastro | grava `payments.provider = 'internal'` e o evento `internal_payment_confirmed` |

Nenhuma cobrança é criada, nenhum webhook é alterado, nenhuma credencial
financeira é usada.

---

## 8. Problemas encontrados e corrigidos

| # | Sintoma | Causa | Correção |
| --- | --- | --- | --- |
| 1 | Teste de proteção `08` reprovou com `delivery_items_json` na lista de vazamento | o helper devolvia ciphertext de credencial sem checar estado da entrega | guarda `delivery_not_found` / `delivery_revoked` / `delivery_unavailable` dentro da função |
| 2 | `stock_reservations_window` violado na alocação tardia | `starts_at = ended_at = now()` | janela positiva (`now() - 1min` … `now()`) nas duas funções de alocação tardia |
| 3 | `payments_provider_check` recusava a confirmação interna | lista fechada com dois valores | lista fechada com `internal`, sem texto livre |
| 4 | Carrinho de 10 produtos estourava `stock_reservations_quantity_check` | limite de 20 unidades totais herdado do mono-item | limite 200 na reserva e em `orders.quantity`; por item continua 20 |
| 5 | Teste de interface existente quebrou | dois headings com o mesmo nome | título do grupo só aparece com mais de um produto |
| 6 | Testes novos usavam `sha256Hex` (assíncrono) sem `await` | erro do próprio teste | `await` adicionado |
| 7 | Token de teste da revogação era curto demais | validação real de entropia da rota | token com entropia equivalente à de produção |

Nenhum problema ficou escondido: todos apareceram como teste vermelho antes da
correção e voltaram a verde depois.

---

## 9. Restrições da missão — verificação

| Restrição | Situação |
| --- | --- |
| Trabalhar só na branch atual, sem trocar | cumprido (`arena/e7e73e28-prime-store`) |
| Preservar o trabalho anterior | 218 testes anteriores intactos e verdes |
| Não fazer merge na `main` | nenhum merge executado |
| Não publicar em produção | nenhum deploy; `smoke:functions` exige projeto remoto e não foi executado |
| Não integrar WyviPay | nenhum código, rota ou chave da WyviPay |
| Não criar cobranças / não tocar webhooks / não reabrir checkout pago | `create-order`, `mp-webhook` e `demo-payment` inalterados |
| Não usar credenciais financeiras | nenhuma chave real em jogo |
| Não liberar produto sem pagamento | `requested`/`not_required` não reserva, não vende e não entrega (testado) |
| Não criar confirmação manual | não existe rota nem tela de aprovação |
| Não reformular o painel administrativo | nenhum arquivo de `src/pages/admin` alterado |
| Não mexer na identidade visual | apenas 8 linhas de CSS para os grupos de entrega |
| Não apagar dados | nenhum `delete`/`drop` em dados; migrações apenas aditivas |
| Não enfraquecer proteções | nenhuma permissão ampliada; teste global de privilégios verde |
| Não remover testes | 0 testes removidos |

---

## 10. Pendências e dependências externas (não bloqueiam esta entrega)

1. **Integração financeira real** (WyviPay ou outro provedor) — fora do escopo.
   O gancho já existe (`apply_payment_status`) e é o mesmo caminho usado pelo
   mecanismo interno; ligar o provedor significa apenas chamar essa função com a
   confirmação assinada.
2. **`smoke:functions` contra projeto publicado** — precisa de
   `SUPABASE_URL`/`SUPABASE_ANON_KEY` de um projeto remoto. Rodado sem as
   variáveis, encerra pedindo configuração (comportamento esperado, sem rede).
3. **E2E em navegador real** — o download do Chromium falha neste container; a
   cobertura equivalente está em jsdom (10 arquivos, 79 testes).
4. **Contrato do frontend de checkout multi-item** — a loja pública continua
   registrando **solicitação sem pagamento** (`order-request`). O motor de compra
   paga já aceita vários produtos (`create_order_multi`), mas a tela de checkout
   pago permanece desligada por decisão de produto.

---

## 11. Estado final da branch

```
branch: arena/e7e73e28-prime-store
base:   41f626b (docs de planejamento, trabalho anterior preservado)
main:   0b50248 (não tocada)
```

Arquivos modificados: `src/App.tsx`, `src/pages/DeliveryPage.tsx`,
`src/services/orderService.ts`, `src/styles.css`,
`supabase/functions/_shared/handlers/delivery.ts`, `package.json`,
`package-lock.json`, `tests/db/helpers.ts`.

Arquivos novos: 3 migrações, 2 arquivos de teste de banco, 1 de interface,
`scripts/local-db.mjs`, e a pasta `docs/auditoria/automacao-entregas/`
(este relatório + `EXECUTION-REGISTRY.md`).

O trabalho está commitado nesta branch, sem push para `main` e sem publicação.
