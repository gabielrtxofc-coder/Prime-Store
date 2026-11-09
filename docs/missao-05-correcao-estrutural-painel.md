# Missão 05 — Correção estrutural, responsividade e estabilização do painel administrativo

**Data:** 2026-11-09 · **Branch:** `arena/66cda9f6-prime-store` (fixada pela plataforma; ver Pendências) · **Commit-base:** `2571bd8` (contém `main` via `8f37527`)

> Objetivo: preservar o funcionamento atual do painel e corrigir a **estrutura** da
> interface (larguras, quebras, áreas de toque), sem redesenhar, sem novas
> funcionalidades e sem tocar em banco, RLS, pagamentos, Supabase ou regras de
> negócio. Nenhuma alteração de `.tsx` foi feita: toda a correção está em
> `src/styles.css` (regras aditivas no final do arquivo).

## 1. Auditoria — o que estava quebrado, por que e o que foi feito

Método real: build de demonstração (`VITE_BACKEND_ENABLED=true`, Supabase fictício
em `127.0.0.1:9`, `VITE_ADMIN_DEMO=true`) servido em `vite preview` (porta 4173);
Chromium headless (`@sparticuz/chromium` + `playwright-core`, com `LD_LIBRARY_PATH`
apontando para as bibliotecas AL2023 do próprio pacote) percorrendo, nos **9
tamanhos de referência** (320/360/375/390/414/768/1024/1280/1440), o login demo e as
abas Visão geral, Produtos, Estoque e Pedidos, incluindo as interações "Detalhes" em
Produtos e Pedidos. Métrica: `document.documentElement.scrollWidth` vs `innerWidth` e
retângulos dos elementos visíveis à direita da viewport (excluindo descendentes de
`.admin-table-wrapper`, onde a rolagem horizontal é intencional).

| # | Problema (antes) | Causa raiz | Correção (depois) |
|---|------------------|-----------|-------------------|
| P1 | Sistema/abas "Visão geral" estouravam ~656 px: a página ficava mais larga que 320–414 px (85/82/82/82/67 elementos fora) | `.admin-section` é grade de **coluna implícita** sem `grid-template-columns`: o trilho vira `max-content` do filho mais largo (métricas ~640 px) | `.admin-section { grid-template-columns: minmax(0, 1fr) }` + `> * { min-width: 0 }` |
| P2 | Barras de filtros ("Pedidos", detalhe do pedido) forçavam 418 px de largura | `min-content` dos `<select>` = texto da opção mais longa; itens flexíveis não encolhiam | `.admin-toolbar > * { min-width: 0 }`; `.admin-toolbar .form-control { flex: 1 1 170px; width: auto }`; `.admin-period` limitado a 100% e empilhado ≤ 560 px; `.admin-header__actions { flex-wrap: wrap }` |
| P3 | Painéis lado a lado em "Estoque" e no detalhe do pedido não cabiam em telas ≤ 360 px (418 px) | Pisos absolutos `minmax(320px, 1fr)` / `minmax(260px, 1fr)` acima da largura útil | `repeat(auto-fit, minmax(min(320px, 100%), 1fr))` e idem 240px nos detalhes |
| P4 | Histórico/eventos do detalhe do pedido cortava texto em telas estreitas | Trilhos fixos `140px 1fr auto` | ≤ 640 px empilha em `minmax(0, 1fr)` com gap 2px |
| P5 | Valores longos (digest/fingerprints, SKU, descrições) estouravam painéis e células | Falta de quebra de palavra | `overflow-wrap: anywhere` / `word-break: break-all` nas células e datas/valores; `min-width: 0` nos cabeçalhos de painel |
| P6 | Tabelas com cabeçalhos `white-space: nowrap` empurravam a página | (já correto: rolagem em `.admin-table-wrapper`; reforçado com `overscroll-behavior-x: contain` e `min-width: 620px` só ≤ 640 px para manter a hierarquia legível) | Página nunca rola na horizontal; só o contêiner da tabela rola (permitido explicitamente) |
| P7 | Alvos de toque pequenos nas abas e ações | Tamanhos definidos para mouse | Em `@media (pointer: coarse)`, `.admin-tab`, `.link-button` e botões de ação do painel passam a `min-height: 44px` |
| P8 | Painel de detalhe do pedido sem teto de largura | — | `.admin-order-detail { max-width: 100% }` |
| P9 | `input[type=file]` da importação CSV estourava 42 px em 320–360 px (era o único estouro remanescente) | Largura intrínseca do controle de arquivo | `.admin-page input[type='file'] { width: 100%; min-width: 0 }` |

