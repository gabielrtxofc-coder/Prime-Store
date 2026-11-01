# Missão 06 — revisão independente da Prime Store V1

> Revisão independente do que foi construído nas Missões 01–05, feita na branch
> `arena/08e7eb3e-prime-store` (base `6c51f18`, idêntica ao estado da Missão 05,
> `3b1aa42`). Nada foi mesclado na `main` e nada foi publicado em produção.
>
> Data: 2026-11-01.

## 1. Problemas encontrados

Os três primeiros foram **reproduzidos** (não deduzidos): primeiro em
PostgreSQL local pelos próprios handlers HTTP, depois por HTTP real contra as
Edge Functions **já publicadas** no sandbox `eorlmqolbknrplvdbbtl`
(`catalog` v5, `create-order` v5, `demo-payment` v3).

### A. Reserva vencida prendia a unidade e o próprio catálogo impedia a recuperação

`/catalog` respondia com `available_units` da view, que conta apenas unidades
`available`. A expiração de reserva é **preguiçosa**: só acontece quando alguém
chama `expire_overdue_reservations` (criação de pedido, consulta de status ou
ação administrativa). Não existe `pg_cron` no projeto (confirmado:
`cron.job` → `42P01`), então nada expira por tempo.

Consequência: depois de um checkout abandonado, a unidade ficava `reserved`
para sempre; o catálogo anunciava `availableUnits = 0`; e, como o botão de
compra fica desabilitado quando a disponibilidade é 0, o cliente **não
conseguia** iniciar o pedido que destravaria a reserva. O produto aparecia
esgotado de forma permanente, sem nenhum caminho de recuperação pela interface.

Evidência local (`/home/user/scratch/probe1.ts`, handler real + PostgreSQL real):

```
disponivel inicial: 1
catalogo (1a visita): 0
catalogo (2a visita): 0
depois de get_order_status: 1
```

Evidência por HTTP real no sandbox: pedido `PS-3PXQ75` criado (`201`), e o
`GET /catalog` seguinte continuou anunciando `availableUnits: 10` (a unidade da
reserva seguia presa), mesmo com `stock_units.status = 'reserved'`.

### B. Replay idempotente de um checkout encerrado respondia `200`

Quando o pedido original já tinha morrido (`failed` por falha de cobrança,
`expired` por reserva vencida, ou `cancelled`), repetir a mesma
`idempotency_key` devolvia `200 { order, payment: null, replayed: true }`.

No navegador isso é indistinguível de um checkout vivo: `CheckoutPage` salvava
o pedido pendente, **limpava o carrinho** e navegava para `/pagamento`, onde a
tela mostrava um pedido que nunca poderia ser pago. Pior: como a chave
continuava a mesma, cada novo clique voltava ao mesmo pedido morto.

Evidência por HTTP real: `POST /create-order` → `201` (`PS-3PXQ75`),
`release_order_reservation(..., 'payment_not_configured')` → pedido `failed`;
replay da mesma chave → `200` com `"status": "failed"` e `"replayed": "true"`.

### C. `demo-payment` anunciava o modo demonstrativo mesmo com a chave do banco desligada

`GET /demo-payment` e `action: 'capabilities'` respondiam apenas a partir de
`isDemoSandboxAllowed(config)` (segredo do ambiente + ref do projeto). Com
`app_settings.demo_payments_enabled = false`, a tela oferecia a simulação e o
clique falhava com `demo_disabled` (404) vindo do banco — interface prometendo o
que o servidor recusava.

### D. Webhook aceita notificação sem assinatura quando falta `MP_WEBHOOK_SECRET` (**não corrigido — comportamento intencional**)

Com `MP_WEBHOOK_SECRET` ausente, `POST /mp-webhook` não valida assinatura e
**grava** a linha em `payment_events` (`signature_valid = null`). Reproduzido no
sandbox: um POST anônimo criou o evento `auditoria06-sem-assinatura`
(`status = failed`, `signature_valid = null`).

Não houve alteração de pedido, porque o handler nunca confia no conteúdo da
notificação e sempre reconfere o pagamento no Mercado Pago. Além disso o
comportamento é **coberto por teste existente** (`tests/db/05_end_to_end_flow.test.ts`
chama o handler com `mercadoPagoWebhookSecret: null` e espera `200`), isto é, é
uma decisão da V1 e não uma regressão. Registrado como pendência de *hardening*
na seção 4 — não alterado para não contrariar o comportamento testado.

### E. Verificações que **não** revelaram problema

- **`admin_add_stock_unit` com 6 parâmetros e handler enviando 5**: os dois
  últimos parâmetros têm `DEFAULT` (`p_notes`, `p_import_batch_id`) e o RPC é
  chamado com argumentos nomeados; não há divergência de contrato.
