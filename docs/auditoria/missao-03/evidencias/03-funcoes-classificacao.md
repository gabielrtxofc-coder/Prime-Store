# Evidência 03 — Classificação das funções do schema `public`

Estado após as migrações `0017`–`0024`, verificado com
`has_function_privilege(...)` no banco local reconstruído e no projeto remoto
`eorlmqolbknrplvdbbtl` (41 `SECURITY DEFINER`, 4 funções de trigger sem
`SECURITY DEFINER`, 45 no total; 0 executáveis por `anon`; 23 por `authenticated`).

## 1. RPC administrativa (Edge Function `admin-api`) — 23

Executáveis por `authenticated`, mas **sempre** passam por `assert_admin()`
(allowlist `admin_users.is_active` **e** `aal = 'aal2'`). Não acessam ciphertext
sem necessidade e registram auditoria quando alteram estado.

`admin_add_stock_unit`, `admin_audit_log`, `admin_create_product`,
`admin_expire_reservations`, `admin_get_order`, `admin_get_product`,
`admin_import_stock_units`, `admin_indicators`, `admin_list_orders`,
`admin_list_products`, `admin_list_refund_requests`, `admin_list_stock`,
`admin_resolve_dispute`, `admin_resolve_refund`, `admin_revoke_delivery`,
`admin_rotate_delivery_token`, `admin_set_product_active`,
`admin_set_stock_unit_status`, `admin_stock_fingerprints`, `admin_stock_summary`,
`admin_update_product`, `admin_update_stock_unit`, `is_admin`.

Observações:
- `admin_list_stock` só devolve `email_enc`/`password_enc` com
  `p_include_credentials = true`; a decifragem acontece no `admin-api`, nunca no navegador.
- `admin_rotate_delivery_token` recebe o **ciphertext já cifrado** pelo backend; o RPC
  não conhece a chave.
- `is_admin(boolean)` é consulta sem efeito colateral, usada para a UI decidir se pede MFA.

## 2. Backend interno (somente `service_role`) — 17

| Função | Papel |
| --- | --- |
| `create_order` | cria pedido + reserva de 30 min; idempotência (fase A) |
| `attach_payment` | grava o QR/copia-e-cola devolvido pelo provedor |
| `apply_payment_status` | máquina de estados do pagamento (fase B) |
| `record_payment_event` / `finish_payment_event` | deduplicação e trilha de webhooks |
| `get_order_status` | estado do pedido sob prova do token privado (sem ciphertext) |
| `get_delivery_token_enc` | **único** acesso ao ciphertext do link (prova de posse) |
| `resolve_delivery` | credenciais cifradas de uma entrega ativa (decifragem no servidor) |
| `get_catalog` | catálogo público (a Edge Function aplica limites) |
| `reserve_stock_units`, `release_order_reservation`, `consume_reservation`, `allocate_late_units`, `expire_overdue_reservations` | estoque e reservas |
| `assert_admin`, `log_admin_action` | autorização/auditoria usadas pelas RPCs admin |
| `get_secret_material` | leitura do segredo no Vault — **nunca** exposto a usuários |
| `setting_int` | leitura de configuração operacional |

## 3. Trigger / utilitárias (sem `SECURITY DEFINER`) — 4

`set_updated_at` (trigger de `updated_at`), `products_record_price_change` (trigger de
histórico de preço) e `generate_order_reference` (helper da referência `PS-XXXXXX` usada
por `create_order`). Todas com `search_path = public, pg_temp` fixo (migração `0020`).

## 4. “Não deveria ser executável por `authenticated`” — verificação, não promessa

Nenhuma função interna aparece na lista de executáveis por `authenticated`:

```
create_order ................... authenticated=false  anon=false
apply_payment_status ........... authenticated=false  anon=false
resolve_delivery ............... authenticated=false  anon=false
get_order_status ............... authenticated=false  anon=false
get_delivery_token_enc ......... authenticated=false  anon=false   service_role=true
get_secret_material ............ authenticated=false  anon=false
record_payment_event ........... authenticated=false  anon=false
```

`revoke execute on all functions in schema public from public, anon, authenticated` é
reaplicado na `0022` e há `alter default privileges ... revoke execute` para que
funções futuras não nasçam expostas.
