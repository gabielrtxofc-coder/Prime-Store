# Missão 07 — Ativação operacional, consolidação e fechamento

**Data:** 2026-11-09 · **Branch:** `arena/66cda9f6-prime-store` @ `f046a82`
(commit anterior: `cd87b3d`, missão 06) · **PR #2:** aberto, draft, intocado
(`head=f046a82` após o push) · **`main`:** `8f37527`, intacta · **tag de
segurança:** `safety/m07-start-cd87b3d`

> **Classificação geral: PARCIAL — ativação remota BLOQUEADA.**
> A parte que depende do projeto Supabase real (`eorlmqolbknrplvdbbtl`) **não
> foi executada nem pode ser comprovada nesta conversa**: o aplicativo
> Supabase conectado pelo usuário está **desligado (`disabled`)** e a rede
> deste ambiente não alcança `*.supabase.co` (conexão recusada, HTTP 000).
> Tudo o que era executável localmente foi feito e verificado; os itens
> remotos estão listados com precisão no §8. Nenhuma tarefa remota é
> declarada concluída.

---

## 1. Escopo e restrições cumpridas

- **Pagamentos:** nenhum código de Mercado Pago ou WyviPay foi lido,
  migrado, configurado ou publicado fora do que já existia; o diff da missão
  não toca `mercadopago.ts`, `mpWebhook.ts`, `mpSignature.ts`, telas de
  checkout ou webhooks (verificado por `git diff cd87b3d..HEAD --name-only`).
  A loja permanece no fluxo de solicitação sem cobrança.
- **Sem merge, sem deploy, sem publicação de frontend, sem alteração na
  `main`, sem apagar branches, sem "force push".**
- **Sem dados reais**: nenhum pedido, cliente, credencial ou e-mail real foi
  lido/alterado; nenhuma migração foi aplicada remotamente; nenhum e-mail ou
  notificação foi enviado; nenhuma chave foi exposta em commit/relatório.
- **`service_role` jamais** em código de navegador (o painel usa RPC com o
  JWT do próprio usuário + `assert_admin()` no banco).
- **RLS/AAL2/allowlist não foram afrouxados**; a migração 0038 apenas recria
  uma função administrativa mantendo o mesmo modelo de privilégios (revoga de
  `public`/`anon`, concede a `authenticated`/`service_role`).

## 2. Baseline registrado (início da missão)

| Verificação | Resultado |
|---|---|
| `node` / `npm` | v22.22.3 / 10.9.8 |
| `HEAD` inicial | `cd87b3d` (= remoto) |
| Árvore | limpa; 0 stashes |
| `npm test` (unit) | 118/118 ✓ |
| `npm run test:db` (PostgreSQL local 18.6) | 276/276 ✓ |
| Tag de segurança | `safety/m07-start-cd87b3d` |
| PG local de teste | recriado em `/tmp/pg-m07fresh` (:55432), descartável |

## 3. Bloqueio remoto — por que nada do ambiente real foi executado

1. `list_connector_tools("supabase")` retorna **`status: "disabled"`** nesta
   conversa (o usuário conectou o app, mas o deixou desligado).
2. Rede deste sandbox para `*.supabase.co`: **HTTP 000** (confirmado também
   em missões anteriores; nada mudou).
3. Consequência: publicação/atualização de Edge Functions, leitura/escrita de
   `PRIME_ENCRYPTION_KEY` e demais variáveis, aplicação das migrações 0034–0038
   no banco real, provisionamento dos 2 administradores reais, smoke test HTTP
   do ambiente real e indicadores reais **não foram executados**. Não inventamos
   evidência; nenhum item remoto é declarado PASS.
4. **Nenhum dado remoto foi lido** — nem mesmo para "conferir". O protocolo
   de ativação exige o app ligado; até lá, a única via segura é local.

## 4. Entregue localmente nesta missão

### 4.1 Diálogos de confirmação para ações destrutivas (missão 06 · pendência T232 — T048)

Novo componente `src/components/admin/ConfirmActionDialog.tsx` +
`useConfirmAction.ts`, aplicado em **todas** as ações sensíveis do painel:

| Origem | Ação | Confirmação |
|---|---|---|
| `AdminProducts` | Ativar/Desativar produto | dialog (desativar com `danger`) |
| `AdminStock` | Desativar/Reativar unidade | dialog + **motivo obrigatório** na desativação |
| `AdminStock` | Importar CSV para estoque | dialog (`danger`, após prévia) |
| `AdminOrders` | Revogar link de entrega | dialog (`danger`) |
| `AdminOrders` | Gerar novo link | dialog (consequence explícita) |
| `AdminOrders` / `AdminOverview` | Reembolso: Autorizar / Processado / Recusar | dialog por decisão (processado = `danger`, revoga entrega) |
| `AdminOrders` | Disputa: Reembolsar e encerrar / Reverter / Manter em análise | dialog (refund = `danger`) |
| `AdminOverview` | Liberar reservas vencidas agora | dialog (`danger`) |

