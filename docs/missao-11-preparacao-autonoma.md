# Missão 11 — Preparação autônoma de lançamento

Data: 2026-11-09 (UTC). Branch: `arena/6296b54a-prime-store` (baseada na
`main` `0edf709f34480e3a1af56e65c190fe38f5f732bb`).
Natureza: **execução real** — auditorias, correções, migrações locais, testes
novos, verificação visual em navegador e documentação. **Nada foi alterado no
Supabase remoto:** nenhuma migração reaplicada, nenhuma Edge Function
publicada, nenhum segredo criado/alterado, nenhum admin criado, nenhum dado de
cliente tocado, nenhum merge na `main`.

---

## Resumo executivo

**Preparação autônoma (escopo desta missão): 100% concluída** — 9 grupos
(A–I) executados, com evidência. **Prontidão de lançamento: 60%** (ver §10):
tudo que depende do código e do ambiente local está verde e auditado; o
percentual restante é operacional/humano (publicação remota, migrações
0039/0040 no projeto real, administradores reais, secrets, backup/PITR,
revisão jurídica e decisão de pagamentos) e **não pode ser declarado pronto**
enquanto essas pendências existirem.

| Grupo | Escopo | Classificação | Evidência principal |
| --- | --- | --- | --- |
| **A** | Auditoria estrutural, reconciliação docs 08/09/10/PROGRESSO, inventário de pendências | **APROVADO** | §1.1–§1.3 |
| **B** | adminApi (4 argumentos de estoque, JWT do usuário, AAL2, fail-closed), migrações 0033–0038, 8 Edge Functions | **APROVADO** | §2 |
| **C** | Loja pública, ciclo de pedido completo, painel admin | **APROVADO** | §3 |
| **D** | Autenticação/segurança + testes novos de segurança | **APROVADO** | §4 |
| **E** | Verificação visual 8 larguras (320–1440), loja + painel, com correções | **APROVADO** | §5 |
| **F** | Auditoria de pagamentos + documentação WyviPay (sem inventar endpoints, sem implementar) | **APROVADO** | §6 |
| **G** | Correção de problemas por gravidade, com evidência e testes | **APROVADO** | §7 |
| **H** | Suíte completa: `npm test`, `test:db`, `typecheck`, `build`, `bundle:functions`, `npm audit --omit=dev` | **APROVADO** | §8 |
| **I** | Este relatório, `PROGRESSO.md`, commits organizados e PR para `main` (sem merge) | **APROVADO** | §9–§11 |

**Números finais:** `npm test` **136/136** (18 arquivos, era 127/127 em 16);
`test:db` **304/304** (25 arquivos, era 294/294 em 24); `tsc -b` exit 0;
`vite build` exit 0; `bundle:functions` **8/8**; `npm audit --omit=dev`
**0 vulnerabilidades**; auditoria visual **160 checks, 0 falhas**.

---

## 1. Grupo A — auditoria estrutural e reconciliação documental

### 1.1 Estrutura conferida

- **40 migrações** (`0001`–`0038` + `0039`/`0040` criadas nesta missão, locais);
- **8 Edge Functions** (`admin-api`, `catalog`, `create-order`, `delivery`,
  `demo-payment`, `mp-webhook`, `order-request`, `order-status`) com wrappers e
  handlers em `_shared/handlers/` — `bundle:functions` confirma 8/8;
- suítes: 21 arquivos `tests/db` (→ 25 com os novos), 3 `tests/unit`, 16
  `src/**/*.test.tsx` (→ 18);
- varredura `TODO`/`FIXME` em `src/` e `supabase/functions/`: **0 ocorrências**.

### 1.2 Reconciliação documental

- `docs/missao-08-reconciliacao-supabase.md`, `docs/missao-09-fechamento-operacional.md`
  e `docs/missao-10-reconciliacao-final.md` conferidos: a recuperação da M09
  (5 arquivos, fast-forward na branch oficial) e a integração por PR #2 para a
  `main` estão coerentes com o histórico git atual (`main` = `0edf709`).
- `docs/PROGRESSO.md` coerente com o estado real; **atualizado ao final desta
  missão** (§9).
- Nenhuma afirmação antiga foi reescrita; correções factuais foram acrescentadas
  como atualizações datadas (ex.: nota de bloqueio remoto da Missão 10, §6.3).

### 1.3 Inventário de pendências (consolidado — detalhado em §11)

