# Segurança

## Princípios

1. **O navegador é hostil.** Preço, quantidade, autorização e estados são sempre
   decididos no servidor. O cliente envia apenas `product_id` e `quantity`.
2. **Nenhuma chave privilegiada no frontend.** O bundle contém somente
   `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`. `service_role` existe apenas
   nas Edge Functions.
3. **Sem escrita direta no banco.** `anon`/`authenticated` não têm GRANT em
   tabela alguma; toda operação passa por funções SQL.
4. **Dados de comprador mínimos.** O e-mail informado vai para o Mercado Pago na
   criação da cobrança e **não é armazenado** pela loja nem registrado em log.
   Nenhum dado de cartão é solicitado.
5. **Defesa em profundidade**: RLS habilitado em todas as tabelas, sem policies
   (nega tudo por padrão), somado à revogação de privilégios.

## Credenciais de estoque

- Cifradas com **AES-256-GCM** (`account_email_enc`, `account_password_enc` como
  `bytea`). A chave (`PRIME_ENCRYPTION_KEY`) existe apenas nas secrets das Edge
  Functions; o banco nunca a vê em claro.
- `credential_fingerprint` = HMAC-SHA256(chave, `email\0senha`), único por
  produto: permite detectar duplicatas **sem** guardar texto claro e sem
  permitir reversão.
- Decifradas somente em dois caminhos:
  1. `delivery` — pedido pago, aprovado e entrega ativa;
  2. `admin-api` → `stock.list` com `includeCredentials` (ação auditada).
- Consultas públicas jamais expõem `account_email_enc`, `account_password_enc`,
  `cost_cents`, `credential_fingerprint` ou ids de unidades.

## Token de entrega

- 32 bytes aleatórios (base64url), gerados pela Edge Function.
- Banco guarda **apenas o hash SHA-256** (`deliveries.token_hash`, único) e, para
  poder reexibir o link ao comprador, o token cifrado (`token_enc`).
- Acesso por `/entrega/<token>`; sem token válido a resposta é
  `410 delivery_unavailable` (não revela se o pedido existe).
- Revogação (`admin_revoke_delivery`) e rotação (`admin_rotate_delivery_token`)
  invalidam o link imediatamente; reembolso processado revoga automaticamente.
- Sem expiração por decisão de produto: o link é permanente até ser revogado.
- `view_count` e `last_viewed_at` são registrados para auditoria.

## Autorização administrativa

```
allowlist (admin_users.is_active) + claim aal = 'aal2'  →  assert_admin()
```

- AAL1 (somente senha) nunca executa ação: o banco responde `mfa_required`.
- JWT válido de usuário fora da allowlist → `forbidden`.
- Toda mutação administrativa grava `admin_audit_log` com `auth.uid()`.
- O painel não guarda decisões de autorização em cache: cada chamada revalida.

## Webhooks

- Assinatura `x-signature` (HMAC-SHA256 do manifest `id:...;request-id:...;ts:...;`)
  validada quando `MP_WEBHOOK_SECRET` existe → `401 invalid_signature`.
- O payload da notificação **nunca** é fonte de verdade: o handler sempre
  consulta o pagamento real na API do Mercado Pago.
- Deduplicação por `payment_events` (`unique(provider, notification_id)`), além
  da idempotência das funções de estado.
- Segredos e tokens nunca aparecem em log; falhas registram apenas ids e status.

## RLS e privilégios

- RLS habilitado nas 17 tabelas, sem policies → leitura/escrita negadas por
  padrão para `anon` e `authenticated`.
- `revoke all on all tables/sequences` para `anon`/`authenticated`;
  `service_role` recebe acesso amplo (server-side apenas).
- `revoke execute on all functions from public, anon, authenticated` e concessão
  explícita: `service_role` (todas), `authenticated` (apenas `admin_*` e
  `is_admin`), `anon` (nenhuma).
- `alter default privileges` revoga o acesso automático em objetos futuros.
- Único objeto público de leitura: a view `public_catalog` (sem custo, sem
  credenciais, somente produtos ativos e com estoque).

## Integridade e concorrência

- Unidades reservadas com `SELECT … FOR UPDATE SKIP LOCKED` + índice único
  parcial (`stock_reservation_units` ativo por unidade) → nenhuma venda dupla.
- `orders.total_cents = unit_price_cents × quantity` garantido por CHECK.
- `payments` tem índice único parcial para uma cobrança aberta por pedido.
- `delivery_units` é único por unidade → uma credencial não vaza para dois pedidos.

## O que ainda pode ser endurecido

- Rate limiting por IP no `create-order` (hoje a validação é por payload e
  disponibilidade) e CAPTCHA se houver abuso.
- Rotação periódica de `PRIME_ENCRYPTION_KEY` com re-cifragem (não implementada;
  trocar a chave hoje inviabiliza credenciais existentes — documentado).
- Alertas sobre falhas de webhook e sobre `refund_pending`.
