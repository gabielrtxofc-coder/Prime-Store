# Missão 08 — Reconciliação, validação e ativação controlada do Supabase

> **Data:** 2026-11-09 · **Branch:** `arena/66cda9f6-prime-store` (a partir de `c644e1e`)
> **Projeto:** `eorlmqolbknrplvdbbtl` (`prime-store-sandbox`, sa-east-1, PostgreSQL 17.11.0.011)
> **Classificação final: PARCIAL.** Nenhuma validação HTTP remota, nenhum admin real,
> nenhuma verificação de backup e nenhum deploy de Edge Function puderam ser concluídos
> nesta sessão — ver seções 8–12.
> **Pagamentos congelados durante toda a missão** (sem Mercado Pago, WyviPay, PIX, webhooks ou cobrança ativados).

## 1. Resumo executivo

| Área | Estado |
|---|---|
| Projeto confirmado e saudável (exceto Realtime) | ✅ verificado |
| Migrações 0034→0038 **aplicadas** de forma aditiva e idempotente | ✅ aplicadas e verificadas |
| Migração 0033 confirmada aplicada (histórico remoto `solicitacao_sem_pagamento` + `_v2`) | ✅ verificada no histórico e por efeitos |
| Migração 0030 (`grants_rls_public_catalog`) confirmada no histórico remoto | ✅ entrada existente (correção de achado anterior) |
| RLS / grants / `search_path` re-auditados **após** as aplicações | ✅ 20/20 tabelas RLS; 0 policies; 0 grants anon/authenticated |
| Cron de expiração de reservas ativo e saudável | ✅ `job_health` OK, 0 falhas consecutivas |
| Cofre de criptografia íntegro (AES-256-GCM, 32 bytes) | ✅ sem revelar valores |
| Deploy da Edge Function `admin-api` (única que precisava de republicação) | ❌ **BLOCKED** (ferramentas de função sem efeito nesta sessão + rede inalcançável) |
| Smoke HTTP read-only | ❌ **BLOCKED** (sem saída de rede para `*.supabase.co`; sem anon key; conector sem ferramenta de invoke) |
| Verificação formal de backup/PITR | ❌ **BLOCKED** (conector não expõe ferramenta de backup) |
| Provisionamento de 2 admins reais | ❌ **BLOCKED** (faltam dados reais; `auth.users = 0`) |
| Realtime | ⚠️ **UNHEALTHY** (informativo; a loja usa polling) |

**Por que PARCIAL, e não BLOQUEADA nem APROVADA:** a maior parte da missão exigia
averiguações remotas, e estas foram executadas com evidência (auditorias SQL, migrações
aplicadas, grants, cron, catálogo de secrets por presença). Porém a missão só pode ser
declarada aprovada com validação remota de ponta a ponta (HTTP nas funções + smoke), que
não foi possível; e a pendência de admins permanece (depende de dados humanos).

## 2. Identidade do projeto (Grupo B)

`list_projects` → único projeto no escopo: `eorlmqolbknrplvdbbtl` (`prime-store-sandbox`),
organização da Arena, `sa-east-1`, `ACTIVE_HEALTHY`, PostgreSQL `17.11.0.011`,
criado em 2026-10-30. `get_project` confirma os mesmos dados. `get_project_health`:
`auth`, `db`, `db_postgres_user`, `rest`, `storage`, `pooler`, `pg_bouncer` =
`ACTIVE_HEALTHY`; **`realtime` = `UNHEALTHY`** (a loja não usa subscriptions; o painel
também não — polling é o mecanismo; manter monitorado, sem ação destrutiva).

## 3. Reconciliação de migrações (Grupo C/D)

### 3.1 Estado remoto antes desta missão

32 entradas no histórico (`list_migrations`), equivalentes renomeadas das locais
0001–0032 (nomes curtos: `foundation`, `admin_authorization`, `products_catalog`,
`stock_units`, `orders_reservations`, `payments_events`, `deliveries`, `reservation_core`,
`orders_api`, `payments_api`, `admin_api`, `admin_api_import_orders`,
`admin_api_delivery_refunds`, **`grants_rls_public_catalog`** ← 0030, `idempotencia_pedido`,
`status_disputa`, `chargeback_x_reembolso`, `search_path_funcoes`, `indices_operacionais`,
`privilegios_finais`, `cofre_chave_criptografia`, `status_sem_ciphertext`,
`indices_redundantes`, `modo_demonstrativo_estrutura`, `catalogo_pedido_demo`,
`demo_aprovacao_pagamento`, `demo_semeadura_privilegios`, `solicitacao_sem_pagamento`
(2026-11-01 07:09), `solicitacao_sem_pagamento_v2` (07:10), `0031_agendamento_expiracao_reservas`
(09:00), `0032_limite_requisicoes` (09:10)).

