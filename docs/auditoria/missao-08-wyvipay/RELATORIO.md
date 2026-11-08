# Missão 08 — Auditoria e planejamento da integração WyviPay

> **Natureza desta entrega:** reconhecimento e planejamento técnico. **Nada foi
> implementado.** Nenhuma linha de código de produção, migração, credencial ou
> configuração de provedor foi alterada.
>
> **Data:** 08/11/2026
> **Branch de trabalho desta sessão:** `arena/4d7b2f32-prime-store`
> **Base auditada (somente leitura):** `origin/arena/08e7eb3e-prime-store` @ `2a456ee`
> **Nada foi mesclado na `main`. Nada foi publicado. Nenhuma operação financeira
> foi executada.**

---

## 0. Correção de premissa (leia antes de tudo)

O enunciado parte de três premissas que **não se confirmam** no repositório. Elas
mudam o escopo real do trabalho, então estão no começo e não nas notas de rodapé.

| Premissa do enunciado | O que a auditoria encontrou |
| --- | --- |
| "Trabalhe sobre a branch atual `arena/08e7eb3e-prime-store`" | Essa branch não é a minha branch de sessão. O ambiente fixa `arena/4d7b2f32-prime-store`, e trocar de branch está fora das minhas permissões. Auditei `08e7eb3e` **sem fazer checkout**, por `git worktree` destacado em `/tmp`, e entreguei o relatório na minha branch. A branch `08e7eb3e` **não foi tocada** (nem push, nem commit). |
| "Leia o relatório completo da Missão 07" | A Missão 07 é `docs/auditoria/missao-07/RELATORIO.md` em `08e7eb3e` (`f6f3405`/`dbdf76a`). Lido integralmente. |
| "Substituir a integração do Mercado Pago" | A integração **existe e está madura** (cliente HTTP, handler de webhook com HMAC, funções de banco; 178 arquivos alterados no total, 198 testes de banco). O que **não** existe é credencial: o fluxo real nunca rodou. Isso inverte a natureza do risco — ver §4. |
| "Relatório da Missão 08" | Já existe uma Missão 08 anterior em `08e7eb3e` (`2a456ee`), com escopo diferente: **loja sem pagamento**. O checkout público hoje **não tem gateway nenhum** — é registro de solicitação (`requested` / `not_required`). A cobrança ficou fora do roteador. Este documento é a Missão 08 **de pagamento** e não substitui nem reescreve o relatório anterior. |

**Consequência para o planejamento:** a WyviPay não entra "no lugar do Mercado
Pago na tela de checkout". Ela entra (a) no lugar de um provedor já abstraído no
backend e (b) reabrindo um fluxo de cobrança que hoje está desligado da
experiência pública. São dois trabalhos distintos e o §7 os separa.

### 0.1 Onde está o trabalho que ainda não chegou à `main`

`main` está em `0b50248` — o frontend demonstrativo da Fase 2, **sem backend,
sem gateway, sem banco**. Todo o backend está em branches não mescladas:

