# WyviPay — mapeamento de integração (síntese para preparação de lançamento)

> **Missão 11, Grupo F / Task 016.** Documento **sintético**: consolida o estado
> atual dos pagamentos da Prime Store e o mapeamento de integração com a
> WyviPay a partir da auditoria da Missão 08 (b)
> (`docs/auditoria/missao-08-wyvipay/RELATORIO.md`, 702 linhas).
>
> **Escopo respeitado:** nenhum endpoint novo foi inventado — todas as rotas
> citadas aqui estão registradas no RELATORIO da Missão 08 (§3.1, §5.3, §7.4).
> **Nada foi implementado:** nenhum código de integração foi escrito, nenhuma
> migração criada ou aplicada para a WyviPay, nenhuma credencial criada/lida,
> nenhuma cobrança emitida, nenhum valor movimentado.
>
> Data da síntese: 2026-11-09. **Atualização Missão 13 (2026-11-10):**
> estado remoto revalidado — 8/8 funções publicadas, migrações 0034–0038 e
> 0039–0041 confirmadas no histórico, secrets sem `MP_*`/`WyviPay`, D7
> recuperado da fonte (§6.1), §6.2 e §8 atualizados. Nenhum endpoint novo
> foi adicionado nem nada implementado.
>
> **Atualização 2026-11-13 — integração IMPLEMENTADA nesta branch:** migração
> `0042` (CHECKs `wyvipay`, `attach_order_buyer`), cliente `_shared/wyvipay.ts`
> (API v2), `create-order` multi-item com cobrança, `wyvi-webhook` (assinatura
> + dedup + reconsulta), reconciliação em `order-status`, rota `/pagamento` no
> frontend e suítes novas (`tests/unit/wyvipay.test.ts`,
> `tests/db/24_wyvipay_fluxo.test.ts`). O operacional (env, cadastro do
> webhook, checklist, estados, rotação, v1×v2) está em
> [`docs/wyvipay.md`](./wyvipay.md). As seções abaixo continuam válidas como
> mapeamento/auditoria — o estado "nada implementado" descreve o momento da
> síntese.

---

## 1. Estado atual dos pagamentos (auditado na Missão 11)

| Componente | Estado real hoje | Evidência |
| --- | --- | --- |
| Fluxo público vivo | `POST /order-request` → `create_purchase_request()` → `orders.status='requested'`, `payment_status='not_required'`. **Sem cobrança, sem reserva de estoque, sem entrega** no caminho do comprador | `supabase/functions/_shared/handlers/orderRequest.ts`; migração `0033` |
| Rota de pagamento no frontend | **Fora do roteador** desde a Missão 07/08: `PaymentCheckoutPage` está em `src/pages/demo/`, sem rota em `src/App.tsx` | `src/App.tsx` (grep `PaymentCheckoutPage` → 0) |
| `paymentService.ts` | Stub órfão sem chamadores (devolve `not_configured`; nenhum componente o importa) | grep de importadores → 0 |
| Edge Function `create-order` | **Fail-closed**: sem `MP_ACCESS_TOKEN`, libera a reserva (`release_order_reservation`, motivo `payment_not_configured`) e responde `503`; exceção só para produtos `is_demo` em ambiente demo autorizado (`payment_mode: 'demo'`) | `handlers/createOrder.ts:159-185` |
| Cliente Mercado Pago | Código presente e íntegro (`_shared/mercadopago.ts`, 274 linhas; `handlers/mpWebhook.ts`) — **congelado, sem consumidor vivo, sem secrets configurados** (registro M08: nenhum `MP_*` no sandbox) | leitura do código; `docs/auditoria/missao-08-wyvipay/RELATORIO.md` §1.1 |
| Pagamento simulado (demo) | `demo-payment` existe: `capabilities`/`approve`/`seed`; desligado por padrão (`DEMO_PAYMENT_ENABLED` + allowlist de ref); aprova só produtos/unidades `is_demo` via `demo_approve_payment` → `apply_payment_status` | `handlers/demoPayment.ts` |
| Máquina de estados | `apply_payment_status` (migração `0019`) é **agnóstica de provedor**: approved/rejected/cancelled/refunded/charged_back/amount_mismatch, aprovação tardia, pago-sem-estoque, disputa | `0019_chargeback_x_reembolso.sql` |
| Modelo multi-item | **Resolvido no banco** pela migração `0034` (`create_order_multi`, `reserve_stock_units_multi`, `allocate_late_units_multi`, `create_order_delivery`, `order_summary_multi`) e `0035` (`apply_payment_status` multi-item: alocação por item + entrega que cobre todos os itens) | cabeçalhos de `0034`/`0035`; ver §4, R1 |
| `payments.provider` | `CHECK` restrito a `('mercado_pago','demo')` (migrações `0007`/`0026`) — **não** inclui `wyvipay` | grep das migrações |
| Credenciais | Nenhuma `MP_*` nem `WYVI_*` configurada (registro M08); nenhum segredo no repositório (varredura M10) | `RELATORIO.md` §5.3; `docs/missao-10-reconciliacao-final.md` |
| Presença da WyviPay no código | **Zero ocorrências** de `wy_test_`/`wy_live_`/`wyvipay` no repositório | `RELATORIO.md` §5.3 |
| Testes de pagamento | 16 arquivos de banco + dublês `tests/unit/fakeMp.ts` e `tests/db/mpSignature.ts`; suíte verde na Missão 13 (`npm test` 136/136; `test:db` 308/308) | execução Missão 13 |