**Não havia** entradas para 0034, 0035, 0036, 0037 e 0038. Efeitos ausentes confirmados
por SQL: `create_order_multi`, `create_order_delivery`, `internal_confirm_payment`,
`allocate_late_units_multi`, `allocate_late_units_for_order`, `order_summary_multi`,
`parse_request_items`, `order_required_units`, `reserve_stock_units_multi`,
`order_items_json`, `order_stored_items_json`, `delivery_items_json` = ausentes;
`stock_adjustment_reason` (enum) ausente; `stock_units.status_reason*` ausente;
`apply_payment_status` na versão pré-0035 (sem entrega automática e sem o bloqueio 0037);
`admin_set_stock_unit_status(uuid, text)` na assinatura antiga.

### 3.2 0033 (solicitacao_sem_pagamento)

Aplicada **duas vezes** no remoto (v1 `20261101070946` e v2 `20261101071019`, 2026-11-01);
local consolidada em `supabase/migrations/20261101120000_0033_solicitacao_sem_pagamento.sql`.
Efeitos presentes no remoto: enum `order_status` contém `requested`;
`payment_status` contém `not_required`; `orders.buyer_name`/`buyer_email`;
`order_items` presente com `items_count` default. **Nenhuma reaplicação foi feita** —
somar entradas ao histórico não traria efeito novo (as migrações são idempotentes) e
geraria ruído no histórico.

Divergência de nomes/entradas (arquivo local único vs. duas entradas remotas) é **nominal,
não estrutural**: os objetos que a 0033 cria estão presentes e o fluxo de solicitação sem
pagamento está operacional no remoto.

### 3.3 0030 (`grants_rls_public_catalog`)

Correção de achado anterior desta própria missão: a entrada **existe** no histórico
remoto (`20261031003349`). O estado atual confere: `public_catalog` com
`security_invoker = true` e grants apenas para `postgres`/`service_role`
(0 para `anon`/`authenticated`).

### 3.4 Migrações aplicadas nesta missão (0034–0038)

Todas **aditivas** (novas funções `CREATE OR REPLACE`; 1 novo tipo enum; 2 novas colunas
nulas/com default; 2 inserts idempotentes em `app_settings`; relaxamento de CHECK de
`quantity` para 1–200; `DROP` apenas do overload antigo `admin_set_stock_unit_status(uuid, text)`).
Nenhuma linha de negócio foi alterada, nenhum dado foi apagado. Aplicadas via
`create_migration` na ordem de dependência (0034→0038), com rollback automático em caso
de falha — todas concluíram com sucesso (2026-11-09 17:14–17:16 UTC):

| Arquivo local | Nome no histórico remoto | Efeito-chave |
|---|---|---|
| `20261108120000_0034_pedidos_multiproduto.sql` | `m08_0034_pedidos_multiproduto` | Núcleo multi-produto: reserva por item em 1 transação, `create_order_multi`, `create_order_delivery` (entrega idempotente por pedido, cobertura validada por item), `internal_confirm_payment` (testes isolados; desligada por padrão; `service_role`), `app_settings.max_items_per_order=10`, `internal_confirmation_enabled=false` |
| `20261108121000_0035_pagamento_multiproduto.sql` | `m08_0035_pagamento_multiproduto` | `apply_payment_status` passa a alocar por item e **criar a entrega** ao aprovar (fecha o caminho "pago sem entrega"); comportamento de pedido legado preservado |
| `20261108122000_0036_entrega_multiproduto.sql` | `m08_0036_entrega_multiproduto` | `resolve_delivery` devolve `items` por produto (+`product`/`units` para compatibilidade) |
| `20261109120000_0037_bloqueio_solicitacao_sem_pagamento.sql` | `m08_0037_bloqueio_solicitacao_sem_pagamento` | Guarda `ignored_no_payment_required`: solicitação sem pagamento nunca vira venda, em qualquer caminho de confirmação |
| `20261109130000_0038_motivos_ajuste_estoque.sql` | `m08_0038_motivos_ajuste_estoque` | Enum `stock_adjustment_reason`; `stock_units.status_reason/status_reason_note`; `admin_set_stock_unit_status(uuid,text,text,text)` (motivo obrigatório ao desativar; `other` exige nota ≥ 5 chars); `admin_list_stock` expõe o motivo; overload antigo removido |