Contrato do diálogo (verificado por 7 testes de componente):

- mostra o **registro afetado + consequência** em linguagem simples;
- foco inicial em **Cancelar**; Esc e clique no fundo cancelam;
- confirmar fica **desabilitado durante o processamento** e quando
  `confirmDisabled` (validação externa); sem duplo clique;
- Tab/Shift+Tab ciclam entre os botões visíveis;
- enquanto processa, Esc/fundo não fecham.

Correção de defeito encontrada pelos próprios testes: o efeito do diálogo
re-focava "Cancelar" a cada tecla digitada nos campos (callbacks recriados
por render). Corrigido com refs (`onCancelRef`, `busyRef`) — ver
`ConfirmActionDialog.tsx`.

### 4.2 Motivos categorizados de ajuste de estoque (T037 · fecha T068 da missão 06)

Migração `20261109130000_0038_motivos_ajuste_estoque.sql` (a 38ª; aplicada
limpa a partir de zero nos testes):

- enum `public.stock_adjustment_reason`: `inventory_adjustment`,
  `invalid_credential`, `compromised_credential`, `duplicate_import`,
  `data_correction`, `other`;
- `stock_units.status_reason` (nullable) e `stock_units.status_reason_note`
  (NOT NULL default `''`, `char_length ≤ 300`);
- `admin_set_stock_unit_status(uuid, text, text default null, text default '')`
  recriada (a assinatura antiga foi **removida** — uma única sobrecarga viva):
  - `disabled` ⇒ motivo **obrigatório**, precisa pertencer ao enum;
    `other` exige nota com ≥ 5 caracteres; nota > 300 é recusada;
  - `available` ⇒ motivo é **limpo** (reativação não carrega "pena");
  - tudo gravado em `admin_audit_log` (`stock_unit_status_changed` com
    `reason`/`note` no metadado);
- `admin_list_stock` passa a devolver `status_reason` e `status_reason_note`;
- privilégios reafirmados: revoga de `public`/`anon`, concede a
  `authenticated` e `service_role` (mesmo modelo da 0014/0022).

Gateway (`admin-api`): `stock.setStatus` valida antes do banco e responde
**422 estáveis** (`adjustment_reason_required`, `invalid_adjustment_reason`,
`adjustment_reason_note_required`) — o banco permanece a última barreira.
UI: o diálogo de desativação traz o `<select>` de motivo e a nota
(`other` ⇒ nota obrigatória), e a tabela mostra o motivo sob o status.
Modo demo espelha a mesma semântica.

### 4.3 Resiliência a falhas de infraestrutura (GRUPO 11 · T049–T052 · também fecha T199 da missão 06)

- **Auth fora do ar:** `verifyUser` agora captura a falha de rede do Auth e
  responde **503 `auth_unavailable`** (falha fechada — nunca autoriza),
  registrando `auth.unavailable` em log. Antes, o erro genérico subia para o
  fallback 500.
- **Queda total do banco:** coberta por suíte própria
  (`tests/unit/resilience_admin.test.ts`, 8 casos): conexão recusada não
  vaza `ECONNREFUSED` (resposta `500 internal_error` com mensagem fixa),
  erro desconhecido do PostgREST não vaza `relation ... does not exist` nem o
  código, `is_admin` com o rpc quebrado → `is_admin:false` (fail-closed),
  rate limit com o banco fora → fail-open registrado (`rate_limit.unavailable`)
  sem conceder decisão de autorização, chave ausente → `503 not_configured`
  **sem nenhuma chamada de negócio ao banco**.

### 4.4 Re-auditoria pós-mudança (GRUPO 12 · T053–T057)

Executada contra o PostgreSQL local recriado do zero (38 migrações):

