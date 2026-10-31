# Missão 03 — Hardening, correção de integridade e integração do backend

**Projeto:** `prime-store-sandbox` (`eorlmqolbknrplvdbbtl`, `sa-east-1`, PostgreSQL 17.11,
`ACTIVE_HEALTHY`)
**Data:** 2026-10-31
**Escopo autorizado:** correções de código, novas migrações, deploy de Edge Functions e
testes no sandbox. Nenhuma alteração em produção, nenhum pagamento real, nenhum merge em
`main`.

> Nota de método: este relatório separa explicitamente **(a)** o que foi executado e
> medido, **(b)** o que é implementação testada apenas contra simulador e **(c)** o que
> está bloqueado por dependência externa. Nenhuma integração simulada é declarada validada.

---

## 1. Resumo executivo

Duas falhas de integridade encontradas na auditoria eram reais e foram corrigidas na raiz,
com testes que falham se o comportamento antigo voltar:

1. **Sequestro de pedido por chave de idempotência.** `create_order()` sobrescrevia
   `client_token_hash` sempre que a chave já existia. Qualquer requisição que reutilizasse
   (ou adivinhasse) a chave assumia o pedido — e, com ele, o link de entrega e as
   credenciais. Agora a identidade é `(chave, hash do token, produto, quantidade)`; replay
   legítimo devolve o pedido original, divergência devolve `idempotency_conflict` (HTTP
   409) e o token **nunca** é alterado.
2. **Chargeback tratado como reembolso concluído.** `apply_payment_status()` caía no mesmo
   ramo para `refunded` e `charged_back`, revogando a entrega de forma irreversível a partir
   de uma contestação. Agora `charged_back` marca o pedido como `disputed`, preserva a
   entrega, registra evento próprio e exige decisão administrativa explícita
   (`admin_resolve_dispute`) — enquanto `refunded` mantém o comportamento de devolução
   (pedido `refunded`, entrega revogada, pendências processadas).

Além disso: `search_path` fixo em 100% das funções, chave de criptografia retirada do
ambiente versionado (Vault + fallback), `token_enc` removido do RPC de status do pedido,
índice da FK de importação criado, privilégios fechados e verificados em 5 contextos,
6 Edge Functions implantadas e 9 migrações aplicadas no sandbox.

**O que continua aberto:** validação contra o Mercado Pago real (sem credenciais de teste),
execução de chamadas HTTP às funções implantadas (sem egress de rede neste ambiente) e
provisionamento dos dois administradores (sem e-mails autorizados). Ver §9.

---

## 2. Fase A — Idempotência em `create_order`

### Correção

`supabase/migrations/20261031121600_0017_idempotencia_pedido.sql`

```sql
if p_idempotency_key is not null then
  select * into v_existing from public.orders where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.client_token_hash <> p_client_token_hash
       or v_existing.product_id <> p_product_id
       or v_existing.quantity <> v_qty then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    return jsonb_build_object(..., 'idempotent_replay', true);
  end if;
end if;
```

- O caminho de `unique_violation` (corrida) aplica **as mesmas** regras — duas requisições
  simultâneas não geram dois pedidos nem trocam token.
- A mensagem de conflito não informa qual campo divergiu, nem devolve referência, ID ou
  valor do pedido existente (anti-enumeração).
- `orders_idempotency_key_check` exige `^[A-Za-z0-9_-]{16,128}$` (entropia mínima, defesa
  em profundidade).

### Ajuste no backend (Edge Function `create-order`)

O servidor gerava um token novo a cada requisição, o que tornava o retry legítimo
impossível (a identidade nunca se repetia). Agora o cliente envia `client_token` — o token
privado da tentativa de checkout, criado no navegador e mantido durante o retry
(`newClientToken()` em `src/services/orderService.ts`) — e o handler o reutiliza:

```ts
const idempotencyKey = optionalIdempotencyKey(body.idempotency_key);
const clientToken = optionalClientToken(body.client_token) ?? randomToken(32);
const clientTokenHash = await sha256Hex(clientToken);
```