**Verificação pós-aplicação (SQL, somente leitura):**
- 12 funções novas presentes; `apply_payment_status` contém o marcador `ignored_no_payment_required` (corpo passou de 13.907 → 16.719 bytes); `admin_set_stock_unit_status` existe em **uma** versão (a nova);
- enum `stock_adjustment_reason` criado; colunas `status_reason` + `status_reason_note` presentes;
- 20 tabelas, **20 com RLS**, **0 políticas**, **0 grants** de tabela para `anon`/`authenticated` (0 DML também); **61 funções `SECURITY DEFINER`, todas com `search_path` fixo**; 23 funções executáveis por `authenticated` (exatamente as `admin_*` + `is_admin`), **0 por `anon`**;
- contagens de dados **inalteradas**: `products` 2, `orders` 8, `order_items` 2, `deliveries` 3, `stock_units` 27, `stock_reservations` 7, `payments` 3, `order_events` 18, `admin_users` 0, `admin_audit_log` 0;
- única escrita em tabela: `app_settings` ganhou `updated_at` + as chaves `max_items_per_order=10` e `internal_confirmation_enabled=false` (configuração, idempotente, sem dados de negócio).

### 3.5 8 vs 9 funções (T054)

**Ground truth medido nesta missão: 8.** Evidências: `ls supabase/functions` (8 diretórios de função + `_shared`); saída de `npm run bundle:functions` (8 linhas `bundled …`); `list_edge_functions` remoto (8 `ACTIVE`: `catalog` v6, `delivery` v4, `create-order` v7, `order-status` v5, `mp-webhook` v5, `admin-api` v4, `demo-payment` v3, `order-request` v1; `verify_jwt` true apenas em `admin-api`).

O "9" aparecia em `docs/PROGRESSO.md` ("9 funções empacotam") e `docs/missao-06-painel-operacional.md` ("9 funções empacotadas OK") — **nunca correspondeu a 9 funções existentes**. As causas prováveis são a confusão com "9 larguras" da mesma frase (auditoria visual 54/54 telas × 9 larguras) e/ou com "9 migrações" da Fase 2 da auditoria. Corrigido nos dois documentos nesta missão. Nenhuma função foi criada ou removida no remoto.

### 3.6 Backup (verificação exigida) — BLOCKED

O conector Supabase desta sessão **não expõe ferramenta de backup/PITR** (nenhuma listagem de backups, restore ou snapshot). Mitigações, documentadas sem maquiagem: (i) todas as migrações eram aditivas e idempotentes; (ii) `create_migration` executa com rollback em falha — nenhuma ficou pela metade; (iii) `npm run test:db` recria o schema **do zero** (38 migrações) em PostgreSQL real: **293/293**; (iv) nenhum dado de negócio foi tocado (contagens idênticas antes/depois); (v) o sandbox tem o estado `ACTIVE_HEALTHY`. Ainda assim, **a verificação formal de backup não foi feita** → item BLOCKED, com a recomendação de o operador confirmar PITR/backup diário no painel Supabase antes de qualquer nova escrita relevante.

## 4. Segredos e criptografia (somente presença; nenhum valor revelado)

`list_secrets` (valores redigidos pelo próprio conector): presentes `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEYS`,
`SUPABASE_SECRET_KEYS`, `SUPABASE_DB_URL`, `SUPABASE_JWKS`, `DEMO_PAYMENT_ENABLED`,
`DEMO_ALLOWED_PROJECT_REFS`, `STORE_URL`, `ALLOWED_ORIGINS` (atualizada 2026-11-01).
**`PRIME_ENCRYPTION_KEY` NÃO está nos secrets de env** — e isso é seguro por design:
as Edge Functions usam o fallback no Supabase Vault (`get_secret_material`,
`service_role` apenas). Verificado: `vault.secrets` contém `prime_store_encryption_key`
com `decrypted_secret` em base64 de **44 caracteres ⇒ exatamente 32 bytes (AES-256-GCM)**
✓ e `demo_setup_token`. Nenhuma chave foi trocada, recriada ou re-cifrada; nenhum valor
foi lido ou impresso. `STORE_URL` e `ALLOWED_ORIGINS` presentes (loja fechada por padrão:
anônimos sem CORS liberado). **Ausentes** `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` —
coerente com pagamentos congelados.

