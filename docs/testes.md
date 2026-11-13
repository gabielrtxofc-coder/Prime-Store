# Testes

## Missão 06 (revisão independente)

- `tests/db/10_auditoria_missao06.test.ts` (**9**) — catálogo expira reserva
  vencida e devolve a unidade ao estoque sem depender de outro endpoint; reserva
  válida não é tocada; falha na limpeza não derruba o catálogo; replay de pedido
  `failed`/`expired` → `409 previous_attempt_closed` sem duplicar pedido; replay
  de pedido pago → `200 replayed`; identidade nova conclui o checkout depois do
  `409`; `capabilities` do modo demo acompanha `demo_payments_enabled` e o
  segredo do ambiente.
- `src/pages/checkoutRetry.test.tsx` (**2**) — o formulário renova chave e token
  ao receber `previous_attempt_closed` e conclui na segunda tentativa; em falha
  de rede repete a mesma identidade e mantém o carrinho.

Estado atual: `npm run typecheck` limpo · `npm test` **70/70** (9 arquivos) ·
`npm run test:db` **148/148** (12 arquivos, PostgreSQL 18.6 real local) ·
`npm run build` OK.

## Missão 05 (revisão final)

- `tests/db/09_modo_demonstrativo.test.ts` (**10**) — migrações `0026`–`0029`:
  modo desligado por padrão; `demo_approve_payment`/`demo_seed_stock` só para
  `service_role`; aprovação feliz reutilizando `apply_payment_status`
  (`provider='demo'`, entrega `active`, reserva `consumed`, evento
  `demo_payment_approved`, zero eventos de Mercado Pago); prova de posse;
  produto não `is_demo`; **`demo_real_stock_blocked`**; reserva vencida devolvida
  ao estoque; dupla aprovação; desligamento da chave; semeadura fictícia com
  limite.
- `tests/unit/cors.test.ts` (**13**) — normalização de origem, lista
  `ALLOWED_ORIGINS` + `STORE_URL`, `Vary: Origin`, ausência de `*`, preflight
  `204` e chamada de origem estranha sem `Access-Control-Allow-Origin`.
- `tests/db/08_privilegios_funcoes.test.ts` (+2) — `public_catalog` com
  `security_invoker`, sem `SELECT` para `anon`/`authenticated` e com `SELECT`
  para `service_role`.

Estado na Missão 05: `npm run typecheck` limpo · `npm test` **68/68** ·
`npm run test:db` **139/139** (11 arquivos, PostgreSQL 17.11 real local) ·
`npm run build` OK.

### Banco de dados local (como rodar)

O `test:db` precisa de um PostgreSQL acessível. Neste ambiente ele foi iniciado
com o pacote embutido (`@embedded-postgres/linux-x64`) em `/tmp/pgdata` e
`DATABASE_URL=postgresql://postgres@/postgres?host=/tmp/pgdata`. Cada arquivo de
teste recria o schema do zero (`bootstrap_local.sql` + todas as migrações).

## Missão 04 (integração)

- `src/pages/demoPayment.test.tsx` (4) — bloco "Modo de demonstração" só com
  `demo_enabled` do servidor + produto `isDemo`; clique chama `demo-payment` uma
  vez e libera o link após nova consulta; sem botão quando o modo está desligado;
  erro do backend sem detalhe técnico.
- `src/pages/admin/adminDemo.test.tsx` (5) — painel demonstrativo local: opt-in
  explícito, faixa de aviso permanente, ações sem rede, logout.
- `src/pages/catalogBackend.test.tsx` (+1) — selo `DEMO` no produto de
  demonstração, `DISPONÍVEL`/quantidade real no produto real e `ESGOTADO` sem
  compra.

Estado na missão 04: **67 testes de frontend**, `typecheck` e `build` limpos.
`npm run test:db` não rodava então (sem binários de PostgreSQL e sem egress para
baixá-los); a verificação remota foi feita por HTTP contra as funções
publicadas — evidências em
[`auditoria/missao-04/RELATORIO.md`](./auditoria/missao-04/RELATORIO.md).

> `vitest.config.ts` usa `envDir: './tests/env-isolated'` para que o `.env.local`
> de desenvolvimento (backend e painel demonstrativo ligados) não contamine as
> asserções de configuração dos testes.

## Missão 03 (hardening)

- `tests/db/06_hardening_integridade.test.ts` — matriz de idempotência (10) e de
  chargeback/reembolso (10).
- `tests/db/07_create_order_http.test.ts` — idempotência pelo handler HTTP, fallback da
  chave no Vault e ação `orders.resolveDispute` (12).
- `tests/db/08_privilegios_funcoes.test.ts` — 5 contextos de privilégio, `search_path`,
  policies, view pública e ciphertext (12).