Sem `client_token`, cada requisição é uma nova sessão de compra (comportamento anterior,
seguro). Com ele, reload/retry devolve o pedido original e o mesmo token.

### Testes (executados)

`tests/db/06_hardening_integridade.test.ts` (10 cenários de idempotência) e
`tests/db/07_create_order_http.test.ts` (7 cenários pelo handler HTTP, incluindo 409 e
corpo de erro). Cobrem exatamente a matriz pedida: mesma chave/token/parâmetros, token
diferente, produto diferente, quantidade diferente, duas requisições simultâneas, retry
após falha de comunicação e tentativa de takeover por terceiro. O teste antigo
("replay rotaciona o token") foi reescrito: ele afirmava justamente o defeito.

---

## 3. Fase B — Chargeback ≠ reembolso

### Modelo de estado adotado (o mais simples que preserva a distinção)

| Evento do provedor | `payments.status` | `orders.status` | Entrega | Efeitos |
| --- | --- | --- | --- | --- |
| `refunded` | `refunded` | `refunded` | `revoked` | `payment_refunded`, pendências `processed` |
| `charged_back` | `charged_back` | **`disputed`** | **preservada** | `payment_charged_back`, `requires_admin_review = true`, **sem** contabilidade de reembolso |
| `charged_back` após reembolso | `charged_back` | `refunded` (inalterado) | `revoked` (inalterado) | `payment_charged_back_after_refund` |
| `approved` atrasado sobre pedido encerrado | inalterado | inalterado | inalterado | `payment_approved_ignored_late` → `ignored_late_approval` |

`order_status` ganhou o valor `disputed` (migração `0018`, isolada por exigência do
PostgreSQL). A decisão humana acontece em `admin_resolve_dispute(order, outcome, notes)`
com `outcome ∈ {refund, reinstated, refund_pending}` — auditada em `admin_audit_log`
(`dispute_resolved`) e refletida em `admin_indicators` (`orders_disputed`,
`payments_charged_back`) e no filtro "somente problemas" do painel.

### Integração

- `mp-webhook`: registra `mp_webhook.dispute_flagged` e `mp_webhook.late_approval_ignored`
  sem imprimir PII e **sem** revogar entrega; devolve `requires_admin_review` na resposta.
- `admin-api`: nova ação `orders.resolveDispute`.
- Painel: `AdminOrders` lista/filtra `disputed`, mostra selo "contestar" e oferece os três
  desfechos; `AdminOverview` exibe "Disputas abertas" e "Chargebacks".

### Testes (executados)

Aprovado→chargeback, aprovado→reembolso, chargeback duplicado, reembolso duplicado,
reembolso depois de chargeback, chargeback depois de reembolso, aprovação fora de ordem,
encerramento de disputa por admin com MFA, reversão da disputa, indicadores e filtro de
problemas — todos em `tests/db/06` e repetidos no sandbox real (evidência 05, itens 3–5).

---

## 4. Fase C — RLS e privilégios

Ver [`evidencias/02-privilegios-por-tabela.md`](./evidencias/02-privilegios-por-tabela.md).

- 17 tabelas com RLS habilitada e **zero políticas** (negar por padrão); acesso somente por
  funções `SECURITY DEFINER` auditáveis. Nenhuma política genérica foi criada.
- `anon`: nenhum privilégio de tabela, nenhuma função executável.
- `authenticated`: nenhum privilégio de tabela; executam apenas `admin_*` + `is_admin`,
  todas com `assert_admin()` (allowlist **e** AAL2).
- `service_role`: acesso total (backend).
- `public_catalog`: único objeto de leitura pública; sem custo, credenciais ou tokens.
- `alter default privileges` impede que objetos futuros nasçam expostos.
- As 17 tabelas sinalizadas na auditoria continuam inacessíveis diretamente — verificado
  por tentativa real de `select` sob `set local role`, não por inspeção de `pg_grants`.