**Config de auth (`get_auth_config`):** `disable_signup=true`; `external_email_enabled=true`;
telefone e provedores externos desabilitados; refresh token rotation ativo (reuse interval 10s);
`mfa_totp_enroll_enabled=true` e `mfa_totp_verify_enabled=true` (AAL2 disponível);
`password_min_length=6` (observação de endurecimento — elevar para ≥ 12 + HIBP é decisão
do operador; **não alterado** sem autorização); `site_url=http://localhost:5173` e
`uri_allow_list=http://localhost:5173,http://127.0.0.1:5173` (coerente com loja ainda não
publicada; atualizar quando houver domínio real).

**Cron (`pg_cron`):** job 1 `select public.run_reservation_expiry('cron')` a cada minuto,
ativo; job 2 `select public.prune_rate_limit_counters(interval '1 hour')` aos 7 min de cada
hora, ativo. `job_health`: `expire_overdue_reservations`, última execução
2026-11-09T17:12Z, `last_processed=0`, **`consecutive_failures=0`**. `rate_limit_counters` = 0 linhas.

## 5. Auditoria de estoque, produtos, pedidos (sem registros fictícios)

- `products` 2, `stock_units` 27 (por unidade, credencial cifrada, impressões HMAC),
- `orders` 8 · `order_items` 2 · `stock_reservations` 7 · `payments` 3 · `deliveries` 3 ·
  `order_events` 18 · `admin_audit_log` 0,
- `admin_users` **0** — o painel não tem sessão possível; **nenhum** admin foi inventado.
- Nenhuma linha foi inserida/alterada/apagada por esta missão fora da `app_settings` (seção 3.4).
- Pedidos `paid`/`refund_pending` com coerência de entrega **não** foram revalidados por query
  linha a linha nesta sessão; os invariantes que interessam a esta missão (4. e 5.) foram
  conferidos por contagem e por presença de colunas/funções.

## 6. RLS / grants / privilégios (re-revisão pós-migração)

20/20 tabelas com RLS; 0 políticas (deny-all por design; acesso apenas via
`SECURITY DEFINER` com `assert_admin()` interno); `anon` sem grants de tabela;
`authenticated` sem grants de tabela/DML; `public_catalog` `security_invoker=true`,
sem grants cruzados; 23 funções executáveis por `authenticated` (todas `admin_*` + `is_admin`);
0 por `anon`; **nenhuma permissão foi ampliada nesta missão**; o overload antigo de
`admin_set_stock_unit_status` foi removido **pela migração 0038 desenhada**, não por edição
ad hoc; novo grant mínimo: `authenticated` + `service_role` para a nova assinatura.

## 7. Administradores — BLOCKED (dados reais ausentes)

`auth.users = 0` e `public.admin_users = 0`. O provisionamento dos 2 admins exige **nome de
exibição + e-mail Auth real** de cada administrador (não fabricados nesta missão), e cada um
deve configurar o próprio TOTP. `scripts/provision-admin.sql` está preparado para esse
momento (allowlist em `admin_users` + instrução de passos). `assert_admin()` e `is_admin()`
foram revalidados em definição (AAL2 via `mfa` obrigatório para mutações; `is_admin(false)`
para leitura de sessão). **Marcar como BLOCKED até chegada dos dados.**

## 8. Edge Functions — publicação NÃO concluída (BLOCKED)

Remoto (inalterado): 8 funções `ACTIVE` (seção 3.5). A única função cujo código-fonte mudou
desde o deploy remoto é **`admin-api`** (M06: `optionalIsoTimestamp`/`boundedInt` em
`orders.list`/`stock.list`/`audit.list`; M07: validação de motivo em `stock.setStatus` +
resiliência `503 auth_unavailable`). **Também ficou incompatível com o banco** após a
0038 (a v4 chama `admin_set_stock_unit_status(uuid, text)`, que não existe mais).