| # | Verificação | Resultado |
|---|---|---|
| T053 | Tabelas sem RLS | **0** |
| T053 | Funções executáveis por `anon` | **nenhuma** |
| T053 | Executáveis por `authenticated` | somente `admin_*` (incl. nova `admin_set_stock_unit_status(uuid,text,text,text)`, 1 sobrecarga) + `is_admin` — allowlist exata |
| T053 | Funções de `0038` | enum com 6 valores; colunas e checks presentes; assinatura antiga removida |
| T054 | Varredura de segredos em 247 arquivos rastreados (JWT-like, chaves privadas, `sk_*`/`rk_*`/`whsec_*`, atribuição de `service_role`) | **nada encontrado** |
| T055 | Escopo do diff `cd87b3d..HEAD` | 18 arquivos, +1337/−91; **zero** arquivos de pagamento/checkout/webhook; `main` intacta; PR #2 OPEN draft; sem branches novas |
| T056 | Bundles das Edge Functions | **8/8** auto-contidos, sem `npm:`/`jsr:`/`esm.sh`/`deno.land`, bytes: admin-api 45.385, create-order 29.299, order-status 28.815, mp-webhook 26.437, demo-payment 26.226, delivery 22.790, order-request 22.226, catalog 19.589 |
| T057 | Consistência | `tsc -b` limpo; migrações 0001→0038 aplicam do zero nos testes (resetDatabase); suites 127 unit + 293 db verdes |

Observação honesta: a auditoria visual "54/54 nas 9 larguras" da missão
05/06 dependia de ferramenta de navegador que não existe neste repositório;
o re-teste visual completo **não** foi reexecutado. As adições de CSS
seguem os padrões existentes (`min-width: 0`, `overflow-wrap`, grid
responsivo) e os testes de componente cobrem o diálogo.

### 4.5 Três rodadas de verificação (GRUPO 15 · local, honesta)

**Rodada 1 — funcional.** Fluxos ponta a ponta no PostgreSQL real (local):
38 migrações do zero → regras de estoque, pedido multiproduto, entrega,
reembolso e admin-api HTTP→SQL verdes; novos casos de motivo de ajuste
(10 casos, incluindo injeção SQL no campo motivo — rejeitada pelo enum);
diálogos exercitados por testes de componente em todas as páginas.
**Resultado: PASS local.** (Nada disso comprova o ambiente remoto.)

**Rodada 2 — segurança e borda.** `anon` sem funções; allowlist AAL2;
rate-limit fail-open documentado; erros 4xx/5xx estáveis sem vazar internos;
injeção no motivo de ajuste recusada; motivo ausente/inválido/nota longa
recusados no gateway **e** no banco; segredos ausentes do repositório;
diálogo anti-duplo-clique + Esc-bloqueado durante processamento.
**Resultado: PASS local.** Nenhuma vulnerabilidade nova aberta; nenhum RLS
afrouxado.

**Rodada 3 — usuário real (usabilidade).** Revisão dirigida dos fluxos e dos
textos: foco inicial seguro, consequência explícita antes de revogar
entrega/reembolsar/desativar, modais com alvos de toque ≥ 44px em telas
`pointer: coarse`, aviso de auditoria ao exibir credenciais preservado,
erros com mensagem compreensível. **Limitação declarada:** nesta sessão não
houve navegador humano nem pulso de uso real; a verificação foi por leitura
dirigida do código + testes de componente (sem alegar "teste com usuários").

**T072 (consolidação):** nenhum item das três rodadas contradiz outro; a
única pendência aberta que não é de código é **o ambiente remoto**, listada
no §8.

### 4.6 Testes automatizados (GRUPO 16)

| Suíte | Resultado |
|---|---|
| `npm test` (unit + componente) | **127/127** (16 arquivos) |
| `npm run test:db` (unit + integração PG) | **293/293** (24 arquivos · inclui 10 casos novos de `21_stock_adjustment_reason`, 8 de `resilience_admin`) |
| Typecheck (`tsc -b`) | limpo |
| Build de produção (`vite build`) | OK (dist gerado; loja pública intacta) |
| Bundle Edge Functions | 8/8 |

Novas coberturas: motivos de ajuste (banco + gateway + UI), resiliência de
infraestrutura, contrato do diálogo de confirmação, diálogos integrados nos
fluxos (stock import/desativação, produtos, confirmação antes da ação).

## 5. Decisão de não aplicar migrações remotamente agora

A migração 0038 existe e foi validada localmente, mas **não** será aplicada
no Supabase real sem o app ligado nesta conversa e sem a confirmação do
projeto (`eorlmqolbknrplvdbbtl`) via protocolo pré-alteração: estado atual
de funções/migrações, janela de manutenção, impacto zero em dados reais
(0038 não toca linhas existentes — colunas nascem vazias). Como o app está
desligado, qualquer tentativa violaria a exigência de evidência real.

## 6. Protocolo pré-alteração remota (registro de estado — nada executado)

