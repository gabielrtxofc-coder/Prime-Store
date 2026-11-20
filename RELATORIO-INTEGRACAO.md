# Relatório de preparação para integração — redesign v2

Data: 17/11/2026 · Branch de trabalho: `arena/b804eb72-prime-store` → destino `main`
**Nenhum merge foi feito e nada foi publicado.** Este documento é a evidência para a autorização.

Resumo em uma linha: o redesign é 100% front-end (CSS/JSX), nada foi gravado em banco nesta missão,
424 testes de banco + 162 de interface passam, e a limpeza do banco fica **parada aguardando sua
confirmação** porque os dados de teste que existem ali são anteriores a esta missão e têm dependências.

---

## 1. Dados de teste identificados e removidos

### 1.1 O que esta missão gravou em banco: nada

| Verificação | Resultado |
|---|---|
| `git diff --stat main...HEAD -- supabase src/services` | só `src/services/adminDemoData.ts` (2 linhas: caminho de imagem de fixture em memória) |
| Escritas de banco durante a missão | **nenhuma** — nenhum `INSERT/UPDATE/DELETE` foi executado |
| Smoke HTTP contra as Edge Functions | bloqueado pela rede do sandbox (`fetch failed`), portanto nenhuma função foi chamada |
| Fluxo de checkout exercitado nos testes de UI | rodou contra o mock local (`127.0.0.1:8787`), que só responde `GET /catalog` — nenhum pedido criado |

### 1.2 Removidos de fato (arquivos locais criados nesta missão)

| Item | Por quê | Situação |
|---|---|---|
| `shots/v2/` (23 PNGs, 9 MB) | capturas intermediárias de inspeção | removido |
| `shots/arte/home-destaques-desktop.png` | captura em branco (falha de `scrollIntoView`) | removido do repositório |
| `.cache/mock/catalog.mjs`, `.cache/shot/*.mjs` | catálogo falso e scripts de captura | **ignorados pelo Git** (`.cache/`), nunca saem do sandbox |

### 1.3 Encontrados, **não removidos** (aguardando sua confirmação)

Projeto Supabase `prime-store-sandbox` (`eorlmqolbknrplvdbbtl`), somente leitura até aqui:

| Objeto | Conteúdo | Por que não apaguei |
|---|---|---|
| `products` | 2 produtos “Produto de exemplo — acesso avulso/mensal”, `is_active = false`, criados em 31/10 | anteriores à missão e referenciados por pedidos |
| `orders` / `order_items` | 12 pedidos (31/10 a 16/11) / 6 itens | históricos de teste com pagamento e entrega vinculados |
| `payments` / `payment_events` | 4 / 3 | dependem de `orders` (FK) |
| `stock_units` / `deliveries` | 27 / 4 | unidades vendidas/reservadas ligadas aos pedidos |
| `order_events` / `admin_audit_log` | 26 / 3 | trilha de auditoria — apagar contradiz a política do próprio painel |
| `_revoke_probe` (tabela) | 1 coluna, sobra de teste de revogação | não foi criada nesta missão |
| `src/services/adminDemoData.ts` | fixtures fictícias em memória (2 produtos, 5 pedidos) | é o modo demonstração do painel, não é dado persistido |
| `src/data/products.ts` | catálogo local legado, **sem nenhum import** | código morto, anterior à missão |

**Por que parei aqui:** a instrução foi remover “somente os dados de demonstração criados durante esta
missão”. Nada do que está no banco foi criado nesta missão, e os objetos têm dependências em cascata
(pedido → pagamento → entrega → estoque → auditoria). Apagar sem sua confirmação seria exatamente a
“limpeza indiscriminada” que você proibiu.

**Plano proposto (não executado, um comando por etapa, com contagem antes/depois):**

1. `pg_dump` lógico das 8 tabelas envolvidas para um arquivo local (backup antes de qualquer `DELETE`).
2. Arquivar em vez de apagar: renomear os 2 produtos para `[arquivado] …` e manter `is_active = false`.
3. Se você quiser os pedidos fora do painel: `UPDATE orders SET status = 'cancelled'` (não `DELETE`),
   preservando pagamentos, entregas e auditoria.
