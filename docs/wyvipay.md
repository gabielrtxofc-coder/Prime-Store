# WyviPay — PIX na Prime Store (API v2)

> Visão operacional da integração implementada nesta branch. O mapeamento
> completo da API (endpoints, vocabulário, diferenças v1 × v2) está em
> [`docs/wyvipay-integracao.md`](./wyvipay-integracao.md) e na auditoria em
> `docs/auditoria/missao-08-wyvipay/`.

## 1. Como funciona o fluxo

```
Checkout (multi-item) ──► POST /create-order
                          ├─ cria pedido + reserva de estoque (banco, transação única)
                          ├─ POST https://api.wyvipay.com.br/api/v2/cobrancas
                          │    valor em CENTAVOS, Idempotency-Key = order-<uuid>
                          └─ 201 { payment: { qr_code (copia-e-cola), qr_code_base64 } }
                                        │
        cliente paga ───────────────────┤
                                        ▼
WyviPay entrega webhook ──► POST /wyvi-webhook
   X-Wyvi-Assinatura: v1=<hmac>          ├─ valida assinatura (HMAC sobre {carimbo}.{corpo})
   X-Wyvi-Carimbo (unix)                 ├─ dedup por X-Wyvi-Entrega
   X-Wyvi-Entrega (id único)             ├─ RECONSULTA GET /cobrancas/{txid}  ← fonte da verdade
   X-Wyvi-Evento (cobranca.paga)         └─ apply_payment_status (banco): paga → entrega
                                        │
Tela /pagamento (poll a cada 15 s) ─────┘  (mesma reconciliação pela API)
```

Pontos que a implementação garante:

- **A notificação nunca é fonte de verdade.** Antes de confirmar qualquer
  coisa, o handler consulta `GET /cobrancas/{txid}` e confere o valor com o
  pedido (`amount_mismatch` → entrega bloqueada + pendência de reembolso).
- **Idempotência por pedido.** `Idempotency-Key = order-<uuid>`: repetir o
  checkout devolve a MESMA cobrança (replay `200 + Idempotent-Replayed`).
- **Estoque nunca fica preso.** Falha na criação da cobrança → reserva
  liberada na hora; expiração/cancelamento no provedor → liberação via webhook.
- **Entrega só com pagamento legítimo.** Nenhuma outra rota cria entrega; o
  banco valida tudo dentro de `apply_payment_status`.
- **Evento de teste (`dados.teste: true`) em produção é ignorado.**
- **Sem credencial no cliente.** O navegador só fala com as Edge Functions; a
  chave WyviPay vive em secrets do Supabase.

## 2. Variáveis de ambiente (Edge Functions)

| Variável | Obrigatória | Onde vive | O que faz |
|---|---|---|---|
| `WYVI_API_KEY` | Sim (cobrança) | `supabase secrets set` | Chave da API v2 (`wy_test_...`/`wy_live_...`). Ausente → checkout responde `503 payment_not_configured` (ou registra solicitação, se o cliente enviar `fallback_to_request`). |
| `WYVI_WEBHOOK_SECRET` | Sim (webhook) | `supabase secrets set` | `whsec_...` exibido **uma única vez** na criação do destino. Ausente → `wyvi-webhook` responde `503` e não processa nada (fail-closed). |
| `WYVI_ENVIRONMENT` | Não | `supabase secrets set` | `test`/`production`. Se ausente, deriva do prefixo da chave. |
| `WYVI_API_BASE` | Não | `supabase secrets set` | Padrão `https://api.wyvipay.com.br` (mesma URL nos dois ambientes). |

O Mercado Pago (`MP_*`) permanece **legado e EXPLÍCITO**: para usá-lo é
preciso `MERCADO_PAGO_LEGACY_ENABLED=true` **e** `MP_ACCESS_TOKEN`. Sem a
flag, um token MP antigo nunca cria cobrança — a loja responde
`503 payment_not_configured` (configuração pendente) até a `WYVI_API_KEY`
existir. Consulta/notificação de cobranças MP já existentes continua
funcionando (nada é removido). Teste: `tests/db/24_wyvipay_fluxo.test.ts`
(“MP_ACCESS_TOKEN sem WYVI e sem flag legada”).

