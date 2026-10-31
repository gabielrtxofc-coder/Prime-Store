# Mercado Pago (sandbox, Checkout Transparente)

## Contestação (chargeback) — não é reembolso

`charged_back` **não** é tratado como devolução concluída: o pedido vai para `disputed`,
a entrega é preservada, um evento `payment_charged_back` é registrado e o painel assume a
decisão (`admin_resolve_dispute`: reembolsar, reverter a contestação ou manter reembolso
pendente). A aprovação que chega depois de um pedido encerrado é registrada como
`payment_approved_ignored_late` e não reabre nada.

## O que está implementado

- Integração pelo **Checkout Transparente / Payments API** (`POST /v1/payments`)
  com `payment_method_id: "pix"`, dentro de `supabase/functions/_shared/mercadopago.ts`.
- `create-order` cria pedido + reserva no banco **antes** de chamar o provedor e,
  se a cobrança falhar, libera a reserva imediatamente (`payment_creation_failed`)
  devolvendo `502 payment_provider_unavailable`.
- Sem `MP_ACCESS_TOKEN`, o checkout responde `503 payment_not_configured` e
  **nenhuma** unidade permanece reservada.
- `order-status` reconcilia o pagamento direto na API do Mercado Pago
  (`GET /v1/payments/{id}`), independentemente de webhook.
- `mp-webhook` valida `x-signature` (HMAC do manifest
  `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`) quando `MP_WEBHOOK_SECRET`
  está configurado, registra o evento (dedup por `notification_id`) e **sempre**
  reconfere o pagamento real antes de mudar estado.
- Idempotência: repetição da notificação não duplica efeitos; eventos fora de
  ordem não rebaixam um pedido pago.

## Fluxo

```
1. frontend  POST /create-order { product_id, quantity, payer_email }
2. handler   gera client_token (alta entropia) → guarda só o hash
3. banco     create_order(): reserva unidades (30 min) e cria pedido
4. handler   POST /v1/payments (PIX, expiração 30 min, external_reference=order_id)
5. banco     attach_payment(): guarda ids, QR code, copia-e-cola e expiração
6. frontend  exibe QR + copia-e-cola e consulta /order-status a cada 5 s
7. MP        envia webhook → handler valida assinatura e consulta o pagamento real
8. banco     apply_payment_status(): unidades → sold, pedido pago, entrega gerada
9. frontend  recebe delivery.url e mostra o link privado de entrega
```

## Aprovação tardia

Se o pagamento for aprovado depois da expiração da reserva:

1. `apply_payment_status` tenta realocar unidades **disponíveis** do mesmo produto.
2. Se conseguir, o pedido é pago normalmente e a entrega é criada.
3. Se não houver estoque, o pedido vai para `refund_pending`, a entrega fica
   **bloqueada** e um `refund_request` é aberto para decisão administrativa.
4. O reembolso é **manual** no Mercado Pago; o painel apenas autoriza, marca como
   processado (o que revoga o link de entrega) ou recusa.

## Configuração necessária (sandbox)

1. Conta Mercado Pago de teste + aplicação do tipo *Checkout Transparente*.
2. Chave PIX cadastrada na conta de teste (obrigatório para gerar cobrança PIX).
3. `MP_ACCESS_TOKEN` = token da aplicação de teste (`TEST-...`).
4. `MP_WEBHOOK_SECRET` = assinatura secreta da aplicação.
5. Webhook apontando para
   `https://<REF>.supabase.co/functions/v1/mp-webhook`, tópico **Pagamentos**,
   evento **payment.updated** (e `payment.created`).
6. `MP_NOTIFICATION_URL` e `STORE_URL` definidos nas secrets.

### Validação manual no sandbox (checklist)

- [ ] `POST /create-order` retorna QR e `ticket_url`
- [ ] Pagar com a conta de teste (PIX de teste do MP)
- [ ] Webhook chega, assinatura válida, `payment_events` com `signature_valid = true`
- [ ] Pedido vira `paid`, unidades `sold`, entrega `ready`
- [ ] Link `/entrega/<token>` mostra exatamente as unidades compradas
- [ ] Webhook duplicado retorna `{ duplicate: true }` sem efeitos extras
- [ ] Notificação `pending` após `approved` não altera o pedido
- [ ] Pagar após expirar (esperar 30 min ou forçar `reservation_expires_at`)
      → reembolso pendente ou entrega com novas unidades

## Pendências conhecidas

- **Não foi possível executar o fluxo real neste ambiente**: o sandbox não tem
  saída de rede para `api.mercadopago.com` e não há credenciais de teste
  disponíveis. Os testes cobrem o contrato do provedor com um servidor fake
  (`tests/unit/fakeMp.ts`) e o handler completo contra PostgreSQL real.
- O Mercado Pago recomenda a **API de Orders** para integrações novas. A V1 usa
  a Payments API (estável e suficiente para PIX); a migração fica registrada como
  próximo passo em `limitacoes-e-pendencias.md`.
- Reembolso não é automatizado por decisão de escopo (sempre manual e
  autorizado no painel).
