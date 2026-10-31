# Missão 03 — Registro de execução (retomada)

> Atualizado em 2026-10-31. Este arquivo permite que outra sessão continue o
> trabalho sem reconstruir histórico. O relatório completo está em
> [`RELATORIO.md`](./RELATORIO.md); as provas em [`evidencias/`](./evidencias/).

## Estado geral

| Fase | Escopo | Estado |
| --- | --- | --- |
| A | Idempotência em `create_order` | **Concluída** (migração `0017`, handler, testes) |
| B | Chargeback ≠ reembolso | **Concluída** (migrações `0018`/`0019`, webhook, painel, testes) |
| C | RLS/privilégios por tabela e função | **Concluída** (migrações `0022`, `0024`; 5 contextos testados) |
| D | `search_path` | **Concluída** (migração `0020`; 0 funções sem configuração) |
| E | Credenciais e tokens de entrega | **Concluída** (chave no Vault `0023`; `get_order_status` sem `token_enc` `0024`) |
| F | Índice de performance | **Concluída** (migração `0021` criou o índice da FK; `0025` removeu 3 duplicados) |
| G | Edge Functions implantadas | **Concluída** (6 funções `ACTIVE`) — validação HTTP pendente por falta de rede |
| H | Mercado Pago sandbox | **Bloqueada por credencial** (implementação + testes com provedor simulado prontos) |
| I | Provisionamento de admins/MFA | **Procedimento pronto**, execução bloqueada (sem e-mails autorizados) |
| J | Testes de integridade | **Concluída** (banco real; 115 testes de banco) |
| K | Frontend | **Concluída no código** (catálogo, pedido, PIX, entrega, painel/status `disputed`) |
| L | Validação final | **Parcial**: advisors re-consultados via SQL; Security Advisor/Performance Advisor do painel indisponíveis (sem rede) |
| M | Documentação | **Concluída** (este diretório + atualização de `docs/`) |

## Concluído nesta sessão

### Banco de dados (`supabase/migrations`, 24 arquivos)

- `0017_idempotencia_pedido.sql` — replay idempotente por (chave + token + produto +
  quantidade); conflito controlado; token nunca sobrescrito; entropia mínima da chave.
- `0018_status_disputa.sql` — valor `disputed` no enum `order_status` (isolado por
  exigência do PostgreSQL).
- `0019_chargeback_x_reembolso.sql` — `apply_payment_status` separa reembolso de
  contestação; `admin_resolve_dispute`; filtro "somente problemas" e indicadores
  (`orders_disputed`, `payments_charged_back`) atualizados; guarda de aprovação tardia.
- `0020_search_path_funcoes.sql` — `search_path = public, pg_temp` em todas as funções.
- `0021_indices_operacionais.sql` — índice da FK `stock_units.import_batch_id` + 3
  índices de consulta real; nenhum índice removido.
- `0022_privilegios_finais.sql` — fechamento de privilégios (padrão negar, conceder por
  classificação) e RLS reafirmada.
- `0023_cofre_chave_criptografia.sql` — chave AES-256 no Supabase Vault +
  `get_secret_material(text)` (somente `service_role`).
- `0024_status_sem_ciphertext.sql` — `get_order_status` deixa de devolver `token_enc`;
  ciphertext do link passa por `get_delivery_token_enc(uuid, text)`.
- `0025_indices_redundantes.sql` — remove 3 índices com definição duplicada (dois criados
  por engano na `0021`, um em `deliveries`), preservando o índice da FK de importação.

### Edge Functions / backend

- `create-order`: aceita `client_token` (token privado da tentativa) para que o retry
  repita a mesma identidade; `create_order` recebe a chave crua; `idempotency_conflict`
  → HTTP 409 com mensagem genérica.
- `order-status`: ciphertext do link lido por RPC dedicado e decifrado no servidor.
- `mp-webhook`: trata `charged_back` (log de disputa, sem revogação), `ignored_late_approval`.
- `admin-api`: nova ação `orders.resolveDispute` (refund/reinstated/refund_pending).
- `_shared/deps.ts`: `resolveEncryptionKey()` (env → Vault, cache por instância) e
  `serviceRpc`.

