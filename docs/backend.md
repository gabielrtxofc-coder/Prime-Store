# Backend: banco, funções e endpoints

## Migrações (`supabase/migrations`)

Aplicadas em ordem alfabética; cada arquivo é reprodutível a partir de um banco
vazio. Não há alteração manual de schema.

| Arquivo | Conteúdo |
| --- | --- |
| `…_0001_tipos_enums.sql` | Enums de estado (`order_status`, `payment_status`, `stock_unit_status`, `reservation_status`, `delivery_status`, `delivery_link_status`) |
| `…_0002_fundacao_configuracao.sql` | `app_settings` (durações de reserva/PIX, limite por pedido) e `setting_int()` |
| `…_0003_administracao.sql` | `admin_users` (allowlist) e `admin_audit_log` |
| `…_0004_catalogo_produtos.sql` | `product_categories`, `products` (preço, custo, validade, instruções, tema), `product_price_history` |
| `…_0005_estoque_unidades.sql` | `stock_units` (credenciais cifradas + fingerprint) e `import_batches` |
| `…_0006_pedidos_reservas.sql` | `orders`, `order_events`, `stock_reservations`, `stock_reservation_units` |
| `…_0007_pagamentos.sql` | `payments`, `payment_events`, `refund_requests` |
| `…_0008_entregas.sql` | `deliveries` (hash do token) e `delivery_units` |
| `…_0009_integridade_indices.sql` | PKs, uniques, índices e FKs |
| `…_0010_view_catalogo_publico.sql` | View `public_catalog` (única leitura pública) |
| `…_0011_funcoes_nucleo.sql` | Funções de negócio (pedido, reserva, pagamento, entrega) |
| `…_0012_funcoes_admin.sql` | Funções administrativas (`admin_*`) |
| `…_0013_triggers.sql` | `updated_at` e histórico de preços |
| `…_0014_seguranca_rls_grants.sql` | RLS em todas as tabelas, revogação de GRANTs, EXECUTE explícito |
| `…_0015_comentarios.sql` | Comentários de documentação dentro do banco |
| `…_0016_seed_categorias_e_config.sql` | Categorias e parâmetros iniciais (idempotente) |
| `…_0017_idempotencia_pedido.sql` | `create_order` com replay idempotente por (chave + token + produto + quantidade) e `idempotency_conflict` |
| `…_0018_status_disputa.sql` | Valor `disputed` em `order_status` (isolado: enum não pode ser usado na mesma transação) |
| `…_0019_chargeback_x_reembolso.sql` | `apply_payment_status` separa reembolso de contestação; `admin_resolve_dispute`; indicadores e filtro de problemas |
| `…_0020_search_path_funcoes.sql` | `search_path = public, pg_temp` em todas as funções |
| `…_0021_indices_operacionais.sql` | Índice da FK `stock_units.import_batch_id` + índices de consulta real |
| `…_0022_privilegios_finais.sql` | Fechamento de privilégios e RLS reafirmada |
| `…_0023_cofre_chave_criptografia.sql` | Chave AES-256 no Supabase Vault + `get_secret_material(text)` (`service_role`) |
| `…_0024_status_sem_ciphertext.sql` | `get_order_status` sem `token_enc`; `get_delivery_token_enc(uuid, text)` |
| `…_0025_indices_redundantes.sql` | Remove 3 índices com definição duplicada (mantém o índice da FK de importação) |

## Modelo de dados (resumo)

- **products** — `slug` único, preço e custo em centavos, `access_validity_days`,
  `instructions` (públicas), `max_quantity_per_order`, `is_active`,
  `archived_at`. Custo e margem nunca aparecem no catálogo público.
- **stock_units** — `product_id`, `account_email_enc`/`account_password_enc`
  (`bytea` cifrado AES-256-GCM), `credential_fingerprint` (HMAC-SHA256, único por
  produto), `status` (`available | reserved | sold | disabled`),
  `sold_order_id`, `import_batch_id`.
- **orders** — um produto por pedido, `quantity`, `unit_price_cents`,
  `total_cents` (CHECK de consistência), `status`, `payment_status`,
  `delivery_status`, `client_token_hash`, `idempotency_key`, `reference`
  (`PS-XXXXXX`), `reservation_expires_at`.
- **stock_reservations / stock_reservation_units** — reserva de 30 min com
  índice único parcial que impede duas reservas vivas para a mesma unidade.
- **payments / payment_events** — cobrança PIX (`provider_payment_id` único) e
  log idempotente de notificações (`payment_events` com unique por notificação).
- **deliveries / delivery_units** — token guardado apenas como hash SHA-256;
  `delivery_units` liga a entrega às unidades vendidas (uma unidade pertence a
  uma única entrega).
- **refund_requests** — reembolso manual com estados
  `pending | authorized | processed | rejected`.
- **admin_users / admin_audit_log** — allowlist e auditoria de operações.

## Funções SQL relevantes

### Núcleo (service_role)