**Conclusão da auditoria:** não há fluxo de cobrança vivo a substituir — a
integração WyviPay **reabriria** um fluxo deliberadamente congelado (vantagem:
nenhum cliente em produção a quebrar; risco: o código congelado envelheceu
relativamente ao modelo multi-item — mitigado por `0034`/`0035`, ver R1).

---

## 2. Mapeamento de contrato (WyviPay)

> **Fonte única:** `RELATORIO.md` §3.1/§3.3/§3.4 e Apêndice B (documentação
> consultada pela Missão 08 em 2026-11-08: `api-reference`, `guides/pix`,
> `guides/webhooks`, `guides/ambiente-de-teste`, rotas `payment-pix/create`,
> `payment-pix/get`, `refunds/create`). Nenhum endpoint abaixo foi criado ou
> presumido nesta missão.

### 2.1 Rotas WyviPay citadas na auditoria (não inventadas)

| Rota citada | Uso na integração | Onde a rota aparece na fonte |
| --- | --- | --- |
| `POST /api/v1/cobrancas` | criar cobrança PIX | RELATORIO §3.1, §5.3 (sondagem `401 sem_credencial`) |
| `GET /api/v1/cobrancas/{txid}` | reconferência (fonte de verdade) | RELATORIO §3.1, §7.1 |
| `GET /api/v1/cobrancas` (ex.: `?limit=1`) | smoke de leitura / reconciliação | RELATORIO §6.1, etapa 2 |
| `DELETE /cobrancas/{txid}` | cancelar cobrança | RELATORIO §3.1 |
| `POST /reembolsos` | reembolso (capacidade nova) | RELATORIO §3.1, §7.4 |
| destino `POST /webhooks` | cadastrar destino + `whsec_` | RELATORIO §3.1 (D4), §6 |
| `GET /webhooks/{id}` | monitorar destino (20 falhas → inativo) | RELATORIO §4/R5, §9 etapa 10 |
| `GET /api/v1/conta` | sonda barata de validade da chave (rotação) | RELATORIO §6.1 |
| `GET /api/v1/webhooks/certificado` | certificado mTLS (público, medido `200`) | RELATORIO §5.3 |
| `GET /api/v1/transparency` | rota pública (medida `200`) | RELATORIO §5.3 |

Base citada: `https://api.wyvipay.com.br/api/v1` (RELATORIO §5.3/§7.4).

### 2.2 Necessidade × contrato