Classificação das funções (antes: 22 executáveis por `authenticated`; agora 23 — entrou
`admin_resolve_dispute`): ver
[`evidencias/03-funcoes-classificacao.md`](./evidencias/03-funcoes-classificacao.md).
Nenhum grant foi ampliado para "silenciar" advisor; as duas únicas exposições conscientes
(`admin_stock_fingerprints`, `get_delivery_token_enc`) estão justificadas e testadas.

---

## 5. Fase D — `search_path`

Migração `0020`: `alter function … set search_path = public, pg_temp` nas três funções
apontadas pelo advisor (`generate_order_reference`, `set_updated_at`,
`products_record_price_change`) **e** um laço que corrige qualquer função restante sem
configuração explícita.

Medição no sandbox depois da migração: `sem_search_path = 0` (antes: 3) e
`SECURITY DEFINER = 41`, todos com `search_path=public, pg_temp` — verificado em teste
(`08_privilegios_funcoes`: "toda função SECURITY DEFINER tem search_path fixo e seguro").

`pg_temp` fica por último de propósito: nunca é resolvido antes de `public`.

---

## 6. Fase E — Credenciais e ciclo de vida do link

### Algoritmo (inalterado, agora com a chave fora do ambiente)

- AES-256-GCM com subchaves derivadas por HKDF-SHA256 (`prime-store/credentials/v1`,
  `prime-store/fingerprint/v1`), envelope `versão(1) | IV(12) | ciphertext+tag`.
- Token do link: 32 bytes aleatórios; guardado como `token_hash` (SHA-256) + `token_enc`
  (ciphertext). Consulta por hash; revogação/rotação pelo painel.
- `credential_fingerprint`: HMAC-SHA256 com chave derivada do servidor (deduplicação entre
  importações sem chave fixa no código).
- Decifragem **somente** nas Edge Functions; o navegador recebe apenas a URL do link.

### Correções desta missão

1. **Chave mestra**: `PRIME_ENCRYPTION_KEY` é opcional; sem ela, o backend lê
   `get_secret_material('prime_store_encryption_key')` do Supabase Vault (RPC
   `service_role`-only, migração `0023`), com cache por instância. Falha fechada (503) se
   não houver nenhuma das duas.
2. **`get_order_status` não devolve mais `token_enc`** (migração `0024`): retorna
   `link_ready`. O ciphertext passou a ser lido por `get_delivery_token_enc(order,
   client_token_hash)` — prova de posse, somente link ativo, somente `service_role`.
3. `resolve_delivery` continua devolvendo o ciphertext das credenciais **para o backend**,
   que decifra; nenhum RPC devolve credencial em claro.
4. Testes garantem: view pública sem colunas sensíveis, `get_order_status` sem
   `'token_enc'`, RPC de ciphertext privado, fingerprints apenas para admin AAL2.

---

## 7. Fase F — Performance

Migração `0021` criou o índice que realmente faltava: `stock_units_import_batch_idx`
(FK sinalizada pelo advisor).

Ao revisar o resultado, a comparação **por definição** (não por nome) mostrou que a `0021`
havia criado dois índices que já existiam com outro nome desde a `0009`
(`stock_units_sold_order_idx` = `stock_units_order_idx`,
`stock_units_product_status_idx` = `stock_units_status_idx`), e que
`deliveries_order_idx` é subconjunto do índice único `deliveries_order_id_key`. A migração
`0025` remove esses três — **redundância de definição**, não "desuso" — e mantém o índice
da FK. Resultado após a `0025`: `fks_sem_indice = 0`, `indices_duplicados = 0`.

Nenhum índice foi removido por estar sem uso: sem tráfego de produção isso seria adivinhação.
Um teste automatizado passou a falhar se duas definições de índice voltarem a se repetir.

---

## 8. Fase G — Edge Functions implantadas

Ver [`evidencias/06-edge-functions-deploy.md`](./evidencias/06-edge-functions-deploy.md).