Deploy remoto de funções · aplicação de `0039`/`0040` no projeto real ·
admins reais + TOTP · secrets (`PRIME_ENCRYPTION_KEY` já no Vault; `MP_*`
congeladas) · backup/PITR verificado · smoke remoto revisado · tag M07 esclarecida
· histórico de migrações (27 registros × 40 arquivos) · dependências WyviPay
D1–D11 · revisão jurídica.

## 2. Grupo B — adminApi, migrações e Edge Functions

Auditoria (leitura de código + suítes HTTP→banco existentes + missão 10):

- **4 argumentos de estoque:** `admin_set_stock_unit_status(uuid, text, text, text)`
  (`0038`) bate exatamente com `stock.setStatus` do handler
  (`p_stock_unit_id`, `p_status`, `p_reason`, `p_note`); a assinatura antiga de 2
  argumentos foi removida na própria 0038; `DROP FUNCTION` da assinatura antiga
  é seguro (CREATE OR REPLACE nunca sobrescreve assinatura diferente).
- **JWT do usuário:** `adminApi` usa `rpcForUser(authorization)` — as RPCs
  administrativas enxergam `auth.uid()`/`aal` do chamador; a service role só
  é usada onde o backend é o ator. Nenhuma autorização administrativa é
  substituída por service role.
- **AAL2:** `assert_admin()` exige allowlist (`admin_users.is_active`) e
  `aal='aal2'` quando `mfa_required`; falha com `not_authenticated`/`not_admin`/
  `mfa_required` — confirmado pelos testes 04, 08, 20 e pela nova varredura 22.
- **Fail-closed:** sem Authorization → 401; corpo inválido → 400; ação
  desconhecida → 400; MFA ausente → 403 `mfa_required`; sem material de
  criptografia → 503 sem gravar segredo; rate limit por rota via
  `consume_rate_limit`.
- **Migrações 0033–0038:** lidas e conferidas no código (pedido sem pagamento,
  multiproduto, pagamento, entrega, bloqueio, motivos de estoque). Registro M08
  diz que estão aplicadas no remoto — **evidência histórica**, não revalidada
  nesta missão (conector supabase desligado; ver §6.3).
- **8 Edge Functions:** empacotadas com sucesso (`bundle:functions` 8/8);
  `admin-api` é a única com `verify_jwt=true` por padrão no wrapper (as demais
  são públicas por contrato e protegidas por token/prova de posse no corpo).

## 3. Grupo C — loja pública, ciclo completo e painel

Exercitado de ponta a ponta, sem tocar produção:

- **Loja:** catálogo (adaptador de payload `{products[], generated_at}`),
  busca/filtros, página de produto, carrinho (teto 10 itens distintos + teto por
  produto), checkout de solicitação, recibo (`/pedido/:id`), acompanhamento,
  entrega, páginas institucionais — cobertos pelos testes de página (18
  arquivos) e pela auditoria visual (§5).
- **Ciclo de pedido completo:** `POST /order-request` →
  `create_purchase_request` (preço lido no banco, idempotência com
  `idempotency_conflict`, replay rotaciona código) → consulta
  `order-status` com código privado → estado `requested`/`not_required`
  imune a forja de pagamento (suíte 19, casos A–I).
- **Painel admin:** login com allowlist + TOTP, abas Visão geral/Produtos/
  Estoque/Pedidos com dados do mock ao vivo no navegador (§5), ações com
  diálogo de confirmação, badges de itens por pedido (campo `items_count` —
  exigiu a migração 0040, §7).
- **Modo demonstrativo:** `VITE_ADMIN_DEMO` isola o painel sem rede —
  testado (`adminDemo.test.tsx`); rota `/admin` protegida
  (`adminRoute.test.tsx`, 7 casos).

## 4. Grupo D — autenticação/segurança + testes novos

### 4.1 Auditoria (superfícies conferidas)