- **Privilégios no banco**: 17 tabelas com RLS, 0 *policies* (negação total),
  `anon` sem `EXECUTE` em nenhuma função, `anon` sem `SELECT` em nenhuma tabela,
  0 funções `SECURITY DEFINER` sem `search_path` fixo, 22 funções `admin_*`
  concedidas a `authenticated` — todas chamando `assert_admin` (verificado por
  `pg_get_functiondef`).
- **CORS**: nenhuma função responde `*`; origem fora da lista recebe `204` sem
  `Access-Control-Allow-Origin`.
- **Modo demonstrativo**: as três travas continuam intactas
  (`DEMO_PAYMENT_ENABLED`, `DEMO_ALLOWED_PROJECT_REFS`,
  `app_settings.demo_payments_enabled`), e `demo_approve_payment` continua
  recusando produto não `is_demo` e unidade real (`demo_real_stock_blocked`).
- **Pagamento real**: `createPixPayment` só é chamado quando existe
  `MP_ACCESS_TOKEN`; sem token, produto `is_demo` recebe `payment: null` +
  `payment_mode: 'demo'` e produto real tem a reserva liberada e recebe `503
  payment_not_configured`. Nenhuma chamada ao provedor é feita no caminho
  demonstrativo.

### F. Riscos de rastreabilidade (não são bugs de código)

- O ledger do sandbox tem **27 migrações** registradas, mas o repositório tem
  **30 arquivos**; `0030_catalogo_view_sem_acesso_publico` não aparece no
  ledger, embora seus efeitos estejam aplicados (`public_catalog` com
  `security_invoker=true` e sem grants para `anon`). Estado correto, histórico
  inconsistente.
- `demoAllowedProjectRefs` tem como padrão (quando a variável não existe) a ref
  do sandbox `eorlmqolbknrplvdbbtl`. Não abre nada por si só — depende de
  `DEMO_PAYMENT_ENABLED=true` — mas é um padrão específico de ambiente dentro
  do código.

### G. Detalhes menores observados, sem correção

- `CartContext.addItem` limita a soma ao `maxQuantity` do produto, mas não ao
  estoque disponível no momento do clique; o servidor recusa com
  `insufficient_stock` e o catálogo é atualizado. Cosmético.
- O par (chave de idempotência, token) vive apenas na montagem da tela de
  checkout: sair e voltar recria as chaves e pode gerar um segundo pedido
  `pending_payment` (a reserva anterior expira em 30 min e volta ao estoque).

## 2. Problemas corrigidos

Correções mínimas, sem mudança de estilo e sem afrouxar nenhuma proteção.

### 2.1 `supabase/functions/_shared/handlers/catalog.ts`

Novo `releaseExpiredReservations(deps)` chama
`expire_overdue_reservations({ p_product_id: null })` **antes** de ler a
disponibilidade. Falha na limpeza não derruba a vitrine: é registrada como
`catalog.expire_failed` e a resposta segue (o catálogo é leitura pública e não
pode depender de escrita).

Por que é seguro: `expire_overdue_reservations` só age em reservas `active` com
`expires_at <= now()` de pedidos `pending_payment`, usa `FOR UPDATE SKIP
LOCKED`, e **não** é executável por `anon`/`authenticated` (o handler chama com
service role). Não altera preço, pedido pago ou reserva válida.

### 2.2 `supabase/functions/_shared/handlers/createOrder.ts`

`CLOSED_ORDER_STATUSES = ['failed','expired','cancelled']`; no replay, antes de
qualquer outra decisão, o pedido nesse estado gera
`409 previous_attempt_closed` (sem devolver dados do pedido antigo). O caminho
de pedido **pago** continua devolvendo `200` com `replayed: true`, para o
comprador chegar ao link de entrega; o caminho de `pending_payment` continua
idempotente.

### 2.3 `src/services/backend/http.ts`, `src/services/orderService.ts`

Mensagem amigável para `previous_attempt_closed` e novo
`isClosedAttemptError()`.

### 2.4 `src/pages/CheckoutPage.tsx`

`idempotencyKey`/`clientToken` passaram de `useRef` para
`useState({ idempotencyKey, clientToken })`. O submit usa `send(attempt)`; em
`previous_attempt_closed` renova **as duas** chaves e repete **uma única vez**.
Falhas de rede continuam repetindo a mesma requisição (o retry seguro que já
existia). O carrinho só é limpo depois do pedido novo.

### 2.5 `supabase/functions/_shared/handlers/demoPayment.ts`