Smoke HTTP das funções implantadas: `npm run smoke:functions` (script
`scripts/smoke-edge-functions.mjs`). Requer rede e `SUPABASE_URL`/`SUPABASE_ANON_KEY`;
não foi executado no ambiente da missão (sem egress).

Resultado: **115 testes de banco** + **57 de frontend**. Detalhe em
[`auditoria/missao-03/evidencias/04-testes-executados.md`](./auditoria/missao-03/evidencias/04-testes-executados.md).

## Como rodar

```bash
npm test            # 148 testes de frontend (jsdom, sem banco)
npm run test:db     # 350 testes de banco + unitários
npm run test:all    # tudo (frontend + banco)
npm run typecheck && npm run build
```

### Requisitos do banco local

Os testes de banco **não usam mocks**: eles recriam o schema a partir de
`supabase/migrations` em um PostgreSQL real e chamam as funções SQL com as
mesmas roles e claims de JWT usadas em produção (`anon`, `authenticated`,
`service_role`, `auth.uid()`, `aal`). Os provedores de pagamento são os únicos
componentes simulados (`tests/unit/fakeMp.ts` para o Mercado Pago legado e
`tests/unit/fakeWyvi.ts` para a WyviPay — servidor HTTP com validação estrita,
idempotência e helper de assinatura `X-Wyvi-*`), e eles validam o corpo da
requisição enviada pelo código de produção.

## Suítes

| Arquivo | Testes | Cobre |
| --- | --- | --- |
| `tests/db/01_schema_security.test.ts` | 7 | Migrações do zero, RLS em todas as tabelas, negação de acesso direto para anon/authenticated, EXECUTE revogado das funções internas, view pública sem colunas sensíveis, integridade referencial, unicidade de reserva ativa |
| `tests/db/02_orders_reservations.test.ts` | 12 | Criação de pedido com reserva de 30 min, estoque insuficiente com quantidade real, limite por produto, produto inativo, **preço do cliente ignorado**, idempotência por chave, expiração e liberação, execução concorrente da última unidade (12 tentativas → 1 venda), distribuição de múltiplas unidades, falha no meio da transação, consulta cruzada de pedido negada |
| `tests/db/03_payments_webhooks.test.ts` | 12 | Cobrança PIX com QR/copia-e-cola, valor divergente recusado, aprovação idempotente (unidades vendidas + entrega), notificação fora de ordem, recusa devolve estoque, aprovação perto do vencimento, aprovação após expiração com/sem estoque (reembolso pendente), estorno revoga entrega, dedup de webhooks em paralelo, uma cobrança aberta por pedido |
| `tests/db/04_admin_delivery.test.ts` | 14 | Autenticação → allowlist → AAL2 em cada nível, CRUD de produtos com histórico de preço, importação parcial com relatório e bloqueio de duplicatas, credenciais só sob demanda e auditadas, listas/indicadores/reembolsos, revogação e rotação de entrega, auditoria, entrega de pedido não pago negada, edição de unidade reservada/vendida negada |
| `tests/db/05_end_to_end_flow.test.ts` | 6 | Fluxo completo pelos handlers reais (catalog → create-order → webhook → order-status → delivery), liberação de estoque com o provedor indisponível, `503 payment_not_configured`, validação de payload, webhook com assinatura inválida, escada de autorização administrativa |
| `tests/unit/wyvipay.test.ts` | 25 | Cliente WyviPay v2: POST /cobrancas em centavos com `Idempotency-Key`, replay sem duplicar, conflito `409`, valores/`Idempotency-Key` inválidos recusados antes da rede, falha de comunicação, consulta (sem imagem QR), cancelamento idempotente, reembolso, mapa de situações, assinatura de webhook (válida/errada/adulterada/velha/fora da janela) |
| `tests/db/24_wyvipay_fluxo.test.ts` | 17 | Fluxo ponta a ponta com a WyviPay simulada: privilégios das funções (service_role/anon), cobrança multi-item sem PII, replay sem cobrança dupla, 409 anti-takeover, 502 com reserva liberada, webhook → 401 sem eventos, segredo ausente → 503, aprovação + dedup + entrega, reconsulta manda (pendente/`amount_mismatch`), expiração/cancelamento liberam estoque, `dados.teste` em produção, reconciliação com throttle de 15 s, fallback/503 sem provedor, formato legado mono |
| `tests/unit/crypto_csv_mp.test.ts` | 19 | AES-256-GCM (chave errada, adulteração, IV por mensagem), HMAC fingerprint, entropia dos tokens, SHA-256/tempo constante, CSV (cabeçalho, `;`, BOM, aspas, acentos), validação linha a linha, detecção de duplicatas, mascaramento, cliente do Mercado Pago (PIX 30 min, idempotência, sem PII, erros) |
| `src/services/backend/backend.test.ts` | 10 | Configuração por env, contrato do catálogo (itens inválidos descartados), cliente HTTP (chave anon, sem `service_role`), mapeamento de erros |
| `src/pages/paymentDelivery.test.tsx` | 5 | Página PIX (QR, copia-e-cola, validade), link de entrega ao aprovar, ausência de pedido na sessão, entrega com credenciais mascaradas, link revogado |
| `src/services/checkoutService.test.ts` | 5 | Estratégia do checkout final: cobrança → `kind payment`; sem provedor → `kind request`; `503 payment_not_configured` → fallback `order-request` com a MESMA identidade; outros erros repassados sem mascarar |
| `src/lib/pixQr.test.ts` | 5 | QR nos três formatos (data URI do provedor, base64 puro, copia-e-cola → SVG gerado), BR Code inválido nunca derruba a tela |
| `src/pages/checkoutPayment.test.tsx` | 2 | Checkout PIX: navega para `/pagamento` gravando pedido pendente + comprovante, limpa o carrinho e mantém a identidade no retry de rede |
| `src/pages/catalogBackend.test.tsx` | 3 | Catálogo real substitui o local; falha do backend mantém fallback com aviso; modo demonstração não faz rede |
| `src/App.test.tsx`, `src/lib/cart.test.ts`, `src/context/CartContext.test.tsx` | 39 | Regressão do frontend existente (catálogo, carrinho, checkout demonstrativo, FAQ, acessibilidade) |

