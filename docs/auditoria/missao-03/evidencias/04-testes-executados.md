# Evidência 04 — Testes executados

Todos os resultados abaixo são saídas reais locais (PostgreSQL 16.2 reconstruído
pelas 25 migrações + Vitest). Nada aqui foi inferido.

## Comandos e resultados

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` (`tsc -b`) | sem erros |
| `npm test` (frontend) | **6 arquivos / 57 testes**, todos aprovados |
| `npm run test:db` | **9 arquivos / 115 testes**, todos aprovados |
| `npm run build` | build de produção OK (`AdminPage` ≈ 259 kB, `index` ≈ 281 kB) |
| `node scripts/bundle-functions.mjs` | 6 bundles gerados |

Total: **172 testes automatizados** (57 frontend + 115 banco/integração local).

## Fase A/B — `tests/db/06_hardening_integridade.test.ts` (20 testes)

Idempotência (`create_order`):

| Cenário | Esperado | Resultado |
| --- | --- | --- |
| mesma chave + mesmo token + mesmos parâmetros | devolve o pedido original (`idempotent_replay = true`), 1 pedido | ok |
| mesma chave + token diferente | `idempotency_conflict`; hash original intacto; 1 pedido | ok |
| tentativa de takeover | erro sem referência/ID/valor do pedido alheio; token do dono continua válido | ok |
| mesma chave + produto diferente | `idempotency_conflict`; nenhum pedido do segundo produto | ok |
| mesma chave + quantidade diferente | `idempotency_conflict` | ok |
| chave curta (`curta`) | `invalid_idempotency_key` | ok |
| 3 requisições simultâneas com a mesma chave | 1 pedido, mesmo `order_id` | ok |
| repetição após falha de comunicação (3x) | 1 pedido, 1 reserva | ok |
| sem chave | cada requisição cria pedido próprio; token de um não abre o outro | ok |
| token em texto puro (não SHA-256) | `invalid_client_token` | ok |

Chargeback × reembolso (`apply_payment_status`):

| Cenário | Observado |
| --- | --- |
| aprovado → reembolso | pedido `refunded`, entrega `revoked`, evento `payment_refunded` |
| aprovado → chargeback | pedido **`disputed`**, pagamento `charged_back`, entrega **`active`**, `requires_admin_review=true`, **0** reembolsos processados, evento `payment_charged_back` |
| chargeback duplicado | `already_applied`, 1 único evento |
| reembolso duplicado | `already_applied`, 1 único evento |
| reembolso depois de chargeback | pedido `refunded`, entrega revogada |
| chargeback depois de reembolso | pedido permanece `refunded`, evento `payment_charged_back_after_refund`, entrega continua revogada |
| aprovação atrasada após reembolso | `ignored_late_approval`, nada é reaberto |
| disputa encerrada por admin com MFA | `admin_resolve_dispute('refund')` → `refunded` + auditoria `dispute_resolved` |
| disputa revertida | `reinstated` → `paid` + entrega `ready` |
| indicadores | `orders_refunded ≥ 1`, `payments_charged_back ≥ 1`, `orders_disputed` presente, "somente problemas" inclui `disputed` |

## Fase A (HTTP) — `tests/db/07_create_order_http.test.ts` (12 testes)

- mesmo `client_token` + mesma chave → mesmo pedido, `replayed: true`, **token devolvido
  é o mesmo** (sem rotação) e 1 único pedido no banco;
- mesma chave + outro token → **HTTP 409** `idempotency_conflict`, nenhum dado do pedido
  na resposta, hash do token inalterado no banco;
- mesma chave com produto/quantidade diferente → 409;
- chave curta / token fraco → 422 e nenhum pedido criado;
- repetição de retry → 1 reserva, 2 unidades ainda disponíveis;
- chave de criptografia: usa env quando existe (0 chamadas ao banco), cai para
  `get_secret_material('prime_store_encryption_key')` quando não existe (1 chamada,
  memorizada), falha fechada (null) quando não há segredo;
- `admin-api` `orders.resolveDispute`: sem token → 401; decisão inválida → 422.

## Fase C/D/F — `tests/db/08_privilegios_funcoes.test.ts` (13 testes)

- `anon` não lê nenhuma das 10 tabelas internas; lê apenas `public_catalog`;
- `authenticated` idem; `service_role` lê tudo;
- `anon` executa **0** funções; `authenticated` executa apenas `admin_*` + `is_admin`;
- `admin_list_orders`: não-admin → `not_admin`; AAL1 → `mfa_required`; AAL2 → sucesso;
- `is_admin(true)`: `false` em AAL1, `true` em AAL2;
- `admin_stock_fingerprints`: AAL1 → `mfa_required`; não-admin → `not_admin`; AAL2 →
  apenas hashes de 64 caracteres hex;
- `SECURITY DEFINER` com `search_path=public, pg_temp`: 41/41;
- nenhuma tabela sem RLS; nenhuma política com `roles={public}`/`USING true`;
- `public_catalog` sem `cost_cents`/credenciais/tokens;
- `get_order_status` sem `'token_enc'` e com `link_ready`;
- `get_delivery_token_enc` executável **somente** por `service_role`;
- índice da FK `stock_units_import_batch_idx` presente e **nenhum par de índices com a
  mesma definição** (protege o achado corrigido pela migração `0025`).

## Testes anteriores mantidos e ajustados

- `02_orders_reservations`: a asserção "replay rotaciona o token" descrevia o bug; foi
  substituída por "replay para a mesma requisição e nunca troca o token do pedido".
- `05_end_to_end_flow`: `buildDeps` passou a fornecer `serviceRpc` e
  `resolveEncryptionKey` (novas dependências).
- `01_schema_security`, `03_payments_webhooks`, `04_admin_delivery`: sem alteração.

## Limitações declaradas

- Testes de banco rodam contra PostgreSQL **local** (16.2). O remoto é 17.11; os
  invariantes verificados por SQL coincidem, mas não há aqui suíte remota automatizada.
- Nenhuma chamada HTTP real às Edge Functions implantadas foi possível (sem rede para
  `*.supabase.co` neste ambiente).
- O Mercado Pago foi exercitado com **providor simulado** (`tests/unit/fakeMp.ts`).
  Isso **não** é validação de integração real e está registrado como pendência.