Tentativas desta missão (2× `update_edge_function` com o bundle completo
[`.local/functions-build/admin-api.ts`, sha256 `69e34f97bc87b01076192ad0e9ce2d6ebaee784d263e00c029cd91c7dc47bcaf`,
45.242 bytes, `charset: 'utf8'` agora permanente no `scripts/bundle-functions.mjs`] e
1× `create_edge_function` de sonda `m08-deploy-probe`): **nenhuma persistiu** —
`list_edge_functions` permanece com `admin-api` v4 (`updated_at` 2026-11-01T04:09Z) e a
sonda nunca apareceu. Adicionalmente: saída de rede para `*.supabase.co` **inalcançável**
(`curl` → exit 35), sem `SUPABASE_ACCESS_TOKEN` no ambiente para a CLI, e o conector não
oferece ferramenta de invocar função. **Nenhuma função obsolete foi publicada; nenhuma foi
deletada; o remoto não foi tocado.**

**Impacto prático hoje:** apenas a ação `stock.setStatus` do painel remoto ficaria quebrada
(500) — e ela é inalcançável: não há sessões de admin (`auth.users=0`, `admin_users=0`).
As outras 7 funções são compatíveis com o banco reconciliado (mesmos nomes/argumentos de RPC).

**Ação para concluir (em máquina com rede e credenciais):**
1. `npx supabase functions deploy admin-api --project-ref eorlmqolbknrplvdbbtl`
   (ou upload do bundle `.local/functions-build/admin-api.ts` no painel), mantendo `verify_jwt = true`;
2. `SUPABASE_URL=https://eorlmqolbknrplvdbbtl.supabase.co SUPABASE_ANON_KEY=<anon> node scripts/smoke-edge-functions.mjs`
   — esperado: `catalog 200`, `create-order 422/404`, `delivery 404`, `mp-webhook 400/401/403`, `admin-api 401`; **não** passar `PRODUCT_ID` (não criar pedido de verdade);
3. opcional pós-provisionamento de admins: `ADMIN_JWT=<token AAL2> … smoke` para o caso 200/403.

## 9. Smoke test (Grupo K) — BLOCKED nesta sessão

`node scripts/smoke-edge-functions.mjs` sem env → exit 2 (`Defina SUPABASE_URL e SUPABASE_ANON_KEY.`).
Com rede inalcançável (curl exit 35) e sem anon key disponível (secrets remotos são servidos
redigidos; `.env*` local só contém `.env.example`), **nenhuma requisição HTTP foi feita**.
Nenhuma escrita comercial ocorreu. O script continua pronto para a máquina de destino.

## 10. Verificação local (evidência)

- `npm test` → **127/127** (16 arquivos) — 2026-11-09, pós-edição do `bundle-functions.mjs`;
- `npm run bundle:functions` → **8/8** bundles auto-contidos; mudança mínima no empacotador
  (`charset: 'utf8'`) para que os bundles carreguem acentuação legível (sem alteração de lógica);
- `npm run test:db` → **293/293** (PG local real; recria o schema das 38 migrações do zero) —
  estado `c644e1e`, ainda válido: nesta missão o código testado não mudou, só o empacotador e docs;
- `git status` limpo antes do commit desta missão (apenas arquivos listados na seção 13).

## 11. Divergências, riscos e observações (sem suavização)

1. **Edge Function `admin-api` remota fora de sincronia** (v4 vs. código pós-0038) — BLOCKED acima; única superfície remota degradada e hoje inalcançável.
2. **Smoke HTTP não executado** — critérios HTTP da missão sem evidência própria (ver 9).
3. **Backup/PITR não verificado** — conector sem ferramenta (ver 3.6).
4. **Realtime `UNHEALTHY`** — informativo; polling cobre o produto; monitorar.
5. **`password_min_length=6`** — abaixo do recomendado; decisão do operador (não alterado).
6. **`PRIME_ENCRYPTION_KEY` fora dos env secrets** — Vault é o mecanismo ativo (chave 32B OK); documentado para quem operar o painel saber que trocas exigem re-cifragem.
7. **Histórico 0033 duplicado** (`solicitacao_sem_pagamento` + `_v2`) — nominal; efeitos únicos; não reaplicar.
8. **Histórico remoto com nomes curtos** diferentes dos arquivos locais — reconciliação 1:1 documentada na seção 3; não é possível (nem desejável) renomear versões já aplicadas.
9. **`admin_audit_log` vazio e `admin_users` vazio** — nada operacional no painel ainda; não confundir "infra preparada" com "painel validado com dados reais".
10. **`rate_limit_counters` = 0** — contador limpo; cron 0032 ativo (`prune` horário).
11. **Produtos/pedidos reais intactos** — nenhuma correção retroativa foi feita em pedidos históricos (ex.: pedidos `requested` legados seguem como estão; mudar status seria ação comercial não autorizada).