4. `DROP TABLE _revoke_probe` (isolada, sem FK) — único objeto realmente descartável.
5. Conferência final: mesmas contagens de `payments`, `deliveries` e `admin_audit_log`.

Qualquer `DELETE` definitivo precisa da sua palavra explícita, item por item.

---

## 2. Dados preservados

- **Banco do projeto sandbox:** 2 produtos, 12 pedidos, 6 itens, 4 pagamentos, 3 eventos de pagamento,
  27 unidades de estoque, 4 entregas, 26 eventos de pedido, 3 registros de auditoria, 5 categorias.
- **Configuração do projeto:** `app_settings` com 8 chaves (`demo_payments_enabled = false`,
  `max_items_per_order = 10`, `max_quantity_per_order = 20`, `pix_expiry_minutes = 30`,
  `reservation_minutes = 30`, `admin_bootstrap_created_count = 2`).
- **Segredos das Edge Functions:** 14 nomes configurados (`SUPABASE_*`, `STORE_URL`, `ALLOWED_ORIGINS`,
  `SETUP_ADMIN_CODE`, `DEMO_*`, `WYVI_API_KEY`, `WYVI_WEBHOOK_SECRET`). Nenhum valor foi lido, copiado
  para arquivo ou impresso — o conector devolve hash.
- **Código de produção:** `supabase/functions/**`, `supabase/migrations/**`, `src/services/**`
  (exceto as 2 linhas de fixture) intactos.

---

## 3. Auditoria por área (Etapa 2)

| Área | Situação | Evidência |
|---|---|---|
| Cadastro de produto | ✅ cria | `adminApi.createProduct` chamado pelo formulário; 18 campos no teste de UI; `adminProductsUx.test.tsx` |
| Edição de produto | ✅ edita | mesmo formulário com slug travado; `adminApi.updateProduct` |
| Upload de imagens | ⚠️ **não existe upload** | o modelo aceita apenas `image_url` (texto). Não há bucket, rota nem função de upload. Prévia e fallback de monograma funcionam; upload real exigiria Storage + contrato novo |
| Gerenciamento de imagens | ✅ via URL | prévia no formulário, miniatura na lista, capa na loja e no detalhe |
| Estoque | ✅ | `stockSummary`, `listStock`, `addStock`, `updateStock`, `setStockStatus`, `previewImport`, `commitImport`; testes `21_stock_adjustment_reason`, `04_admin_delivery` |
| Preços | ✅ | `price_cents` inteiro; margem calculada no formulário; `product_price_history` coberto por `06_hardening_integridade` |
| Publicação | ✅ | `is_active` via `adminApi.setProductActive`; catálogo público filtra ativos (`25_saneamento_catalogo`) |
| Navegação administrativa | ✅ | shell com sidebar + menu móvel, `aria-current`, `adminNavigationUx.test.tsx`, smoke de UI |
| Carrinho e compra | ✅ | contador, quantidade máxima, checkout com validação e bloqueio de envio; `checkoutService.test.ts`, `17/18` de pedido multiproduto |
| WyviPay | ✅ integração presente e **intocada** | `create-order` → cobrança PIX; fallback só em `payment_not_configured`; `wyvipay.ts` + `24_wyvipay_fluxo.test.ts` |
| Webhooks / atualização de pedido | ✅ | `wyvi-webhook` valida HMAC `X-Wyvi-Assinatura` (v1, janela ±300 s, comparação em tempo constante) antes de escrever; sem segredo responde 503 (fail-closed) — `11_webhook_assinatura`, `26_wyvi_worker_handler` |
| Responsividade | ✅ | sem rolagem lateral em 1440/768/390/360; tabelas viram cartões; capturas em `shots/final/` e `shots/arte/` |

Nada disso foi alterado pela branch: a auditoria confirma que o redesign é camada de apresentação.

---

## 4. Testes executados e resultados (Etapa 3)