| Função | Papel |
| --- | --- |
| `create_order(product_id, quantity, idempotency_key, client_token_hash)` | Resolve reservas vencidas, seleciona unidades com `FOR UPDATE SKIP LOCKED`, cria pedido + reserva e devolve os dados públicos. Nunca aceita preço do cliente. |
| `get_order_status(order_id, client_token_hash)` | Consulta do comprador; exige o hash do token privado. |
| `expire_overdue_reservations(product_id)` | Libera unidades e marca pedidos vencidos. Idempotente; chamado em toda criação de pedido. |
| `attach_payment(...)` / `apply_payment_status(...)` | Registra a cobrança e aplica o estado real do pagamento (aprovação, recusa, estorno, aprovação tardia, divergência de valor). |
| `record_payment_event(...)` / `finish_payment_event(...)` | Deduplicação de webhooks (um registro por notificação). |
| `resolve_delivery(token_hash)` | Devolve credenciais cifradas apenas para pedido pago, aprovado e entrega ativa; incrementa contador de visualizações. |
| `admin_*` | Operações do painel, todas protegidas por `assert_admin()` (allowlist + AAL2). |

### Autorização

```sql
assert_admin() -- exige auth.uid() na allowlist ativa e claim aal = 'aal2'
is_admin(require_mfa boolean) -- versão booleana para o frontend
```

`anon` e `authenticated` **não** têm GRANT em nenhuma tabela; o único objeto de
leitura pública é a view `public_catalog`. Nenhuma função interna é executável
por `anon`; `authenticated` recebe EXECUTE apenas nas funções `admin_*`, que
revalidam a autorização internamente.

## Endpoints das Edge Functions

| Função | Método | Corpo | Retorno |
| --- | --- | --- | --- |
| `catalog` | `GET` (`?q&category`) ou `POST` | `{ q?, category? }` | `{ products[], generated_at }` |
| `create-order` | `POST` | `{ product_id, quantity, payer_email, idempotency_key? }` | `201 { order, client_token, payment{ qr_code, qr_code_base64, ticket_url, expires_at } }` |
| `order-status` | `POST` | `{ order_id, client_token }` | `{ order_id, reference, status, payment_status, delivery_status, payment, delivery{ url } }` |
| `delivery` | `GET ?token=` ou `POST { token }` | | `{ reference, product{ instructions, access_validity_label }, units[{ email, password, notes }] }` |
| `mp-webhook` | `POST` | Notificação do Mercado Pago | `{ received: true }`, `401` em assinatura inválida, `500` para forçar reentrega |
| `admin-api` | `POST` + `Authorization: Bearer <JWT>` | `{ action, payload }` | Resultado da ação |
| `demo-payment` | `GET` | — | `{ demo_enabled, mode }` (capacidade do servidor) |
| `demo-payment` | `POST` | `{ action: 'approve', order_id, client_token }` | `{ demo: true, result, order_status, payment_status, delivery_status }` |

### Pagamento demonstrativo (somente sandbox)

`demo-payment` existe para percorrer o fluxo sem provedor de pagamento. Ela não
cria cobrança, não fala com o Mercado Pago e não aceita nada fora do sandbox
autorizado: exige o segredo `DEMO_PAYMENT_ENABLED=true`, a ref do projeto em
`DEMO_ALLOWED_PROJECT_REFS` e `app_settings.demo_payments_enabled = true`
(faltando qualquer uma, responde `404`). Só atua em produtos/unidades
`is_demo = true`, grava o pagamento com provider `demo` e chama a **mesma**
`apply_payment_status(id, 'approved')` usada pelo webhook real — portanto a
reserva, o consumo de estoque e a entrega seguem as regras normais.
`create-order` responde `payment: null` e `payment_mode: "demo"` nesses pedidos,
para que o frontend nunca exiba um PIX falso.

### Códigos de erro estáveis

`insufficient_stock` (409, com `available_units`), `quantity_above_product_limit`
(422), `product_unavailable` (404), `not_found` (404), `delivery_unavailable`
(410), `mfa_required` (403), `forbidden` (403), `duplicate_credential` (409),
`payment_not_configured` (503), `payment_provider_unavailable` (502),
`demo_unavailable` (404), `demo_order_not_payable` (409),
`demo_reservation_expired` (410), `demo_real_stock_blocked` (409),
`invalid_signature` (401), `internal_error` (500).

## Estados

```
order.status:      pending_payment → paid → refunded
                   pending_payment → expired (reserva vencida)
                   pending_payment → cancelled (pagamento recusado)
                   paid → refund_pending (aprovação tardia sem estoque)
                   * → failed (divergência de valor)
payment.status:    pending | in_process | approved | rejected | cancelled
                   | refunded | charged_back | amount_mismatch
delivery_status:   not_ready | ready | blocked | revoked
```

A aprovação de pagamento **nunca** faz downgrade de um pedido pago; webhooks
repetidos e fora de ordem são idempotentes (`payment_events` +
`apply_payment_status`).