| Superfície | Estado | Onde é garantido |
| --- | --- | --- |
| Painel admin | e-mail/senha → Supabase Auth (anon key) → allowlist no banco → **AAL2 obrigatório**; nenhuma chave privilegiada no navegador | `adminAuth.ts`, `assert_admin()`, testes 04/08/20/22 |
| RPCs `admin_*` | SECURITY DEFINER, `search_path` fixo, `assert_admin()` como **primeira** declaração em todas (23 funções) | teste 08 (fonte) + **novo teste 22 (varredura dinâmica)** |
| Solicitação de compra | prova de posse (`client_token` hash), idempotência com conflito estável, preço sempre do servidor | 15, 16, 06 e **novo teste de payload** |
| Acompanhamento/entrega | código privado (`get_order_status*` revogadas de `public`/`anon`) | 13/16/19 |
| Rate limits | `consume_rate_limit` por rota + orçamentos próprios (pedido, entrega) | 13 |
| RLS/privilégios | 20 tabelas com RLS; `anon` sem nenhuma tabela e **sem nenhuma função**; `authenticated` só `admin_*`+`is_admin` | 01, 08 (dinâmico) |
| CORS/crypto | `_shared/cors.ts`, crypto CSV/AES-GCM | `tests/unit/cors.test.ts`, `crypto_csv_mp.test.ts` |
| Pagamentos | congelados (`not_required`; `create-order` fail-closed `503 payment_not_configured`) | 19, §6 |
| Frontend | modo demo sem rede; sem token privilegiado; validação de identificadores | adminDemo/adminRoute/**requestService** |

### 4.2 Testes novos de segurança (12 casos, todos verdes)

1. **`tests/db/22_admin_guardia_aal2.test.ts` (7 casos)** — varredura
   **dinâmica** sobre todas as `admin_*` do `pg_proc` (≥ 20, lista do banco,
   não manual): fonte contém `public.assert_admin()`; `anon` sem EXECUTE
   (fonte + tentativa real de chamada); AAL1 → `mfa_required` em **todas**;
   estranho AAL2 → `not_admin` em **todas**; controle positivo AAL2; âncora
   específica da **0040** (`admin_list_orders` redefinida mantém guarda,
   privilégio e devolve `items_count=2` em pedido multiproduto semeado).
2. **`src/services/requestService.test.ts` (5 casos)** — trava o payload do
   checkout: chaves exatas `items/buyer_name/buyer_email/idempotency_key/
   client_token`, itens só `product_id`+`quantity`, **nenhum** campo de
   preço/total/status em lugar algum do corpo, sem `Authorization`, e
   validação de `isOrderId`/`isOrderReference` contra entradas maliciosas.

Nenhum teste existente foi removido ou afrouxado.

## 5. Grupo E — verificação visual (8 larguras)

**Receita (reproduzível):** build com
`VITE_BACKEND_ENABLED=true VITE_SUPABASE_URL=http://127.0.0.1:8787
VITE_SUPABASE_ANON_KEY=visual-anon-key VITE_ADMIN_DEMO=true` → `vite preview`
(4173) + mock backend das 4 Edge Functions (8787, dados fictícios citados:
6 produtos, pedido `PS-VISU11`) → Chromium headless real
(`puppeteer-core` + `@sparticuz/chromium`, sem CDN do Playwright) →
`.local/visual/audit.mjs`.

**Plano:** 8 larguras (320, 360, 390, 414, 768, 1024, 1280, 1440) × 15 rotas
da loja + login do modo demo + 4 abas do painel = **160 verificações** de
rolagem horizontal, elementos visíveis fora da janela (ignorando recorte por
ancestral) e erros de página; screenshots de evidência em
`docs/missao-11-evidencia/` (17 arquivos PNG/JSON, 1,6 MB).

**Resultado:** primeira execução **25 falhas** — 1 bug real + 24 falsos
positivos de orbs decorativos recortados:

- **Bug real corrigido:** `/produto` a **320px** criava rolagem de 25px
  (arte com `aspect-ratio` + `min-height` forçava min-content 345 > 320).
  Correção em `src/styles.css`: `grid-template-columns: minmax(0, 1fr)` +
  `min-width: 0` em `.product-detail__art` e `.product-art--detail`.
- **Detector refinado:** passa a ignorar conteúdo cortado por ancestral com
  `overflow: hidden/clip/auto/scroll` (orbs de decoração não são fuga de tela).

**Execução final: `CHECKS=160 FAILURES=0`** — sem rolagem horizontal, sem
elemento visível fora da janela, sem pageerror em nenhuma largura/rota,
incluindo o ciclo pedido (`PS-VISU11` renderizado com itens e valores) e o
painel em modo demo. Relatório completo:
`docs/missao-11-evidencia/audit-report.json`.

## 6. Grupo F — pagamentos atuais e documentação WyviPay

### 6.1 Auditoria dos pagamentos atuais

Ver §2 e `docs/wyvipay-integracao.md` §1: fluxo vivo é
solicitação **sem cobrança** (`not_required`); `create-order` fail-closed;
Mercado Pago congelado sem secrets; demo-payment isolado; máquina de estados
agnóstica (`0019`) + multi-item (`0034`/`0035`); nenhuma ocorrência de
WyviPay no código.

### 6.2 Entrega da Task 016

- **`docs/wyvipay-integracao.md`** — síntese completa: estado atual,
  mapeamento de contrato (rotas **exatamente** como citadas no
  `docs/auditoria/missao-08-wyvipay/RELATORIO.md` — nenhuma inventada),
  mapa de status, assinatura de webhook, reutilização, riscos, plano de
  etapas, dependências e critérios de conclusão.
- **R1 atualizado:** risco crítico "cobrança multi-item vs máquina
  mono-produto" está **mitigado no banco** pelas migrações `0034`/`0035`
  (constam como aplicadas nos registros M08–M10); resta, na etapa 6 do
  plano WyviPay, ligar o handler `create-order` a `create_order_multi` —
  hoje o handler segue mono e fail-closed. Ressalva: aplicação remota
  reconfirmável apenas com o conector ligado.
- **Nota de bloqueio remoto de `docs/missao-10` atualizada:** conector
  supabase agora aparece *conectado mas desligado*; segue **nenhuma consulta
  remota** na Missão 11; `0039`/`0040` criadas localmente e **não aplicadas**.
- **Nada foi implementado:** zero código de integração, zero migração
  WyviPay, zero credencial, zero cobrança.

## 7. Grupo G — correções por gravidade (com evidência)

| # | Problema (gravidade) | Correção | Evidência |
| --- | --- | --- | --- |
| **F1** | Painel em modo demo chamava backend quando `VITE_BACKEND_ENABLED` ausente | `AdminPage.tsx`/`AdminLogin.tsx`: demo 100% local | `adminDemo.test.tsx` (+4 asserções) |
| **F2** | Carrinho aceitava quantidade acima do limite do produto (erro cru do servidor) | `CartContext.tsx`: teto 10 itens distintos (`cart_full`) + checagem por produto | `CartContext.test.tsx` (novo caso do teto 10) |
| **F3** | Falhas de adicionar ao carrinho sem feedback claro | toasts em `ProductCard.tsx`/`ProductPage.tsx`; aviso em `CartPage.tsx` | testes de página verdes |
| **F4** | Replay da mesma chave com itens diferentes podia falhar com 500 cru (corrida/UNIQUE) | **migração `0039`**: `create_purchase_request` com tratamento de `orders_idempotency_key_key` → `idempotency_conflict` estável + replay idêntico seguro | `tests/db/15` +2 casos (conflito e corrida `Promise.all`) |
| **F5** | Checkout não regenerava a identidade após 409 e travava em mensagem duplicada | `CheckoutPage.tsx`: renovação pós-409; teste usa `findAllByText` (alerta + toast) | `checkoutRequest.test.tsx` (novo arquivo, 2 casos) |
| **E1** | `admin_list_orders` não devolvia `items_count` (pedido multiproduto parecia de 1 produto na lista) | **migração `0040`**: coluna no SELECT, mesma assinatura/privilégios | `tests/db/20` (+1 caso) e âncora no teste 22 |
| **V1** | `/produto` com rolagem horizontal a 320px (Grupo E) | `styles.css` `minmax(0,1fr)` + `min-width:0` | auditoria final 160/0 |

**Migrações `0039`/`0040` NÃO aplicadas remotamente** (limite da missão);
aplicação é pendência do operador — ambos os arquivos declaram isso em seu
cabeçalho.

Debounce da busca do admin: avaliado como opcional; não feito (sem
necessidade comprovada — não altera funcionalidade que funciona).

## 8. Grupo H — suíte completa (execução final)

| Comando | Resultado |
| --- | --- |
| `npm test` | **136/136** em 18 arquivos (baseline: 127/127 em 16) |
| `npm run test:db` (PostgreSQL local isolado, porta 55432, dados em `.local/pgdata`) | **304/304** em 25 arquivos (baseline: 294/294 em 24) |
| `npm run typecheck` (`tsc -b`) | exit 0 |
| `npm run build` | exit 0 (index 289,44 kB + AdminPage 301,60 kB separado) |
| `npm run bundle:functions` | **8/8** (admin-api, catalog, create-order, delivery, demo-payment, mp-webhook, order-request, order-status) |
| `npm audit --omit=dev` | **0 vulnerabilidades** |
| `git diff --check` | sem erros |

Infra: PostgreSQL 18.6 local via `scripts/local-db.mjs` (cluster em
`.local/pgdata`, isolado, sem tocar qualquer projeto remoto).

## 9. Grupo I — registro, commits e PR

- Este relatório: `docs/missao-11-preparacao-autonoma.md`.
- `docs/PROGRESSO.md` atualizado com o estado da Missão 11.
- Evidência visual: `docs/missao-11-evidencia/` (audit-report.json + PNGs).
- Commits organizados por grupo nesta branch; **PR para `main` aberto sem
  merge** (link no `PROGRESSO.md` ao final).

## 10. Prontidão de lançamento (percentual)

Rubrica ponderada — só itens verificáveis contam:

| Bloco | Peso | Status | Ganho |
| --- | --- | --- | --- |
| Código: suítes, typecheck, build, bundle, audit | 25% | ✅ verde (§8) | 25 |
| Segurança: auditoria + varredura dinâmica + testes novos | 15% | ✅ verde (§4) | 15 |
| Verificação visual 8 larguras com correções | 10% | ✅ 160/0 (§5) | 10 |
| Documentação (relatórios, PROGRESSO, WyviPay, evidências) | 10% | ✅ (§6, §9) | 10 |
| Migrações `0039`/`0040` aplicadas no projeto real | 10% | ❌ pendente do operador | 0 |
| Publicação das Edge Functions + smoke remoto revisado | 15% | ❌ bloqueado (conector desligado/credencial de deploy) | 0 |
| Administradores reais + TOTP + secrets finais + backup/PITR | 10% | ❌ pendente (pessoas/acesso) | 0 |
| Revisão jurídica + decisão de pagamentos (WyviPay D1–D11) | 5% | ❌ pendente | 0 |
| **Total** | **100%** | | **60%** |

**Prontidão de lançamento: 60%.** A missão **não** pode ser declarada pronta
para lançamento: seguem pendências operacionais importantes (publicação
remota, migrações novas, admins reais, verificação de backup, revisão
jurídica). A preparação autônoma — escopo desta missão — está **100%
concluída**.

## 11. Pendências e próximos passos (para o operador)

1. **Ligar o app supabase** nesta conversa e revalidar no remoto: migrações
   aplicadas (histórico M08), assinaturas RPC (0038), RLS, funções e secrets
   — sem expor valores.
2. **Aplicar `0039` e `0040`** no projeto real (revisão prévia dos arquivos;
   não reaplicar as demais).
3. **Publicar** as 8 funções a partir do código desta branch (manter
   `verify_jwt=true` no admin-api) e executar smoke revisado (o existente
   cobre 6 slugs, não 8).
4. Provisionar **administradores reais** com TOTP individual (roteiro
   comentado em `scripts/provision-admin.sql`).
5. Conferir **backup/PITR** no painel (timestamps, retenção, restauração
   disponível — sem restaurar).
6. Esclarecer a **tag M07** com evidência original antes de qualquer recriação.
7. **WyviPay:** decisões da etapa 0 + chave `wy_test_` (D1/D5) antes de
   qualquer implementação; ver `docs/wyvipay-integracao.md`.
8. **Revisão jurídica** de termos/reembolsos e definição do modelo de
   cobrança para o lançamento.

## 12. Declarações e limites

- Nada foi alterado no Supabase remoto; nenhum segredo foi exibido, criado ou
  alterado; nenhum admin real foi criado; nenhum TOTP de pessoa real foi
  gerado; nenhum pagamento/webhook/cobrança foi ativado; nenhum dado de
  cliente ou produção foi modificado; **nenhum merge na `main`**.
- Nenhum resultado foi inventado: todos os números vêm de execução real
  registrada neste relatório; endpoints WyviPay citados vêm do RELATORIO da
  Missão 08.
- Nenhum teste existente foi removido ou afrouxado; nenhuma proteção foi
  reduzida; falhas encontradas foram corrigidas e registradas (§5, §7).
- Apps **conectados mas desligados** (`google_drive`, `notion`, `supabase`)
  precisam ser ligados antes de qualquer uso — nenhum deles foi utilizado.

## Fontes internas

- `docs/auditoria/missao-08-wyvipay/RELATORIO.md` (pagamentos/WyviPay)
- `docs/missao-08-reconciliacao-supabase.md`, `docs/missao-09-fechamento-operacional.md`,
  `docs/missao-10-reconciliacao-final.md` (reconciliação)
- `docs/wyvipay-integracao.md` (síntese desta missão)
- `docs/missao-11-evidencia/audit-report.json` + PNGs (verificação visual)
- Execuções reais: `npm test`, `npm run test:db`, `tsc -b`, `vite build`,
  `bundle:functions`, `npm audit --omit=dev`, `audit.mjs` (160 checks)
