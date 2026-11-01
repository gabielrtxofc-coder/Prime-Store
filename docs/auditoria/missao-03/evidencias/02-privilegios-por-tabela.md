# Evidência 02 — Privilégios por tabela (5 contextos)

Projeto: `prime-store-sandbox` / `eorlmqolbknrplvdbbtl` (sa-east-1, PostgreSQL 17).
Verificação executada também no banco local reconstruído pelas 25 migrações
(`tests/db/08_privilegios_funcoes.test.ts`), com privilégios efetivos
(`has_table_privilege` + tentativa real de leitura sob `set local role`).

## Modelo

| Contexto | Tabelas internas | `public_catalog` | Funções | Caminho de acesso |
| --- | --- | --- | --- | --- |
| `anon` | nenhum privilégio | `SELECT` | nenhuma | Edge Functions públicas (`catalog`, `create-order`, `order-status`, `delivery`, `mp-webhook`) |
| `authenticated` (não admin) | nenhum privilégio | `SELECT` | nenhuma | idem |
| `authenticated` admin **sem MFA** | nenhum privilégio | `SELECT` | `admin_*` executam, mas levantam `mfa_required` | `admin-api` (recusa 403) |
| `authenticated` admin **com MFA (AAL2)** | nenhum privilégio direto | `SELECT` | `admin_*` executam | `admin-api` → RPC com o JWT do usuário |
| `service_role` | todos | `SELECT` | todas | Edge Functions (backend) |

Não existe política por linha (`CREATE POLICY`) em nenhuma tabela **de propósito**: RLS
está habilitada em todas as 17 tabelas e, sem política, o acesso direto por
`anon`/`authenticated` é negado por completo. Quem precisa de dado passa por
funções `SECURITY DEFINER` com validação própria — não por política genérica
(`USING (true)`), que era justamente o que a auditoria pedia para evitar.

## Inventário (17 tabelas + 1 view)

| Objeto | RLS | Políticas | `anon` | `authenticated` | `service_role` | Observação |
| --- | --- | --- | --- | --- | --- | --- |
| `admin_audit_log` | sim | 0 | — | — | SELECT/ALL | Auditoria de ações administrativas |
| `admin_users` | sim | 0 | — | — | ALL | Allowlist de administradores |
| `app_settings` | sim | 0 | — | — | ALL | `reservation_minutes`, `pix_expiry_minutes`, … |
| `deliveries` | sim | 0 | — | — | ALL | `token_hash` + `token_enc` (ciphertext) |
| `delivery_units` | sim | 0 | — | — | ALL | Vínculo entrega ↔ unidade |
| `import_batches` | sim | 0 | — | — | ALL | Lotes de importação de estoque |
| `order_events` | sim | 0 | — | — | ALL | Histórico (inclusive disputas) |
| `orders` | sim | 0 | — | — | ALL | `client_token_hash`, `idempotency_key` |
| `payment_events` | sim | 0 | — | — | ALL | Deduplicação de webhooks |
| `payments` | sim | 0 | — | — | ALL | QR/copia-e-cola, valor, status |
| `product_categories` | sim | 0 | — | — | ALL | Categorias |
| `product_price_history` | sim | 0 | — | — | ALL | Histórico de preço |
| `products` | sim | 0 | — | — | ALL | Inclui `cost_cents` (nunca exposto) |
| `refund_requests` | sim | 0 | — | — | ALL | Pendências de reembolso |
| `stock_reservation_units` | sim | 0 | — | — | ALL | Unidades reservadas por reserva |
| `stock_reservations` | sim | 0 | — | — | ALL | Reservas de 30 minutos |
| `stock_units` | sim | 0 | — | — | ALL | Credenciais cifradas + fingerprint |
| `public_catalog` (view) | n/a | n/a | **SELECT** | **SELECT** | SELECT | Único objeto exposto; sem custo/credenciais |

Colunas da view pública verificadas por teste: não existem `cost_cents`,
`account_email_enc`, `account_password_enc`, `credential_fingerprint`,
`client_token_hash`, `token_hash` nem `token_enc`.

## Resultado das verificações (executadas, não declaradas)

```
anon lê stock_units .................... false
anon lê orders ......................... false
anon executa create_order .............. false
anon executa admin_indicators .......... false
authenticated lê orders ................ false
authenticated executa create_order ..... false
authenticated executa get_secret_material false
authenticated executa admin_list_orders  (AAL1) → mfa_required
authenticated executa admin_list_orders  (AAL2) → true
authenticated executa admin_* .......... apenas funções admin_* e is_admin
service_role executa ................... 45/45 funções
tabelas sem RLS ........................ 0
políticas genéricas (roles={public} ou USING true)  0
```

## Duas exceções conscientes (documentadas)

1. **`admin_stock_fingerprints` é executável por `authenticated`.** É chamada pelo
   `admin-api` com o JWT do administrador e valida `assert_admin()` (allowlist + AAL2)
   internamente. Devolve apenas HMAC-SHA256 com chave derivada do servidor
   (`prime-store/fingerprint/v1`), não reversível sem a chave mestra. Necessária para
   deduplicar importações de estoque. Teste cobre: AAL1 → `mfa_required`; não-admin →
   `not_admin`; AAL2 → apenas hashes de 64 hex.
2. **`get_delivery_token_enc` devolve o ciphertext do token do link**, mas é
   `service_role`-only, exige prova de posse (`client_token_hash`) e só devolve material
   de entrega ativa. É a superfície mínima necessária para decifrar no servidor.