| Necessidade | Mercado Pago (hoje) | WyviPay | Veredito |
| --- | --- | --- | --- |
| Criar cobrança PIX | `POST /v1/payments` | `POST /api/v1/cobrancas` | direto |
| Valor | `transaction_amount` decimal | `valor_centavos` **inteiro** | melhor — casa com `total_cents` |
| QR Code | `qr_code_base64` + `ticket_url` | `qrcode` (**data URI**, pode vir `null`) + `copia_e_cola` | adaptar render |
| Expiração | `date_of_expiration` (mín. 30 min) | `expiracao_segundos` (60…2.592.000; 1800 s atende) | direto |
| Referência | `external_reference` | `referencia` (volta em consulta **e** webhook) | melhor |
| Idempotência | `X-Idempotency-Key` | `Idempotency-Key` (repetição → `200`, não `201`) | direto |
| Webhook | `x-signature: ts=…,v1=…` sobre manifesto | `X-Wyvi-Assinatura: v1=<hmac>` sobre **`{X-Wyvi-Carimbo}.{corpo cru}`** + `X-Wyvi-Entrega`/`X-Wyvi-Evento` | **reescrever verificação** (§2.4) |
| Dedup | `notification_id` sintético | `id` da entrega (UUID explícito) | melhor |
| Reembolso | manual no painel do provedor | `POST /reembolsos` + eventos `reembolso.*` | capacidade nova |
| Disputa | `charged_back` | `med.*` (`desfecho`) e `cobranca.estornada.natureza=MED_FRAUDE` | mapear → `disputed` |
| Rate limit | não documentado | **200 req/min por rota e por chave**; `429 limite_atingido` | planejar orçamento |

### 2.3 Mapeamento de status (WyviPay → `payment_status`)

| Situação/evento | `payment_status` | Caminho em `apply_payment_status` |
| --- | --- | --- |
| `pendente` | `pending` | só reflete |
| `concluida` / `cobranca.paga` | `approved` | consome reserva / realoca / pago-sem-estoque |
| `falhou` / `cobranca.expirada` | `cancelled` | libera reserva |
| `cancelada` / `cobranca.cancelada` | `cancelled` | libera reserva |
| `estornada` (`natureza=ORIGINAL`) / `cobranca.estornada` | `refunded` | revoga entrega |
| `estornada` (`natureza=MED_FRAUDE`) / `med.encerrado` desfavorável | `charged_back` → `disputed` | entrega **preservada** |
| `reembolso.solicitado` / `reembolso.falhou` | *sem transição* | evento/notes |
| `pagador` nulo | irrelevante | **nunca** casar pedido pelo pagador |

Regra de ouro preservada: **a notificação nunca é fonte de verdade** — o
handler sempre reconfere em `GET /cobrancas/{txid}` antes de mudar estado.

### 2.4 Assinatura de webhook (diferença que quebra copiar-e-colar)

| | Mercado Pago (implementado) | WyviPay (a implementar) |
| --- | --- | --- |
| Cabeçalho | `x-signature: ts=<ts>,v1=<hex>` | `X-Wyvi-Assinatura: v1=<hex>` |
| Mensagem assinada | manifesto `id:…;request-id:…;ts:…;` | **`{X-Wyvi-Carimbo}.{corpo cru}`** |
| Timestamp | dentro do manifesto (24 h + 5 min) | `X-Wyvi-Carimbo`, janela **±300 s** |
| Corpo cru | não cobre o corpo | **obrigatório**: `request.text()` antes de qualquer `JSON.parse` |
| Comparação | hex, tempo constante manual | `timingSafeEqual` sobre `Buffer` |

A janela **não pode** ser ampliada "para não perder evento" (enfraqueceria
proteção existente). A verificação cirúrgica reutiliza o raw-body já lido por
`mpWebhook.ts` antes do parse.

---

## 3. O que é reutilizável (não tocar)