## 12. O que NÃO foi feito (e por quê)

- ❌ Deploy/republicação de funções (ferramentas sem efeito + rede inalcançável — seção 8).
- ❌ Smoke HTTP (seção 9).
- ❌ Verificação formal de backup (seção 3.6).
- ❌ Provisionamento de admins (faltam nome + e-mail Auth reais — seção 7).
- ❌ Qualquer ativação de pagamento/webhook/cobrança (fora de escopo; congelados).
- ❌ Alteração de `main`, do PR #2, de branches, da tag `safety/m07-start-cd87b3d`.
- ❌ Registros fictícios, pedidos/cobranças/e-mails reais, testes de escrita remota.
- ❌ Enfraquecimento de RLS/grants/policies para contornar erros (nenhuma permissão ampliada).
- ❌ Reaplicação do arquivo 0033 (já aplicado, 2 entradas no histórico).

## 13. Arquivos alterados nesta missão

- `scripts/bundle-functions.mjs` — `charset: 'utf8'` no esbuild (bundles com acentuação legível).
- `docs/PROGRESSO.md` — entrada M08; correção "9 → 8 funções" (resultado M06).
- `docs/missao-06-painel-operacional.md` — correção "9 → 8 funções empacotadas OK".
- `docs/missao-08-reconciliacao-supabase.md` — este relatório.

## 14. Ações necessárias (em ordem)

1. Operador: confirmar backup/PITR do projeto no painel Supabase (antes de novas escritas).
2. Máquina com rede/credenciais: publicar `admin-api` (comando na seção 8) e rodar o smoke (sem `PRODUCT_ID`).
3. Receber dados dos 2 admins (nome + e-mail Auth) e executar `scripts/provision-admin.sql` + TOTP de cada um.
4. Após provisionamento: validar o painel com dados reais e só então marcar a ativação operacional como concluída.
5. (Opcional, decisão do operador) elevar `password_min_length` para ≥ 12 e ativar `password_hibp_enabled`.
6. Monitorar `realtime` (`UNHEALTHY`) — sem impacto no produto; investigar no painel se houver interesse.
7. Manter pagamentos congelados até decisão própria (WyviPay ou outro provedor) em missão futura.

## 15. Classificação por grupo (A–L)

| Grupo | Entrega | Status |
|---|---|---|
| A. Repo/branch/tag/PR intactos | verificado (HEAD=`c644e1e`, `main`=`8f37527`, PR #2 open draft, tag presente) | PASS |
| B. Projeto confirmado/saudável | seção 2 | PASS |
| C. Migrações reconciliadas e pendentes aplicadas | seções 3.1–3.4 | PASS |
| D. 0033–0038 investigadas e tratadas | seções 3.2 e 3.4 (0034–0038 aplicadas; 0033 preservada) | PASS |
| E. Segredos/cofre auditados sem revelar valores | seção 4 | PASS |
| F. Auth/RLS/grants/admin auditados | seções 4, 6, 7 | PASS |
| G. Estoque/pedidos/produtos auditados (sem fictícios) | seção 5 | PASS |
| H. Funções publicadas e testadas | **seção 8 — deploy bloqueado** | **FAIL/BLOCKED** |
| I. Smoke HTTP read-only | seção 9 | BLOCKED |
| J. Realtime/health/advisors re-revisados | §2 (health); advisors não expostos — revisão manual via SQL | PARTIAL |
| K. Documentação/relatório | este documento + PROGRESSO | PASS |
| L. Veredito geral | **PARCIAL** — não declarada aprovada | PARTIAL |

*Evidência de que nada foi maquiado: os itens sem validação remota funcional
(H, I, e o backup de C) estão marcados como BLOCKED, não como PASS.*