**Severidades antes:** 12 telas com estouro de página (todas em 320–414 px). **Depois:**
0 telas com estouro em todos os 9 tamanhos (verificação automatizada) e em paisagem
667×375 (extra, fora da referência).

## 2. Evidência antes × depois (por tamanho de referência)

`scrollWidth/innerWidth` — valores iguais significam ausência de rolagem horizontal da página.

| Tela | 320 | 360 | 375 | 390 | 414 | ≥ 768 |
|------|-----|-----|-----|-----|-----|-------|
| Visão geral (antes) | 656/320 ✗ | 656/360 ✗ | 656/375 ✗ | 656/390 ✗ | 656/414 ✗ | OK |
| Visão geral (depois) | 320/320 ✓ | 360/360 ✓ | 375/375 ✓ | 390/390 ✓ | 414/414 ✓ | OK ✓ |
| Pedidos — detalhe (antes) | 418/320 ✗ | 418/360 ✗ | 418/375 ✗ | 418/390 ✗ | 418/414 ✗ | OK |
| Pedidos — detalhe (depois) | 320 ✓ | 360 ✓ | 375 ✓ | 390 ✓ | 414 ✓ | OK ✓ |
| Estoque (antes) | 362/320 ✗ | 362/360 ✗ | OK | OK | OK | OK |
| Estoque (depois) | 320 ✓ | 360 ✓ | 375 ✓ | 390 ✓ | 414 ✓ | OK ✓ |
| Produtos / detalhe / Pedidos | OK | OK | OK | OK | OK | OK |

Relatórios completos e capturas: `docs/missao-05-evidencia/audit-report-antes.json`,
`audit-report-depois.json` e `antes*/` / `depois*/` (capturas reais; conjunto integral
estava em `/tmp/visual-tools/shots` durante a verificação).

## 3. Validações executadas

- `npm run typecheck` — limpo.
- `npm test` — **118/118** (15 arquivos) — nenhuma asserção afrouxada.
- `npm run test:db` — **264/264** (21 arquivos) contra PostgreSQL local real.
- `npm run build` — OK (chunk admin separado: `AdminPage-*.js` 290,52 kB, gzip 73,24 kB).
- Auditoria visual automatizada — 9 larguras × 7 telas (login + 4 abas + 2 detalhes) = **63 capturas depois**, 0 estouros; re-teste também em 667×375 (paisagem, não referenciado, verificação extra).

## 4. Preservação (o que NÃO foi alterado)

Nenhuma alteração em: regras de negócio, cálculos (receita, totais), banco, migrações,
RLS/grants, Supabase (nome de tabelas/colunas/funções), autenticação/MFA, checkout,
pagamentos, pedidos (nenhum fluxo de aprovação criado), estoque automático,
integridade de pedidos, seeds, `package.json` (zero dependências novas), rotas,
conteúdos visíveis e textos. Zero alterações em `.tsx`/`.ts` de produção: só
`src/styles.css`.

## 5. Pendências e limitações documentadas

1. **Verificação em aparelho físico** não foi possível neste ambiente; a evidência é
   Chromium headless com emulação dos 9 tamanhos de referência (+ paisagem 667×375).
2. **Correção do early return em `AdminPage.tsx`** ("Painel indisponível" quando não há
   backend configurado e não há sessão demo — ignora `canUseAdminDemo()`) **não aplicada**:
   altera a lógica de visibilidade do painel, não a estrutura, e aguarda autorização
   explícita do responsável(a). Contornada apenas no preview de demonstração via flags de
   build; o código de produção não foi tocado.
3. **`input[type=file]` nativo** continua com a aparência do sistema operacional (não
   reestilizado, propositalmente — a missão proíbe redesenho estético).
4. Tabelas mantêm `min-width: 620px` e rolam dentro de `.admin-table-wrapper` em telas
   ≤ 640 px — rolagem **interna ao contêiner**, nunca da página (permitido pela missão).
5. Branch de trabalho fixada pela plataforma em `arena/66cda9f6-prime-store` (criação de
   branch própria bloqueada); `main` intacta; PR #2 permanece **draft**; nada foi mergeado.
