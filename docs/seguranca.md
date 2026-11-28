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
  `bytea`) com subchaves HKDF-SHA256 e envelope `versão | IV(12) | ciphertext+tag`.
- **Onde a chave mestra fica (ordem de precedência):**
  1. secret `PRIME_ENCRYPTION_KEY` da Edge Function, se existir;
  2. Supabase Vault, lido por `get_secret_material('prime_store_encryption_key')` —
     função `SECURITY DEFINER` executável **apenas** por `service_role` (migração `0023`);
  3. sem nenhuma das duas, as operações falham fechadas (`503 not_configured`).
  A chave nunca é versionada, impressa em relatório ou enviada ao navegador.
- `credential_fingerprint` = HMAC-SHA256(chave, `email\0senha`), único por
  produto: permite detectar duplicatas **sem** guardar texto claro e sem
  permitir reversão.
- Decifradas somente em dois caminhos:
  1. `delivery` — pedido pago, aprovado e entrega ativa;
  2. `admin-api` → `stock.list` com `includeCredentials` (ação auditada).
- Consultas públicas jamais expõem `account_email_enc`, `account_password_enc`,
  `cost_cents`, `credential_fingerprint` ou ids de unidades.
- Nenhum RPC devolve o ciphertext do link de entrega. `get_order_status` retorna
  apenas `delivery.link_ready`; o ciphertext sai por
  `get_delivery_token_enc(order_id, client_token_hash)` (prova de posse, somente
  entrega ativa, somente `service_role`) e é decifrado na Edge Function — migração `0024`.

## Idempotência de checkout (corrigida na missão 03)

- Identidade = `idempotency_key` + `hash(token privado)` + produto + quantidade.
- Mesma tupla → devolve o pedido original (`idempotent_replay`) e **o mesmo token**.
- Qualquer divergência → `idempotency_conflict` (HTTP 409, mensagem genérica,
  sem revelar dados do pedido). O `client_token_hash` de um pedido existente
  **nunca** é sobrescrito.
- O navegador mantém o token da tentativa (`client_token`) para que o retry
  repita a mesma identidade.

## Chargeback × reembolso (corrigido na missão 03)

| Evento | Pedido | Entrega | Efeitos |
| --- | --- | --- | --- |
| `refunded` | `refunded` | revogada | evento `payment_refunded`, pendências processadas |
| `charged_back` | `disputed` | **preservada** | evento `payment_charged_back`, revisão administrativa obrigatória |
| `approved` atrasado | inalterado | inalterada | `payment_approved_ignored_late` |

Encerramento só por `admin_resolve_dispute` (auditado).

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

## Autorização operacional (perfil diário)

```
allowlist (operator_users.is_active)  →  assert_operator()   (AAL1 basta)
```

- Só funções `ops_*`: estoque e campos operacionais de produto.
- Nenhuma saída contém credencial, fingerprint, custo, pedidos ou clientes.
- `operator_users` sem políticas e sem grants: o cliente não se autopromove.
- Operador nunca passa em `assert_admin()` (nem em AAL2).
- Ver [`perfil-operacional.md`](./perfil-operacional.md).

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
- A view `public_catalog` **não é mais pública** (missão 05): passou a
  `security_invoker = true` e teve o `SELECT` revogado de `anon`/`authenticated`
  (mantido para `service_role`). Antes, `GET /rest/v1/public_catalog` com a chave
  anon devolvia o catálogo direto pelo PostgREST; hoje responde
  `401 42501 permission denied`. O catálogo continua chegando ao navegador pela
  Edge Function `catalog`, que usa `get_catalog()` (`SECURITY DEFINER`).

## CORS por lista de origens (missão 05)

- Nenhuma função responde mais `Access-Control-Allow-Origin: *`.
- `_shared/cors.ts` compara o `Origin` da requisição com a lista explícita
  `ALLOWED_ORIGINS` (segredo) + `STORE_URL`, normalizando para
  `protocolo//host`. Sem `*`, sem regex, sem sufixo curinga.
- Só emite `Access-Control-Allow-Origin` quando há correspondência exata; sempre
  envia `Vary: Origin`.
- Vale para as 7 funções, inclusive `mp-webhook` e `admin-api` (esta continua
  com `verify_jwt: true`; o preflight `OPTIONS` passa, a chamada real exige JWT).
- Consequência operacional: ao trocar de domínio (ou de porta/preview local) é
  obrigatório atualizar `ALLOWED_ORIGINS`, senão o navegador bloqueia a resposta.
- **Sem lista, fecha** — e isso já aconteceu em produção (missão 15): o projeto
  respondia `200` sem `Access-Control-Allow-Origin` e a loja não abria no
  domínio real. O smoke test de servidor não pega esse caso porque `fetch` sem
  `Origin` não precisa de CORS. Hoje a checagem é feita com `Origin` real (ver
  `docs/auditoria/missao-15/RELATORIO.md` §2).

## Corpo de requisição com teto (missão 15)

- `_shared/http.ts` lê o corpo em pedaços e corta em **4 MB**; `Content-Length`
  declarado acima do teto é recusado antes de ler, e um valor mentiroso é
  pego durante a leitura. Resposta: `413 payload_too_large`.
- Os dois webhooks usam o mesmo leitor (`readBodyText`), com a assinatura ainda
  conferida sobre os bytes crus.
- Importação de estoque tem teto de **5.000 linhas** (`MAX_IMPORT_ROWS`): a
  prévia avisa (`truncated`) e o commit recusa com `413 import_too_large`. Antes,
  o limite por campo permitia um CSV de 2 MB com ~60 mil linhas cifradas e
  enviadas num único RPC.

## Cabeçalhos de segurança do site (missão 15)

- Enviados por `vercel.json`: CSP estrita (`script-src 'self'` e
  `style-src 'self'`, **sem** `unsafe-inline`/`unsafe-eval`), HSTS 2 anos com
  preload, `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` e
  `Cross-Origin-Opener-Policy`.
- A UI não usa estilo inline (só classes CSS); há teste que falha se um
  `style={...}` aparecer, porque nesse dia a CSP precisa de `style-src-attr`.
- `no-store` em `/entrega`, `/pedido` e `/admin`; `/assets` com cache imutável.
- `index.html` também declara `referrer=no-referrer` para o token de entrega não
  vazar por `Referer` quando o HTML for servido fora da Vercel.
- `src/lib/publicEnv.ts` só entrega nomes `VITE_*`: nenhuma chave de servidor
  chega ao bundle, mesmo em runtime que exponha `process.env`.

## Integridade e concorrência

- Unidades reservadas com `SELECT … FOR UPDATE SKIP LOCKED` + índice único
  parcial (`stock_reservation_units` ativo por unidade) → nenhuma venda dupla.
- `orders.total_cents = unit_price_cents × quantity` garantido por CHECK.
- `payments` tem índice único parcial para uma cobrança aberta por pedido.
- `delivery_units` é único por unidade → uma credencial não vaza para dois pedidos.

## O que ainda pode ser endurecido

- **Política de senha do Auth (produção):** mínimo 6, CAPTCHA desligado e HIBP
  desligado. O conector não expõe esses campos — ver
  `docs/auditoria/missao-15/DEPENDENCIAS-HUMANAS.md` P4.
- CAPTCHA no checkout se aparecer sinal de abuso (hoje o rate limit por IP +
  reserva de estoque é o que segura).
- Rotação periódica de `PRIME_ENCRYPTION_KEY` com re-cifragem (não implementada;
  trocar a chave hoje inviabiliza credenciais existentes — documentado).
- Alertas sobre falhas de webhook e sobre `refund_pending`.