Template pronto: copie as linhas WyviPay de `.env.functions.example` para
`.env.functions` (ignorado pelo git) e aplique:

```bash
supabase secrets set --env-file .env.functions
```

**Nunca** coloque `WYVI_API_KEY`/`WYVI_WEBHOOK_SECRET` em `.env.example`
preenchido, no código, no frontend, em commit ou em log.

## 3. Cadastro do webhook na WyviPay (AUTOMÁTICO)

Script oficial (idempotente, sem segredos em tela/log/argv):

```bash
WYVI_API_KEY=wy_test_... npm run wyvi:setup            # cria o destino
WYVI_API_KEY=wy_test_... npm run wyvi:setup -- --recreate  # troca o destino
```

O script (`scripts/wyvipay-setup.mjs`):

1. lê a chave **só** por variável de ambiente (ou stdin oculto) — nunca por
   argv, arquivo versionado ou log; chave aparece mascarada;
2. prova os escopos com requisições seguras: `GET /webhooks`
   (`webhook:ler`), `GET /cobrancas/<txid-inexistente>` → 404
   (`cobranca:ler`); a criação em si prova `webhook:criar` (403
   `sem_escopo` é reportado com instrução);
3. lista os destinos e **não duplica** por URL;
4. cria com `cobranca.paga|expirada|cancelada|estornada` (até 5 destinos
   por chave);
5. grava o `whsec_...` (aparece **uma única vez** na resposta) em
   `.env.functions` com permissão 600 — nunca exibido;
6. se a resposta com o segredo se perder, **não há como recuperá-lo**
   (a API não o devolve): `--recreate` exclui o destino da mesma URL e
   cria outro, capturando o novo `whsec_`.

Manual (fallback, mesma receita do painel):

1. **Webhooks → criar destino**; URL exata:
   `https://<REF-DO-PROJETO>.supabase.co/functions/v1/wyvi-webhook`
   (a função está com `verify_jwt = false` — a prova de origem é a
   assinatura HMAC, não o JWT).
2. Eventos: os quatro `cobranca.*`. `chave.rotacionada` é informativo;
   fora da família de cobrança o handler responde `200` sem efeito.
3. Copie o `whsec_...` para o cofre e configure `WYVI_WEBHOOK_SECRET`.

Smoke pós-cadastro: o painel WyviPay permite disparar uma entrega de
teste — resposta esperada `200 {"received":true,...}` (ou `ignored`).

## 4. Estados de pagamento (no modelo existente)

| WyviPay (`situacao`) | `payments.status` / `orders.payment_status` | Efeito |
|---|---|---|
| `pendente` | `pending` | Pedido `pending_payment`, reserva mantida |
| `concluida` | `approved` | Pedido `paid`, estoque consumido, entrega `ready` |
| `cancelada` | `cancelled` | Reserva liberada, pedido encerrado |
| `falhou` (venceu sem pagar) | `cancelled` | Reserva liberada, pedido encerrado |
| `estornada` | `refunded` | Entrega revogada |
| valor divergente | `amount_mismatch` | Entrega bloqueada + `refund_requests` |

Especiais: `requested`/`not_required` = solicitação sem pagamento (nunca vira
venda; `apply_payment_status` bloqueia); `approved` sem estoque →
`refund_pending` (reembolso manual sinalizado).

## 5. Erros que o checkout pode devolver