| Suíte | Comando | Resultado |
|---|---|---|
| Interface + unidade | `npm test` | **23 arquivos / 162 testes** ✅ |
| Banco + unidade (Postgres 18 real, todas as migrações) | `npm run db:local` + `vitest --config vitest.db.config.ts` | **34 arquivos / 424 testes** ✅ |
| Build de produção | `npm run build` | ✅ CSS 118 kB · JS 325 kB · chunk admin 328 kB |
| Typecheck | `npx tsc -b` | ✅ sem erros |
| Smoke funcional de UI (Chromium headless + mock) | `.cache/shot/smoke-ui.mjs` | **18/18 verificações** ✅ |
| Checkout com backend indisponível | `.cache/shot/smoke-checkout-offline.mjs` | erro tratado, sem crash ✅ (mensagem genérica — ver §7) |
| Smoke HTTP das Edge Functions implantadas | `npm run smoke:functions` | ❌ **não executado**: a rede do sandbox só libera GitHub/npm/PyPI (`fetch failed`). Script é read-only e está pronto para rodar de outra máquina |

Verificações funcionais do smoke de UI: catálogo com 8 produtos vindos do servidor, 8 capas carregadas,
busca filtrando, painel de compra, item no carrinho, checkout abrindo com resumo, envio bloqueado com
formulário vazio, envio liberado com dados válidos, sidebar, lista de produtos, formulário com 18 campos,
abas de estoque e pedidos, sem rolagem lateral em 390/360/768 px, zero erro de runtime.

**Ambiente de teste:** Postgres embutido em `127.0.0.1:55432` + mock local em `127.0.0.1:8787`.
Nenhum pagamento real, nenhum pedido real, nenhuma cobrança criada.

---

## 5. Integração de pagamentos (situação)

- **WyviPay:** fluxo `create-order` → cobrança PIX → `wyvi-webhook` → atualização de pedido/entrega.
  Código não modificado nesta branch. Segredos `WYVI_API_KEY` e `WYVI_WEBHOOK_SECRET` estão configurados
  no projeto (valores não lidos).
- **Modo demonstrativo de pagamento:** desligado. As três travas existem e a terceira
  (`app_settings.demo_payments_enabled`) está **`false`**.
- **Mercado Pago:** caminho legado, só ativa com `MERCADO_PAGO_LEGACY_ENABLED=true`.
- ⚠️ **Risco operacional:** como há chave WyviPay configurada no projeto sandbox, um clique real em
  “Finalizar pedido” naquele ambiente pode gerar cobrança de verdade. Todos os testes desta missão
  rodaram contra o mock local, nunca contra o projeto.

---

## 6. Branch, commits e merge (Etapa 4)

**Origem:** `arena/b804eb72-prime-store` (base `8a9afbc` de `main`) · **Destino:** `main`

- `main` **não avançou** desde a criação da branch → `git merge-base --is-ancestor main HEAD` = verdadeiro,
  ou seja, **merge fast-forward, sem conflitos**.
- Arquivos tocados: 16 de código/config (`src/**`, `styles-v2.css`, `vite.config.ts`, `.gitignore`) +
  documentação + imagens de evidência. Nenhum arquivo de backend.
- `git diff --check` limpo · nenhum `.env`/chave versionada · varredura de segredos no diff: nada.
- `vite.config.ts` mudou **apenas** em `server.proxy` (dev). O build não referencia `/mock` (verificado no
  `dist/`), então produção não é afetada.
- `vercel.json`, `supabase/**`, `scripts/**`, `tests/**`: intactos.
- Nenhuma chamada de API removida nos arquivos alterados (diff conferido: só trocas de markup/classe).
- Resultado visual aprovado: preservado — `shots/final/` (19 capturas) e `shots/arte/` (loja com capas).

**Commits da branch:**

```
f516cdc feat(demo): capas reais e dois produtos novos no catálogo de demonstração
e8cf21e feat(ui): redesign visual v2 do painel e da loja
c43cb0f docs(ux): relatório do protótipo de usabilidade
0cf6111 feat(ux): reorganiza cadastro de produtos e navegação do painel
```