Novo `demoCurrentlyEnabled(deps)`: `isDemoSandboxAllowed(config)` **e**
`rpc('demo_payments_enabled')`. `GET /demo-payment` e `action: 'capabilities'`
passam a refletir o estado real (erro na consulta → `false`, nunca relaxa).
Nenhuma trava foi removida: `approve`/`seed` continuam exigindo
`assertSandbox(deps)` e as funções SQL continuam decidindo.

## 3. Testes executados e resultados

| Verificação | Resultado |
| --- | --- |
| `npx tsc -b` | limpo (exit 0) |
| `npx vitest run` (frontend, jsdom) | **70/70** em 9 arquivos |
| `npx vitest run --config vitest.db.config.ts` | **148/148** em 12 arquivos |
| `npx vite build` | OK |
| `npm run bundle:functions` | 7 bundles gerados |
| HTTP real no sandbox (depois do deploy) | ver abaixo |

Banco: PostgreSQL **18.6** embutido (`@embedded-postgres/linux-x64` em
`/tmp/pgdata`), 30 migrações aplicadas do zero por arquivo de teste.

### Testes novos

- `tests/db/10_auditoria_missao06.test.ts` (**9**) — catálogo expira reserva
  vencida e não toca reserva válida; falha de limpeza não derruba o catálogo;
  replay de `failed`/`expired` → `409` e **uma** linha em `orders`; replay de
  pedido pago → `200 replayed`; depois do `409` uma identidade nova conclui o
  pedido; `capabilities` acompanha a chave do banco e o segredo do ambiente.
- `src/pages/checkoutRetry.test.tsx` (**2**) — o formulário troca chave e token
  ao receber `previous_attempt_closed` e conclui na segunda tentativa; em falha
  de rede repete a **mesma** identidade e mantém o carrinho.

**Contraprova (teste de mutação manual):** com os handlers antigos restaurados
(`git stash` das correções), `10_auditoria_missao06` falha em **5 de 9** casos e
`checkoutRetry` falha no caso do retry — os testes cobrem de fato os defeitos,
não o código novo.

### Integração real com o sandbox

Depois de publicar `catalog` **v6** e `create-order` **v6** (código deste
commit), via HTTP real de dentro do banco (`verif.http`):

| Passo | Resultado |
| --- | --- |
| `GET /catalog` | `200`, 2 produtos |
| `POST /create-order` (mensal, qty 1) | `201`, `PS-3GN6P2`, `payment_mode: demo`, sem cobrança |
| `release_order_reservation` + replay da mesma chave | **`409 previous_attempt_closed`** (antes: `200` com pedido `failed`) |
| `POST /create-order` (nova chave) | `201`, `PS-5NG8C2` |
| `GET /catalog` com a reserva ainda válida | `10` disponíveis (1 unidade reservada) |
| reserva envelhecida por SQL + **um** `GET /catalog` | `11` disponíveis; pedido `expired`, reserva `expired`, `0` unidades reservadas |
| `GET /rest/v1/public_catalog` (verificação de acesso) | negado para `anon` (sem grants) |

### Segurança revalidada no sandbox

`17` tabelas / `0` sem RLS · `0` *policies* · `anon` sem `SELECT` em tabela e sem
`EXECUTE` em função · `22` funções `admin_*` todas com `assert_admin` · `0`
funções `SECURITY DEFINER` sem `search_path` · `public_catalog` com
`security_invoker=true`.

## 4. Problemas que permanecem

1. **Pagamento real não validado** — não existe `MP_ACCESS_TOKEN` /
   `MP_WEBHOOK_SECRET` de teste; o caminho PIX (`createPixPayment`,
   `attach_payment`, webhook assinado) só foi exercitado com provedor simulado.
2. **Webhook aceita notificação não assinada quando não há segredo** (item D).
   Recomendação para produção: exigir `MP_WEBHOOK_SECRET` no *boot* da função
   (falhar fechado) e/ou limitar a taxa de `payment_events`; hoje um POST
   anônimo grava uma linha por requisição.
3. **Sem expiração agendada** — não há `pg_cron`. A expiração continua
   preguiçosa; agora também no catálogo (A), o que resolve o caso do cliente,
   mas painel e relatórios podem ver números defasados até o próximo acesso.
   Recomendação: `pg_cron` + `expire_overdue_reservations` a cada minuto.
4. **Sem proteção de abuso/rate limit** em `catalog`, `create-order`,
   `order-status`, `delivery` e `mp-webhook`.
5. **Administradores reais** — a allowlist e o TOTP existem e são exigidos pelo
   banco, mas não há administradores cadastrados neste ambiente (não alterado
   por falta de autorização explícita).
