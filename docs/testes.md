# Testes

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
npm test            # 57 testes de frontend (jsdom, sem banco)
npm run test:db     # 70 testes de banco + unitários
npm run test:all    # tudo (127 testes)
npm run typecheck && npm run build
```

### Requisitos do banco local

Os testes de banco **não usam mocks**: eles recriam o schema a partir de
`supabase/migrations` em um PostgreSQL real e chamam as funções SQL com as
mesmas roles e claims de JWT usadas em produção (`anon`, `authenticated`,
`service_role`, `auth.uid()`, `aal`). O provedor de pagamento é o único
componente simulado (`tests/unit/fakeMp.ts`), e ele valida o corpo da requisição
enviada pelo código de produção.

## Suítes

| Arquivo | Testes | Cobre |
| --- | --- | --- |
| `tests/db/01_schema_security.test.ts` | 7 | Migrações do zero, RLS em todas as tabelas, negação de acesso direto para anon/authenticated, EXECUTE revogado das funções internas, view pública sem colunas sensíveis, integridade referencial, unicidade de reserva ativa |
| `tests/db/02_orders_reservations.test.ts` | 12 | Criação de pedido com reserva de 30 min, estoque insuficiente com quantidade real, limite por produto, produto inativo, **preço do cliente ignorado**, idempotência por chave, expiração e liberação, execução concorrente da última unidade (12 tentativas → 1 venda), distribuição de múltiplas unidades, falha no meio da transação, consulta cruzada de pedido negada |
| `tests/db/03_payments_webhooks.test.ts` | 12 | Cobrança PIX com QR/copia-e-cola, valor divergente recusado, aprovação idempotente (unidades vendidas + entrega), notificação fora de ordem, recusa devolve estoque, aprovação perto do vencimento, aprovação após expiração com/sem estoque (reembolso pendente), estorno revoga entrega, dedup de webhooks em paralelo, uma cobrança aberta por pedido |
| `tests/db/04_admin_delivery.test.ts` | 14 | Autenticação → allowlist → AAL2 em cada nível, CRUD de produtos com histórico de preço, importação parcial com relatório e bloqueio de duplicatas, credenciais só sob demanda e auditadas, listas/indicadores/reembolsos, revogação e rotação de entrega, auditoria, entrega de pedido não pago negada, edição de unidade reservada/vendida negada |
| `tests/db/05_end_to_end_flow.test.ts` | 6 | Fluxo completo pelos handlers reais (catalog → create-order → webhook → order-status → delivery), liberação de estoque com o provedor indisponível, `503 payment_not_configured`, validação de payload, webhook com assinatura inválida, escada de autorização administrativa |
| `tests/unit/crypto_csv_mp.test.ts` | 19 | AES-256-GCM (chave errada, adulteração, IV por mensagem), HMAC fingerprint, entropia dos tokens, SHA-256/tempo constante, CSV (cabeçalho, `;`, BOM, aspas, acentos), validação linha a linha, detecção de duplicatas, mascaramento, cliente do Mercado Pago (PIX 30 min, idempotência, sem PII, erros) |
| `src/services/backend/backend.test.ts` | 10 | Configuração por env, contrato do catálogo (itens inválidos descartados), cliente HTTP (chave anon, sem `service_role`), mapeamento de erros |
| `src/pages/paymentDelivery.test.tsx` | 5 | Página PIX (QR, copia-e-cola, validade), link de entrega ao aprovar, ausência de pedido na sessão, entrega com credenciais mascaradas, link revogado |
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