`apply_payment_status` (0019 + redefinição 0035), `attach_payment`,
`record_payment_event`/`finish_payment_event` (só o filtro de provedor muda),
`release_order_reservation`, `consume_reservation`, `allocate_late_units*`,
`expire_overdue_reservations`, `resolve_delivery`, `create_order_multi`/
`reserve_stock_units_multi`/`create_order_delivery` (0034), toda a RLS e
matriz de privilégios, `consume_rate_limit`, `run_reservation_expiry`, o
webhook fail-closed, `_shared/crypto.ts`, `_shared/http.ts`, `_shared/cors.ts`.

**Classificação das dependências MP** (RELATORIO §2.1, síntese):
**SUBSTITUIR** — `mercadopago.ts` (cliente) e `tests/db/mpSignature.ts`;
**ADAPTAR** — `mpWebhook.ts` (≈70% estrutura serve), `createOrder.ts`,
`orderStatus.ts`, `config.ts`, CHECKs `0007`/`0011`/`0026`, `config.toml`,
`.env.*.example`, smoke, textos de UI, `fakeMp.ts` → base de `fakeWyvi.ts`,
documentação (histórico das missões 03–07 **não** se reescreve);
**REUTILIZAR** — itens acima. Não há SDK npm do provedor (troca não altera
dependências).

---

## 4. Riscos (RELATORIO §4) — status na Missão 11