## Matriz dos cenários críticos

| Cenário (F10) | Cobertura | Onde |
| --- | --- | --- |
| Corrida pela última unidade | ✅ 12 transações concorrentes, 1 venda | `02` |
| Webhooks repetidos | ✅ reentrega + dedup em paralelo | `03` |
| Aprovação perto da expiração | ✅ reserva ainda viva | `03` |
| Aprovação após a expiração | ✅ realoca estoque; sem estoque → reembolso + entrega bloqueada | `03` |
| Pago sem estoque | ✅ `refund_pending` + `refund_request` + entrega bloqueada | `03` |
| Falha ao criar PIX | ✅ reserva liberada, 502 | `05` |
| Provedor indisponível / timeout | ✅ 503 tratado, estoque liberado | `05`, `unit` |
| Notificações fora de ordem | ✅ não desfazem pagamento aprovado | `03` |
| Recarregar a página no meio do checkout | ✅ pedido pendente em `sessionStorage` + página PIX reconsulta | `paymentDelivery.test.tsx` |
| Consulta repetida da entrega | ✅ `resolve_delivery` idempotente (só contador muda) | `03`, `04` |
| Entrega revogada | ✅ 410 e reembolso processado revoga | `04`, frontend |
| Importação parcial | ✅ válidas entram, inválidas/duplicadas reportadas | `04` |
| Acesso administrativo não autorizado | ✅ 401/403 em cada nível | `04`, `05` |
| Operação administrativa sem MFA | ✅ `mfa_required` (AAL1) | `04`, `05` |
| Falha no meio da transação | ✅ rollback deixa estoque intacto | `02` |
| Adulteração de valores/quantidades pelo cliente | ✅ preço vem do banco; quantidade validada por CHECK/limite | `02`, `unit` |
| Acesso a credenciais de outro pedido | ✅ token próprio por pedido; consulta cruzada negada | `03`, `04` |
| Webhook WyviPay com assinatura inválida | ✅ 401 e ZERO linhas em `payment_events` | `24` |
| Entrega repetida do mesmo evento WyviPay | ✅ dedup por `X-Wyvi-Entrega` → um único efeito | `24` |
| Notificação WyviPay forjada ("paga" com API pendente) | ✅ reconsulta manda; `amount_mismatch` bloqueia entrega | `24` |
| Evento de teste em produção | ✅ `dados.teste` ignorado, pedido intacto | `24` |
| Rotação/queda da API WyviPay | ✅ 502 + reserva liberada; reconciliação com throttle de 15 s | `24`, `unit` |

## O que **não** foi executado de verdade

- **Sandbox real do Mercado Pago**: sem credenciais e sem saída de rede para
  `api.mercadopago.com` neste ambiente. O provedor é simulado, mas o contrato
  HTTP (URL, corpo, idempotency key, expiração) é verificado.
- **Deploy das Edge Functions**: as funções rodam nos testes como handlers com
  PostgreSQL real (Deno/Web APIs), mas o deploy no projeto Supabase depende de
  `supabase` CLI + rede liberada (ver `limitacoes-e-pendencias.md`).
- **MFA real (TOTP)**: o caminho AAL1/AAL2 é testado com claims de JWT; o
  enrolamento TOTP em si depende do Supabase Auth (não testável offline).

Nenhum teste é marcado como `skip`. Nenhuma asserção depende de mock que não
verifique comportamento real.
