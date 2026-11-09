# Missão 06 — Painel administrativo operacional: auditoria, correções e ativação

**Data:** 2026-11-09 · **Branch:** `arena/66cda9f6-prime-store` · **Base:** `bf3a3a3` (preservado) ·
**Escopo:** transformar o painel em ferramenta operacional real contra o Supabase. Nenhuma
alteração de regra de negócio, pagamento, estoque automático, `main` ou produção.

> **Veredito:** o painel já estava conectado de ponta a ponta ao Supabase (serviços
> reais, `admin-api` com JWT + allowlist + AAL2, funções SQL com `assert_admin()`,
> dados persistidos). Nesta missão eu **auditei tudo**, **corrigi um defeito real**
> no gateway (`admin-api`), **acrescentei** uma suíte de integração HTTP→banco e
> **comprovei a persistência real** na homologação local. O que falta para operar
> é exclusivamente **externo**: acesso ao Supabase real, `PRIME_ENCRYPTION_KEY` e o
> provisionamento dos dois administradores. Ver §7.

## 1. Auditoria do Supabase e do banco (Grupo 02)

**Conectividade:** neste ambiente de trabalho **não há rota de rede** para `*.supabase.co`
(verificado: `curl https://supabase.co` e `https://<ref>.supabase.co` → `000`).
A auditoria estrutural foi feita sobre as **migrações versionadas aplicadas do zero**
em PostgreSQL 18.6 real (embedded, descartável), que reproduz fielmente o schema de
produção — a mesma estratégia da suíte `test:db`.

**Tabelas (22) e estrutura:** `products` (+`archived_at`, `is_demo`), `product_categories`
(5 semeadas: formas de acesso/modalidades), `product_price_history`,
`stock_units` (credenciais criptografadas por unidade; `status`
avocado/disponível), `stock_reservations` + `stock_reservation_units`, `orders`
(+`buyer_name`/`buyer_email` **não renderizáveis no painel**, `items_count`),
`order_items`, `order_events`, `payments` (+`provider_snapshot`), `payment_events`
(dedup por `notification_unique`), `refund_requests` (1 aberta por pedido),
`deliveries` + `delivery_units`, `admin_users` (allowlist), `admin_audit_log`,
`import_batches`, `rate_limit_counters`, `job_health`, `app_settings`.

**ENUMs:** `order_status = pending_payment, paid, expired, cancelled, refund_pending,
refunded, failed, disputed, requested` · `payment_status = pending, in_process, approved,
rejected, cancelled, refunded, charged_back, amount_mismatch, not_required` ·
`stock_unit_status = available, reserved, sold, disabled` · `delivery_status =
not_ready, ready, revoked, blocked`.

**Segurança:** **todas as 22 tabelas têm RLS ligada**; `anon`/`authenticated` **não
têm nenhum GRANT** em tabela — acesso só via funções `SECURITY DEFINER`
(`get_catalog`, `assert_admin`, …) que aplicam autorização, ou via `service_role` no
servidor. `admin_audit_log`: RLS, sem UPDATE/DELETE para papéis de usuário; toda
mutação grava linha com ator (`log_admin_action`).

**Funções administrativas (24)** — todas `SECURITY DEFINER`, todas iniciando por
`assert_admin()` (allowlist `is_active` + `aal = 'aal2'`), com `FOR UPDATE`/`SKIP LOCKED`
nos pontos de contenção (reserva de estoque, importação, reembolso, expiração),
idempotência (fingerprint único de credencial, `already_resolved`, idempotency key com
token) e transação implícita (tudo ou nada).

**Estoque por unidades, não por contador.** Cada unidade é uma linha com credencial
criptografada (AES-256-GCM) e `credential_fingerprint` (HMAC). "Quantos posso vender"
= `count(status='available')` — sempre consistente com o banco. **Não existe** tabela
de movimentações: o histórico operacional são `admin_audit_log` (ator + ação +
from/to), `order_events` (ciclo de vida do pedido) e `product_price_history`
(trigger em `UPDATE OF price_cents, cost_cents`). Isso foi verificado, não presumido.

**Migrações pendentes/diferenças:** nenhuma — o reset aplica as **37 migrações** do
zelo ao banco sem erro (feito nesta sessão).

**Dados reais vs de teste:** o ambiente local nasce vazio (0 linhas) exceto as 5
categorias e `app_settings` (6); a loja de produção/sandbox tem dados reais
(`products`/`orders`/…) que **não** foram tocados — sem credenciais e sem rede, por
construção.

## 2. Auditoria funcional do painel (Grupo 03)

Legenda: **IV** implementada e validada · **INV** implementada, não validada (depende de
ambiente/credencial externo) · **PI** parcialmente implementada · **NI** não implementada
(por regra de negócio) · **BXDE** bloqueada por dependência externa.