6 funções `ACTIVE`, sem duplicatas, todas no projeto `eorlmqolbknrplvdbbtl`:
`catalog`, `create-order`, `order-status`, `delivery`, `mp-webhook`, `admin-api`.
JWT desligado **por decisão funcional** apenas nas rotas públicas (catálogo e checkout) e
no webhook (que valida HMAC do provedor); `admin-api` mantém verificação de JWT no gateway
**e** autorização no banco.

---

## 9. Fase H — Mercado Pago: status exato

**Implementado e testado com provedor simulado:** criação de PIX (valor, `external_reference`,
`date_of_expiration` +30 min, `notification_url`, `X-Idempotency-Key`), consulta do estado
real antes de qualquer transição, validação de assinatura do webhook, deduplicação por
`notification_id`, tolerância a eventos fora de ordem e a aprovação tardia, tratamento de
"pago sem estoque", valores divergentes (`amount_mismatch`) e ausência de configuração
(`503 payment_not_configured`).

**Bloqueio exato:** não existe `MP_ACCESS_TOKEN`/`MP_WEBHOOK_SECRET` de teste neste
ambiente. Consequências verificáveis: `create-order` responde
`503 payment_not_configured`; `mp-webhook` não valida assinatura (pula a checagem por
ausência do segredo) e recusa processar pagamento. **Nenhuma cobrança, nenhum reembolso e
nenhuma notificação real foram executados.** A integração **não** está declarada validada.

Para concluir: gerar credenciais de teste no Mercado Pago, configurar `MP_ACCESS_TOKEN` e
`MP_WEBHOOK_SECRET`, apontar `MP_NOTIFICATION_URL` para
`https://eorlmqolbknrplvdbbtl.supabase.co/functions/v1/mp-webhook` e executar o roteiro de
10 passos em `docs/mercado-pago.md` (criar pedido → reserva 30 min → PIX 30 min → QR →
notificação → validação → consulta → transição → vínculo de unidades → entrega).

---

## 10. Fase I — Administradores e MFA

Procedimento pronto em `scripts/provision-admin.sql` (insert idempotente em `admin_users`
com placeholders, verificação e revogação) e `docs/painel-admin.md`. A aplicação exige
TOTP: `assert_admin()` verifica `aal = 'aal2'`, e a recusa em AAL1 foi testada em três
níveis (RPC direta, handler `admin-api` e teste de banco).

**Bloqueio:** não há e-mails autorizados para os dois administradores (titular + Natanael);
criar contas com e-mails inventados seria pior que não criar. Pendente também a
demonstração de TOTP real (depende das contas).

---

## 11. Fase J — Testes

Detalhe completo em [`evidencias/04-testes-executados.md`](./evidencias/04-testes-executados.md).

**172 testes automatizados** (57 frontend + 115 banco/integração), todos aprovados, mais
o smoke SQL no sandbox (evidência 05). Nenhum teste de autorização/RLS foi feito apenas com
mock: os testes de banco executam `set local role` + `request.jwt.claims` contra PostgreSQL
real, e as funções SECURITY DEFINER são chamadas de verdade.

---

## 12. Fase K — Frontend

Ajustes mínimos, preservando identidade visual e comportamento aprovado:

- `client_token` estável por tentativa de checkout (idempotência real do retry);
- status `disputed` no painel de pedidos (filtro, selo, bloco de decisão da disputa);
- cartões "Disputas abertas" / "Chargebacks" no painel;
- rótulo "Contestação em análise" na página de pagamento.

Nenhuma funcionalidade fora de escopo foi adicionada. "Tenho interesse" permanece
provisório (sem coleta de dados).

---

## 13. Fase L — Validação final e classificação dos alertas

