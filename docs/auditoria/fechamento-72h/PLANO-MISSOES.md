# Plano de fechamento da Prime Store — 72 h, sem pagamento

> Base: commit `da14212`, branch `arena/e7e73e28-prime-store`. Diagnóstico que
> fundamenta este plano: [`DIAGNOSTICO.md`](./DIAGNOSTICO.md).
>
> **O que este plano NÃO faz:** não implementa WyviPay, não cria cobrança, não
> toca em webhook de pagamento, não reabre o checkout pago, não altera o
> `CHECK (method='pix')`, não usa credencial financeira, não faz merge na `main`,
> não publica em produção.
>
> **Bloqueio financeiro preservado:** a incompatibilidade entre pedido
> multi-item e entrega individual continua documentada em
> [`../missao-08-wyvipay/RELATORIO.md`](../missao-08-wyvipay/RELATORIO.md) (risco
> R1) e **não** será resolvida nesta fase — o fluxo pago está desligado.

---

## O princípio da divisão

Uma única coisa realmente impede a loja de funcionar sem pagamentos hoje:

> **A loja recebe solicitações que ninguém consegue tratar.** O cliente registra
> um pedido multi-produto, recebe número e código, e do outro lado não existe
> fila, nem detalhe correto dos itens, nem ação de confirmar/atender/recusar.

Tudo o mais é confiabilidade (testes), apresentação (mobile, textos) ou
operação (contato, provisionamento). Por isso a ordem abaixo **não** é a ordem
"mais fácil primeiro": é a ordem em que cada missão remove um bloqueio real.

Cada missão é **pequena, fechável em uma sessão e reversível**. Nenhuma depende
do resultado da seguinte.

---

## Visão geral (7 missões, ~5 h de trabalho técnico + 2 dependências humanas)

| # | Missão | Remove o quê | Tamanho | Depende de |
| --- | --- | --- | --- | --- |
| **M1** | Operar solicitações no painel | **G1** — o bloqueio principal | M | — |
| **M2** | Suíte de banco executável no ambiente | **G3** — 186 casos sem verificação | M | decisão D1 |
| **M3** | E2E das jornadas públicas | **G4** — nenhuma prova em navegador | M | M2 (recomendado) |
| **M4** | Mobile e acessibilidade | experiência em celular | M | — |
| **M5** | Conteúdo, contato e limpeza de rotas | **G5, G6, G7** | P | decisão D2 |
| **M6** | Painel real: provisionar administradores | **G2** — painel inoperável de verdade | M | decisão D2 |
| **M7** | Documentação operacional e critérios de pronto | nada bloqueia, mas sem isso não há "concluído" | P | M1–M6 |

Legenda: **P** = pequena (≤ 1 h), **M** = média (1–2 h).

---

## M1 — Operar solicitações no painel de pedidos

**Por que primeiro:** é o único item que impede a loja de funcionar. Sem isso,
o fluxo público produz pedidos que morrem em `requested`.

**Escopo**
1. `AdminOrders.tsx`: incluir `requested` e `not_required` nos filtros; colunas
   adaptadas ao fluxo sem pagamento (itens, solicitante, valor, data, estado);
   busca por número, nome e e-mail do solicitante.
2. `admin_get_order`: devolver `order_items` (nome, quantidade, preço unitário,
   subtotal) — **redefinição compatível**, sem remover campos existentes.
3. `admin_indicators`: contar `orders_requested` e parar de destacar
   "Aguardando PIX" quando não há cobrança configurada.
4. Banco, migração aditiva `0034`: RPC `admin_update_order_status(order, new_status, notes)`
   com transições permitidas (`requested → confirmed | cancelled`), auditoria em
   `admin_audit_log` e `order_events`, sempre via `assert_admin()`.
   **Sem** tocar em `apply_payment_status`, reserva, entrega ou `payments`.
5. Detalhe do pedido no painel: lista de itens + botão de ação, com confirmação.

**Fora de escopo (deliberado):** aprovar pagamento, gerar entrega, mexer em
`payments`. O estado `confirmed` significa **"pedido confirmado pela loja"**,
não "pago".

**Arquivos:** `supabase/migrations/…_0034_admin_solicitacoes.sql`,
`supabase/functions/_shared/handlers/adminApi.ts`, `src/services/adminApi.ts`,
`src/pages/admin/AdminOrders.tsx`, `src/pages/admin/AdminOverview.tsx`.

**Pronto quando:** um pedido de 3 produtos criado na loja aparece na fila,
abre com os 3 itens e quantidades corretas, pode ser confirmado e o histórico
registra quem confirmou e quando. Teste de banco cobrindo transição inválida e
`authenticated` sem permissão.

---

## M2 — Suíte de banco executável neste ambiente

**Por que:** 186 casos de banco (RLS, estoque, idempotência, privilégios) não
rodam aqui. Fechar a loja sem executá-los é entregar no escuro.

**Escopo**
1. Adicionar `embedded-postgres` como devDependency (decisão **D1**) e um script
   `npm run db:local` que sobe o servidor em `/tmp/pgdata` e exporta `DATABASE_URL`.
2. Rodar `npm run test:db` do zero e **registrar o resultado real** (contagem por
   arquivo), incluindo o que quebrar.
3. Corrigir apenas o que for regressão de teste (nunca afrouxar asserção para
   "passar"). Divergências de ambiente vão para o relatório, não para o código.

**Pronto quando:** `npm run test:db` roda em um comando e o número de casos
executados for ≥ 186, com a lista de arquivos verdes.

---

