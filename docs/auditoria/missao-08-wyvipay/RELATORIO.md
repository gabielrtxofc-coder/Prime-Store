# Missão 08 (b) — Auditoria e planejamento da integração WyviPay

> **Natureza desta missão:** reconhecimento e planejamento. **Nenhum código de
> integração foi escrito, nenhuma migração foi aplicada, nenhuma credencial foi
> criada ou lida, nenhuma cobrança foi emitida e nenhum valor foi movimentado.**
>
> - Branch de trabalho: `arena/e7e73e28-prime-store` (o ambiente fixa esta
>   branch; ver §11.1).
> - Commit de referência: `2a456ee` — *feat(loja): catálogo, carrinho e
>   solicitação sem pagamento integrados ao backend*.
> - `main`: **não tocada**, nenhum merge, nada publicado em produção.
> - Projeto Supabase usado só para leitura: `prime-store-sandbox`
>   (`eorlmqolbknrplvdbbtl`, `sa-east-1`).
> - Data: 2026-11-08.
>
> **Resumo em uma frase:** o Mercado Pago está confinado a **oito arquivos de
> código, três migrações e uma coluna de CHECK no banco**; toda a camada de
> dinheiro que importa (`apply_payment_status`, reservas, entrega, disputa,
> reembolso) é **agnóstica de provedor** e pode ser reaproveitada — mas ela
> opera hoje sobre um modelo de **um produto por pedido**, enquanto a loja em
> produção passou a vender **carrinho com vários itens**. O plano abaixo substitui
> o gateway **e** fecha essa lacuna antes de qualquer cobrança real.

---

## 1. Estado atual da integração de pagamentos

### 1.1 O que existe hoje, por camada