Commit final desta preparação: o commit que acompanha este relatório (hash no fim desta entrega).

---

## 7. Pendências e riscos

| # | Item | Gravidade | Ação sugerida |
|---|---|---|---|
| 1 | Limpeza do banco depende da sua confirmação (§1.3) | média | aprovar o plano de arquivamento, não de `DELETE` |
| 2 | Smoke HTTP das funções implantadas não rodou (rede bloqueada) | média | rodar `npm run smoke:functions` de uma máquina com rede e a anon key |
| 3 | Chave WyviPay ativa no projeto sandbox | **alta** (operacional) | não finalizar pedidos reais nesse ambiente; usar chave de teste com prefixo `wy_test_` |
| 4 | Upload de imagem não existe (só `image_url`) | baixa (documentada) | tratar como nova missão com Storage e contrato próprio |
| 5 | Mensagem de erro do checkout é genérica (“Registro não encontrado.”) quando o servidor responde `not_found` | baixa | melhorar o mapa de erro para “Não foi possível registrar o pedido” |
| 6 | 8 capas de demonstração (1,1 MB) em `public/produtos/` entram no build | baixa | **decisão sua**: manter (paridade com o modo demonstração) ou remover antes do merge |
| 7 | Fixtures fictícias do painel viajam no chunk do admin | baixa | já era assim em `main`; carregadas só com `VITE_ADMIN_DEMO=true` |
| 8 | `src/data/products.ts` é código morto | baixa | remover em limpeza separada |
| 9 | Tabela `_revoke_probe` sobrando | baixa | `DROP` isolado após sua confirmação |
| 10 | `python`/PIL ausente no sandbox não afeta nada do produto | informativa | — |

---

## 8. O que falta para eu executar o merge

1. Sua autorização explícita.
2. Decisão sobre o item 6 (manter ou remover as capas de demonstração).
3. Decisão sobre o item 1 (limpar o banco ou deixar como está) — nada será apagado sem isso.

Com o “pode fazer o merge”, o comando é `gh pr merge` / `git merge --ff-only main` seguido de push;
enquanto isso, a branch fica publicada mas intocada no destino.

---

# Adendo — respostas às suas três decisões (17/11/2026)

## 1. Merge para `main` dispara deploy de produção na Vercel? **Sim.**

Verificado no projeto Vercel `prime-store` (`prj_pVhaf3jVffFX24OK5GjAZNZz4vvC`):