## M3 — E2E das jornadas públicas

**Por que:** nenhuma prova em navegador existe; o Chromium não baixa neste
container (G4).

**Escopo**
1. Playwright com `webServer` do Vite, `reuseExistingServer` e projeto mobile
   (`viewport 390×844`).
2. Jornadas: catálogo → produto → carrinho (2 produtos) → checkout → confirmação
   → acompanhamento por número + código; código errado; produto esgotado;
   carrinho vazio; reload no meio do checkout (idempotência).
3. Backend **simulado no nível de `fetch`** (mesma técnica dos testes atuais) ou
   real, se o preview estiver disponível — o teste não pode depender de rede.

**Fallback honesto:** se o download do navegador continuar bloqueado, a entrega
desta missão é um **roteiro manual de 12 passos com evidência** (screenshots e
`curl`), registrado como limitação — não uma suíte que não roda.

**Pronto quando:** 8–10 verificações E2E passam em desktop e mobile, ou o
roteiro manual está cumprido e anexado ao relatório.

---

## M4 — Mobile e acessibilidade

**Escopo**
1. Auditoria em 360/390/768 px: header, menu, busca, carrinho, checkout,
   confirmação, acompanhamento, tabelas do painel.
2. Corrigir: alvos de toque < 44 px, overflow horizontal, tabela do painel em
   tela estreita, campos com teclado inadequado (`inputMode`, `autoComplete`).
3. Teclado e leitor de tela: foco no menu mobile, `aria-live` no carrinho,
   contraste dos textos secundários, `prefers-reduced-motion`.

**Pronto quando:** nenhuma tela com scroll horizontal em 360 px; navegação por
teclado percorre catálogo → checkout sem armadilha de foco; checklist anexado.

**Nenhuma mudança de identidade visual** — só correção de comportamento.

---

## M5 — Conteúdo, contato e limpeza de rotas

**Escopo**
1. `siteConfig.supportContact` real (decisão **D2**) em rodapé e ajuda; se o
   formulário continuar local, dizer isso de forma explícita.
2. `legalContent.ts` e `faqs.ts`: remover "pedido fictício" e "não há integração
   com serviços externos"; descrever o fluxo real (solicitação registrada,
   estoque conferido, nenhum pagamento).
3. `src/lib/links.ts`: remover a normalização de `/entrega/:token` (rota
   inexistente) ou documentar por que fica.

**Pronto quando:** nenhum texto promete o que a loja não faz, nem nega o que ela
faz; `grep` por "fictício" e "pendente de configuração" não encontra ocorrência
pública.

---

## M6 — Painel real: provisionar administradores

**Escopo (depende de decisão D2)**
1. Criar 2 usuários no Supabase Auth, inserir UUIDs em `admin_users`
   (`scripts/provision-admin.sql` já existe), exigir TOTP no primeiro acesso.
2. Reabrir a rota `/admin` no roteador, mantendo `verify_jwt: true` e
   `assert_admin()` + `aal2` como autorização real.
3. Confirmar que o modo demonstrativo do painel (`VITE_ADMIN_DEMO`) fica
   desligado e que o painel aponta para o backend.

**Pronto quando:** login → TOTP → fila de solicitações da M1 funcionando contra
o sandbox, com `admin_audit_log` registrando o acesso.

---

## M7 — Documentação operacional e critérios de pronto

**Escopo**
1. `docs/operacao.md`: como tratar uma solicitação (fila → detalhe → confirmar →
   acompanhar), o que fazer com pedido duplicado, como orientar o cliente.
2. Atualizar `docs/README.md`, `docs/limitacoes-e-pendencias.md` e
   `docs/PROGRESSO.md` com o estado real pós-fechamento.
3. Relatório final com o checklist objetivo de "loja operacional".

**Pronto quando:** um terceiro consegue operar a loja lendo só esse documento.

---

## Duas decisões que preciso de você (não bloqueiam M1 nem M4)

| # | Decisão | Opções | Impacto se ficar em aberto |
| --- | --- | --- | --- |
| **D1** | Adicionar `embedded-postgres` (devDependency) para rodar a suíte de banco | (a) sim (b) não, seguir só com frontend + E2E | M2 e a verificação de RLS/estoque ficam sem execução |
| **D2** | Operar o painel de verdade ou manter demonstrativo | (a) provisionar 2 admins + TOTP + reabrir `/admin` (b) manter fora do roteador e operar por SQL | M6 não acontece; a fila da M1 fica sem interface |

---

## Ordem recomendada de execução

```
M1  →  M2  →  M4  →  M3  →  M5  →  M7  →  M6 (quando D2 for decidida)
 ↑                                          ↑
 bloqueio principal              depende de credencial/usuário
```

M1 primeiro porque é o único que muda a loja de "recebe pedido" para
"consegue atender pedido".

## Critério de "loja operacional" (sem pagamento)

1. Cliente percorre catálogo → carrinho multi-item → solicitação → confirmação →
   acompanhamento, em desktop e celular.
2. Pedido aparece no painel com **todos** os itens e o solicitante.
3. A loja consegue **confirmar** ou **recusar** uma solicitação, com auditoria.
4. Nenhum texto público promete pagamento, cobrança ou entrega imediata.
5. `tsc` limpo, frontend ≥ 75 casos verdes, banco ≥ 186 casos executados (se D1),
   E2E ou roteiro manual aprovado.
6. Nenhuma alteração em pagamento, webhook, `CHECK (method)` ou credencial.
7. Incompatibilidade multi-item × entrega **documentada** como bloqueio do
   fluxo pago.