| Camada | Estado real | Evidência |
| --- | --- | --- |
| Cliente HTTP do provedor | `supabase/functions/_shared/mercadopago.ts` — 274 linhas, PIX via `POST /v1/payments`, idempotência por `X-Idempotency-Key`, timeout 15 s, `sanitizePayment` descarta PII | leitura do arquivo |
| Criação de cobrança | `handlers/createOrder.ts` — cria pedido + reserva **antes** de chamar o provedor; falha do provedor libera a reserva e devolve `502` | `createOrder.ts:158-215` |
| Confirmação | `handlers/mpWebhook.ts` (assinatura + reconferência em `GET /v1/payments/{id}`) e `handlers/orderStatus.ts` (reconciliação sob demanda no polling do comprador) | `mpWebhook.ts:60-190`, `orderStatus.ts:105-140` |
| Webhook | Edge Function `mp-webhook` publicada **v5**, `verify_jwt: false` | `list_edge_functions` |
| Credenciais | `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `MP_API_BASE_URL`, `MP_NOTIFICATION_URL` — **nenhuma configurada** no sandbox | `list_secrets` (só `DEMO_*`, `STORE_URL`, `ALLOWED_ORIGINS`) |
| Atualização de pedido | `apply_payment_status(...)` (migração `0019`, última redefinição) — máquina de estados completa, idempotente | `0019_chargeback_x_reembolso.sql:27-419` |
| Identificador de transação | `public.payments.provider_payment_id text` com índice único global | `0009_integridade_indices.sql`, `payments_provider_payment_id_key` |
| Reembolsos | `refund_requests` + `admin_resolve_refund`; **a devolução em si é manual no provedor** | `docs/mercado-pago.md`, `adminApi.ts:387-398` |
| Estornos/chargeback | `payment_status.charged_back` → `order_status.disputed`, entrega **preservada**, decisão por `admin_resolve_dispute` | `0019` §347-393 |
| Testes | 16 arquivos de banco, 186 blocos `it()`; webhook com assinatura própria (`tests/db/mpSignature.ts`) e provedor fake (`tests/unit/fakeMp.ts`) | contagem no repositório |
| Documentação | `docs/mercado-pago.md` (87 linhas), além de 10 outros documentos com referência ao provedor | `grep -ril "mercado"` |
| Frontend | **Fora do roteador público** desde a missão anterior: `PaymentCheckoutPage` (movido para `src/pages/demo/`), `PaymentPage`, `DeliveryPage`, `admin/*` — arquivos preservados, rotas removidas | `src/App.tsx:68-82` |
| Modo demonstrativo | Ligado no sandbox: `app_settings.demo_payments_enabled = true` + `DEMO_PAYMENT_ENABLED`; três travas | `0026`–`0029`, `list_secrets` |

### 1.2 O que a loja faz hoje de verdade (e o que isso implica)

O fluxo público atual é **catálogo → carrinho → `POST /order-request` →
`create_purchase_request()` → `orders.status='requested'` /
`payment_status='not_required'`**. Não há cobrança, não há reserva de estoque,
não há entrega. Os arquivos de pagamento continuam no repositório, íntegros,
porém **sem consumidor**.

Consequência direta para esta missão: a integração WyviPay **não vai substituir
um fluxo vivo** — vai **reabrir** um fluxo que foi deliberadamente congelado.
Isso é uma vantagem (não há cliente em produção a quebrar) e um risco (o código
congelado envelheceu em relação ao modelo de dados atual; ver §3.2).

### 1.3 Estado verificado nesta auditoria

| Verificação | Resultado |
| --- | --- |
| `git status` | árvore limpa, nada pendente no commit `2a456ee` |
| `git diff main...HEAD` | **sem base comum** (`no merge base`) — a `main` é de outra linhagem; ver §11.1 |
| `npx tsc -b` | limpo (0 erros) |
| `npx vitest run` (frontend) | **75/75** em 9 arquivos |
| Suíte de banco | **não reexecutada nesta sessão** — este container não tem servidor PostgreSQL (`which postgres/initdb` → vazio, `/usr/lib/postgresql` inexistente) e o proxy do npm não entrega os binários. Último registro confiável: 198/198 (missão 07) e 20 casos novos na missão seguinte. **Registrado como dependência de ambiente, não como regressão.** |
| Tabelas no sandbox | 20 em `public` (`orders.buyer_name`, `buyer_email`, `items_count` e `order_items` já aplicados) |
| Enums no sandbox | `order_status` inclui `disputed` e `requested`; `payment_status` inclui `not_required` |
| Linhas sensíveis no sandbox | `payments = 3`, `payment_events = 2`, `refund_requests = 0`, `orders = 8` — nada foi apagado nem alterado |

---

## 2. Dependências do Mercado Pago encontradas

### 2.1 Mapa completo (arquivo → dependência → classificação)

Classificação: **SUBSTITUIR** (específico do provedor), **ADAPTAR** (lógica boa,
contrato novo), **REUTILIZAR** (agnóstico, não mexer).

| # | Arquivo | Dependência | Classe |
| --- | --- | --- | --- |
| 1 | `supabase/functions/_shared/mercadopago.ts` | cliente inteiro: URL, bearer, `POST /v1/payments`, `payment_method_id: "pix"`, `external_reference`, `point_of_interaction.transaction_data.qr_code{,_base64}/ticket_url`, `status` (`approved`/`in_process`/…), HMAC `x-signature` com manifesto `id:{data.id};request-id:{x-request-id};ts:{ts};` | **SUBSTITUIR** (o HMAC é outro: ver §3.3) |
| 2 | `supabase/functions/_shared/handlers/mpWebhook.ts` | nome da função, extração de `data.id`/`type`/`action`, cabeçalhos `x-signature`/`x-request-id`, `record_payment_event`, reconferência via `getPayment` | **ADAPTAR** (≈70% da estrutura serve) |
| 3 | `supabase/functions/_shared/handlers/createOrder.ts` | nome de config, `createPixPayment`, mensagem `503 payment_not_configured` citando o provedor, `expirationMinutes: 30`, `idempotencyKey: order-<uuid>` | **ADAPTAR** |
| 4 | `supabase/functions/_shared/handlers/orderStatus.ts` | `getPayment` no polling (`shouldReconcile`, linhas 105-140) | **ADAPTAR** |
| 5 | `supabase/functions/_shared/config.ts` | `mercadoPagoAccessToken`, `mercadoPagoWebhookSecret`, `mercadoPagoApiBase`, `paymentNotificationUrl`, `requireMercadoPago()` | **ADAPTAR** (renomear + renomear variável de ambiente) |
| 6 | `supabase/migrations/..._0007_pagamentos.sql` | `CHECK (provider = 'mercado_pago')` em `payments` **e** `payment_events`; default `'mercado_pago'` | **ADAPTAR** (migração de dados, sem `DROP` destrutivo) |
| 7 | `supabase/migrations/..._0011_funcoes_nucleo.sql` | `record_payment_event` filtra `where provider = 'mercado_pago'` (linha 934) — **dedup específica de provedor** | **ADAPTAR** |
| 8 | `supabase/migrations/..._0026_modo_demonstrativo.sql` | `CHECK (provider in ('mercado_pago','demo'))` | **ADAPTAR** |
| 9 | `supabase/config.toml` | bloco `[functions.mp-webhook]` | **ADAPTAR** |
| 10 | `.env.example`, `.env.functions.example` | 3 + 4 referências ao provedor | **ADAPTAR** |
| 11 | `scripts/smoke-edge-functions.mjs` | chama `mp-webhook` esperando `400/401/403` | **ADAPTAR** |
| 12 | `src/pages/demo/PaymentCheckoutPage.tsx` | textos ao usuário ("cobrança no Mercado Pago") | **ADAPTAR** (texto) |
| 13 | `src/pages/PaymentPage.tsx` | botão "Abrir a fatura no Mercado Pago" (linha 303) | **ADAPTAR** (label + link) |
| 14 | `src/services/orderService.ts:137` | comentário de contrato | **ADAPTAR** (comentário) |
| 15 | `tests/unit/fakeMp.ts` | dublê do provedor (90 linhas) | **ADAPTAR** → base de `fakeWyvi.ts` |
| 16 | `tests/db/mpSignature.ts` | assina o manifesto do MP | **SUBSTITUIR** por `wyviSignature.ts` |
| 17 | `tests/db/{05,07,09,10,11,13,14,16}` + `tests/unit/crypto_csv_mp.test.ts` | usam os dois dublês e nomes do provedor | **ADAPTAR** (sem afrouxar nenhum caso) |
| 18 | `docs/mercado-pago.md`, `README.md`, `docs/{README,backend,seguranca,testes,painel-admin,limitacoes-e-pendencias,PROGRESSO,setup-local}.md` | **52 menções** em 10 arquivos de documentação (+7 nos dois `.env.*.example`) | **ADAPTAR** (documentação histórica das missões 03-07 **não** se reescreve) |

### 2.2 Dependências que **não** existem (verificado, não presumido)

- **Não há SDK** do Mercado Pago em `package.json` — só `@supabase/supabase-js`, React e ferramentas de build. Trocar de gateway **não altera dependências npm**.
- **Não há domínio de pagamento no frontend**: `src/services/paymentService.ts` é um stub que devolve `not-configured` e não faz rede.
- **Nenhuma credencial `MP_*` no sandbox** e nenhuma no repositório.
- **Nenhuma chamada de reembolso ao provedor** existe no código: `refund_requests` é registro interno; a devolução é manual. Ou seja, a WyviPay **acrescenta** capacidade (`POST /reembolsos`), não substitui uma já existente.

### 2.3 O que é 100% reutilizável (não tocar)

`apply_payment_status` (máquina de estados: `approved`/`rejected`/`cancelled`/`refunded`/`charged_back`/`amount_mismatch`, aprovação tardia, pago-sem-estoque, disputa), `attach_payment`, `record_payment_event`/`finish_payment_event` (só o filtro de provedor muda), `release_order_reservation`, `consume_reservation`, `allocate_late_units`, `expire_overdue_reservations`, `resolve_delivery`, toda a RLS e a matriz de privilégios, `consume_rate_limit`, `run_reservation_expiry`, o webhook fail-closed, `_shared/crypto.ts`, `_shared/http.ts`, `_shared/cors.ts`.

---

## 3. Compatibilidade com a WyviPay

Documentação consultada em 2026-11-08: `api-reference` (visão geral, 135 rotas), `guides/pix`, `guides/webhooks`, `guides/ambiente-de-teste`, `endpoint/payment-pix/create`, `endpoint/payment-pix/get`, `endpoint/refunds/create`.

### 3.1 Mapeamento de contrato

| Necessidade da Prime Store | Mercado Pago (hoje) | WyviPay | Veredito |
| --- | --- | --- | --- |
| Criar cobrança PIX | `POST /v1/payments` | `POST /api/v1/cobrancas` | directo |
| Valor | `transaction_amount` **decimal** (reais) | `valor_centavos` **inteiro** | **melhor** — casa com `total_cents` do banco, elimina o `toFixed(2)` |
| QR Code | `qr_code_base64` (base64 puro) + `ticket_url` | `qrcode` (**data URI** `data:image/png;base64,…`, pode vir `null`) e `copia_e_cola` | adaptar render (`<img src>` direto, sem prefixo) |
| Copia e cola | `qr_code` | `copia_e_cola` | direto |
| Expiração | `date_of_expiration` ISO, mínimo 30 min | `expiracao_segundos` (60…2.592.000, padrão 3600) | 1800 s atende |
| Referência do pedido | `external_reference` | `referencia` (volta em toda consulta **e em todo webhook**) | melhor |
| Idempotência | `X-Idempotency-Key` | `Idempotency-Key` (`200` em vez de `201` na repetição) | directo |
| Consulta | `GET /v1/payments/{id}` | `GET /api/v1/cobrancas/{txid}` | directo |
| Situações | `approved`, `in_process`, `pending`, `rejected`, `cancelled`, `refunded`, `charged_back` | `pendente`, `concluida`, `cancelada`, `falhou`, `estornada` | **mapear** (§3.4) |
| Cancelar | (implícito) | `DELETE /cobrancas/{txid}` | novo, disponível |
| Webhook | `x-signature: ts=…,v1=…` sobre manifesto montado | `X-Wyvi-Assinatura: v1=<hmac>` sobre **`{carimbo}.{corpo-cru}`** + `X-Wyvi-Carimbo`, `X-Wyvi-Entrega`, `X-Wyvi-Evento` | **reescrever a verificação** (§3.3) |
| Id de dedup | `notification_id` (derivado) | `id` **da entrega** (UUID, explícito no corpo e no header) | **melhor** — o handler atual já inventa um id sintético quando falta |
| Reembolso | manual no painel do provedor | `POST /reembolsos` + eventos `reembolso.solicitado`/`falhou`/`cobranca.estornada` | **capacidade nova** |
| Disputa/chargeback | `charged_back` | `med.aberto`/`med.atualizado`/`med.encerrado` (campo `desfecho`) e `cobranca.estornada.natureza = MED_FRAUDE` | mapear para `disputed` |
| Rate limit | não documentado como limite rígido | **200 req/min por rota e por chave**, com `X-RateLimit-*` e `429 limite_atingido` | planejar orçamento |

### 3.2 Incompatibilidades reais (as que exigem trabalho, não parágrafo)

**A. Modelo de pedido — a mais séria.**
`create_order` (fluxo de cobrança) cria **um** pedido com `product_id`,
`quantity`, `unit_price_cents`, `reserve_stock_units(order, product, qty, …)`.
`apply_payment_status` aprova chamando `consume_reservation` e
`allocate_late_units(p_order_id, v_order.product_id, v_order.quantity)` —
**sempre um produto**. `deliveries` tem `UNIQUE (order_id)` e `resolve_delivery`
lê `v_order.product_id` para montar **um** bloco `product`.
Já o fluxo novo registra em `order_items` (até 10 produtos) e o carrinho da loja
**é multi-item por desenho**. Cobrar um carrinho de 2 produtos no fluxo atual
seria cobrar `orders.total_cents` e entregar só `product_id`. **Não é um bug a
corrigir depois: é pré-requisito para faturar.**

**B. `payments.method` tem `CHECK (method = 'pix')`.** A WyviPay cobra cartão
(`/cartao/…`) e cripto. Se a loja for só PIX na V1, o CHECK fica — mas isso é
uma **decisão explícita**, não um acidente (§7, etapa 0).

**C. `provider_payment_id` é `UNIQUE` global.** O `txid` da WyviPay começa com
`test` no ambiente de teste (§5.3) e é único — compatível. Mas o campo é
`text` e não tem restrição de formato: **não** guardar `txid` e `id` no mesmo
campo (a doc é explícita: *"Guarde este [txid], não o `id`"*).

**D. Valor.** A Prime Store guarda centavos inteiros; a WyviPay também — **mas**
ela recusa `valor_menor_que_a_taxa` e exige plano vigente (`409 sem_plano`).
Produtos do sandbox custam R$ 29,90 e R$ 49,90, muito acima do piso; ainda
assim, a UI deve tratar `422`/`409` com mensagem própria, não com `502` genérico.

**E. Duas formas de taxa.** No sandbox os produtos são `is_demo`, e a WyviPay
aprovou o modo de teste com `wy_test_`; mas o **modo demonstrativo da loja**
(`demo-payment`) e o **ambiente de teste da WyviPay** são coisas diferentes e
precisam de nomes diferentes na interface e na documentação, senão viram uma
só na cabeça do operador (§4, risco R4).

### 3.3 Assinatura de webhook: a diferença que quebra copiar-e-colar

| | Mercado Pago (implementado) | WyviPay (a implementar) |
| --- | --- | --- |
| Cabeçalho | `x-signature: ts=<ts>,v1=<hex>` | `X-Wyvi-Assinatura: v1=<hex>` |
| Mensagem assinada | `id:{data.id};request-id:{x-request-id};ts:{ts};` | **`{X-Wyvi-Carimbo}.{corpo cru}`** |
| Timestamp | dentro do manifesto, validado por idade (24 h + 5 min) | `X-Wyvi-Carimbo`, validado por idade **±300 s** |
| Corpo cru | não é necessário (o HMAC não cobre o corpo) | **obrigatório** — `request.text()` **antes** de qualquer `JSON.parse` |
| Comparação | hex, tempo constante (feito à mão) | `timingSafeEqual` sobre `Buffer` (o atual `timingSafeEqual` de string serve) |

O `mpWebhook.ts` já lê `rawBody` antes do parse (linha 46), então a mudança é
**cirúrgica**: trocar a função de verificação e a origem do carimbo. A janela de
24 h deve **encolher para 300 s** — é o que o provedor documenta e o que fecha
replay. Aumentar essa janela "para não perder evento" seria enfraquecer proteção
existente (proibido por §7).

### 3.4 Mapa de estados (WyviPay → enums do banco)

| Situação/evento WyviPay | `payment_status` | Caminho em `apply_payment_status` |
| --- | --- | --- |
| `pendente` | `pending` | §5 (só reflete) |
| `concluida` / `cobranca.paga` | `approved` | §1 (consome reserva / realoca / pago-sem-estoque) |
| `falhou` / `cobranca.expirada` | `cancelled` | §3 (libera reserva) |
| `cancelada` / `cobranca.cancelada` | `cancelled` | §3 |
| `estornada` (`natureza=ORIGINAL`) / `cobranca.estornada` | `refunded` | §4 (revoga entrega) |
| `estornada` (`natureza=MED_FRAUDE`) / `med.encerrado` desfavorável | **`charged_back`** | §4-bis → `disputed`, entrega **preservada** |
| `reembolso.solicitado` | *nada* (andamento) | evento em `order_events`, sem transição |
| `reembolso.falhou` | *nada* | evento + `refund_requests.notes` |
| `pagador` nulo | *irrelevante* | nunca usar pagador para casar pedido |

Regra de ouro preservada: **a notificação nunca é fonte de verdade**; o handler
sempre reconfere em `GET /cobrancas/{txid}` antes de mudar estado (como hoje).

---

## 4. Problemas e riscos identificados

| # | Risco | Gravidade | Detalhe e mitigação |
| --- | --- | --- | --- |
| **R1** | **Cobrança multi-item sem máquina de estados multi-item** | **crítico** | `apply_payment_status`, `consume_reservation`, `allocate_late_units` e `resolve_delivery` são mono-produto; o carrinho é multi-item. Cobrar antes de resolver isso entrega o pedido errado. Mitigação: etapa 1 do plano (§7) — unificar `create_order` sobre `order_items` **antes** de plugar a WyviPay. |
| **R2** | **Rotação semanal de chaves** (toda segunda-feira) | **crítico** | Toda `wy_*` é trocada semanalmente; a antiga **morre no mesmo instante**. Uma variável de ambiente estática quebra a loja toda segunda. A doc manda assinar `chave.rotacionada`, mas esse evento **só avisa o prefixo, nunca a chave** — logo o webhook **não resolve** a rotação. Procedimento proposto em §6. |
| **R3** | **Divergência documental sobre `wy_test_`** | alto | §5. Uma página diz `501 ambiente_indisponivel`, outra diz que a chave de teste emite. Decidir o desenho com base na página errada custa uma etapa inteira. |
| **R4** | **Confusão "demo da loja" × "teste da WyviPay"** | alto | O sandbox tem `demo_payments_enabled = true`. Um evento de teste (`teste: true`) chegando na URL de produção liberaria pedido real — a própria doc alerta. Mitigação obrigatória: **recusar `teste: true` quando o ambiente for produção** (§6, controle 9). |
| **R5** | **Destino de webhook se desliga sozinho** | médio | 20 falhas seguidas → `ativo: false` e eventos perdidos **não são reenviados**. Sem monitorar, a loja para de confirmar pagamentos em silêncio. Mitigação: `GET /webhooks/{id}` periódico + reconciliação por `GET /cobrancas`. |
| **R6** | **Retentativas em janela curta (1 h, 5 tentativas)** | médio | O MP reenviava por horas; a WyviPay para depois da 5ª (~1 h). Um deploy de 15 min ainda cabe; um incidente de 2 h perde o evento. Mitigação: conciliação ativa obrigatória (não opcional). |
| **R7** | **Orçamento de 200 req/min por chave e por rota** | médio | O `order-status` faz polling; com a reconciliação interna, cada polling pode virar 1 requisição ao provedor. Hoje `ROUTE_LIMITS['order-status'] = 60/min`. Com 200/min do lado do provedor, 4 compradores simultâneos em polling já encostam no teto. Mitigação: reconciliar **no máximo 1× por N segundos por pedido** (cache no banco), não a cada polling. |
| **R8** | **Reembolso parcial com taxa** | médio | Sem `valor_centavos`, a WyviPay devolve **o líquido** (R$ 98,51 de R$ 100,00). O padrão "devolver tudo" do produto precisa ser explícito: devolver `valor_centavos = total_cents` (bruto) ou aceitar devolver o líquido e documentar. Silêncio aqui vira prejuízo contábil. |
| **R9** | **`refund_pending` sem ação** | médio | O fluxo "pago sem estoque" abre `refund_requests` e espera decisão humana. Sem chamada a `POST /reembolsos`, o dinheiro fica com a loja indefinidamente. |
| **R10** | **`saldo_insuficiente` no reembolso** | baixo | A WyviPay não adianta valor. Um reembolso pedido depois de saque falha com `422`. Não é bug do código; é procedimento operacional. |
| **R11** | **Relógio** | baixo | A janela de ±300 s depende de NTP correto nas Edge Functions. Sem isso, **todo** webhook é recusado (`401`). |
| **R12** | **Dados pessoais no webhook** | baixo | `cobranca.paga` traz `pagador.nome` e `documento` mascarado. O `payment_events` atual guarda `payload_hash`, não o corpo: manter assim (§6, controle 10). |
| **R13** | **`create_order` só com um produto → carrinho bloqueado na UI** | médio | Se a integração reabrir o checkout antigo, a loja volta a vender um item por pedido — regressão funcional contra a missão anterior. |

---

## 5. Validação do ambiente de teste e a divergência documental

### 5.1 A divergência, com as duas citações

**Página A — *Visão geral* (`/api-reference`), tabela "Ambientes":**

| Prefixo | Ambiente | Situação |
| --- | --- | --- |
| `wy_live_` | Produção | Emite Pix de verdade. |
| `wy_test_` | Teste | **Ainda não emite cobrança. Responde `501` com `ambiente_indisponivel`.** |

E o texto que a acompanha: *"A chave de teste recusa em vez de fingir."*

**Página B — *Ambiente de teste* (`/guides/ambiente-de-teste`):**

> *"Exercite a integração inteira sem mover dinheiro de verdade: a chave
> `wy_test_` **cria cobranças**, aceita pagamentos simulados e dispara webhooks
> reais."*

E a mesma página lista explicitamente *"Ainda não é simulado"* para MED,
leitura de QR de terceiros e desfecho em duas etapas — sem mencionar `501`.
Ela ainda diz: *"O `txid` começa com `test`"* e documenta os botões
**Simular pagamento** / **Expirar** no painel.

**Terceira fonte — a própria referência da rota (`POST /cobrancas`), tabela de
erros:**

> `501` | `ambiente_indisponivel` | **Não é mais devolvido: a chave `wy_test_`
> emite no ambiente de teste.**

### 5.2 Diagnóstico

A página A está **desatualizada**; a página B e a referência da rota descrevem o
comportamento atual. A evidência mais forte é a nota "não é mais devolvido" na
tabela de erros da rota — é uma correção pontual, escrita por quem mudou o
comportamento. A página A manteve o texto antigo (o mesmo texto justificativa,
"recusa em vez de fingir", é anterior à mudança).

**Contudo, isto é uma inferência documental, não uma medição** — e a regra desta
missão é não confiar em dedução quando dá para medir. **Não foi possível medir**:
não existe credencial `wy_test_` neste ambiente (§5.3).

Portanto o plano trata o comportamento como **desconhecido até a primeira
chamada real** e a etapa 2 do §7 começa exatamente por esse teste — com as duas
respostas aceitáveis previstas (`201` = página B correta; `501` = página A
correta) e um caminho de projeto para cada uma.

### 5.3 Credencial de teste: **não existe** — dependência externa

Verificado, sem revelar conteúdo:

| Verificação | Resultado |
| --- | --- |
| Secrets do projeto `prime-store-sandbox` | apenas `SUPABASE_*`, `DEMO_PAYMENT_ENABLED`, `DEMO_ALLOWED_PROJECT_REFS`, `STORE_URL`, `ALLOWED_ORIGINS`. **Nenhuma `WYVI_*`, `WYVIPAY_*`, `MP_*`** |
| Arquivos `.env*` no repositório e na máquina | só `.env.example` / `.env.functions.example` (sem valores) |
| Variáveis de ambiente do shell | nenhuma relacionada a WyviPay |
| Busca por `wy_test`/`wy_live`/`wyvipay` no repositório | **0 ocorrências** |

**Sem credencial, nada foi gerado, nada foi consultado com autenticação.** O que
*foi* possível medir — e foi medido, de dentro do sandbox Supabase (que tem saída
HTTPS para `api.wyvipay.com.br`; o shell deste container **não** tem):

| Sondagem (sem credencial, sem efeito financeiro) | Resultado observado |
| --- | --- |
| `GET https://api.wyvipay.com.br/api/v1/cobrancas` | `401` `{"erro":{"codigo":"sem_credencial", …}}` — API viva, contrato de erro em português com `codigo` estável e espelho `error.code` |
| `POST /api/v1/cobrancas` `{"valor_centavos":1990}` sem chave | `401 sem_credencial` — o `401` vem **antes** de qualquer validação de corpo |
| `GET /api/v1/webhooks/certificado` (rota pública) | `200`, 1.289 bytes — certificado de cliente mTLS disponível |
| `GET /api/v1/transparency` (rota pública) | `200` com volume público e `atualizado_em` do instante da chamada |

Conclusões úteis que **já** podem ser fixadas no desenho: o ambiente alcança a
API (a integração é testável de dentro do sandbox); o formato de erro é
`erro.codigo` + espelho `error.code`; as rotas públicas respondem sem chave,
então o teste de conectividade **não** exige credencial.

> **Dependência externa registrada (D1):** obter uma chave `wy_test_` no painel
> da WyviPay (*Painel → Desenvolvedor → Chaves de API*). Nada avança da etapa 2
> sem ela. Ela **não** deve ser colada em conversa, relatório, log ou `.env`
> versionado.

---

## 6. Segurança e confiabilidade: como cada proteção é preservada

O desenho abaixo **não relaxa nenhuma** das proteções das missões 06-07. Onde a
WyviPay oferece algo novo, ele é **somado**.

| # | Proteção exigida | Como fica na integração WyviPay |
| --- | --- | --- |
| 1 | **Credenciais só no servidor** | `WYVI_API_KEY` e `WYVI_WEBHOOK_SECRET` **apenas** como secrets de Edge Function. Nunca em `VITE_*` (bundle público), nunca no banco, nunca em log, nunca em resposta de erro. `cors.ts`/`config.ts` continuam sem expor segredo. |
| 2 | **Assinatura HMAC dos webhooks** | `HMAC-SHA256(whsec, "{X-Wyvi-Carimbo}.{corpo cru}")`, comparado em tempo constante contra `v1=` do `X-Wyvi-Assinatura`. Implementação em `wyvipay.ts` reusando `timingSafeEqual` de `mercadopago.ts`. |
| 3 | **Falsas notificações** | Fail-closed em camadas: segredo ausente → `503`; cabeçalho malformado → `401`; HMAC divergente → `401`; carimbo fora de ±300 s → `401`; **e nenhuma linha gravada antes de tudo isso** (comportamento já existente, preservado). Mais: mTLS opcional (`PUT /webhooks/{id} {mtls:true}`) como camada extra — **não** substituta. |
| 4 | **Notificações repetidas** | Dedup por **`X-Wyvi-Entrega` / `id` do corpo** (UUID da entrega, exatamente o que a doc manda usar) — melhor que o `notification_id` sintético atual. Índice único já existe: `payment_events_notification_unique (provider, notification_id)`. Repetição responde `200` sem efeito. Nunca deduplicar por `txid` (o mesmo txid aparece em `cobranca.paga`, `cobranca.estornada`, `split.creditado`). |
| 5 | **Identificação única de cada entrega** | O `id` da entrega é gravado **antes** de processar (a doc insiste nisso), com `payload_hash` para auditoria. |
| 6 | **Idempotência na criação** | Header `Idempotency-Key: order-<order_id>` — usa o id do pedido, não valor aleatório (a doc: *"Use o seu identificador do pedido, não um valor aleatório"*). Atenção: `200` no replay **não revalida o corpo** — logo, nunca reaproveitar a chave com valor diferente; o pedido é a chave, então isso não acontece por construção. |
| 7 | **Conferência de valor e referência** | Dupla: (a) o handler manda `referencia = order.uuid` e reconfere na volta que `txid` → `referencia` casa; (b) `apply_payment_status` **já** bloqueia divergência (`amount_mismatch`, entrega bloqueada, `refund_request` aberto) contra `orders.total_cents`. O valor vem de `valor_centavos` inteiro — sem arredondamento. |
| 8 | **Aprovação duplicada** | Dois cliques no mesmo evento → dedup por entrega; dois caminhos (webhook + polling) chegando juntos → `apply_payment_status` roda sob `SELECT … FOR UPDATE` do pedido e devolve `already_applied`. Preservado sem alteração. |
| 9 | **Aprovação tardia de pedido encerrado** | `apply_payment_status` §0 devolve `ignored_late_approval` (registra evento, não reabre). **Acrescentar** a recusa de evento de teste em produção: se `dados.teste === true` e o ambiente não é sandbox → `404`, sem gravar. |
| 10 | **Liberação de reservas** | `release_order_reservation` chamada em: falha de criação (`502`), `cobranca.expirada`/`cancelada`, e pelo `pg_cron` (`run_reservation_expiry`, 1/min). Nada muda — a WyviPay só troca quem gera o evento. |
| 11 | **Log sem dados sensíveis** | Manter o padrão atual: `notification_id`, `order_id`, `provider_status`, `result`. **Nunca** `wtoken`, `whsec`, `Authorization`, `pagador.documento`, corpo cru, `copia_e_cola`. `payload_hash` SHA-256 no lugar do corpo. |
| 12 | **CORS** | Inalterado: `ALLOWED_ORIGINS` + `STORE_URL`; webhook é chamado servidor-a-servidor (a política de CORS não o afeta). |

### 6.1 Rotação semanal de chaves — procedimento proposto

**O problema, sem eufemismo.** A doc afirma que **todas** as chaves, inclusive a
padrão, são trocadas **toda segunda-feira**, e que a antiga *"para de valer no
mesmo instante"*. E afirma, na mesma seção, que o evento `chave.rotacionada`
*"não leva a chave nova, só o prefixo dela"*, justamente para o webhook não
virar o vazamento. Consequência lógica que precisa ser dita em voz alta:

> **Nenhum webhook entrega a chave nova. A loja não tem como se atualizar
> sozinha.** Se ninguém copiar a chave do painel para o secret da função, a
> integração para na segunda-feira seguinte e o sintoma é `401 chave_invalida`
> em toda criação de cobrança.

Isso é um **processo operacional obrigatório**, não um detalhe de código. Três
caminhos, do melhor ao pior:

**Caminho A (recomendado na V1) — rotação assistida com janela de verificação.**
1. Segunda-feira, 1ª hora: `GET /api/v1/conta` com a **chave atual** (rota `conta:ler`, a mais barata para sondar validade).
   - `200` → a chave ainda vale; nada a fazer, rotina encerra.
   - `401` → a rotação aconteceu.
2. O operador copia a nova chave do painel e roda
   `supabase secrets set WYVI_API_KEY=… --project-ref <ref>` (nunca por chat,
   nunca em arquivo versionado).
3. Disparo do *smoke* de pagamento (leitura): `GET /cobrancas?limit=1`.
   - `200` → chave nova ativa. Registrar horário.
   - `401` → repetir o passo 2 (cola errada, chave antiga, chave de outro ambiente).
4. `chave.rotacionada` é assinado **para servir de gatilho**, não de solução:
   ao recebê-lo, o handler grava `order_events`/tabela própria com o **prefixo**
   recebido e marca uma pendência operacional visível no painel.
5. Enquanto `GET /conta` responder `401`, a loja mantém a cobrança **desligada
   de forma limpa**: `create-order` responde `503 payment_not_configured` e
   **libera a reserva** (comportamento que já existe e está testado). Falhar
   fechado e sem prender estoque é melhor que aceitar pedido que não cobra.

**Caminho B (V2) — "duas chaves, uma viva".** Como a chave padrão não pode ser
revogada e a doc sugere *"gere um segredo novo no painel"*, a loja mantém
**duas** chaves em escopo mínimo e separadas por função:
`WYVI_API_KEY_CHARGES` (só `cobranca:criar`, `cobranca:ler`) e
`WYVI_API_KEY_REFUNDS` (só `reembolso:criar`). A rotação de uma não derruba a
outra; a superfície de cada vazamento é menor. Ainda exige ação humana semanal,
mas o raio de explosão é metade.

**Caminho C (V2, só se a WyviPay confirmar por escrito) — integração com
provisionamento.** Se existir rota de criação de chave via API com escopo
`chave:criar`, a loja poderia gerar a chave nova sozinha. **Não está documentado
nas páginas consultadas** e a doc afirma que a chave é guardada só como hash
("nem a Wyvi consegue ler a chave depois de criada"). **Não planejar em cima
disso** até haver confirmação do fornecedor (dependência **D3**).

**Regras que valem para os três caminhos:**
- Nenhuma chave em `VITE_*`, `app_settings`, `payment_events`, `order_events` ou
  corpo de webhook.
- `create_order`/`checkout` **não** deve requisitar a chave a cada chamada
  pensando que isso resolve: o secret é lido do ambiente a cada execução, então
  a troca de secret propaga sem deploy — **mas não sem alguém trocar o secret**.
- Alarme de calendário semanal + verificação automática (cron diário do
  `pg_cron` que já existe, chamando o `GET /conta` via `verif.http` em um job de
  saúde e gravando só o HTTP status em `job_health`) — isso detecta a rotação
  **antes** do primeiro cliente reclamar. É a peça que transforma um processo
  humano em um processo observável.

---

## 7. Arquitetura proposta

### 7.1 Princípio

**Um adaptador de provedor, duas bordas finas.** Toda a regra de dinheiro
continua no banco (é o que as missões 03-07 construíram e testaram). O que muda
é **quem fala HTTP** e **como o gasto é reconhecido**.

```
Navegador (React)
  │  checkout do carrinho (multi-item)
  ▼
Edge Function `create-order`            ← mesma rota, contrato ampliado
  │  1. create_order(items) → pedido + reserva por item
  │  2. wyvipay.createCharge({valor_centavos, referencia, expiracao_segundos}, Idempotency-Key)
  │  3. attach_payment(txid, copia_e_cola, qrcode, expira_em)
  │     └─ falhou? release_order_reservation() + 502
  ▼
PostgreSQL  (regras intocadas: reserva, apply_payment_status, entrega, disputa)
  ▲
  │  Edge Function `wyvi-webhook`         ← nova, espelha o desenho do mp-webhook
  │    HMAC(carimbo.corpo) → dedup por X-Wyvi-Entrega → GET /cobrancas/{txid}
  │    → apply_payment_status(...)  (fonte de verdade = consulta, não o aviso)
  │
  │  Edge Function `order-status`         ← reconciliação sob demanda, com cache
  ▼
WyviPay  (https://api.wyvipay.com.br/api/v1)
```

### 7.2 Decisões de arquitetura (com o porquê)

| Decisão | Alternativa descartada | Por quê |
| --- | --- | --- |
| **Manter `create-order` como porta de entrada**, ampliando para `items[]` | Criar `create-charge` novo | Uma rota, um caminho de reserva, um caminho de liberação. Duas rotas de cobrança = duas chances de esquecer liberar estoque. |
| **`wyvipay.ts` como módulo único** de acesso ao provedor | Espalhar `fetch` pelos handlers | Hoje o isolamento do MP em um arquivo é o que permitiu esta auditoria ser mecânica. |
| **Webhook novo (`wyvi-webhook`), `mp-webhook` desativado mas não apagado** | Renomear `mp-webhook` | Renomear quebra URLs já cadastradas e apaga histórico de versões. Duas funções coexistem durante a transição; a antiga sai do `config.toml` só no fim. |
| **`provider` como `text` com CHECK ampliado**, não ENUM | Criar ENUM | Migrar para ENUM exige `USING` e trava a tabela; CHECK é ampliável com `NOT VALID` + `VALIDATE`. |
| **Normalizar status no adaptador, não no banco** | Deixar o banco entender `concluida` | O banco já tem o vocabulário certo (`approved`, `refunded`, …) e 186 testes em cima. O adaptador traduz. |
| **Reconciliação com cache temporal** | Reconciliar a cada polling | §4/R7: 200 req/min por rota. Cache de 15 s por pedido derruba o consumo em ~4× sem perder confirmação. |
| **Reembolso: pedir sempre `valor_centavos` explícito** | Usar o padrão (líquido) | §4/R8. O padrão devolve o líquido e cria diferença contábil. |

### 7.3 Mudanças no banco (não destrutivas, todas aditivas)

| Objeto | Mudança | Impacto em dados existentes |
| --- | --- | --- |
| `payments.provider` / `payment_events.provider` | `CHECK` ampliado para `('mercado_pago','demo','wyvipay')` via `ADD CONSTRAINT … NOT VALID` + `VALIDATE` | **nenhum** — linhas antigas continuam válidas |
| `payments` | novas colunas `provider_reference text` (o `referencia`), `provider_txid text` (o `txid`; hoje usado por `provider_payment_id`), `taxa_centavos int`, `liquido_centavos int`, `copia_e_cola text` (se `qr_code` não servir), `ambiente text CHECK ('producao','homologacao')` | colunas anuláveis, nada reescreve o passado |
| `payments_provider_payment_id_key` | **manter**; acrescentar `UNIQUE (provider, provider_payment_id)`? → **não**: o índice atual já é único global, o que é mais rígido. Nada a fazer. | — |
| `order_items` | novas colunas `reservation_id uuid`, `unit_price_cents` já existe | anulável |
| `stock_reservations` | **nova** coluna `order_item_id uuid` + trocar o índice `stock_reservations_one_active_per_order` por `(order_item_id) WHERE status='active'` | pedidos mono-item continuam com 1 reserva ativa; o índice antigo é substituído **sem** apagar linha |
| `deliveries` | remover a unicidade `deliveries_order_id_key` **ou** aceitar 1 entrega por pedido com N unidades (recomendado: manter e entregar N unidades de N produtos na mesma entrega) | **recomendado manter 1:N unidades** — menos mudança, `resolve_delivery` passa a agrupar por produto |
| `payment_events` | nova coluna `provider_delivery_id text` (o `X-Wyvi-Entrega`) + índice único `(provider, provider_delivery_id)` | aditiva |
| `app_settings` | `wyvi_payment_enabled` (bool) para ligar/desligar a cobrança sem deploy | aditiva |
| `job_health` | reuso para o job `wyvi-key-rotation-check` | aditiva |
| enum `payment_status` | **nenhum** valor novo necessário | — |
| enum `order_status` | **nenhum** valor novo necessário | — |

> Nenhuma migração desta lista faz `DROP COLUMN`, `DELETE`, `TRUNCATE` ou
> `ALTER TYPE … DROP VALUE`. Todas são reversíveis com `DROP` do objeto criado.

### 7.4 Configuração (novas variáveis de ambiente)

| Variável | Onde | Obrigatória | Observação |
| --- | --- | --- | --- |
| `WYVI_API_KEY` | secret da Edge Function | sim (para cobrar) | `wy_live_…` em produção, `wy_test_…` em teste. **Rotaciona semanalmente.** |
| `WYVI_WEBHOOK_SECRET` | secret | sim | `whsec_…`, aparece **uma única vez** na criação do destino |
| `WYVI_API_BASE_URL` | secret (opcional) | não | padrão `https://api.wyvipay.com.br/api/v1`; existe só para testes |
| `WYVI_WEBHOOK_URL` | secret | não | se ausente, o `notification_url` não é enviado (o destino é cadastrado na API, não na cobrança) |
| `WYVI_ENVIRONMENT` | secret | sim | `production` \| `test` — **usado para recusar `teste: true`** quando `production` |
| `WYVI_EXPIRATION_SECONDS` | secret (opcional) | não | padrão 1800, casado com `reservation_minutes` |
| `WYVI_ROUTE` | secret (opcional) | não | `white` (padrão) \| `black`. Black exige `pagador.cpf` e custa R$ 0,50 + 6% |
| `WYVI_RECONCILE_MIN_INTERVAL_SECONDS` | secret (opcional) | não | padrão 15 — cache da reconciliação (§4/R7) |

`MP_*` **não** são removidas do código nesta fase: saem de `.env.example` só no
fim, quando `mp-webhook` for desativado (etapa 8). Durante toda a transição, a
ausência de `MP_*` continua produzindo o comportamento seguro já testado.

---

## 8. Lista de arquivos que serão modificados

### 8.1 Novos

| Arquivo | Conteúdo |
| --- | --- |
| `supabase/functions/_shared/wyvipay.ts` | cliente: `createCharge`, `getCharge`, `cancelCharge`, `refundCharge`, `verifyWebhookSignature`, `isTimestampFresh`, `normalizeStatus`, `sanitizeCharge` |
| `supabase/functions/_shared/handlers/wyviWebhook.ts` | borda: assinatura → dedup por entrega → reconferência → `apply_payment_status` |
| `supabase/functions/wyvi-webhook/index.ts` | `Deno.serve` + `withCors`, espelho de `mp-webhook/index.ts` |
| `supabase/functions/_shared/handlers/refund.ts` (ou ação em `admin-api`) | `POST /reembolsos` a partir de `refund_requests` |
| `supabase/migrations/20261…_0034_wyvipay_provider.sql` | ampliação do `CHECK` de `provider` + colunas novas (aditivas) |
| `supabase/migrations/20261…_0035_cobranca_multi_item.sql` | `order_items`/reserva por item, `create_order` multi-item, `apply_payment_status` multi-item, `resolve_delivery` agrupado |
| `supabase/migrations/20261…_0036_reconciliacao_cache.sql` | carimbo de última reconciliação por pedido |
| `tests/unit/fakeWyvi.ts` | dublê do provedor (evolução de `fakeMp.ts`, que **não** é apagado) |
| `tests/db/wyviSignature.ts` | assina `carimbo.corpo` |
| `tests/db/17_wyvi_webhook.test.ts` | webhook: assinatura, carimbo, dedup, teste-em-produção, repetição, ordem |
| `tests/db/18_wyvi_cobranca.test.ts` | criação, idempotência, falha libera reserva, rate limit do provedor |
| `tests/db/19_cobranca_multi_item.test.ts` | pagamento de carrinho de N produtos ponta a ponta |
| `tests/unit/wyvipay_client.test.ts` | contrato HTTP do cliente |
| `docs/wyvipay.md` | equivalente ao `mercado-pago.md`: fluxo, configuração, rotação, checklist |
| `docs/auditoria/missao-08-wyvipay/{RELATORIO,PLANO,ROTACAO-CHAVES}.md` | esta entrega |

### 8.2 Modificados

| Arquivo | Mudança |
| --- | --- |
| `supabase/functions/_shared/config.ts` | bloco `wyvi*` em `AppConfig` + `requireWyvi()`; `mercadoPago*` marcado como legado |
| `supabase/functions/_shared/handlers/createOrder.ts` | aceitar `items[]`; chamar `wyvipay.createCharge`; mapear erro do provedor (`422`/`409`/`429` → mensagens distintas, não um `502` genérico) |
| `supabase/functions/_shared/handlers/orderStatus.ts` | reconciliação via `getCharge` + cache; devolver `qrcode`/`copia_e_cola` |
| `supabase/functions/_shared/handlers/delivery.ts` | agrupar unidades por produto |
| `supabase/functions/_shared/handlers/adminApi.ts` | `refunds.request` (dispara `POST /reembolsos`) |
| `supabase/config.toml` | `[functions.wyvi-webhook] verify_jwt = false`; `mp-webhook` comentado na etapa 8 |
| `.env.example`, `.env.functions.example` | bloco WyviPay; `MP_*` comentado |
| `scripts/smoke-edge-functions.mjs` | smoke de `wyvi-webhook` (assinatura inválida → `401`) |
| `src/services/orderService.ts` | contrato `payment` com `copia_e_cola`/`qrcode`/`expira_em` |
| `src/pages/demo/PaymentCheckoutPage.tsx` → `src/pages/CheckoutPaymentPage.tsx` | reaberto no roteador como checkout do carrinho; textos sem "Mercado Pago" |
| `src/pages/PaymentPage.tsx` | QR em `data:` URI, rótulo sem MP, instrução de copia e cola |
| `src/App.tsx` | rotas `checkout/:id/pagamento` e `/entrega/:token` de volta |
| `src/services/paymentService.ts` | remove o stub, chama `create-order` |
| `docs/{README,backend,seguranca,testes,limitacoes-e-pendencias,painel-admin,PROGRESSO}.md` | atualização factual; `mercado-pago.md` vira histórico com aviso no topo |
| `tests/{05,07,09,10,11,13,14,16}.test.ts`, `tests/unit/crypto_csv_mp.test.ts` | **adaptados, nunca afrouxados**; cada caso que hoje exercita MP ganha par com WyviPay ou é parametrizado |

### 8.3 Deliberadamente **não** modificados

`apply_payment_status` na sua lógica de negócio (só ganha o ramo multi-item),
`release_order_reservation`, `expire_overdue_reservations`, `consume_rate_limit`,
`run_reservation_expiry`, `resolve_delivery` (regra de token), RLS de todas as
tabelas, `_shared/crypto.ts`, `_shared/cors.ts`, `_shared/http.ts`,
`_shared/rateLimit.ts`, identidade visual (`styles.css`, componentes) e todos os
relatórios das missões 03-07.

---

## 9. Plano de implementação em etapas

Cada etapa termina verde (testes + `tsc`) e é reversível por si só. Nenhuma
etapa faz deploy em produção.

| Etapa | Objetivo | Entregável | Critério de saída |
| --- | --- | --- | --- |
| **0** | Decisões de produto | ADR curto: (a) PIX só na V1? (b) rota `white`/`black`? (c) reembolso devolve bruto ou líquido? (d) rotacionar por Caminho A ou B? | 4 respostas escritas, aprovadas por quem responde pela loja |
| **1** | **Cobrança multi-item** (pré-requisito, sem provedor) | migração `0035`: `create_order(items)`, reserva por item, `apply_payment_status` multi-item, `resolve_delivery` agrupado | `tests/db/19` verde; pedido de 2 produtos pago **pela demo** entrega os 2 produtos; nenhum teste antigo quebrado |
| **2** | **Validar `wy_test_`** (a divergência do §5) | script `scripts/verify-wyvi-test-key.mjs` + registro do resultado | `201` → seguir; `501` → contratar chave de produção **sem** ligar cobrança (feature flag) e planejar homologação por `referencia`+`GET` |
| **3** | Cliente WyviPay isolado | `wyvipay.ts` + `tests/unit/wyvipay_client.test.ts` + `fakeWyvi.ts` | contrato HTTP exercitado: URL, bearer, `valor_centavos` inteiro, `Idempotency-Key`, `referencia`, timeout, `429` com `Retry-After`, erro `erro.codigo` |
| **4** | Webhook | `wyviWebhook.ts` + `wyvi-webhook/index.ts` + `tests/db/17` | assinatura válida passa; inválida/velha/ausente → `401` **sem gravar**; repetição → `200 duplicate`; `teste:true` em produção → recusa; `txid` de outra conta → nada muda |
| **5** | Migração de provedor no banco | migração `0034` (CHECK ampliado `NOT VALID` → `VALIDATE`) | `INSERT` com `provider='wyvipay'` aceito; linhas `mercado_pago`/`demo` intactas; `tests/db/01` e `08` verdes |
| **6** | Ligar criação de cobrança | `createOrder.ts` + `config.ts` + feature flag `wyvi_payment_enabled` | com flag desligada: `503` e reserva liberada (igual hoje); com flag ligada e `wy_test_`: `201` com `copia_e_cola` e QR; falha do provedor → `502` + reserva liberada |
| **7** | Frontend de pagamento | checkout do carrinho + página PIX + entrega | 2 produtos pagos → QR → webhook simulado → `/entrega/<token>` com credenciais dos 2 produtos; testes de UI verdes |
| **8** | Desligar o Mercado Pago | `mp-webhook` fora do `config.toml`, `MP_*` comentadas, `mercado-pago.md` marcado como histórico | `mp-webhook` responde igual a rota inexistente; nenhum código chama MP; suíte inteira verde |
| **9** | Reembolso | `POST /reembolsos` a partir de `refund_requests` + `admin-api` | `refund_pending` → reembolso solicitado com `valor_centavos` explícito → `cobranca.estornada` fecha a pendência e revoga a entrega |
| **10** | Rotação + observabilidade | job de saúde da chave (§6.1), alarme de destino inativo (`GET /webhooks/{id}`), conciliação `GET /cobrancas` | rotação simulada (chave inválida) → loja em `503` **sem prender estoque** e alerta na `job_health`; destino desligado é detectado em ≤ 1 h |
| **11** | Publicação | `bundle:functions`, deploy das funções novas, cadastro do destino de webhook, smoke | checklist de publicação (§10) cumprido, nenhuma credencial em log de deploy |

**Ordem obrigatória:** etapa **1 antes** da 6. Cobrar um carrinho com a máquina
de estados mono-produto é a falha mais cara do projeto inteiro (§4/R1).

---

## 10. Testes necessários

### 10.1 Unitários (sem rede, sem banco)

| Caso | Assertiva |
| --- | --- |
| `createCharge` monta o corpo | `valor_centavos` **inteiro** (não `19.90`), `referencia`, `expiracao_segundos` entre 60 e 2.592.000 |
| Idempotência | header presente; repetição devolve `200` e o mesmo `txid` |
| `sanitizeCharge` | descarta `pagador.nome`/`documento`; guarda `txid`, `situacao`, `valor_centavos`, `expira_em`, `copia_e_cola` |
| `qrcode` nulo | cliente não quebra; `copia_e_cola` continua disponível |
| `normalizeStatus` | as 5 situações → `payment_status` do banco (§3.4), com teste para valor desconhecido → `pending` (nunca `approved`) |
| Assinatura | `HMAC(carimbo + "." + corpo)` correto passa; corpo **reordenado** falha (prova que é sobre bytes crus); `v1=` ausente falha; carimbo `±301 s` falha; comparação é tempo constante |
| Erros HTTP | `401`/`403`/`404`/`409`/`422`/`429`/`5xx` mapeados para `ApiError` com `codigo` preservado; `Retry-After` respeitado |
| Timeout | `AbortController` dispara em `timeoutMs`; erro vira `503` interno, não exceção crua |
| Segredos | nenhuma função do módulo lança erro contendo chave, `whsec` ou corpo cru |

### 10.2 Banco / integração (PostgreSQL real, como a suíte atual)

| Caso | Origem do risco |
| --- | --- |
| Webhook com assinatura válida muda pedido para `paid` e cria entrega | fluxo base |
| Assinatura inválida, ausente, cabeçalho incompleto, carimbo velho → **0 linhas** em `payment_events` | R3/fail-closed |
| Mesma entrega 5× → 1 processamento, 4 `{duplicate:true}` | R4 |
| Mesmo `txid` em eventos **diferentes** (`paga`, `estornada`, `split.creditado`) → todos processados | erro clássico de dedup por txid |
| `dados.teste = true` com `WYVI_ENVIRONMENT=production` → recusa, nada muda | R4 |
| Valor divergente → `amount_mismatch`, entrega bloqueada, `refund_request` aberto | preservação |
| Aprovação após `refunded`/`cancelled` → `ignored_late_approval` | preservação |
| Aprovação após expiração, com e sem estoque | preservação |
| `concluida` chegando 2× por caminhos diferentes (webhook + polling) → `already_applied` | dupla aprovação |
| Criação falha (`5xx`, timeout, `429`) → reserva liberada, unidades `available` | liberação |
| Cobrança de **2 produtos** aprovada → 2 reservas consumidas, `deliveries` com as N unidades dos 2 produtos, `resolve_delivery` devolve 2 blocos | R1 |
| Estorno `MED_FRAUDE` → `disputed`, entrega **preservada**; estorno `ORIGINAL` → `refunded`, entrega revogada | §3.4 |
| Reconciliação: 10 pollings em 60 s → ≤ 4 chamadas ao provedor | R7 |
| `anon`/`authenticated` sem acesso a `payments`, `payment_events`, `refund_requests`, `order_items` | preservação |
| `mercadopago`/`demo` continuam aceitos no `CHECK` de `provider` | migração não destrutiva |

### 10.3 Testes de contrato contra o provedor (com `wy_test_`, etapa 2+)

Nunca em produção, nunca com `wy_live_`, sempre com o *Idempotency-Key* do pedido:

1. `POST /cobrancas` → `201`/`200`, capturar `txid` e `copia_e_cola`; conferir `txid` começando com `test`.
2. Repetir com a **mesma** chave → mesmo `txid`, `200`.
3. `GET /cobrancas/{txid}` → `pendente`.
4. **Simular pagamento** no painel → webhook `cobranca.paga` chega **assinado**; validar HMAC localmente, conferir `teste: true` e `ambiente: homologacao`.
5. `POST /reembolsos` na cobrança de teste → `DEVOLVIDO` imediato + `cobranca.estornada`.
6. Valores de borda: `valor_menor_que_a_taxa`, `expiracao_invalida` (59 s e 2.592.001 s), `sem_plano` (se aplicável).
7. `429`: laço controlado até ver `X-RateLimit-Remaining` cair e um `429 limite_atingido` — depois **parar**.
8. Limpeza: **Limpar tudo** no painel de teste (única exclusão real na Wyvi).

### 10.4 Regressão obrigatória (não pode cair)

`npx tsc -b` limpo; frontend 75/75; banco com os **186 casos atuais + novos**,
nenhum caso removido ou afrouxado; `vite build`; `npm run bundle:functions`.
Nesta sessão só os dois primeiros foram possíveis (§1.3).

---

## 11. Dependências que precisam de intervenção humana

| # | Dependência | Por que não posso resolver | Bloqueia |
| --- | --- | --- | --- |
| **D1** | **Chave `wy_test_`** (painel WyviPay → Desenvolvedor → Chaves de API) | É credencial; a missão proíbe criar/alterar credenciais. Não deve ser colada em chat | etapas 2, 3, 6, 7, 9 |
| **D2** | **Conta WyviPay com plano de taxas vigente** e situação ativa | Sem plano, toda cobrança é `409 sem_plano` | go-live |
| **D3** | **Confirmar com o fornecedor**: (a) a divergência do `wy_test_` (§5); (b) se existe provisionamento de chave por API — Caminho C do §6.1 | Só o fornecedor responde | desenho da rotação (etapa 10) |
| **D4** | **Destino de webhook cadastrado** (`POST /webhooks`) e `whsec_` guardado no cofre | O `whsec_` aparece **uma vez**; exige decisão de onde guardar | etapa 4 |
| **D5** | **Decisões de produto da etapa 0** (PIX só? rota? bruto ou líquido? A ou B?) | Decisão comercial, não técnica | todas |
| **D6** | **Processo humano da rotação semanal** com responsável nomeado | §6.1: nenhum webhook entrega a chave nova | operação contínua |
| **D7** | **Servidor PostgreSQL local** para `npm run test:db` | Ausente neste container | verificação automática da suíte de banco |
| **D8** | **Credencial de deploy de Edge Functions** (`supabase` CLI/token) | Ausente no ambiente (herdado da missão 07) | etapas 4, 6, 11 |
| **D9** | **Saída de rede do shell** para `*.supabase.co`/`api.wyvipay.com.br` | Bloqueada neste container; contornada pelo sandbox via `verif.http` (§5.3) | testes de contrato automatizados no CI |
| **D10** | **Decidir sobre o histórico de migrações** (27 registros × 36 arquivos) | Pendência herdada da missão 07; `db push` continua perigoso | aplicação das migrações novas |
| **D11** | **Revisão jurídica** de termos/reembolsos com o novo provedor e das taxas | Conteúdo comercial | publicação |

---

## 12. Critérios objetivos para considerar a integração concluída

Só vale marcar "concluída" quando **todos** forem verdadeiros e demonstráveis:

**Funcional**
1. Pedido com **2 ou mais produtos distintos** é cobrado, pago e entregue com as credenciais dos produtos corretos e quantidades exatas.
2. `POST /create-order` com `Idempotency-Key` repetida devolve a **mesma** cobrança (mesmo `txid`), sem segundo QR.
3. `copia_e_cola` e QR renderizam na UI a partir do `referencia`/`txid` reais do provedor de teste.
4. `cobranca.paga` → pedido `paid`, unidades `sold`, entrega `ready`, em ≤ 10 s do evento (sem contar simulação manual).
5. `cobranca.expirada`/`cancelada` → pedido `expired`/`cancelled` **e** unidades `available`.
6. Polling do `order-status` **não** gera mais que `ceil(tempo/15 s)` chamadas ao provedor por pedido.

**Segurança (cada um com prova no relatório final)**
7. Webhook sem assinatura, com assinatura errada ou com carimbo > 300 s → `401` e **zero** linhas em `payment_events`. Medido antes/depois, no mesmo banco (padrão da missão 07).
8. Repetição da mesma entrega 5× → 1 processamento.
9. Evento com `teste: true` em ambiente de produção → recusado, nenhum estado alterado.
10. Nenhuma ocorrência de `wy_live_`, `whsec_`, `Authorization` ou corpo de webhook em logs, respostas, `payment_events`, `order_events` ou repositório (`grep` na saída de log do deploy é parte do critério).
11. `anon` e `authenticated` continuam **sem** `SELECT`/`EXECUTE` em `payments`, `payment_events`, `refund_requests`, `order_items` e nas funções internas.
12. Valor cobrado em centavos inteiros; divergência de valor bloqueia entrega (teste existente, verde).

**Robustez operacional**
13. Falha do provedor (timeout, `5xx`, `429`) → reserva liberada, estoque íntegro, `502` com mensagem que não vaza credencial.
14. Rotação de chave ensaiada: chave inválida → loja em `503 payment_not_configured` **sem** unidade presa; alerta registrado; recuperação executada pelo procedimento do §6.1 em < 15 min.
15. Destino de webhook desligado por falhas é **detectado** por monitoração em ≤ 1 h.
16. Conciliação diária `GET /cobrancas` não encontra divergência entre `payments.status` e a situação no provedor.

**Documentação e código**
17. `docs/wyvipay.md` publica: fluxo, variáveis, checklist de publicação, procedimento de rotação, tabela de estados e o que fazer em cada erro (`422`, `409`, `429`, `5xx`).
18. Nenhuma referência funcional ao Mercado Pago em código executável; `mercado-pago.md` marcado como histórico.
19. `tsc -b` limpo, `vite build` OK, `bundle:functions` OK, frontend **≥ 75** casos verdes, banco **≥ 186 + novos** casos verdes, **nenhum** caso removido ou afrouxado.
20. Reembolso de um pedido `refund_pending` concluído pelo painel com `valor_centavos` explícito, e `cobranca.estornada` fechando a pendência e revogando a entrega.

---

## 13. O que este relatório **não** afirma

- **Não** afirma que `wy_test_` funciona: a divergência do §5 continua em aberto e só a primeira chamada autenticada resolve (§5.2).
- **Não** afirma que a suíte de banco está verde **hoje**: sem PostgreSQL neste container, apenas o último registro conhecido foi citado (§1.3).
- **Não** afirma que a loja está pronta para produção: seguem pendentes confirmação comercial, entrega multi-produto (etapa 1), e-mail, revisão jurídica e credenciais de deploy (D7-D11).
- **Não** afirma que a rotação semanal está resolvida por software: ela é **processo humano observável**, e o Caminho C depende de confirmação do fornecedor (D3).
- **Não** foi executada nenhuma operação financeira, nenhuma migração, nenhuma alteração de credencial e nenhum `merge`.

---

## Apêndice A — Evidências desta auditoria

| Evidência | Como foi obtida |
| --- | --- |
| `git log -1` → `2a456ee`; árvore limpa | `git status`, `git log` |
| `main` sem base comum com esta branch | `git diff --stat main...HEAD` → *no merge base* |
| `tsc -b` limpo | execução |
| 75/75 no frontend, 9 arquivos | `npx vitest run` |
| Suíte de banco não executável | `which postgres pg_ctl initdb` vazio; `/usr/lib/postgresql` ausente |
| Nenhuma credencial WyviPay/MP | `list_secrets` do projeto; `grep -ril "wy_test\|wy_live\|wyvipay"` → 0; `env` |
| 20 tabelas, enums com `requested`/`not_required` | consultas ao `information_schema`/`pg_enum` no sandbox |
| `payments=3`, `payment_events=2`, `refund_requests=0`, `orders=8` | `SELECT count(*)` no sandbox |
| 8 Edge Functions publicadas (`catalog` v6, `create-order` v7, `order-status` v5, `delivery` v4, `mp-webhook` v5, `admin-api` v4, `demo-payment` v3, `order-request` v1) | `list_edge_functions` |
| API WyviPay viva, erro `401 sem_credencial`, certificado mTLS `200`, transparência `200` | `verif.http_*` de dentro do sandbox |
| Divergência `501` × "cria cobranças" × "não é mais devolvido" | três páginas citadas em §5.1 |
| Rotação semanal e `chave.rotacionada` sem a chave | §"Toda chave é trocada por semana" e catálogo de eventos |
| Contagem de dependências: **23 arquivos de código/config**, **52 menções** em 10 documentos | `grep -rln` / `grep -c` por arquivo |

## Apêndice B — Correspondência de nomes na migração

| Hoje (Mercado Pago) | WyviPay | Onde |
| --- | --- | --- |
| `MP_ACCESS_TOKEN` | `WYVI_API_KEY` | secrets |
| `MP_WEBHOOK_SECRET` | `WYVI_WEBHOOK_SECRET` | secrets |
| `MP_API_BASE_URL` (`api.mercadopago.com`) | `WYVI_API_BASE_URL` (`api.wyvipay.com.br/api/v1`) | `config.ts` |
| `MP_NOTIFICATION_URL` | `WYVI_WEBHOOK_URL` | `config.ts` |
| `mp-webhook` | `wyvi-webhook` | Edge Functions |
| `x-signature` / `x-request-id` | `X-Wyvi-Assinatura` / `X-Wyvi-Entrega` / `X-Wyvi-Carimbo` / `X-Wyvi-Evento` | headers |
| `external_reference` | `referencia` | corpo |
| `provider_payment_id` (id do MP) | `txid` (**não** o `id`) | banco |
| `qr_code_base64` (base64 puro) | `qrcode` (**data URI**) | resposta |
| `approved` | `concluida` | status |
| `charged_back` | `med.encerrado` desfavorável / `estornada` com `natureza=MED_FRAUDE` | status |
| `notification_id` (sintético) | `X-Wyvi-Entrega` (**UUID da entrega**) | dedup |