| Configuração | Valor |
|---|---|
| Repositório ligado | `gabielrtxofc-coder/Prime-Store` (GitHub) |
| **Production Branch** | **`main`** |
| `gitProviderOptions.createDeployments` | `enabled` |
| Ignored Build Step (`commandForIgnoringBuildStep`) | `null` (nenhum) |
| Build | `npm ci` → `npm run build` → `dist` |
| Produção atual | deploy `dpl_HvSgZWC…` do commit **`8a9afbc`** (merge do PR #10), estado `READY/PROMOTED`, alias **`prime-store-gilt.vercel.app`** |

Histórico confirma o gatilho: **cada PR mergeado na `main` (#6 a #10) gerou um deploy `target: production`
promovido automaticamente** para o alias público. Nossa branch, por sua vez, só gera *preview* — o push do
commit `11090d6` criou um deploy `target: null` com alias `…-git-arena-b804eb-67fe4f-….vercel.app`.

**Conclusão:** ao mergear, a Vercel publica sozinha em produção em segundos. Nenhum merge foi feito, então
nada foi publicado.

Três formas de evitar a publicação automática, se você quiser mergear sem ir ao ar (todas reversíveis):

| Opção | Como | Efeito |
|---|---|---|
| A | aceitar o deploy | o redesign entra no ar em `prime-store-gilt.vercel.app` |
| B | `vercel.json` com `"git": { "deploymentEnabled": { "main": false } }` | a Vercel ignora builds da `main`; remover a chave reativa |
| C | mergear e, em seguida, promover de volta o deploy `8a9afbc` ("Rollback") no painel | janela de poucos segundos no ar com a versão nova |

⚠️ **Contexto importante:** as variáveis de produção deste projeto apontam para o Supabase **sandbox**
(`VITE_SUPABASE_URL=https://eorlmqolbknrplvdbbtl.supabase.co`, `VITE_SUPABASE_ANON_KEY` do projeto demo,
`VITE_BACKEND_ENABLED=true`, `VITE_ADMIN_DEMO=false`). Ou seja, "produção" hoje é um site de demonstração
apontando para o banco de testes — e com `WYVI_API_KEY` configurada. Vale decidir isso antes do go-live.

## 2. Imagens de demonstração: mantidas

- `public/produtos/` com as **8 capas** (1,2 MB) versionadas em `f516cdc`; nada foi removido.
- Continuam referenciadas pelas fixtures do modo demonstração (`adminDemoData.ts`) e pelo mock local, então
  a apresentação aprovada segue idêntica (`shots/final/` e `shots/arte/`).
- Consequência aceita: 1,2 MB de estáticos no `dist` (não são requisitadas em produção, pois o catálogo real
  vem do backend).

## 3. Banco: lista exata, origem comprovada e backup verificado

### 3.1 Lista exata dos registros de teste (projeto `eorlmqolbknrplvdbbtl`)

**Produtos (2) — já arquivados, não precisam de ação**

| Produto | Flags | Criado | `archived_at` | Unidades | Itens |
|---|---|---|---|---|---|
| `f8c3c8f2…` Produto de exemplo — acesso avulso | `is_demo=true`, `is_active=false` | 31/10 00:34 | **16/11 15:06** | 13 | 2 |
| `23d8f61c…` Produto de exemplo — acesso mensal | `is_demo=true`, `is_active=false`, `is_featured=true` | 31/10 00:34 | **16/11 15:06** | 14 | 4 |

**Pedidos (12) — nenhum tem coluna de arquivamento**

| Referência | Estado | Pagamento | Total | Criado | Itens/Pagto/Entrega |
|---|---|---|---|---|---|
| PS-DL28KM | paid | approved | R$ 29,90 | 31/10 15:41 | 0/1/1 |
| PS-X2KL5N | paid | approved | R$ 29,90 | 01/11 02:35 | 0/1/1 |
| PS-Q56ZCP | paid | approved | R$ 29,90 | 01/11 03:11 | 0/1/1 |
| PS-3PXQ75 | failed | pending | R$ 29,90 | 01/11 03:49 | 0/0/0 |
| PS-3GN6P2 | failed | pending | R$ 29,90 | 01/11 04:01 | 0/0/0 |
| PS-5NG8C2 | expired | pending | R$ 29,90 | 01/11 04:01 | 0/0/0 |
| PS-RHT8MA | expired | pending | R$ 29,90 | 01/11 06:12 | 0/0/0 |
| PS-S2SDYS | requested | not_required | R$ 129,70 | 01/11 07:11 | 2/0/0 |
| PS-5AA364 | requested | not_required | R$ 59,80 | 13/11 13:23 | 1/0/0 |
| PS-GTW9UY | requested | not_required | R$ 49,90 | 13/11 13:51 | 1/0/0 |
| PS-VGA3S7 | paid | approved | R$ 29,90 | 16/11 14:02 | 1/1/1 |
| PS-WBCLBE | failed | pending | R$ 29,90 | 16/11 22:37 | 1/0/0 |

**Demais objetos**

| Objeto | Qtd | Marcador de origem |
|---|---|---|
| `order_items` | 6 | **100% ligados aos 2 produtos `is_demo`** |
| `payments` | 4 | **`provider = 'demo'`** em todas (PIX demonstrativo, `approved`) |
| `deliveries` | 4 | vinculadas aos pedidos `paid` acima; 0 revogadas |
| `stock_units` | 27 | **`is_demo = true` em 27/27** (0 unidades reais) |
| `order_events` | 26 | histórico dos 12 pedidos acima |
| `payment_events` | 3 | eventos dos pagamentos demo |
| `admin_audit_log` | 3 | registros de operação do painel (mantidos) |
| `refund_requests` | 0 | — |
| `_revoke_probe` (tabela) | 0 linhas | sobra de teste de revogação, vazia |

**Origem comprovada:** o catálogo inteiro é `is_demo`; todo estoque é `is_demo`; todo pagamento tem
`provider = 'demo'`; nenhum item aponta para produto fora dos dois de exemplo. Não existe receita real
nesse projeto.

### 3.2 Backup: existe e foi testado

| Item | Valor |
|---|---|
| Arquivo | `.backups/produtos-demo-2026-11-17.sql` (fora do Git — `.gitignore`, por conter dados) |
| SHA-256 | `94b17386e88ade38c92b198ff9097207e191dbacf9ed5af31c354737eb52752e` |
| Conteúdo | `INSERT` completo das 2 linhas de `products`, com `ON CONFLICT (id) DO NOTHING` |
| **Teste de restauração** | aplicado em Postgres 18 local com todas as migrações → **2 linhas** e fingerprint **`7781da84ca091709382344d8ec917fa7`**, idêntico ao do projeto |

Restaurar = rodar esse arquivo; nada é sobrescrito.

Para os pedidos/pagamentos, a recuperação hoje dependeria de backup do provedor: o projeto é **Hobby**
(sem PITR, sem backup diário gerenciado), então **não existe snapshot automático** — só o export manual.

### 3.3 O que foi executado

**Nada.** O arquivamento dos produtos **já estava feito** (`archived_at` em 16/11 15:06, `is_active=false`,
`is_demo=true`) — não havia o que arquivar de novo. Nenhum `INSERT`, `UPDATE`, `DELETE` ou `DROP` foi
executado no projeto nesta rodada; a única escrita foi em hardware local (`.backups/` e Postgres de teste).

**Recomendação para os pedidos:** não mudar `orders.status` (o cancelamento dispara liberação de reserva e
altera `stock_units`, o que não é reversível de forma limpa). Em vez disso, uma migração pequena e reversível
adicionando `orders.archived_at` (mesmo padrão de `products`), e o painel passa a filtrar por ela. Fica como
tarefa separada, para você decidir.

`_revoke_probe` está vazia: pode ser removida (`DROP TABLE`) em uma limpeza avulsa — não executei porque é
destrutivo.

## 4. Situação final

| Item | Estado |
|---|---|
| Branch | `arena/b804eb72-prime-store` (publicada, sem merge) |
| Commit | `11090d6` + este adendo |
| Merge | **não executado**, aguardando sua autorização |
| Deploy | nenhum deploy disparado por esta preparação além do *preview* automático já existente |
| Imagens | 8 capas mantidas |
| Banco | intacto; arquivamento dos produtos já vigente; backup verificado |
| Testes | 162 (interface) + 424 (banco/sistema) + build + 18 verificações de UI |

**Pendências para a autorização do merge:** escolher A, B ou C do item 1 (o que acontece com o deploy) e
dizer se quer o `archived_at` em `orders` como missão separada.

---

# Opção B aplicada — deploy automático da `main` desativado

`vercel.json` passou a declarar:

```json
{
  "git": {
    "deploymentEnabled": {
      "main": false
    }
  },
  "rewrites": [ ... ]
}
```

Como funciona: a Vercel lê essa chave no commit que chega ao branch e **ignora a criação de deploy**
para o branch listado. As demais branches continuam gerando *preview* normalmente (foi assim que os
previews desta missão apareceram). O deploy de produção existente **não é removido nem promovido** —
o alias `prime-store-gilt.vercel.app` continua servindo o deploy atual.

**Para reativar a publicação automática** (qualquer uma das duas formas):

1. Remover o bloco `"git"` do `vercel.json` (ou trocar `false` por `true`), commitar e mergear; o próximo
   push na `main` volta a gerar produção.
2. Ou, no painel da Vercel, **Deploy Hooks / Deploy** manual ou o botão *Redeploy* no commit desejado.

Nada foi alterado em variáveis de ambiente, banco de dados, credenciais da WyviPay ou domínios.