| Operação | Caminho | Classe |
|---|---|---|
| Login admin (e-mail+senha) | `AdminLogin` → `adminAuth.signInWithPassword` → Supabase Auth | IV (unit+HTTP) |
| Gate TOTP / AAL2 | `AdminMfaGate`, `adminAuth.verifyTotp`; banco exige `aal2` | IV (testes de rota/HTTP) |
| Listar produtos | `AdminProducts` → `admin_api products.list` → `admin_list_products` | IV (frontend+DB+HTTP) |
| Criar produto | form → `products.create` → `admin_create_product` (valida, grava, audita) | IV (HTTP+DB; auditoria verificada) |
| Editar produto (preço/custo/…) | `products.update` → `admin_update_product` (+trigger histórico) | IV (histórico comprovado por SQL) |
| Ativar/desativar produto | `products.setActive` → `admin_set_product_active` | IV |
| Associação produto↔categoria | campo `category_id` no form (validado; FK para `product_categories`) | IV |
| Excluir produto | **não existe** — alternativa segura: desativar/arquivar (`is_active`, `archived_at`) | NI (por design) |
| Histórico de preços | `admin_get_product` → trigger `products_price_history` | IV (comprovado) |
| Listar/resumir estoque | `AdminStock` → `stock.summary`/`stock.list` → `admin_stock_summary`/`admin_list_stock` | IV |
| Cadastrar unidade | `stock.add` → `admin_add_stock_unit` (HMAC fingerprint, unique → 409) | IV (HTTP+SQL) |
| Editar credencial/notas | `stock.update` → `admin_update_stock_unit` | IV |
| Ativar/desativar unidade | `stock.setStatus` → `admin_set_stock_unit_status` (só available↔disabled; `for update`) | IV |
| Importar CSV (prévia→grava) | `stock.import.preview/commit` → `admin_import_stock_units` (idempotente por fingerprint) | IV (testes DB) |
| "Quantidade manual" (contador) | **não existe** — modelo por unidades; "ajuste" = desativar/reativar unidade + nota | PI (por design; ver §6) |
| Saída comercial de estoque | pedido pago → reserva consumida (`consume_reservation`, `sold`) | IV (fluxo E2E) |
| Devolução ao estoque pós-reembolso | **não há restock automático** (produto digital consumido; revoga entrega) | BXDE/regra de negócio |
| Listar/filtrar pedidos | `AdminOrders` → `orders.list` → `admin_list_orders` (clamp 1–200) | IV |
| Detalhe do pedido | `orders.get` → `admin_get_order` (sem `client_token_hash`; PII buyers não renderizada) | IV |
| Alterar estado do pedido livremente | **não existe** — transições por: webhook (pagamento), reembolso, disputa, revogação | NI (regra comercial) |
| Resolver reembolso | `refunds.resolve` → `admin_resolve_refund` (revoga entrega se processado; idempotente) | IV |
| Resolver disputa | `orders.resolveDispute` → `admin_resolve_dispute` | IV |
| Revogar/rotacionar entrega | `deliveries.revoke`/`rotate` → funções + `delivery_url` (token só no cliente HTTPS) | IV |
| Indicadores comerciais | `AdminOverview` → `indicators` → `admin_indicators()` + período por `orders.list` | IV (not_required nunca vira receita) |
| Logs de auditoria | `audit.list` → `admin_audit_log` (ator, ação, entidade) | IV (verificado por SQL) |
| Expiração manual de reservas | `reservations.expire` → `admin_expire_reservations` | IV |
| Integração de pagamento real | Mercado Pago congelado no código; loja vende "solicitação sem pagamento"; WyviPay **planejada, não implementada** | BXDE |
| Provisionar 2 administradores | `scripts/provision-admin.sql` + `docs/painel-admin.md` | BXDE (execução exige acesso ao Supabase) |

## 3. Correções implementadas nesta missão

**Defeito (gateway, severidade média):** `orders.list` aceitava `from`/`to` como texto
arbitrário e `limit`/`offset` via `Number(...)` sem validação. Valores como `'lixo'`
o faziam o PostgreSQL levantar `22P02` → `500 internal_error` (e `NaN` chegava ao banco).
Agora o gateway valida: `optionalIsoTimestamp` (422 estável, aceita só datas ISO) e
`boundedInt` (faixa segura com fallback; cobre `stock.list` e `audit.list` também).
Nada no caminho feliz mudou.

**Arquivos:** `supabase/functions/_shared/validation.ts` (+`optionalIsoTimestamp`,
+`boundedInt`), `supabase/functions/_shared/handlers/adminApi.ts` (4 pontos).
**Novos testes:** `tests/db/20_admin_api_http.test.ts` — **12 casos** (401 sem sessão,
400 JSON inválido, 400 ação desconhecida, 422 data malformada, clamp de limit/offset,
422 create sem nome/preço, 422 refund status, 503 sem chave de criptografia sem gravar,
sessão AAL2 ok, **CRUD de produto por HTTP persistido no banco com trigger de histórico
e auditoria**, **stock.add por HTTP → indicators atualizado → duplicado → 409 sem
corromper**).