| Passo | Estado |
|---|---|
| Confirmar project-ref | **Não executado** (sem app) |
| Confirmar projeto (nome/org) | **Não executado** |
| Estado atual de funções/variáveis/migrações | **Não executado** |
| Backup/recuperação disponível | **Desconhecido** |
| Impacto em clientes/pedidos reais | 0038 não altera dados existentes; 0034–0037 (já revisadas na missão 06) também não destroem dados — mas nada foi aplicado agora |
| Registros identificados usados em teste | Nenhum (nenhum teste no real) |

## 7. Checklist de ativação da missão 06 — status nesta missão

| Passo do checklist | Situação em 2026-11-09 |
|---|---|
| Definir `PRIME_ENCRYPTION_KEY` (32B) no ambiente das functions | **BLOQUEADO** — aguardando app Supabase |
| Confirmar `STORE_URL` / `ALLOWED_ORIGINS` | **BLOQUEADO** |
| Empacotar e publicar as 8 Edge Functions (com 0038 embutida) | **BLOQUEADO** (bundle local pronto: 8/8) |
| Aplicar migrações pendentes no real (0033→0038) | **BLOQUEADO** (validadas apenas localmente) |
| Criar os 2 usuários Auth reais + `admin_users` (allowlist) / TOTP | **BLOQUEADO** — faltam dados reais dos 2 administradores (nomes, e-mails Auth) — ver §9 |
| Confirmar e-mail dos admins + AAL2 ativo | **BLOQUEADO** |
| Smoke HTTP do ambiente real (`scripts/smoke-edge-functions.mjs`) | **BLOQUEADO** |
| Decisão de pagamentos (fora do escopo desta missão) | **FORA DE ESCOPO** — loja segue solicitação sem cobrança |

## 8. Bloqueios remotos — lista exata para concluir a missão

Ligue o app **Supabase** nesta conversa (basta ativar; não é preciso
reconectar credenciais) e terei como executar e comprovar:

1. Registrar estado anterior (funções, migrações, variáveis) do projeto
   `eorlmqolbknrplvdbbtl`;
2. Aplicar migrações 0033→0038 no banco real e evidenciar RLS/grants finais;
3. Publicar/atualizar as 8 Edge Functions (admin-api com `stock.setStatus`
   + `verifyUser` 503; strings inalteradas para o resto);
4. Definir/confirmar `PRIME_ENCRYPTION_KEY` (32B), `STORE_URL`,
   `ALLOWED_ORIGINS` no ambiente das functions — sem imprimir valores;
5. Provisionar os 2 administradores **reais** (requer, da sua parte: nome de
   exibição, e-mail Auth real de cada conta, confirmação de e-mail e TOTP de
   cada um); rodar `scripts/provision-admin.sql` com os UUIDs reais e
   verificar `is_admin:true, mfa_satisfied:true` via `session`;
6. Smoke do ambiente real (`node scripts/smoke-edge-functions.mjs` com
   `SUPABASE_URL`/`SUPABASE_ANON_KEY` públicos) — loja pública, catálogo,
   order-request e `admin-api` com sessão AAL2;
7. Indicadores reais no painel contra o banco de produção (leitura apenas,
   com conta de teste identificada se você autorizar a criação; **jamais**
   pedidos/clientes reais);
8. T077 (usabilidade/indicadores no ambiente real) e demais tarefas remotas
   do escopo;
9. Rodada final de re-verificação pós-ativação e atualização deste relatório.

## 9. O que falta de você (inputs humanos)

- Ativar o app Supabase nesta conversa;
- Fornecer os dados reais dos 2 administradores (nome de exibição e e-mail
  Auth de cada um) quando chegarmos ao passo 5;
- Autorizar ou não a criação de **registros de teste claramente
  identificados** no ambiente real (ex.: `teste-m07-…@prime.invalid`) — sem
  e-mails reais, sem tocar pedidos/clientes existentes.

## 10. Commits desta missão

| Commit | Conteúdo |
|---|---|
| `f046a82` | feat(admin): motivos categorizados de ajuste de estoque, diálogos de confirmação e resiliência (missão 07) — 18 arquivos, +1337/−91 (inclui este relatório na sequência) |

## 11. Classificação final desta etapa

- **Local (código, banco local, testes, docs): CONCLUÍDA.**
- **Remota (ativação real): BLOQUEADA** — app Supabase desligado nesta
  conversa e sem rota de rede; nenhuma evidência de produção existe.
- **Missão como um todo: PARCIAL.** Não declaramos "CONCLUÍDA" sem a parte
  remota comprovada, nem classificamos como BLOQUEADA no todo, porque toda a
  parte executável localmente foi entregue e verificada.