| Status/código | Significado | O cliente deve |
|---|---|---|
| `202` + `payment_mode: "recovery"` | Criação da cobrança com resultado **incerto** (timeout/5xx): tentativa PRESERVADA (mesma chave, reserva intacta) e cobrança em recuperação | Seguir para `/pagamento` — o PIX aparece em instantes; nada foi cobrado |
| `409 idempotency_conflict` | Mesma chave com outros dados | Recomeçar o checkout (identidade nova) |
| `409 previous_attempt_closed` | Tentativa anterior encerrada sem cobrança | Recomeçar o checkout |
| `409 insufficient_stock` | Estoque acabou no meio do caminho | Revisar o carrinho |
| `502 payment_provider_unavailable` | Recusa DEFINITIVA (validação/limite) — reserva já liberada | Tentar de novo (novo pedido, sem cobrança órfã) |
| `503 payment_not_configured` | Sem `WYVI_API_KEY` (ou sem flag MP legada) e sem fallback | Configurar a chave (equipe) |
| `429 limite_atingido` | Rate limit da API v2 (com `Retry-After`) — reserva liberada | Esperar e tentar de novo |

Classificação de falhas (`classifyWyviFailure` em `_shared/wyvipay.ts`):
**incertas** (5xx, rede/timeout, 409 `idempotencia_conflitante`) → `202`,
reserva e tentativa preservadas; **definitivas** (400/401/403/404/422/429,
409 de limite) → reserva liberada + erro estável. Nunca se declara "não houve
cobrança" sem evidência.

## 6. Rotação de chave (correção importante)

**Fato oficial (docs WyviPay → Guias → Chaves):** chaves criadas por você
**NÃO rotacionam sozinhas**. Só a chave **padrão** da conta gira toda semana
(automaticamente, se tem mais de 7 dias) — e a padrão **não serve para
integração** (não é revogável por escopo, não dá para controlar permissão).
Em resumo:

- `WYVI_API_KEY` pessoal (`wy_test_…`/`wy_live_…`): **fica estável** enquanto
  você não revogar. Não há troca automática semanal (o texto antigo deste
  documento estava ERRADO).
- Se a chave **vazou**: revogue no painel e crie outra (escopos não se
  acrescentam em chave existente — crie já com
  `cobranca:criar|cobranca:ler|webhook:criar|webhook:ler`).
- O evento `chave.rotacionada` é informativo e **não leva a chave** no corpo;
  o handler responde `200 ignored`.
- Checklist de troca real: gere nova chave → `supabase secrets set
  WYVI_API_KEY=…` → rode o smoke (seção 8) → confirme um pagamento de teste
  → revogue a antiga no painel.

## 7. Pendências manuais (sem segredos no texto)

- [ ] **Chave de teste** (criada pelo responsável): colocar em
      `WYVI_API_KEY` via `supabase secrets set` — nunca aqui no chat/repo.
- [ ] **Cadastrar o destino de webhook:** `WYVI_API_KEY=… npm run wyvi:setup`
      (seção 3) — o `whsec_` vai para `.env.functions` (600); depois
      `supabase secrets set --env-file .env.functions`.
- [ ] **Deploy:** `npm run bundle:functions` + `supabase functions deploy`
      (`wyvi-webhook` e `wyvi-worker` são as novas) e deploy do frontend
      (Vercel/estático).
- [ ] **Secrets de produção:** `PRIME_ENCRYPTION_KEY`, `STORE_URL`,
      `ALLOWED_ORIGINS` + os WYVI_* (ver `.env.functions.example`).
- [ ] **Limite de teste:** o ambiente de teste aceita no máximo 50 cobranças;
      troque para a chave `wy_live_` quando sair do sandbox (mesma URL).
- [ ] **Rodar verificações:** `npm test`, `npm run test:db`, `npm run typecheck`,
      `npm run build`, `npm run smoke:functions` (após o deploy).

## 8. Verificações automatizadas

| Comando | Cobre |
|---|---|
| `npm test` | Frontend: checkout → rota `/pagamento`, fallback de solicitação, recuperação 202, QR do copia-e-cola, "Gerando seu PIX" |
| `npm run test:db` | Cliente HTTP WyviPay (idempotência, classificação de falhas, assinatura — `tests/unit/wyvipay.test.ts`) + fluxo completo no banco (`tests/db/24_wyvipay_fluxo.test.ts`: fila, recuperação, corrida, gate de MP legado) + regressão de todas as suítes |
| `npm run smoke:functions` | Pós-deploy: recusas seguras das 10 funções, inclusive `wyvi-webhook` (401/503) e `wyvi-worker` (401 sem service_role) |
| `npm run wyvi:setup` | Cadastro idempotente do destino de webhook + prova de escopos (seção 3) |