6. **Modo demonstrativo ligado no sandbox** — precisa ser desligado
   (`DEMO_PAYMENT_ENABLED` e `app_settings.demo_payments_enabled`) antes de
   qualquer ambiente público.
7. **Domínio final** em `STORE_URL`/`ALLOWED_ORIGINS` e revisão de CORS com o
   domínio real.
8. **Ledger de migrações divergente** (F) — recomenda-se reconciliar o
   histórico (`0030` ausente do ledger).
9. **Itens menores (G)** — limite de carrinho vs. estoque e a identidade do
   checkout recriada ao remontar a tela.

## 5. Alterações feitas no GitHub e no Supabase

**GitHub** (branch `arena/08e7eb3e-prime-store`, sem merge na `main`):

- `6c51f18` — importa o estado da Missão 05 (`3b1aa42`) como base da revisão.
- `4bb31d6` — correções A, B (handler + frontend) e C, com os testes novos.
- Removidos arquivos de sondagem temporários (`tests/db/aa_probe_retry.test.ts`,
  `tests/probe/`) antes do commit; nenhum dado de teste foi apagado.

**Supabase (sandbox `eorlmqolbknrplvdbbtl`) — Edge Functions:**

| Função | Antes | Depois | Escopo |
| --- | --- | --- | --- |
| `catalog` | v5 | **v6** | correção A |
| `create-order` | v5 | **v6** | correção B |
| `demo-payment` | v3 | v3 (inalterada) | correção C ainda não publicada |
| `order-status`, `delivery`, `mp-webhook`, `admin-api` | — | inalteradas | — |

Banco: **nenhuma migração, `GRANT`, `REVOKE`, política ou credencial foi
alterada**. Dados criados apenas pela própria auditoria, todos preservados:

- pedido `PS-3PXQ75` (`failed`) e `PS-3GN6P2` (`failed`) — criados e encerrados
  para provar os achados A e B;
- pedido `PS-5NG8C2` (`expired`) — usado para provar a expiração pelo catálogo;
- evento `payment_events.notification_id = 'auditoria06-sem-assinatura'`
  (`failed`) — prova do achado D;
- nenhum pedido, unidade ou evento legítimo foi removido ou reescrito.

## 6. Avaliação independente sobre a qualidade da V1

**O que está sólido.** O modelo de dados é o ponto mais forte: RLS em 17/17
tabelas com negação por padrão, `anon` sem acesso a tabelas e funções, funções
`SECURITY DEFINER` com `search_path` fixo, dinheiro em centavos, reserva com
janela e unicidade, idempotência de pedido com validação de token, entrega por
token privado cifrado e auditoria de ações administrativas. As três travas do
modo demonstrativo são redundantes e o caminho demonstrativo não chama o
provedor de pagamento. A autorização administrativa é decidida no banco
(`assert_admin` + AAL2), nunca no cliente. O frontend não usa chave
privilegiada e não inventa estado de pagamento.

**O que esta revisão expôs.** As falhas estavam nas *bordas* do fluxo, não no
núcleo transacional: uma expiração “preguiçosa” sem gatilho de leitura, um
replay idempotente que confundia “já existe” com “ainda dá para pagar”, e uma
capacidade de UI que não consultava todas as travas. São exatamente os casos que
testes de banco por função tendem a não cobrir, porque dependem da sequência
HTTP + navegador.

**Rigor da suíte.** Boa cobertura de segurança e de integridade transacional
(148 casos de banco/unitários + 70 de frontend), com contraprova de que os
testes novos falham no código antigo. O que faltava era justamente teste de
*sequência de navegação* (checkout → falha → retry), agora coberto.

**Conclusão honesta.** A V1 é um **protótipo funcional e seguro no que diz
respeito a dados e permissões**, com o fluxo demonstrativo comprovado por HTTP
real. Ela **não está pronta para produção**: falta validar pagamento real com
credenciais de teste do Mercado Pago, cadastrar administradores com TOTP,
desligar o modo demonstrativo, configurar domínio/CORS definitivos, agendar a
expiração de reservas e colocar limite de abuso nas rotas públicas. Nenhuma
dessas pendências foi declarada resolvida aqui.

## Como reproduzir

```bash
# frontend
npx tsc -b && npx vitest run && npx vite build

# banco (PostgreSQL local em /tmp/pgdata)
DATABASE_URL='postgresql://postgres@/postgres?host=/tmp/pgdata' \
  npx vitest run --config vitest.db.config.ts

# bundles das Edge Functions
npm run bundle:functions
```

Provas de HTTP real foram feitas de dentro do banco, com `verif.http_post` /
`verif.http_get` (o sandbox do agente não tem saída TLS para
`*.supabase.co`).