| Alerta da auditoria | Classificação | Situação |
| --- | --- | --- |
| `create_order` sobrescreve token na chave repetida | **vulnerabilidade real** (tomada de conta de pedido) | corrigido + testado |
| `charged_back` no mesmo ramo de `refunded` | **bug de integridade real** (ação irreversível indevida) | corrigido + testado |
| 3 funções sem `search_path` | **configuração de segurança real** (risco de resolução maliciosa) | corrigido (0 restantes) |
| `admin_stock_fingerprints` acessível a `authenticated` | **configuração intencional** (guardada por `assert_admin`; retorna HMAC) | mantido e documentado |
| 17 tabelas sinalizadas como expostas | **falso positivo** de advisor: sem grants diretos, com RLS | verificado e documentado |
| 22 funções executáveis por `authenticated` | **intencional** (RPCs admin) | agora 23, todas com AAL2 |
| FK `stock_units.import_batch_id` sem índice | **recomendação de performance real** | índice criado |
| Índices redundantes (`0021`, `deliveries`) | **desperdício real de escrita** (achado na verificação) | 3 removidos na `0025`; teste de regressão |
| `token_enc` em `get_order_status` | **exposição desnecessária de material cifrado** | removido; RPC dedicado |
| Chave de criptografia em variável de ambiente | **risco operacional** | Vault + fallback; env opcional |
| Índices "não utilizados" | **não aplicável** (sem tráfego de produção) | nenhum removido |

Nenhum advisor foi desativado. Security Advisor e Performance Advisor do painel não foram
reexecutados porque este ambiente não acessa o dashboard; os invariantes equivalentes foram
consultados por SQL e estão na evidência 01.

---

## 14. Fase M — Artefatos

```
docs/auditoria/missao-03/
  RELATORIO.md                     (este arquivo)
  REGISTRO.md                      (estado para retomada)
  evidencias/
    01-migracoes-aplicadas.md
    02-privilegios-por-tabela.md
    03-funcoes-classificacao.md
    04-testes-executados.md
    05-smoke-remoto.md
    06-edge-functions-deploy.md
    07-variaveis-e-segredos.md
```

Scripts de verificação acrescentados: `scripts/smoke-edge-functions.mjs`
(`npm run smoke:functions`).

`docs/` atualizado: `seguranca.md`, `backend.md`, `mercado-pago.md`, `painel-admin.md`,
`limitacoes-e-pendencias.md`, `testes.md`, `PROGRESSO.md`.

> Nota sobre a missão 01: o relatório de auditoria original (`docs/auditoria/missao-01/`)
> **não existe neste repositório**. Este documento usa como referência os pontos citados na
> missão, não aquele arquivo.

---

## 15. Critérios de conclusão — situação honesta

| # | Critério | Situação |
| --- | --- | --- |
| 1 | Idempotência corrigida e testada | ✅ |
| 2 | Chargeback ≠ reembolso | ✅ |
| 3 | Permissões de tabelas e funções verificadas | ✅ |
| 4 | Alertas de `search_path` corrigidos | ✅ |
| 5 | Proteção de credenciais demonstrada | ✅ |
| 6 | Índice ausente tratado | ✅ |
| 7 | Edge Functions implantadas | ✅ (6 ativas) — invocação HTTP pendente (script `npm run smoke:functions` pronto para rodar) |
| 8 | Mercado Pago sandbox funcional **ou** dependência exata documentada | ⚠️ documentada (`MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`) |
| 9 | Procedimento de provisionamento de admins pronto | ✅ (execução pendente de e-mails) |
| 10 | MFA validado onde possível | ✅ no que independe de contas reais (3 níveis testados) |
| 11 | Frontend integrado | ✅ no código |
| 12 | Testes e2e de pedido/pagamento/entrega | ✅ local (PostgreSQL + MP simulado) — ⚠️ sem HTTP real |
| 13 | Advisors reexecutados e documentados | ⚠️ via SQL; painel indisponível |
| 14 | Nenhuma exposição de credenciais/chaves/dados internos em endpoint público | ✅ verificado por teste |
| 15 | Relatório final com evidência real | ✅ (este documento + `evidencias/`) |

**Prontidão:** o backend está pronto para operar com pagamento real assim que
`MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` e dois administradores com TOTP existirem. Antes de
vender, falta ainda **validar a integração com o Mercado Pago sandbox** e executar uma
compra ponta a ponta pelo domínio público — nenhuma das duas foi feita aqui.