| # | Risco | Gravidade | Status na Missão 11 |
| --- | --- | --- | --- |
| **R1** | Cobrança multi-item vs máquina mono-produto | crítico | **MITIGADO no banco e RECONFIRMADO na Missão 13.** Migrações `0034` (pedido + reserva + alocação + entrega multi-item) e `0035` (`apply_payment_status` multi-item) constam **no histórico remoto real** (`list_migrations` M13: `m08_0034…`–`m08_0038…` presentes; antes citadas como aplicadas nos registros M08–M10 ("0034–0038 aplicadas"). Resta, na etapa 6 do plano, ligar o handler `create-order` a `create_order_multi` — hoje ele ainda chama o fluxo mono (`create_order`) e, sem secrets, responde `503 payment_not_configured` |
| **R2** | Rotação semanal de chaves (`wy_*` trocadas toda segunda; antiga morre no mesmo instante; evento `chave.rotacionada` não entrega a chave) | crítico | **Pendente de decisão operacional** — procedimento Caminho A/B/C no RELATORIO §6.1; exige responsável nomeado (D6) |
| **R3** | Divergência documental `wy_test_` (501 × "cria cobranças" × "não é mais devolvido") | alto | **Em aberto** — inferência documental do RELATORIO §5; só a primeira chamada autenticada resolve (etapa 2, D3) |
| **R4** | Confusão "demo da loja" × "ambiente de teste da WyviPay" (`teste: true` em produção liberaria pedido real) | alto | **Controle obrigatório** previsto: recusar `teste: true` quando `WYVI_ENVIRONMENT=production` (RELATORIO §6, controle 9) |
| **R5** | Destino de webhook se desliga (20 falhas seguidas → `ativo: false`, eventos não reenviados) | médio | Mitigação prevista: `GET /webhooks/{id}` periódico + reconciliação |
| **R6** | Retentativas só por ~1 h (5 tentativas) | médio | Mitigação obrigatória: conciliação ativa por `GET /cobrancas` |
| **R7** | Orçamento 200 req/min por rota/chave × polling do `order-status` | médio | Mitigação: reconciliação cacheada (≥ 1×/15 s por pedido) |
| **R8** | Reembolso sem `valor_centavos` devolve o **líquido** (diferença contábil) | médio | Decisão de produto: sempre enviar `valor_centavos = total_cents` (bruto) |
| **R9** | `refund_pending` sem ação automática (dinheiro parado) | médio | Etapa 9 do plano (`POST /reembolsos`) |
| **R10** | `saldo_insuficiente` após saque | baixo | Procedimento operacional |
| **R11** | Relógio/NTP (fora de ±300 s → todo webhook `401`) | baixo | Monitorar |
| **R12** | PII de pagador no webhook | baixo | Manter `payload_hash` SHA-256, nunca corpo cru |
| **R13** | Reabrir checkout mono-product regressaria a loja multi-item | médio | Contornado: `0034`/`0035` tornam o fluxo de cobrança compatível com `order_items` |

---

## 5. Plano de implementação (RELATORIO §9 — resumo; **não executado**)

Ordem obrigatória: **etapa 1 antes da 6** (pagar carrinho com máquina
mono-produto é a falha mais cara do projeto — R1; hoje cumprida no banco por
`0034`/`0035`, a reconfirmar).

| Etapa | Objetivo | Critério de saída |
| --- | --- | --- |
| 0 | Decisões de produto (PIX só V1? rota white/black? reembolso bruto/líquido? rotação A ou B?) | 4 respostas escritas |
| 1 | Cobrança multi-item no banco | `tests/db/19` verde (hoje: `0034`/`0035` criadas) |
| 2 | Validar chave `wy_test_` (divergência R3) | `201` → seguir; `501` → replanejar |
| 3 | Cliente `wyvipay.ts` isolado + `fakeWyvi.ts` | contrato HTTP exercitado sem rede real |
| 4 | Webhook `wyvi-webhook` | assinatura inválida → `401` sem gravar; dedup por entrega |
| 5 | Migração de provedor (CHECK `provider` ampliado, aditiva) | linhas antigas intactas |
| 6 | Ligar criação de cobrança (flag `wyvi_payment_enabled`) | flag off → `503` + reserva liberada; on + `wy_test_` → `201` com QR |
| 7 | Frontend de pagamento (checkout + QR/data-URI + entrega) | 2 produtos pagos → entrega com N unidades |
| 8 | Desligar Mercado Pago (`mp-webhook` fora do config, `MP_*` comentadas) | nenhum código chama MP; suíte verde |
| 9 | Reembolso (`POST /reembolsos`) | `refund_pending` → reembolso com valor explícito |
| 10 | Rotação + observabilidade (job de saúde, alarme de destino) | rotação → `503` sem prender estoque + alerta |
| 11 | Publicação (bundle, deploy, cadastro do destino, smoke) | checklist cumprido, nenhum segredo em log |

---

## 6. Bloqueios e dependências

### 6.1 Dependências humanas (RELATORIO §11)

| # | Dependência | Bloqueia |
| --- | --- | --- |
| D1 | Chave `wy_test_` (painel → Desenvolvedor → Chaves de API) | etapas 2, 3, 6, 7, 9 |
| D2 | Conta com plano de taxas vigente (`409 sem_plano` sem plano) | go-live |
| D3 | Confirmar com o fornecedor: divergência `wy_test_`; provisionamento de chave por API | desenho da rotação |
| D4 | Destino de webhook cadastrado + `whsec_` no cofre (aparece **uma vez**) | etapa 4 |
| D5 | Decisões de produto da etapa 0 | todas |
| D6 | Processo humano da rotação semanal com responsável | operação contínua |
| D7 | Servidor PostgreSQL local para `npm run test:db` | verificação automática da suíte de banco — **atendido**: `embedded-postgres` + `scripts/local-db.mjs` (suíte 308/308 na M13) |
| D8 | Credencial de deploy de Edge Functions (CLI/token) | etapas 4, 6, 11 |
| D9 | Saída de rede para `api.wyvipay.com.br` (shell bloqueado; sandbox tem) | testes de contrato no CI |
| D10 | Decidir sobre histórico de migrações (citação da fonte: 27 registros × 36 arquivos) | `db push` perigoso — **atualização M13:** 41 registros remotos × 42 arquivos locais; divergência de nomes da era inicial é histórica e conhecida; nenhum `db push` está planejado |
| D11 | Revisão jurídica de termos/reembolsos/taxas | publicação |

### 6.2 Estado remoto — atualização nas Missões 12/13 (2026-11-10)

- O conector **supabase** foi ligado nas Missões 12/13 e **todas as leituras
  promovidas foram refeitas ao vivo**: 41 migrações no histórico (inclui
  `m08_0034`–`m08_0038` **e** as quatro M12: `0039`, `0039b`, `0040`,
  `0041`); 8/8 Edge Functions `ACTIVE` com versões/`verify_jwt` registrados;
  11 secrets **por nome**, sem `MP_*` nem `WYVI_*`; auth com TOTP e
  `mfa_allow_low_aal=false`; contagens de dados iguais ao baseline.
- Migrações **0039/0040** (criadas na M11) **foram aplicadas** na M12 com
  md5 provados — pendência encerrada; 0041 (segurança `search_path`) também
  aplicada.
- Nenhum segredo foi criado ou alterado; nenhum pagamento foi ativado;
  nenhuma integração WyviPay foi implementada.
- **A pendência que restava para a WyviPay segue humana:** decisões D1–D6,
  credenciais D8 e revisão jurídica D11 (§6.1).

---

## 7. Critérios para considerar a integração concluída (RELATORIO §12 — resumo)

**Funcional:** (1) pedido com ≥2 produtos cobrado/pago/entregue com quantidades
exatas; (2) `Idempotency-Key` repetida → mesma cobrança; (3) QR e copia-e-cola
renderizados a partir de dados reais do provedor de teste; (4) `cobranca.paga` →
`paid` + entrega ≤ 10 s; (5) expiração/cancelamento liberam unidades;
(6) polling não excede 1 chamada/15 s por pedido.

**Segurança:** (7) webhook sem assinatura/errado/velho → `401` e **zero** linhas
em `payment_events`; (8) entrega repetida 5× → 1 processamento; (9)
`teste: true` em produção → recusado; (10) nenhum `wy_live_`/`whsec_`/corpo em
logs, respostas ou repositório; (11) `anon`/`authenticated` sem acesso às tabelas
sensíveis; (12) valor em centavos inteiros; divergência bloqueia entrega.

**Operacional:** (13) falha do provedor → reserva liberada + `502` sem vazar
credencial; (14) rotação ensaiada → `503` sem estoque preso, recuperação < 15 min;
(15) destino desligado detectado ≤ 1 h; (16) conciliação diária sem divergência.

**Documentação/código:** (17) `docs/wyvipay.md` publica fluxo, variáveis,
checklist, rotação, estados e erros; (18) sem referência funcional viva ao MP;
(19) `tsc`/`build`/`bundle` verdes, suítes sem caso removido; (20) reembolso de
`refund_pending` executado com valor explícito.

---

## 8. Declarações desta síntese

- **Não** afirma que `wy_test_` funciona (divergência R3 em aberto).
- **Não** afirma prontidão de lançamento: seguem pendências operacionais
  (D1–D11), decisões da etapa 0 e revisão jurídica.
- *Atualização M13:* a presença de `0034`/`0035` no histórico remoto passou
  de "registro histórico" para **consulta ao vivo confirmada**
  (§6.2/R1); nenhum outro item desta síntese foi reavaliado nem implementado.
- **Não** foi executada nenhuma operação financeira, nenhuma migração, nenhuma
  alteração de credencial, nenhum deploy e nenhum merge nesta missão.
- Todos os endpoints e comportamentos citados vêm de
  `docs/auditoria/missao-08-wyvipay/RELATORIO.md`; **nenhum foi inventado**.

## Fontes

1. `docs/auditoria/missao-08-wyvipay/RELATORIO.md` (Missão 08 b, 2026-11-08) —
   auditoria completa da integração WyviPay (§1 estado, §2 dependências,
   §3 contrato, §4 riscos, §5 ambiente de teste, §6 segurança, §7 arquitetura,
   §9 plano, §11 dependências, §12 critérios).
2. `docs/auditoria/missao-08-wyvipay/DIAGNOSTICO.md` e `DEPENDENCIAS-HUMANAS.md`.
3. `docs/mercado-pago.md` — estado do provedor atual (histórico).
4. `docs/missao-10-reconciliacao-final.md` — bloqueio remoto e validações M10.
5. Código-fonte da Missão 11 (handlers, migrações `0033`–`0038`, frontend).