## 9. Tabela v1 × v2 (o que mudou na API)

| Assunto | v1 (morta em 16/11/2026) | v2 (usada aqui) |
|---|---|---|
| Base | `.../api/v1` | `https://api.wyvipay.com.br/api/v2` |
| Cobrança | criação em reais/decimal | `valor_centavos` inteiro (1..100.000.000) |
| Idempotência | frágil | `Idempotency-Key` obrigatório, replay `200 + Idempotent-Replayed`, conflito `409` |
| SDK | `@wyvipay/sdk` 1.x (encerra junto) | sem SDK — cliente próprio (`_shared/wyvipay.ts`) |
| Webhook | cabeçalhos antigos | `X-Wyvi-Assinatura: v1=<hex>` sobre `{carimbo}.{corpo}`, janela ±300 s |
| Situações | vocabulário antigo | `pendente/concluida/cancelada/falhou/estornada` |
| QR | — | imagem **só na criação**; consulta devolve só `copia_e_cola` |

## 10. Fila de eventos, recuperação e throttle (automação)

Arquitetura de cobrança das fases de automação (migração `0043`):

```
WyviPay ──POST──▶ wyvi-webhook ──registra──▶ payment_events (fila)
                     │ responde 2xx em <1 s (sem consultar a API)
                     ▼
   ┌── wyvi-worker (service_role) ── claim SKIP LOCKED ──┐
   │                                                     │
   └── poll do order-status (processa a fila do pedido) ─┘
                     │  RECONSULTA GET /cobrancas/{txid}  ← fonte da verdade
                     ▼
        apply_payment_status (banco: pedido/estoque/entrega)
```

- **Resposta rápida:** o webhook só valida assinatura HMAC (corpo cru),
  deduplica por `X-Wyvi-Entrega` (nunca por txid), grava na fila e
  responde `200 {queued:true}`. Retentativas do provedor (1ª/30s/2min/
  10min/1h) viram `duplicate` sem efeito repetido.
- **Processamento fora da requisição:** `wyvi-worker` (JWT `service_role`)
  reivindica eventos vencidos (`claim_wyvi_events`, SKIP LOCKED), reconsulta
  a API, aplica e grava o desfecho; falha transitória → backoff
  15s·2ⁿ (máx ~8h, 10ª tentativa → `failed` visível na fila). O poll de
  `order-status` processa a fila do pedido consultado — recuperação mesmo
  sem worker vivo.
- **Cobrança incerta (create-order):** falha sem evidência de recusa →
  `mark_payment_attempt` (linha `wyvipay` aberta **sem txid** + evento
  `payment_creation_uncertain`) e `202 payment_mode:"recovery"`. O replay
  (checkout ou `order-status`) reenvia a MESMA `Idempotency-Key`
  `order-<uuid>` com `expira_em_segundos` **determinístico** (derivado de
  `created_at`/`reservation_expires_at`): a API devolve a cobrança
  original (replay) e o vínculo completa — nunca uma segunda cobrança.
- **Corrida pagamento-antes-do-vínculo:** `apply_payment_status` recebe o
  provedor explícito (`p_provider='wyvipay'`) — a linha re-inserida nunca
  vira `mercado_pago`. Confirmação que chega antes do vínculo é devolvida
  ao cliente como estado atual (não como erro).
- **Throttle global:** `provider_api_gates` + `try_acquire_provider_slot`
  (15 s por pedido/rota, entre instâncias) substitui o Map em memória;
  `429/503` com `Retry-After` grava `not_before` (janela respeitada).
- **Observabilidade (sem segredos):** eventos
  `payment_creation_uncertain` em `order_events`; filas consultáveis:
  `select event_type, status, last_error from payment_events where
  provider='wyvipay' and status in ('received','failed')`.