### Frontend

- `CheckoutPage`/`orderService`: `client_token` estável por tentativa + `newClientToken()`.
- `adminApi`: tipos `orders_disputed`, `payments_charged_back`, `DisputeOutcome`,
  `resolveDispute`; `AdminOrders` lista `disputed`, mostra selo e encerra disputa;
  `AdminOverview` mostra disputas/chargebacks; `PaymentPage` rotula "Contestação em análise".

### Testes

- `tests/db/06_hardening_integridade.test.ts` (20) — matriz de idempotência e de
  chargeback/reembolso.
- `tests/db/07_create_order_http.test.ts` (12) — idempotência pelo handler HTTP + fallback
  de chave no Vault + `orders.resolveDispute` na API.
- `tests/db/08_privilegios_funcoes.test.ts` (13) — 5 contextos, privilégios efetivos,
  `search_path`, policies, view pública, ciphertext.
- Ajustes: `02` (replay não rotaciona token — comportamento antigo era o bug),
  `05` (deps com `serviceRpc`/`resolveEncryptionKey`).

### Remoto (`prime-store-sandbox` = `eorlmqolbknrplvdbbtl`)

- 9 migrações aplicadas (total 23), verificadas por `list_migrations`.
- Smoke SQL real: replay idempotente, `idempotency_conflict` em tentativa de takeover,
  `approved → charged_back → refunded` com entrega preservada na disputa e revogada no
  reembolso; `get_order_status.delivery` sem `token_enc`; privilégios do RPC de ciphertext.
- 6 Edge Functions criadas e `ACTIVE`: `catalog`, `create-order`, `order-status`,
  `delivery`, `mp-webhook` (`verify_jwt=false`, público por função), `admin-api`
  (`verify_jwt=true`).
- Dados de smoke removidos ao final (nenhum resíduo).

## Em andamento / próximo passo

1. **Validação HTTP das funções**: sem egress para `*.supabase.co` neste ambiente, não foi
   possível chamar as funções implantadas. Script pronto para isso (não executado):
   `SUPABASE_URL=... SUPABASE_ANON_KEY=... [PRODUCT_ID=...] npm run smoke:functions`.
2. **Mercado Pago sandbox**: falta `MP_ACCESS_TOKEN` / `MP_WEBHOOK_SECRET` (credenciais de
   teste reais). Sem elas, `create-order` responde `503 payment_not_configured` e
   `mp-webhook` não valida assinatura (pula verificação por ausência de segredo — decisão
   documentada; em produção o segredo é obrigatório).
3. **Admins**: criar dois usuários no Auth e rodar `scripts/provision-admin.sql`; exige
   e-mails reais (não inventados) + TOTP obrigatório.
4. **Security/Performance Advisor do painel**: reexecutar no dashboard e anexar em
   `evidencias/` (as consultas equivalentes via SQL já foram executadas).

## Bloqueios externos (exatos)

- Sem `MP_ACCESS_TOKEN` de teste → nenhum pagamento real/sandbox criado; nenhuma
  notificação real recebida. Nada foi declarado validado sem essa credencial.
- Sem e-mails dos administradores → contas não criadas.
- Sem egress de rede no sandbox de trabalho → chamadas HTTP às Edge Functions e aos
  endpoints do Mercado Pago não podem ser feitas daqui.
- Sem Supabase CLI e sem acesso ao dashboard → advisors "de painel" não foram colhidos.

## Comandos de verificação

```bash
npm run typecheck        # tsc -b
npm test                 # 57 testes de frontend
npm run test:db          # 115 testes de banco (PostgreSQL local)
npm run build            # build de produção
node scripts/bundle-functions.mjs   # gera .local/functions-build/<slug>.ts
npm run smoke:functions  # smoke HTTP das funções implantadas (exige rede)
```
