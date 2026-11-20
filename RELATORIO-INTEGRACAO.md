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
