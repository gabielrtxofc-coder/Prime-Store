# Diagnóstico para o fechamento da Prime Store (72 h, sem pagamento)

> Reconhecimento feito **antes** de qualquer alteração, em 2026-11-08, sobre o
> commit `2a456ee` (missão 08-b). Branch `arena/e7e73e28-prime-store`.
> Nada foi alterado nesta etapa: o objetivo é que a divisão das missões abaixo
> esteja apoiada em lacunas **medidas**, não em suposições.
>
> Decisão de produto que orienta tudo: **V1 somente PIX, `CHECK (method='pix')`
> permanece como está**, pagamento **não** será implementado agora.

---

## 1. O que já funciona (verificado, não presumido)

| Jornada | Estado | Evidência |
| --- | --- | --- |
| Catálogo público | funciona; lê `get_catalog`, expira reservas vencidas, aplica rate limit | `handlers/catalog.ts`, `catalog` v6 publicado |
| Página de produto | funciona; preço e disponibilidade do servidor | `ProductPage.tsx` |
| Carrinho multi-item | funciona; reconcilia com o catálogo, detecta indisponível e mudança de preço | `CartContext`, `lib/cart.ts`, 11 testes |
| Solicitação sem pagamento | funciona; `create_purchase_request` grava `orders` + `order_items`, idempotente | `order-request` v1, migração `0033` |
| Confirmação multi-item | funciona; mostra os itens, total e o código de acompanhamento | `OrderStatusPage.tsx` |
| Acompanhamento | funciona; exige número + código, "não encontrado" uniforme | `TrackingPage.tsx`, `get_order_status_by_reference` |
| Mobile | menu, busca e navegação mobile existem; 4 breakpoints (1100/900/700/480) | `SiteHeader.tsx`, `styles.css` |
| Segurança | RLS 20/20, `anon` sem tabela/função, rate limit persistente, mínimo privilégio | suítes 01/08/14 |
| Suítes locais | `tsc -b` limpo; frontend **75/75** | execução nesta sessão |

## 2. Lacunas medidas que impedem uma operação de verdade

### G1 — A administração não consegue operar pedidos `requested`

O fluxo público grava `status='requested'` e `payment_status='not_required'`, mas:

- `AdminOrders.tsx` filtra por uma lista fixa de status que **não contém
  `requested` nem `not_required`** (linhas 11-12). O filtro "Todos" mostra, mas
  não há como separar a fila real de trabalho.
- `admin_get_order` devolve `to_jsonb(orders)` e **não devolve `order_items`** —
  o detalhe mostra `product_name` do primeiro item e `quantity` total. Para um
  pedido de 3 produtos, a tela mente por omissão.
- `admin_indicators` conta `orders_pending_payment` e não conta `requested`.
  O painel mostra "Aguardando PIX" para uma loja que não cobra.
- A listagem exibe colunas de pagamento/entrega que, no fluxo atual, são sempre
  `not_required`/`not_ready` — ruído.

**Não existe hoje nenhuma forma de a loja confirmar, atender ou fechar uma
solicitação.** Esse é o maior bloqueio: o cliente registra e ninguém consegue
tratar.

### G2 — Nenhum administrador existe no projeto

`select count(*) from admin_users` → **0**. As Edge Functions administrativas
exigem JWT + allowlist + `mfa_required` (`aal2`). Sem provisionamento,
`/admin` não passa do login. Também não há rota `/admin` no roteador público.

### G3 — Não há teste de banco executável neste ambiente

Sem servidor PostgreSQL, `npm run test:db` não roda (16 arquivos, 186 casos
conhecidos). Toda a lógica de pedido/estoque/RLS fica **sem verificação
automática** justamente na fase de fechamento. `embedded-postgres@18.6.0-beta.19`
**existe no registro npm** e é a rota viável; **não foi instalado** (é decisão
sua, ver §4).

### G4 — Nenhum teste de navegador (E2E)

Não há Playwright no projeto e o download do Chromium **falhou** neste container
(`Download failure, code=1`). Jornadas reais (mobile, teclado, foco, reload no
meio do checkout) nunca foram exercitadas por um navegador de verdade. O que
existe são testes jsdom.

### G5 — Contato de atendimento não configurado

`siteConfig.supportContact = ''` → rodapé e página de ajuda exibem
"Canal de atendimento real pendente de configuração", e o formulário de contato
é **local, sem envio**. Uma loja operacional não pode atender sem canal.

### G6 — Textos institucionais desatualizados

`legalContent.ts` ainda afirma que "não há integração com serviços externos" e
que a confirmação é de "um pedido fictício" — o que deixou de ser verdade desde
a missão 08. FAQ e termos precisam refletir o fluxo real (solicitação real,
estoque real, sem cobrança).

### G7 — Higiene de navegação

`src/lib/links.ts` normaliza `/entrega/:token`, rota que **não existe** no
roteador. Nenhum caminho público a alcança hoje, mas é código morto que aponta
para o checkout pago (que não será reaberto).

## 3. O que **não** é lacuna (para não gastar as 72 h nisso)

- Multi-item **na solicitação** funciona e está testado ponta a ponta.
- A incompatibilidade multi-item × entrega individual é do **fluxo pago** e
  permanece documentada como bloqueio da integração financeira
  (`docs/auditoria/missao-08-wyvipay/RELATORIO.md`, R1). **Não será resolvida
  agora**, conforme sua decisão.
- `PaymentPage`, `DeliveryPage`, `demo/PaymentCheckoutPage`, `mp-webhook`,
  `demo-payment` e os testes do Mercado Pago: preservados, fora do roteador,
  sem alteração.
- WyviPay: zero mudanças.

## 4. Duas decisões que só você pode tomar

1. **Conectar o painel ao backend real?** Hoje `/admin` está fora do roteador.
   Para "administração finalizada" no sentido de operar pedidos de verdade, é
   preciso: criar 2 usuários no Supabase Auth, registrar os UUIDs em
   `admin_users`, configurar TOTP e reabrir a rota. É a única forma de sair do
   modo demonstrativo. **Alternativa:** finalizar o painel como está
   (demonstrativo) e operar pedidos por SQL — pior, mas sem credenciais novas.
2. **Autorizar `embedded-postgres` como dependência de desenvolvimento?** Sem
   isso, a entrega fica com testes de banco não executados. Com isso, os 186
   casos passam a rodar e as missões novas entram com verificação real.

Nenhuma das duas é pré-requisito para começar: as missões 1 e 2 rodam hoje.
