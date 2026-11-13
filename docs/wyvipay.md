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

O Mercado Pago (`MP_*`) permanece **congelado**: só é usado quando
`WYVI_API_KEY` não existe (compatibilidade). Nenhuma regra dele foi removida.

Template pronto: copie as linhas WyviPay de `.env.functions.example` para
`.env.functions` (ignorado pelo git) e aplique:

```bash
supabase secrets set --env-file .env.functions
```

**Nunca** coloque `WYVI_API_KEY`/`WYVI_WEBHOOK_SECRET` em `.env.example`
preenchido, no código, no frontend, em commit ou em log.

## 3. Cadastro do webhook na WyviPay (manual)

1. No painel WyviPay: **Webhooks → criar destino** (até 5 por chave).
2. **URL (endereço exato):**

   ```
   https://<REF-DO-PROJETO>.supabase.co/functions/v1/wyvi-webhook
   ```

   `<REF-DO-PROJETO>` é a ref do projeto Supabase (Dashboard → Settings →
   General). A função já está com `verify_jwt = false` (validação é a
   assinatura HMAC, não o JWT).
3. **Eventos (assine pelo menos):** `cobranca.paga`, `cobranca.expirada`,
   `cobranca.cancelada`, `cobranca.estornada`. (`webhook.teste` e
   `chave.rotacionada` são informativos; fora da família de cobrança o
   handler responde `200` sem efeito.)
4. Ao criar o destino o painel mostra o `whsec_...` **uma única vez** —
   copie para o cofre da equipe e configure em `WYVI_WEBHOOK_SECRET`.
5. O painel permite disparar uma entrega de teste: com a chave de teste e o
   segredo certos, a resposta deve ser `200 {"received":true,...}` (ou
   `ignored` para eventos sem efeito).

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
| `409 idempotency_conflict` | Mesma chave com outros dados | Recomeçar o checkout (identidade nova) |
| `409 previous_attempt_closed` | Tentativa anterior encerrada sem cobrança | Recomeçar o checkout |
| `409 insufficient_stock` | Estoque acabou no meio do caminho | Revisar o carrinho |
| `502 payment_provider_unavailable` | WyviPay indisponível — reserva já liberada | Tentar de novo (novo pedido, sem cobrança órfã) |
| `503 payment_not_configured` | Sem `WYVI_API_KEY` e sem fallback | Configurar a chave (equipe) |
| `429 limite_atingido` | Rate limit da API v2 (com `Retry-After`) | Esperar e tentar de novo |

## 6. Rotação de chave (semanal, segundas)

A WyviPay rotaciona chaves às segundas. Novas chamadas com a chave antiga são
recusadas a partir da troca automática. Checklist de rotação (manual, ~2 min):

1. Gere a nova chave no painel (a antiga vira `wy_antiga_...` por 10 minutos).
2. `supabase secrets set WYVI_API_KEY=wy_...` (ou atualize `.env.functions`
   e rode `supabase secrets set --env-file .env.functions`).
3. Confirme com o smoke (seção 8): `create-order` deixa de responder
   `503 payment_not_configured`.
4. O painel também emite o evento `chave.rotacionada` (o handler responde
   `200 ignored` — é só um aviso; nada quebra).

## 7. Pendências manuais (sem segredos no texto)

- [ ] **Chave de teste** (criada pelo responsável): colocar em
      `WYVI_API_KEY` via `supabase secrets set` — nunca aqui no chat/repo.
- [ ] **Criar o destino de webhook** (seção 3) e guardar o `whsec_...` no
      cofre; configurar `WYVI_WEBHOOK_SECRET`.
- [ ] **Deploy:** `npm run bundle:functions` + `supabase functions deploy`
      (a `wyvi-webhook` é a nova) e deploy do frontend (Vercel/estático).
- [ ] **Secrets de produção:** `PRIME_ENCRYPTION_KEY`, `STORE_URL`,
      `ALLOWED_ORIGINS` + os WYVI_* (ver `.env.functions.example`).
- [ ] **Limite de teste:** o ambiente de teste aceita no máximo 50 cobranças;
      troque para a chave `wy_live_` quando sair do sandbox (mesma URL).
- [ ] **Rodar verificações:** `npm test`, `npm run test:db`, `npm run typecheck`,
      `npm run build`, `npm run smoke:functions` (após o deploy).

## 8. Verificações automatizadas

| Comando | Cobre |
|---|---|
| `npm test` | Frontend: checkout → rota `/pagamento`, fallback de solicitação, QR do copia-e-cola (`src/lib/pixQr.test.ts`), serviço de checkout |
| `npm run test:db` | Cliente HTTP WyviPay (idempotência, valores, assinatura — `tests/unit/wyvipay.test.ts`) + fluxo completo no banco (`tests/db/24_wyvipay_fluxo.test.ts`) + regressão das 23 suítes existentes |
| `npm run smoke:functions` | Pós-deploy: recusas seguras das 9 funções, inclusive `wyvi-webhook` (401/503) |

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