| Branch remota | Commits à frente da `main` | Conteúdo |
| --- | --- | --- |
| `arena/08e7eb3e-prime-store` | **14** | Missões 03→08 no backend: Supabase, PIX/MP, entrega, admin, hardening, solicitação sem pagamento. **É a base que importa.** |
| `arena/a81a96ef-prime-store` | 10 | Linhagem anterior (Missões 03→05), superada pela acima. |
| `arena/35d222bc-prime-store` | — | Já mesclada (`0b50248`, PR #1). |

⚠️ **Risco estrutural de integração (achado novo, não documentado antes):** as
três linhagens têm raízes de commit **diferentes**. `0b50248` (main) descende de
"Initial commit"; `08e7eb3e` descende de `5698b9b "Initial commit"` + `84226d9`,
e importou o estado da Missão 05 como cópia squash (`6c51f18`, sem merge real).
`git merge-base` entre `a81a96ef` e `08e7eb3e` **não** encontra ancestral comum
com a `main`. Ou seja: levar a WyviPay até a `main` não é um `merge` — é uma
**reconciliação de árvores**. Está registrado como etapa 0 do §7.

---

## 1. Estado atual da integração de pagamentos

### 1.1 O que existe e funciona

| Camada | Peça | Arquivo | Estado |
| --- | --- | --- | --- |
| Cliente do provedor | PIX via Payments API, `POST /v1/payments`, idempotência por header | `supabase/functions/_shared/mercadopago.ts` | Completo, com timeout, `MercadoPagoError`, `sanitizePayment` sem dados pessoais |
| Verificação de webhook | HMAC-SHA256 sobre manifesto, `timingSafeEqual`, janela de `ts` | idem (`verifyWebhookSignature`, `isSignatureTimestampFresh`) | Completo; **exige** assinatura desde a Missão 07 |
| Rota de webhook | `POST /mp-webhook` | `functions/mp-webhook/index.ts` + `handlers/mpWebhook.ts` | Fail-closed: sem segredo → `503`; HMAC inválido → `401`; `ts` velho → `401`; nada é gravado antes da validação |
| Criação de cobrança | `POST /create-order` | `handlers/createOrder.ts` | Reserva 30 min → cria PIX → `attach_payment`; falha do provedor **libera a reserva** |
| Reconciliação | Consulta ao provedor independente de webhook | `handlers/orderStatus.ts` | Ativa quando há `provider_payment_id` e token configurado |
| Máquina de estados | `apply_payment_status`, `attach_payment`, `record_payment_event`, `finish_payment_event` | migrações `0011`, `0019` | Idempotente; trata valor divergente, aprovação tardia, contestação ≠ reembolso |
| Persistência | `payments`, `payment_events`, `refund_requests` | migração `0007` | Com `CHECK`, índices únicos parciais e dedup por `notification_id` |
| Aprovação simulada | `POST /demo-payment` | `handlers/demoPayment.ts` | Três travas (segredo + allowlist de project ref + `app_settings`); reusa `apply_payment_status` |
| Frontend de cobrança | `PaymentCheckoutPage`, `PaymentPage` (QR + copia-e-cola + `ticket_url`) | `src/pages/**` | Funcional, **fora do roteador público** desde a Missão 08 anterior |
| Testes | 198 casos de banco/HTTP em 16 arquivos, 70 de frontend, 19 unitários de cripto/CSV/MP | `tests/**` | Verdes na Missão 07 |
| Docs | `docs/mercado-pago.md` + `docs/limitacoes-e-pendencias.md` | — | Detalhados e honestos |

### 1.2 O que **não** existe (e o enunciado assumia que existia)

| Item do enunciado | Realidade |
| --- | --- |
| Reembolsos/estornos implementados | **Não.** O reembolso é **sempre manual, no painel do provedor**. `refund_requests` registra a *pendência*; `admin_resolve_refund` apenas a encerra e revoga a entrega. Não há chamada de estorno na API do provedor. |
| Credenciais configuradas | **Nenhuma.** Não há `MP_ACCESS_TOKEN` nem `MP_WEBHOOK_SECRET` em lugar nenhum (Missões 05/07 registram a ausência; a Missão 07 registra que o webhook responde `503` por isso). |
| Validação do fluxo real | **Nunca ocorreu.** Sem credencial e sem rede de egress, nem no ambiente de dev nem no sandbox. Toda a confiança vem de `tests/unit/fakeMp.ts` e de testes de handler contra PostgreSQL real. |
| 5 Edge Functions publicadas | O sandbox está com versões **antigas** de `catalog`, `order-status`, `delivery`, `demo-payment`, `admin-api` (pendência 1 da Missão 07). |
| Webhook recebendo eventos | Nunca recebeu. `payment_events` tem 2 linhas, ambas de teste de assinatura. |

### 1.3 Estado do banco

33 arquivos de migração (`0001`–`0033`), schema verificado objeto-por-objeto
contra o sandbox na Missão 07 (17 tabelas, 47 funções, 6 enums — idênticos).
Nenhuma migração destrutiva aplicada.

---

## 2. Dependências do Mercado Pago encontradas

Inventário completo, classificado por **custo de substituição**.

### 2.1 Substituição obrigatória (contrato do provedor)

| # | Arquivo | O que é |
| --- | --- | --- |
| 1 | `supabase/functions/_shared/mercadopago.ts` | Cliente inteiro: `createPixPayment`, `getPayment`, manifesto de assinatura, `isSignatureTimestampFresh`, `sanitizePayment`, `MercadoPagoError`, `MIN_PIX_EXPIRATION_MINUTES` |
| 2 | `supabase/functions/_shared/handlers/mpWebhook.ts` | Toda a extração do payload MP (`body.type`, `body.action`, `data.id`, `x-request-id`, `x-signature`), a ordem de validação e a reconferência via `getPayment` |
| 3 | `supabase/functions/mp-webhook/index.ts` | Slug/rota da função |
| 4 | `supabase/config.toml` | Bloco `[functions.mp-webhook]` |
| 5 | `supabase/functions/_shared/config.ts` | `mercadoPagoAccessToken`, `mercadoPagoWebhookSecret`, `mercadoPagoApiBase`, `requireMercadoPago()` |
| 6 | `.env.example`, `.env.functions.example` | `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `MP_NOTIFICATION_URL` |
| 7 | `supabase/migrations/0007_pagamentos.sql` | `CHECK (provider = 'mercado_pago')` em `payments` **e** em `payment_events` |
| 8 | `supabase/migrations/0026_modo_demonstrativo.sql` | Redefine os dois `CHECK` para `in ('mercado_pago','demo')` — **é este o estado vigente** |
| 9 | `supabase/migrations/0011_funcoes_nucleo.sql` | `record_payment_event` filtra por `provider = 'mercado_pago'` **hardcoded** (linha ~934) e insere sem informar `provider` (usa o default) |
| 10 | `supabase/migrations/0009_integridade_indices.sql` | `payments_provider_payment_id_key UNIQUE (provider_payment_id)` — **global, não por provedor** |
| 11 | `supabase/migrations/0011/0019` | Mapa de status: `approved/in_process/pending/rejected/cancelled/refunded/charged_back` (vocabulário MP) alimentado por `p_provider_status` |
| 12 | `supabase/functions/_shared/handlers/createOrder.ts` | `createPixPayment(...)`, `notificationUrl`, mensagem `503` "Mercado Pago não configurado" |
| 13 | `supabase/functions/_shared/handlers/orderStatus.ts` | `getPayment(...)` na reconciliação |
| 14 | `supabase/functions/_shared/handlers/demoPayment.ts` | Importa tipo/nome do provedor no caminho de aprovação simulada |
| 15 | `supabase/functions/_shared/rateLimit.ts` | Comentário e isenção do webhook citando MP |
| 16 | `supabase/migrations/0016_seed_categorias_e_config.sql` | `app_settings.pix_expiry_minutes` com descrição "mínimo aceito pelo Mercado Pago" (`30`) |
| 17 | `supabase/migrations/0015_comentarios.sql`, `0019`, `0033`, `0032` | `COMMENT ON` e notas citando MP |
| 18 | `src/pages/demo/PaymentCheckoutPage.tsx` | 9 ocorrências em texto de UI |
| 19 | `src/pages/PaymentPage.tsx` | Link "Abrir a fatura no Mercado Pago" (usa `ticket_url`) |
| 20 | `src/pages/admin/AdminOrders.tsx` | Instruções de operação ("faça o reembolso no Mercado Pago") |
| 21 | `src/services/backend/http.ts` | Mensagem de erro `502` citando MP |
| 22 | `src/services/orderService.ts` | Comentário da reconciliação |
| 23 | `docs/mercado-pago.md` | Documento inteiro |
| 24 | `scripts/smoke-edge-functions.mjs` | Nota sobre `MP_ACCESS_TOKEN` |

### 2.2 Reutilização direta (não menciona o provedor — **manter**)

Estes são o ativo mais valioso do projeto e **não devem ser reescritos**:

- `_shared/http.ts` (`ApiError`, `json`, `methodGuard`, `readJson`, `errorResponse`)
- `_shared/crypto.ts` (AES-256-GCM, SHA-256, `timingSafeEqual`, tokens)
- `_shared/rest.ts` (cliente PostgREST → RPC)
- `_shared/deps.ts` (`Deps` com injeção de `fetchImpl`, `now`, `rpc`, `log`)
- `_shared/rateLimit.ts` (contadores atômicos no banco, HMAC do IP)
- `_shared/validation.ts`, `_shared/cors.ts`, `_shared/mappers.ts`
- **Toda a máquina de estados de pedido/estoque/entrega**: `apply_payment_status`, `attach_payment`, `release_order_reservation`, `expire_overdue_reservations`, `create_order`, `create_purchase_request`, `get_order_status`, `get_order_status_by_reference`, `admin_*`
- RLS, `revoke/grant`, `job_health`, `rate_limit_counters`, `pg_cron`
- Todo o frontend exceto os textos citados em 2.1

### 2.3 Testes dependentes do provedor

| Arquivo | Casos | Dependência |
| --- | --- | --- |
| `tests/unit/fakeMp.ts` | (dublê) | Servidor MP falso no nível de `fetch` |
| `tests/unit/crypto_csv_mp.test.ts` | 19 | 8 casos são o cliente MP |
| `tests/db/mpSignature.ts` | (dublê) | Assinador do manifesto MP |
| `tests/db/11_webhook_assinatura.test.ts` | 9 | 15 referências — **é a suíte da assinatura** |
| `tests/db/13_limite_requisicoes.test.ts` | 16 | 18 referências (webhook isento) |
| `tests/db/07_create_order_http.test.ts` | 12 | Fluxo de criação de cobrança |
| `tests/db/05`, `06`, `08`, `09`, `10`, `14`, `16` | 94 | Referências indiretas (nome do provedor em payload/estado) |
| `src/pages/paymentDelivery.test.tsx`, `src/App.test.tsx` | — | `ticket_url`, telas de cobrança |

**Nenhum teste precisa ser deletado.** Todos os 198 continuam válidos como
regressão de domínio; apenas o vocabulário de entrada muda (§3).

---

## 3. Compatibilidade com a WyviPay

Fonte: documentação oficial `docs.wyvipay.com.br` (visão geral, guia PIX, guia
de webhooks, ambiente de teste). Base `https://api.wyvipay.com.br/api/v1`,
autenticação `Authorization: Bearer <chave>`, valores **sempre inteiros em
centavos**.

### 3.1 Mapa conceitual

| Necessidade da Prime Store | WyviPay | Veredito |
| --- | --- | --- |
| Criar cobrança PIX | `POST /cobrancas` (`valor_centavos`, `descricao`, `referencia`, `expiracao_segundos`, `pagador.*`) → `txid`, `copia_e_cola`, `qrcode` (data URI PNG) | ✅ **Compatível** |
| QR Code para exibir | `qrcode` volta como `data:image/png;base64,...` | ✅ Melhor que hoje: o MP devolvia base64 puro e o front monta o prefixo; na Wyvi já vem completo (atenção: normalizar, §4.5) |
| Copia e cola | `copia_e_cola` | ✅ Mapeia 1:1 em `payments.qr_code` |
| Consultar cobrança | `GET /cobrancas/{txid}` → `situacao`, `valor_centavos`, `pago_em`, `pagador` | ✅ Mapeia na reconciliação |
| Referência do pedido | campo `referencia` (≤120 chars), volta em toda consulta e webhook | ✅ **Melhor que hoje**: hoje usa-se `external_reference`; `referencia` é explicitamente o caminho de reconciliação |
| Confirmação de pagamento | webhook `cobranca.paga` + reconferência por `GET` | ✅ Mesmo padrão que já usamos |
| Expiração | `expiracao_segundos` (60–2.592.000; padrão 3600) + evento `cobranca.expirada` | ✅ Porém `expira_em` vem na criação → gravar em `payments.expires_at` |
| Cancelamento | `DELETE /cobrancas/{txid}` → evento `cobranca.cancelada`; `409` se não cancelável | ✅ Melhor que hoje (MP não tinha cancelamento implementado) |
| Reembolso | `POST /reembolsos` (`txid`, `valor_centavos?`, `motivo`) + `Idempotency-Key`; `cobranca.estornada` confirma | ✅ **Ganho**: hoje reembolso é 100% manual |
| Assinatura de webhook | HMAC-SHA256 sobre `{carimbo}.{corpo_cru}`, header `v1=<hex>`; carimbo `X-Wyvi-Carimbo` | ⚠️ **Manifesto diferente** — reescrever a verificação (§3.2) |
| Idempotência na criação | header `Idempotency-Key`; repetir devolve a mesma cobrança com `200` | ✅ Mesmo conceito de hoje |
| Splits / subcontas / cartão / cripto | existem | ⛔ **Fora de escopo** da V2 (decisão: PIX apenas) |

### 3.2 Webhooks: o que muda de verdade

| Aspecto | Mercado Pago (hoje) | WyviPay | Impacto |
| --- | --- | --- | --- |
| Manifesto assinado | `id:{data.id};request-id:{x-request-id};ts:{ts};` | **`{carimbo}.{corpo_cru}`** | Nova função; **o corpo cru passa a importar** (hoje o manifesto não usa o corpo) |
| Header da assinatura | `x-signature: ts=...,v1=...` (parse próprio) | `X-Wyvi-Assinatura: v1=<hex>` | Simplifica o parse |
| Carimbo de tempo | dentro do `x-signature` | header separado `X-Wyvi-Carimbo` (segundos) | Separar leitura |
| Janela de tolerância | 24 h + 5 min (escolha nossa) | **recomendado 300 s** (`> 300` recusa) | Ajuste de constante — e consequência operacional (§4.4) |
| Identidade da entrega | `notification_id` (montado por nós, com fallback frágil) | **`id` da entrega**, header `X-Wyvi-Entrega` | **Troca de chave de dedup** — hoje o fallback `${type}:${dataId}:${requestId}` colide sob reenvio |
| Tipo do evento | `type` + `action` | `evento` + `X-Wyvi-Evento` (`cobranca.paga`, `.expirada`, `.cancelada`, `.estornada`, `chave.rotacionada`, …) | Roteamento por tipo explícito, mais limpo |
| Corpo | sem envelope, tudo na raiz | `{ id, evento, criado_em, dados:{...} }` | Mapear `dados.*` |
| Reconferência | `GET /v1/payments/{id}` | `GET /cobrancas/{txid}` | Trivial |
| Retentativas | (do provedor) | 5 tentativas em ~1 h; 10 s de timeout; `2xx` obrigatório | Responder rápido; trabalho fora da request |
| Destino auto-desligado | — | 20 falhas seguidas → `ativo:false`; **eventos perdidos não são reenviados** | Exige rotina de reconciliação por `GET /cobrancas` (§4.7) |
| Cobertura por chave | — | destino nasce amarrado à chave que o criou | **Impacto direto na rotação** (§4.6) |

### 3.3 Tributo de compatibilidade que **não** existe

Uma coisa boa: **o token nunca é tratado como contrato de status**. O código já
normaliza (`v_mapped := case lower(p_provider_status) ...`), então os estados da
Wyvi (`pendente`, `concluida`, `cancelada`, `falhou`, `estornada`) entram como um
**novo** ramo de mapeamento, sem tocar na máquina de estados testada.

---

## 4. Problemas e riscos identificados

### 4.1 🔴 Crítico — `CHECK` de `provider` só aceita `mercado_pago` e `demo`

`payments_provider_check` e `payment_events_provider_check` foram definidos em
`0007` e redefinidos em `0026`. Hoje valem
`provider in ('mercado_pago','demo')`. Inserir `provider='wyvipay'` **falha**.
Sem migração, a integração nova não grava nada.

### 4.2 🔴 Crítico — `payments_provider_payment_id_key` é UNIQUE global

`UNIQUE (provider_payment_id)` sem `provider`. Se `txid` do Wyvi e
`provider_payment_id` do MP colidirem (improvável, mas o desenho está errado →
2.1 #10), um pagamento legítimo é rejeitado. Migração nova precisa trocar por
`UNIQUE (provider, provider_payment_id)`, **sem** apagar dados históricos. É a
única alteração de índice que considero obrigatória.

### 4.3 🔴 Crítico — `record_payment_event` é hardcoded

`where provider = 'mercado_pago' and notification_id = p_notification_id`, e o
`INSERT` não passa `provider` (usa o default `mercado_pago`). Um evento da Wyvi
gravado por essa função seria (a) marcado como MP e (b) deduplicado contra
eventos do MP. Precisa ganhar um parâmetro `p_provider` com default
`'mercado_pago'` para não quebrar chamadas existentes — **atenção**: mudar a
assinatura de uma função exposta a `service_role` exige `CREATE OR REPLACE` com
cuidado, porque parâmetros novos precisam vir com default para não invalidar o
grant nem o bundle antigo.

### 4.4 🟠 Alto — janela de 300 s vs. handshake do Supabase

O guia recomenda recusar `carimbo` com idade > 300 s. Isso é correto contra
replay, mas interage mal com a arquitetura: as Edge Functions são acionadas por
um gateway, e relógio desalinhado ou fila != 0 podem consumir parte da janela.
Mitigação proposta: **300 s como padrão, configurável por env
(`WYVI_WEBHOOK_MAX_AGE_SECONDS`, piso de 60)**, com log de `age` no evento.
Não afrouxar o padrão sem medição.

### 4.5 🟠 Alto — payloads que parecem iguais e não são

Quatro armadilhas concretas, todas capazes de falhar **em silêncio**:

1. `valor_centavos` é inteiro; o código atual converte `transaction_amount` com
   `Math.round(x*100)`. Reaproveitar essa conversão para um campo que **já é
   centavos** multiplicaria por 100.
2. `qrcode` já vem como `data:image/png;base64,`. O front monta
   `data:image/png;base64,${qr_code_base64}`. Colar o data URI no campo
   `qr_code_base64` produz `<img src="data:image/png;base64,data:image/png...">`.
3. `ticket_url` **não tem equivalente** na Wyvi. O link "Abrir a fatura" da
   `PaymentPage` fica órfão → precisa ser removido/condicionado.
4. A resposta de criação (`POST /cobrancas`) **não traz validação nenhuma do
   corpo em caso de replay**: repetir a `Idempotency-Key` com valor diferente
   devolve a cobrança **antiga, com o valor antigo**, `200`. Um bug de servidor
   que crie duas cobranças para o mesmo pedido com valores diferentes passaria
   despercebido. → conferir `valor_centavos` e `referencia` do retorno **sempre**,
   mesmo em `200`.

### 4.6 🔴 Crítico — rotação semanal de chaves

Fatos da documentação: **toda** chave (inclusive a padrão) é trocada às
segundas-feiras; a antiga **para de valer no mesmo instante**; **não há API para
obter a chave nova** — nem `GET /chaves`, nem qualquer rota equivalente entre as
135 listadas; a chave é exibida **apenas no painel**; `chave.rotacionada` avisa
que houve troca e leva **só o prefixo**, por decisão explícita (um webhook
carregando credencial seria o vazamento). Guarda-se apenas o hash.

**Consequência dura:** se a chave estiver hardcoded, o segredo do webhook e/ou a
chave de API **param de funcionar toda segunda-feira às 00:00**, e a loja
responde `401` até alguém abrir o painel e colar a chave nova. Não existe
automação possível fim-a-fim; existe automação **até a fronteira do painel**.

Procedimento proposto (executável, sem depender de milagre):

1. **Nunca** no código. Só em `supabase secrets` (ou Vault). Já é o padrão do
   projeto — manter.
2. Ler a chave em **runtime** por requisição, não em constante de módulo
   (o `loadConfig()` já faz isso; preservar).
3. Assinar `chave.rotacionada` no destino de webhook. Ao receber: gravar um
   **alerta operacional** (`provider_key_rotation` em tabela de eventos) e
   disparar aviso para o responsável. O evento **não** traz a chave — o alerta é
   para *humano com acesso ao painel*, não para automação.
4. **Janela de manutenção semanal declarada**: segunda 00:00–01:00 BRT = troca
   de chave. Nesse intervalo, checkout responde
   `503 payment_not_configured` de forma limpa (não `500`), o estoque é liberado
   e a UI mostra "pagamento temporariamente indisponível, tente novamente". Isso
   é degradação controlada, não queda.
5. **Deploy da chave em dois passos, à prova de ordem**: como a antiga morre no
   mesmo instante, a ordem é: (a) pegar a nova no painel; (b) `supabase secrets
   set`; (c) **republicar / reiniciar** as funções que dependem dela (secrets só
   são lidos no start da instância — **verificar isso na etapa 2**, é o ponto que
   mais arrisca falhar em silêncio); (d) validar com
   `GET /saldo` (rota barata, só leitura) antes de reabrir o checkout.
6. **Duas chaves em paralelo não é opção** — a documentação diz que a antiga
   para de valer no mesmo instante. Não planeje rotação suave; planeje
   **degradação curta e observável**.
7. **Não** automatizar a leitura do painel (scraping de credencial). Se a
   operação exigir zero-intervenção, a decisão correta é **negociar com a Wyvi**
   um mecanismo de rotação por API/cofre — está registrado como dependência
   humana (§9), não como algo que a engenharia resolve.
8. **Webhook também depende da chave?** O destino é criado pela chave e nasce
   vinculado a ela; e o `whsec_` é do destino, não da chave. Precisa ser
   **confirmado com a Wyvi** se a rotação invalida o destino ou só a
   autenticação de saída — é a pergunta de maior impacto operacional em aberto
   (§9, D2).

### 4.7 🟠 Alto — destino auto-desligado perde eventos para sempre

20 falhas seguidas → `ativo:false`, e "os eventos perdidos enquanto esteve
desligado **não são reenviados**; reconcilie por `GET /cobrancas`". Um deploy
ruim de 20 entregas (≈ 1 h de erros, dado o backoff 30 s/2 min/10 min/1 h)
**desliga o webhook** e a loja para de saber de pagamentos — silenciosamente,
porque o pagamento continua entrando.

Mitigação obrigatória no plano: **poller de reconciliação** por
`GET /cobrancas?situacao=concluida&desde=…` (cursor `antes_de`, balde de rate
limit próprio) rodando independente do webhook, mais `GET /webhooks/{id}` para
monitorar `ativo` — e um alerta se ficar `false`.

### 4.8 🟠 Alto — `teste: true` pode virar venda em produção

A doc do ambiente de teste é explícita: o **destino é o mesmo nos dois
ambientes**, e um evento de teste leva `teste: true` e `ambiente: "homologacao"`.
Sem conferência, um ensaio apontando para a URL de produção **libera
mercadoria**. O código atual não tem esse conceito. Vira requisito: rejeitar
`teste: true` quando a chave em uso for `wy_live_`.

### 4.9 🟡 Médio — mínimo de valor e taxa

Piso de geração R$ 0,50 (Purin) e a cobrança precisa cobrir a tarifa e deixar
líquido positivo; senão `valor_menor_que_a_taxa`. O catálogo tem produtos de
R$ 29,90 e R$ 49,90 — sem problema hoje, mas o checkout de carrinho vazio/1 item
precisa de validação server-side para não devolver `422` cru ao cliente. Também:
`taxa_centavos` e `liquido_centavos` voltam na resposta → **gravar para
conciliação** (o MP não dava isso de graça).

### 4.10 🟡 Médio — `/cobrancas` lista sem copia-e-cola e sem QR

A listagem não traz `copia_e_cola` nem `qrcode` (decisão de payload). Qualquer
tela que espere QR a partir da listagem vai exibir vazio. Buscar por `txid`.

### 4.11 🟡 Médio — `pagador` pode vir `null`

"Tratar o nulo: contar com o nome do pagador para casar o pedido é o defeito que
aparece só em produção." **Não** casar por pagador. Casar por `referencia`/`txid`,
como já fazemos.

### 4.12 🟡 Médio — retenção de dados pessoais

O webhook da Wyvi traz `pagador.nome`, `documento` (mascarado), `banco`, `ispb`.
O código atual é cuidadoso (`sanitizePayment` descarta dados pessoais, log só
com `notification_id`). **Não regredir**: não gravar `dados` cru em
`payments.provider_snapshot`, não logar o payload. Se a operação precisar de
`nome`/`banco` para conciliação, isso é decisão de LGPD explícita — hoje não está
autorizada.

### 4.13 🟡 Médio — documentação contraditória sobre `wy_test_` (§5)

E um risco transversal: `docs/testes.md` está **desatualizado** (diz 148 testes
de banco / 70 frontend no topo, enquanto a Missão 07 fechou em 198). Não é
invenção minha; é dívida de documentação que pode induzir alguém a achar que algo
regrediu.

---

## 5. Validação do ambiente de teste e a divergência do `wy_test_`

### 5.1 A divergência, precisamente

| Página | O que afirma |
| --- | --- |
| `api-reference` (Visão geral → Ambientes) | "`wy_test_` — **Ainda não emite cobrança.** Responde `501` com `ambiente_indisponivel`." Com a justificativa: "A chave de teste recusa em vez de fingir." |
| `api-reference/guides/ambiente-de-teste` | "**Exercite a integração inteira** sem mover dinheiro: a chave `wy_test_` **cria cobranças**, aceita pagamentos simulados e dispara webhooks reais." Com `curl` de exemplo, `txid` iniciando em `test`, e painel com "Simular pagamento"/"Expirar". |

As duas também divergem no léxico do payload de teste: o guia mostra
`{txid, valor, taxa, liquido, ...}` enquanto a criação em produção devolve
`{id, txid, situacao, valor_centavos, taxa_centavos, liquido_centavos, ...}`. O
guia parece descrever uma **versão anterior** do contrato.

### 5.2 Interpretação (e o que ela muda)

A divergência não é ambígua na prática: são **dois estados do mesmo produto**.

- A Visão geral é o documento **canônico e atual** e descreve o comportamento
  **enquanto o ambiente de teste está desligado** (é o estado que a Missão 07
  teria encontrado: nada de sandbox de pagamento funcionando).
- O guia descreve o ambiente de teste **quando habilitado** — inclusive com um
  parágrafo em que a própria página reconhece que já falhou ("Alguma coisa nesta
  página não bate com o que a API fez?"). Ele também diz "até 50 cobranças por
  conta" e "Limpar tudo", o que só faz sentido se o ambiente existir.

O trecho decisivo para o risco: *"sem [a separação], uma chave de teste criaria
um Pix **real e pagável** numa linha que o extrato trata como simulação"*. Ou
seja, quando o ambiente está **desligado**, a recusa (`501`) é justamente a
proteção; quando está **ligado**, a criação é segura porque o copia-e-cola aponta
para `.invalid`.

**O que a engenharia deve fazer:** tratar a divergência como **indeterminação de
ambiente**, não como bug de documentação a ser "corrigido" escolhendo a página
mais conveniente. A resposta correta é **projetar para os dois casos**:

- `501 ambiente_indisponivel` na criação → **não é erro do nosso código**.
  Mapear para um estado próprio (`payment_environment_unavailable`) com mensagem
  honesta na UI e **liberação imediata da reserva de estoque** (mesmo caminho de
  `payment_creation_failed`, que já existe e está testado).
- `201` com `txid` iniciando em `test` → fluxo normal, marcado como teste.

**Não** silenciar o `501`, **não** fazer retry em laço e **não** tratar como
sucesso.

### 5.3 A credencial de teste: não existe — dependência externa

Verificado, **sem exibir conteúdo** (e sem nada para exibir):

| Verificação | Resultado |
| --- | --- |
| Variáveis de ambiente do ambiente de execução com `WYVI`, `WYVI_*`, `MP_*`, `PIX_*` | **nenhuma** |
| Arquivos no workspace contendo o padrão `wy_test_` / `wy_live_` | **nenhum** |
| `.env`, `.env.*` locais | **não existem**; só `.env.example` e `.env.functions.example` (sem valor) |
| Segredos do Supabase sandbox citados nas Missões 03–07 | credencial de pagamento **nunca configurada** (o webhook responde `503` por isso) |
| Repositório da Missão 07 (`08e7eb3e`) mencionando `wyvi`/`wy_test_` | **zero ocorrências** |

**Não foi possível validar o funcionamento da credencial de teste** — porque não
há credencial. **Não gerei nenhuma cobrança** (nem de teste), **não usei
`wy_live_`, não movimentei dinheiro**. Registro como **dependência externa D1**
(§9).

Nota adicional que precisa ser dita: mesmo com a credencial em mãos, este
ambiente de execução **não tem rede de saída para `api.wyvipay.com.br`**
(verificado: HTTP `000` por TLS, igual a `api.mercadopago.com`; só
GitHub/npm/PyPI saem). A validação do fluxo real terá de ser feita de dentro do
sandbox Supabase — que é exatamente o padrão que as Missões 04–07 já adotaram
(schema auxiliar `verif.http_*`). Isso é reutilizável, não um bloqueio novo.

---

## 6. Arquitetura proposta

### 6.1 Princípio: adaptador, não reescrita

```
┌────────────────────────── Frontend (React) ──────────────────────────┐
│ /checkout  → solicitação (requested/not_required)      [INTOCADO]    │
│ /pagamento → cobrança PIX  ← REABRIR rota (hoje fora do roteador)    │
│ /entrega/:token                                     [INTOCADO]       │
│ textos: "Mercado Pago" → "Pix" / nome do gateway (sem marca fixa)    │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTPS + CORS por origem
┌───────────────────────────────▼──────────────────────────────────────┐
│ Edge Functions (Deno)                                                │
│  create-order ─┐                                                     │
│  order-status ─┤──►  _shared/payments/provider.ts  (novo contrato)   │
│  wyvi-webhook ─┘        │                                            │
│                         ├── _shared/payments/wyvipay.ts   (novo)     │
│                         └── _shared/mercadopago.ts     (preservado)  │
│                                                                      │
│  _shared/http · crypto · rest · deps · rateLimit · validation        │
│  _shared/cors · mappers                              [INTOCADOS]     │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ RPC (service_role)
┌───────────────────────────────▼──────────────────────────────────────┐
│ PostgreSQL (Supabase)                                                │
│  orders · order_items · stock_units · reservations · deliveries      │
│  payments · payment_events · refund_requests · order_events          │
│  apply_payment_status · attach_payment · record_payment_event        │
│  release_order_reservation · expire_overdue_reservations             │
│  RLS 19+ tabelas · rate_limit_counters · job_health · pg_cron        │
└──────────────────────────────────────────────────────────────────────┘
```

**Decisão central: camada de adaptador com um contrato único.** Um único
`provider.ts` traduz o vocabulário do provedor para o vocabulário do domínio
(`pending | in_process | approved | rejected | cancelled | refunded |
charged_back | amount_mismatch`). Assim:

- a máquina de estados testada em 198 casos **não muda de lógica**;
- migrar para outro gateway no futuro é escrever outro adaptador;
- o MP pode ficar disponível como caminho de rollback (útil porque **nenhum dos
  dois foi validado em produção**).

**Contrato do adaptador (proposto):**

```ts
interface PaymentProvider {
  readonly id: 'wyvipay' | 'mercadopago';
  createPixCharge(input: CreateChargeInput): Promise<ChargeSnapshot>;
  getCharge(providerIds: { txid?: string; paymentId?: string }): Promise<ChargeSnapshot>;
  cancelCharge(txid: string): Promise<{ situacao: string }>;
  requestRefund(input: RefundInput): Promise<RefundSnapshot>;
  verifyWebhook(rawBody: string, headers: Headers): Promise<WebhookDecision>;
}
```

`WebhookDecision` é o ponto sensível: devolve **`reject(kind)`** ou
`accept({ deliveryId, event, reference, txid, statusHint })`, e o handler genérico
nunca lê o payload do provedor. É isso que permite validar assinatura **antes** de
qualquer parse (como já é feito hoje).

### 6.2 Banco: migração `0034`, aditiva, zero perda

| Objeto | Mudança | Por quê |
| --- | --- | --- |
| `payments_provider_check` | `in ('mercado_pago','demo','wyvipay')` | §4.1 |
| `payment_events_provider_check` | idem | §4.1 |
| `payments_provider_payment_id_key` | `DROP` + `UNIQUE (provider, provider_payment_id)` | §4.2 |
| `payments` | `+ provider_txid text`, `+ end_to_end_id text`, `+ fee_cents int`, `+ net_cents int` | `txid` é o identificador de consulta/cancelamento; taxa e líquido vêm de graça e servem à conciliação |
| `payments` | `+ referencia text` **ou** derivar de `orders.reference` | reconciliação por `referencia` (o guia insiste nisso) |
| `payment_events` | `+ delivery_id text` (id da **entrega**, não da cobrança) + índice único `(provider, delivery_id)` | §4.5 → é a chave de idempotência correta da Wyvi |
| `payment_events` | `+ event_name text`, `+ test_flag boolean` | roteamento por `evento`; recusa de `teste: true` em produção (§4.8) |
| `payment_events` | `+ signature_age_seconds int` | observar §4.4 sem logar payload |
| `record_payment_event` | `+ p_provider text default 'mercado_pago'`, `+ p_delivery_id text default null` | §4.3 |
| `set_provider_key_rotation(p_event jsonb)` | **nova** | registra `chave.rotacionada` (só prefixo) e sinaliza operação |
| `reconcile_provider_charges(...)` | **nova** | poller de segurança (§4.7) |
| `app_settings.pix_expiry_minutes` | descrição sem "Mercado Pago"; avaliar 1800 → 1800/3600 conforme UX | §2.1 #16 |
| Índice | `payments (provider, status, created_at desc)` | listagem/conciliação |

**Nada é apagado. Nada é reescrito destrutivamente.** As colunas antigas
(`qr_code`, `qr_code_base64`, `ticket_url`, `provider_snapshot`) permanecem:
`ticket_url` fica `NULL` na Wyvi e o front passa a não depender dele.

### 6.3 Variáveis de ambiente (novas)

```
# Edge Functions — secrets
WYVI_API_KEY=                 # wy_test_... ou wy_live_... — NUNCA no repositório
WYVI_WEBHOOK_SECRET=          # whsec_... do destino (aparece uma única vez)
WYVI_API_BASE=https://api.wyvipay.com.br/api/v1
WYVI_WEBHOOK_MAX_AGE_SECONDS=300
WYVI_EXPIRATION_SECONDS=1800
PAYMENT_PROVIDER=wyvipay      # wyvipay | mercadopago | none  (kill switch)
PAYMENT_ALLOW_TEST_EVENTS=false   # true só em sandbox (§4.8)
```

Regras: sem `WYVI_API_KEY` → `503 payment_not_configured` (comportamento atual,
mantido). Sem `WYVI_WEBHOOK_SECRET` → `503 webhook_not_configured` e **nada é
gravado** (fail-closed, mantido). `PAYMENT_PROVIDER=none` desliga cobrança e
mantém a loja em modo solicitação — é o rollback mais barato que existe.

### 6.4 Alterações nas Edge Functions

| Função | Ação |
| --- | --- |
| `wyvi-webhook` (**nova**) | Borda fina → `handleProviderWebhook('wyvipay')`. Slug novo permite manter `mp-webhook` vivo durante a transição |
| `mp-webhook` (existente) | **Não apagar.** `verify_jwt:false` mantido; vira caminho legado |
| `create-order` | Trocar a chamada direta por `provider.createPixCharge`; adicionar tratamento de `501 ambiente_indisponivel` (§5.2) e de `422` de valor/taxa (§4.9) |
| `order-status` | Reconciliação via `provider.getCharge` |
| `admin-api` | `refunds.resolve` passa a poder **executar** o reembolso (`POST /reembolsos`) com `Idempotency-Key`, em vez de só registrar pendência (§3.1) |
| `_shared/config.ts` | Novos campos; `requireMercadoPago` generalizado |
| `_shared/rateLimit.ts` | `wyvi-webhook` isento (mesma justificativa do MP); nova rota `reconcile` |
| `_shared/payments/*` (**novos**) | `provider.ts`, `wyvipay.ts`, `webhookVerify.ts` |
| `config.toml` | `[functions.wyvi-webhook] verify_jwt = false` |

### 6.5 Frontend (mudança mínima — sem redesenho)

| Arquivo | Mudança |
| --- | --- |
| `src/App.tsx` | Reabrir `/pagamento` (e `/entrega/:token` já existe) — **decisão de produto**, não de código |
| `src/pages/PaymentPage.tsx` | Exibir `copia_e_cola` + QR; **remover o link de `ticket_url`** (§4.5 #3); estados novos: `payment_environment_unavailable`, chave rotacionada |
| `src/pages/demo/PaymentCheckoutPage.tsx` | Textos de MP → neutros ("o Pix"); normalizar o `qrcode` como data URI |
| `src/pages/admin/AdminOrders.tsx` | Instruções de reembolso: "manual no provedor" → "pode ser executado pelo painel" |
| `src/services/backend/http.ts` | `502` sem nome de provedor |
| `src/services/orderService.ts` | Campo `fee_cents`/`net_cents` se exibido no admin |
| `src/lib/links.ts`, `types.ts` | Ajustes de tipo; **nenhuma** mudança de layout, tipografia, paleta ou CSS estrutural |

**Nenhuma mudança visual desnecessária.** O CSS só ganha o necessário para o
aviso de indisponibilidade (reutilizando `.checkout-demo-alert`, que já existe).

### 6.6 Testes (estratégia: preservar 198, somar)

Ver §8.

---

## 7. Plano de implementação

> Nenhuma etapa abaixo foi executada. Cada etapa termina com um critério de
> saída verificável e **sem merge na `main`**.

### Etapa 0 — Reconciliação de linhagem (bloqueante, humana)

`main` (`0b50248`) e `08e7eb3e` têm raízes de commit distintas (§0.1). Antes de
qualquer código de gateway, decidir e executar **como** o backend chega à `main`.
Sem isso, todo o resto é trabalho que não tem destino. Envolve o responsável
(§9 D4). **Saída:** árvore única definida e reproduzível.

### Etapa 1 — Contrato e adaptador (sem tocar em produção)

1. `_shared/payments/provider.ts` (tipos + `ChargeSnapshot` + `WebhookDecision`).
2. `_shared/payments/wyvipay.ts` com `fetchImpl`/`now` injetáveis (padrão de
   `Deps` já existente — é o que permitiu testar o MP sem rede).
3. `_shared/payments/webhookVerify.ts`: HMAC sobre `{carimbo}.{corpo_cru}`,
   `timingSafeEqual`, janela configurável, parsing de `v1=`.
4. Mapa de status Wyvi → enum do domínio (`pendente→pending`,
   `concluida→approved`, `cancelada→cancelled`, `falhou→rejected`,
   `estornada→refunded`).
5. `tests/unit/fakeWyvi.ts` clonando a forma de `fakeMp.ts`.

**Saída:** testes unitários verdes; zero alteração de comportamento em produção.

### Etapa 2 — Banco (migração `0034`, aditiva)

Aplicar §6.2. Ensaiar em banco local com as 33 migrações + 0034, rodar a suíte de
banco inteira. **Nada de `db push`** (a pendência 3 da Missão 07 continua válida:
o ledger do sandbox tem 27 registros para 30+ arquivos). Aplicar por SQL e
registrar a versão efetivamente aplicada.

**Saída:** `198/198` de banco continuam verdes; novas funções com `revoke`/`grant`
só para `service_role`.

### Etapa 3 — Função de banco e webhook

1. `record_payment_event` com `p_provider`/`p_delivery_id` (defaults preservam
   as chamadas atuais).
2. `wyvi-webhook` + handler genérico.
3. Ordem de decisão herdada da Missão 07 (**não reordenar**): segredo ausente →
   `503`; cabeçalhos incompletos → `401`; HMAC inválido → `401`; carimbo velho →
   `401`; `teste:true` com chave live → `ignored`; **só então** gravar e
   reconferir por `GET /cobrancas/{txid}`.
4. Gravar `delivery_id` com índice único **antes** de processar.

**Saída:** notificação forjada → `401`, **zero linhas** em `payment_events`
(mesmo experimento antes/depois da Missão 07, agora para a Wyvi).

### Etapa 4 — Criação, consulta e conciliação

1. `create-order` via adaptador + `Idempotency-Key = order-{id}`.
2. Conferir `valor_centavos` **e** `referencia` do retorno, inclusive em `200` de
   replay (§4.5 #4).
3. Tratar `501 ambiente_indisponivel` → liberar reserva (§5.2).
4. `order-status` reconciliando.
5. Poller `GET /cobrancas` (§4.7) + monitor de `ativo` do destino.

**Saída:** reserva nunca presa; nenhum pagamento aprovado fica órfão mesmo com o
webhook desligado.

### Etapa 5 — Reembolso e cancelamento

`POST /reembolsos` com `Idempotency-Key`, `DELETE /cobrancas/{txid}`, e
`cobranca.estornada` concluindo o ciclo. Manter `chargeback ≠ reembolso` da
migração `0019` — a Wyvi tem o equivalente explícito (`natureza: ORIGINAL` vs
`MED_FRAUDE`, `cobranca_estornada` vs `contestacao_recebida`). **Não** unificar.

**Saída:** reembolso executável pelo painel, auditado, idempotente.

### Etapa 6 — Frontend

§6.5. Reabrir `/pagamento` só **depois** de 4 e 5 verdes.

### Etapa 7 — Rotação de chaves

§4.6. Inclui o alerta de `chave.rotacionada`, a janela de manutenção declarada e
o runbook de segunda-feira. **Saída:** simulação de rotação documentada (trocar a
chave no sandbox e provar que a loja se recupera no passo 5 do runbook).

### Etapa 8 — Publicação

Só após as etapas 1–7 e as dependências D1/D2 resolvidas.

---

## 8. Testes necessários

### 8.1 Unitários (novos)

`tests/unit/wyvipay.test.ts` (~22 casos): criação com `Idempotency-Key` e
`referencia`; `valor_centavos` **sem** reconversão (§4.5 #1); normalização do
`qrcode` data URI (§4.5 #2); ausência de `ticket_url`; `pagador` nulo; `replay
200` com valor divergente **detectado**; `501`; `422 valor_menor_que_a_taxa`;
`429` com `Retry-After`; `5xx` sem reenvio imediato; mapeamento das 5 situações.

`tests/unit/wyviWebhookVerify.test.ts` (~14): assinatura válida; HMAC errado;
sem prefixo `v1=`; carimbo velho (>300 s); carimbo futuro; corpo re-serializado
(**deve falhar** — é o teste que prova que o corpo cru é usado); `timingSafeEqual`
em tempo constante; corpo gigante; JSON inválido; `teste:true` em modo live.

### 8.2 Banco / HTTP (`tests/db/17_*`, `18_*`, ~30 casos)

Reaproveitando a infraestrutura real (PostgreSQL embutido + handlers por HTTP):

- assinatura inválida → `401` e **zero** linhas em `payment_events`;
- entrega repetida (mesmo `delivery_id`) → `duplicate:true`, sem efeito duplo;
- mesmo `txid` em **eventos diferentes** → ambos processados (não travar por
  `txid`);
- `provider='wyvipay'` gravando em `payments` e `payment_events`;
- **dois provedores coexistindo** sem colidir em `UNIQUE` (§4.2);
- aprovação duplicada → um `paid`, uma entrega;
- aprovação tardia de pedido `expired` → `refund_pending`, entrega **bloqueada**,
  `ignored_late_approval`;
- `valor_centavos` ≠ `total_cents` → `amount_mismatch`, entrega bloqueada;
- `referencia` desconhecida → `ignored`, pedido intocado;
- falha na criação → **reserva liberada** (`release_order_reservation`);
- `501 ambiente_indisponivel` → reserva liberada, sem pedido órfão;
- `cobranca.estornada` com `natureza: MED_FRAUDE` ≠ `ORIGINAL`;
- `chave.rotacionada` grava alerta **sem** chave;
- webhook isento de rate limit, mas rate limit ativo nas outras rotas;
- `anon`/`authenticated` sem acesso às funções e tabelas novas;
- **regressão**: as 198 existentes continuam verdes.

### 8.3 Integração (sandbox Wyvi, requer D1/D2)

Roteiro de 12 passos, **executado de dentro do sandbox Supabase** (`verif.http_*`,
padrão das Missões 04–07):

1. `GET /saldo` com a chave de teste → `200`.
2. `POST /webhooks` → guardar `whsec_` (uma vez) **em secret**, nunca em log.
3. `POST /cobrancas` com `referencia` → `201`, `txid` com prefixo `test`.
4. `Idempotency-Key` repetida → `200`, **mesmo** `txid`.
5. Banco: `payments` com `provider='wyvipay'`, `qr_code` preenchido.
6. Painel → "Simular pagamento" → `cobranca.paga` chega no `wyvi-webhook`.
7. Assinatura válida, `payment_events.signature_valid = true`.
8. Pedido `paid`, unidades `sold`, entrega `ready`, `/entrega/<token>` ok.
9. Reentrega do mesmo `delivery_id` → `duplicate`, sem efeito.
10. Evento forjado (HMAC errado) → `401`, **zero** linha nova.
11. `cobranca.expirada` → pedido `expired`, unidade **devolvida**.
12. `POST /reembolsos` → `cobranca.estornada` → entrega revogada.

Se o ambiente devolver `501 ambiente_indisponivel` nos passos 3–12, o resultado é
**"bloqueado por ambiente", não "aprovado"** — e o relatório deve dizer isso.

### 8.4 Não-regressão obrigatória

`npx tsc -b` limpo · frontend `70/70` · banco `198/198 + novos` ·
`npm run build` · `npm run bundle:functions` (**8 bundles hoje**, 9 com
`wyvi-webhook`) · **nenhum teste removido ou afrouxado**.

---

## 9. Dependências que precisam de intervenção humana

| # | Dependência | Bloqueia | Quem |
| --- | --- | --- | --- |
| **D1** | **Credencial `wy_test_`** (chave de teste + `whsec_` do destino). Não existe em nenhum lugar do ambiente, do repositório nem do sandbox. | §8.3 inteiro; qualquer afirmação de "integrada" | Responsável da conta Wyvi |
| **D2** | **Confirmar com a Wyvi** (a) se a rotação semanal invalida o **destino de webhook** ou só a autenticação de saída; (b) se `wy_test_` está habilitado para esta conta e por que a Visão geral diz `501`; (c) se existe mecanismo de rotação por API/cofre. Canal indicado pela própria doc: `contato@wyvipay.com.br`. | §4.6, §5 | Responsável + suporte Wyvi |
| **D3** | **Decisão de produto**: reabrir `/pagamento` na loja pública (hoje a experiência é "sem pagamento" por decisão da Missão 08 anterior) | Etapa 6 inteira | Responsável |
| **D4** | **Reconciliação de linhagem** (`main` × `08e7eb3e`) | Etapa 0 e todo merge | Responsável + arquitetura |
| **D5** | **Janela de manutenção semanal** declarada (segunda 00:00–01:00) e quem executa o runbook de rotação | §4.6 operação | Responsável |
| **D6** | **`supabase` CLI / token de deploy** no ambiente (a Missão 07 registra 5 funções não publicadas por isso) | Publicação de `wyvi-webhook` | Responsável |
| **D7** | **Revisão jurídica**: reter `pagador.nome`/`banco` é dado pessoal; hoje o código descarta. Se a conciliação exigir, precisa de base legal explícita | §4.12 | Responsável + jurídico |
| **D8** | **Conta de teste com PIX** (a Wyvi exige, na doc, chave PIX na conta; para taxa mínima e `sem_plano` é preciso plano vigente) | §8.3 passos 1–3 | Responsável |

Nenhuma delas pode ser resolvida por código. Nenhuma foi contornada.

---

## 10. Critérios objetivos para considerar a integração concluída

Só se pode dizer "concluída" quando **todos** forem verdadeiros e verificáveis
por terceiro:

**Segurança**
1. Nenhuma credencial `wy_`/`whsec_` no repositório, no bundle ou no log
   (`git grep` limpo + inspeção dos bundles).
2. Segredo ausente → `503`, **zero** linhas em `payment_events` (medido).
3. HMAC inválido/ausente → `401`, **zero** linhas (medido antes/depois).
4. Corpo re-serializado **não** valida (prova de uso do corpo cru).
5. Carimbo > janela → recusado; replay de entrega legítima antiga → recusado.
6. `delivery_id` com índice único, gravado **antes** do processamento.
7. `anon` e `authenticated` sem `SELECT`/`EXECUTE` em qualquer objeto novo
   (contagem de privilégios medida).
8. Payload e dados pessoais fora de log e de `provider_snapshot`.

**Dinheiro e estoque**
9. Pagamento aprovado duas vezes → um `paid`, **uma** entrega.
10. Aprovação tardia → sem reabertura, entrega bloqueada, pendência registrada.
11. `valor_centavos` ≠ `total_cents` → `amount_mismatch`, sem entrega.
12. Falha de criação (incl. `501`) → **zero** unidade presa (medido por
    contagem de `stock_units.status`).
13. Nenhum pagamento aprovado fica órfão com o webhook desligado (poller
    demonstrado).

**Operação**
14. Rotação de chave ensaiada: troca no sandbox → loja se recupera pelo runbook,
    com `503` honesto durante a janela.
15. Alerta de `chave.rotacionada` registrado sem expor a chave.
16. `GET /webhooks/{id}` monitorado com alerta se `ativo:false`.

**Qualidade**
17. `tsc -b` limpo; `npm run build` ok; `bundle:functions` ok.
18. Frontend `≥70/70`, banco `≥198/198`, **nenhum** teste removido ou afrouxado.
19. `tests/db/17`+`18` (>30 casos) verdes.
20. Sandbox com as funções nas **versões do repositório** (a pendência 1 da
    Missão 07 tem de estar fechada).

**Honestidade**
21. Se D1/D2 não forem resolvidas, o relatório final **não** pode dizer
    "integrada": diz "implementada, não validada contra o provedor" — regra que a
    Missão 07 já adotou e que deve ser mantida.
22. Documentação atualizada: `docs/mercado-pago.md` → `docs/pagamentos.md`
    (provedor atual + legado), `docs/testes.md` corrigido (está dizendo 148/70
    quando a Missão 07 fechou em 198), `limitacoes-e-pendencias.md` revisado.

---

## 11. O que este trabalho **não** fez

- Não alterou a `main`, não fez merge, não abriu PR.
- Não fez checkout, commit nem push na branch `08e7eb3e`; auditou-a por worktree
  destacado em `/tmp`, somente leitura.
- Não alterou credenciais nem variáveis de ambiente.
- Não executou operação financeira, nem cobrança de teste, nem `wy_live_`.
- Não apagou pedido, produto ou estoque; não rodou migração.
- Não enfraqueceu proteção existente; não editou nenhum arquivo da integração.

---

## 12. Resumo em uma frase

O backend da Prime Store **já tem** a arquitetura que a WyviPay exige (assinatura
HMAC fail-closed, idempotência, reconferência no provedor, reserva de estoque com
liberação, proteção contra dupla aprovação e aprovação tardia) e a troca de
gateway é um **adaptador + uma migração aditiva** — mas a integração atual **nunca
foi validada contra provedor nenhum**, e a WyviPay acrescenta duas exigências
novas que o desenho atual não cobre: **rotação semanal de chave sem API de
leitura** (exige procedimento humano e janela de manutenção) e **recusa explícita
do ambiente de teste** (`501`), sobre a qual a própria documentação se contradiz.
Concluir sem D1 e D2 seria declarar pronto algo nunca exercitado.