**NADA mais foi alterado.** Frontend intacto; modo demo intacto (Missão 05.1 aguarda
sua decisão); nenhuma tabela/migração; nenhuma regra comercial.

## 4. Evidências de persistência real (homologação local)

PostgreSQL 18.6 real, schema recriado pelas 37 migrações, sem rede e sem produção:

| Prova | Evidência |
|---|---|
| Produto criado por HTTP está no banco (`created_by` = admin seed) | `tests/db/20_admin_api_http.test.ts › CRUD de produto` |
| Editar preço por HTTP dispara `product_price_history` (4990→5990) | idem, asserção SQL direta |
| Criar→desativar produto preserva o registro; `is_active=false` | idem |
| Ações geram trilha em `admin_audit_log` (`product_created`, `product_updated`, `product_deactivated`, `stock_unit_added`) | idem + asserção `count >= 1` |
| `stock.add` por HTTP +1 `available` em `indicators`; duplicado → 409 e total inalterado | idem |
| Pedido real → reserva → pagamento aprovado → unidades `sold`; expiração devolve estoque | `tests/db/02, 05, 12, 17, 18` (5 arquivos, inalterados, verdes) |
| Não-admin AAL2 ou admin AAL1 são recusados (`403`/`mfa_required`) | `tests/db/05`, `07`, `20` |

## 5. Testes executados e resultados

| Suíte | Resultado |
|---|---|
| `npm test` (frontend/jsdom) | **118/118** (15 arquivos) |
| `npm run test:db` (PostgreSQL real) | **276/276** (22 arquivos) — baseline 264 + 12 novos |
| `npm run typecheck` | limpo |
| `npm run build` | OK (`AdminPage-*.js`, gzip ~73 kB) |
| `npm run bundle:functions` | 8 funções empacotadas OK |
| Auditoria visual (9 larguras) do painel | **54/54 telas sem estouro** (igual à Missão 05) |

## 6. O que NÃO existe / limitações (sem suavização)

1. **Estoque manual por contador** — o modelo é por unidade com credencial; não há
   coluna `quantity` para editar nem tabela de movimentações. Entradas = cadastrar/importar
   unidades; saídas comerciais = venda/reserva (automático); correções = desativar
   unidade com nota auditada. Se você quiser um razão de movimentações
   (`stock_movements`), é uma **migração nova** — não feita sem sua autorização.
2. **Restock pós-reembolso** — não existe devolução de unidades ao estoque após
   `refund_processed` (entrega é revogada; unidade permanece `sold`). Adequado para
   produto digital consumido; mudar exige decisão comercial.
3. **Integração de pagamento real** — hoje a loja vende **solicitação sem pagamento**
   (`requested`/`not_required`). O código Mercado Pago existe, congelado; credenciais
   `MP_*` **não** estão configuradas em lugar nenhum; **WyviPay não foi iniciada**
   (missão 08 foi só reconhecimento). O painel **já trata** `not_required` fora da
   receita — conferido.
4. **Acesso a aparelho físico** — verificação por emulação headless apenas.
5. **Re-publicação das Edge Functions** — só necessária quando as mudanças de
   validação forem implantadas **e** a WyviPay for integrada; deploy não é desta missão.

## 7. Ativação operacional (ordem objetiva)

1. **Supabase do projeto (produção/sandbox):** confirmar `PRIME_ENCRYPTION_KEY`
   (ou Vault `prime_store_encryption_key`), `STORE_URL`, `ALLOWED_ORIGINS`; **injetar
   as Edge Functions atuais** (incluem o fix de validação): `npm run bundle:functions`
   e deploy das 9 ou pelo painel.
2. **Provisionar os dois administradores** (`docs/painel-admin.md` §Provisionamento):
   criar os usuários em Auth (e-mail real + senha forte), rodar
   `scripts/provision-admin.sql` com os UUIDs, confirmar e-mail, cadastrar TOTP no
   primeiro login de cada um. **Nenhum UUID ou e-mail real existe no repositório;
   nenhum admin foi criado remotamente regerando-se esta missão.**
3. **Fumaça pós-provisionamento:** `node scripts/smoke-edge-functions.mjs` com
   `ADMIN_JWT` (AAL2) — ver §8; `session` deve responder `is_admin:true,
   mfa_satisfied:true`; `indicators` deve retornar números reais.
4. **Pagamentos (decisão comercial externa):** escolher Mercado Pago (retomar) ou
   WyviPay (planejamento da missão 08) e executar a integração — hoje a loja não
   cobra. **Nenhuma mudança de pagamento foi feita nesta missão.**
5. **Opcionais:** aparelho físico para checagem final; decisão sobre `stock_movements`
   e restock pós-reembolso (migrações novas).

## 8. Preservação

`main` intacta (`8f37527`); nenhum merge; nenhum deploy; PR #2 segue **draft**;
`bf3a3a3` permanece no histórico; loja pública inalterada (`npm test` verde, inclui
`App.test.tsx`); dados de produção não lidos nem modificados (sem acesso);
credenciais de teste só em memória; nenhum segredo versionado.
