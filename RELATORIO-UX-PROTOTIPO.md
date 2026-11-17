# Missão UX & Usabilidade — Prime Store (protótipo isolado)

> **Escopo:** melhoria de usabilidade, organização e apresentação da aplicação existente.
> **Não é** reconstrução, rebranding, nova funcionalidade administrativa, alteração de contrato de API,
> de banco, de pagamento, de autenticação ou de regra de negócio.
>
> - Branch: `arena/b804eb72-prime-store` (base `8a9afbc`)
> - Commits: `0cf6111` (implementação) e o commit deste relatório
> - Produção: **não alterada, não publicada**. Nenhuma migração, nenhum acesso ao banco real,
>   nenhuma operação de pagamento, nenhuma mudança de credenciais/variáveis de ambiente.

---

## A. Diagnóstico inicial

Reconhecimento feito antes de qualquer alteração (leitura de `src/`, testes existentes, `docs/`,
`adminApi`/contratos e `styles.css`). A base estava verde: `npm ci` + `npm test` → **21 arquivos,
151 testes, todos passando** antes das mudanças.

| # | Onde | Problema | Por que prejudica | Melhoria aplicada | Benefício |
|---|---|---|---|---|---|
| 1 | `AdminProducts.tsx` — formulário | 18 campos em uma grade única e plana, sem blocos | Quem nunca usou não sabe onde cada informação começa/termina; parece um "paredão" | 5 seções numeradas (Informações, Imagens, Preços, Estoque e validade, Publicação e aparência) | Tarefa vira previsível: dá para varrer o que falta olhando os títulos |
| 2 | idem | Nenhum campo marcado como obrigatório | Erro só aparece depois de tentar salvar | Marcador `*` + nota no topo + `required`/`aria-invalid` | Menos tentativa e erro |
| 3 | idem | Erros somente em um alerta no topo, longe do campo | Usuário precisa procurar qual campo falhou, especialmente no celular | `<p class="field-error">` abaixo de cada campo + `aria-describedby` + foco no primeiro inválido | Correção direta no ponto do erro |
| 4 | idem | Sem dicas de preenchimento (só "instruções") | Dúvida sobre formato de preço, slug, monograma, validade | Dica curta em cada campo (`field-hint` ligada por `aria-describedby`) | Autonomia sem suporte |
| 5 | idem — imagem | Campo de URL de texto, sem prévia, sem indicação do que aparece sem imagem | Não há como saber se a imagem carrega; risco de publicar produto sem arte | Prévia ao lado (4:3), mensagem de fallback do monograma, botão "Limpar imagem", validação de URL | Confiança antes de salvar |
| 6 | idem — preço | Nenhuma leitura de margem | Custo digitado não conversa com o preço | "Margem estimada" calculada ao vivo (apenas leitura) | Decisão comercial mais rápida |
| 7 | idem — salvamento | Botão apenas no fim do formulário; sem estado de envio | Em formulário longo o botão "desaparece"; cliques repetidos | Barra de ações fixa no rodapé do formulário + `Salvando…` desabilitado | Ação sempre visível e com feedback |
| 8 | idem — perda de dados | Trocar de produto/aba descartava o preenchimento silenciosamente | Trabalho perdido sem aviso | Diálogo "Descartar alterações?" reutilizando `ConfirmActionDialog` | Segurança contra perda acidental |
| 9 | idem — edição | Mesmo formulário (bom), mas sem contexto do que está sendo editado | Risco de editar o produto errado | Cabeçalho "Editar produto", aviso "Editando …", resumo da publicação, "Cancelar edição" | Consistência criar/editar sem ambiguidade |
| 10 | `AdminPage.tsx` | Abas só com texto; nada indica o que cada área faz | Navegação exige memorização | Ícone + rótulo, `aria-current`, título e descrição da seção aberta | Orientação imediata |
| 11 | Lista de produtos | 8 colunas densas; ações em link de texto; estoque como número solto | Difícil identificar produto, imagem e urgência de estoque | Miniatura + nome/slug, selo de estoque (`disponível`/`estoque baixo`/`sem estoque`) com contagem, ações com "Ativar" quando inativo | Leitura em varredura |
| 12 | `AdminOverview.tsx` | 5 + 11 indicadores no mesmo peso visual | Nada se destaca; receita se perde | Receita em destaque, grupos "Receita e vendas", "Estoque", "Riscos e atendimento", "Produtos e entregas" | Hierarquia de leitura |
| 13 | `AdminOrders.tsx` / visão geral | Status exibidos como código cru (`requested`, `not_required`) | Vocabulário de banco vazando para o operador | Selo legível (`solicitação`, `sem cobrança`, `pago`…) **com o código cru preservado abaixo** | Menos erro de interpretação, rastreabilidade mantida |
| 14 | `AdminOrders.tsx` / `AdminStock.tsx` | Filtros soltos na mesma linha do conteúdo | Difícil separar "onde filtro" de "o que estou vendo" | Painel de filtros com rótulos curtos + ação "Limpar filtros" (pedidos) | Fluxo de consulta mais claro |
| 15 | `AdminStock.tsx` | Formulário de unidade com inputs sem `form-control`, sem dicas, sem estado de envio | Visual inconsistente e dúvida sobre o que é gravado | Campos padronizados, obrigatórios marcados, dicas, `Cadastrando…` | Consistência com o resto do painel |
| 16 | Loja pública — cartão | Preço e disponibilidade competindo; hierarquia fraca | Compra exige esforço de leitura | Preço maior, legenda de disponibilidade alinhada, botões com altura mínima e toque adequado | Decisão de compra mais rápida |
| 17 | Loja — página do produto | Bloco de preço sem destaque; nenhum sinal de escassez; quantidade sem total | Usuário não vê o que vai pagar/solicitar | Bloco de preço com contorno, "Últimas N unidades", "Total estimado" ao mudar a quantidade, ação principal larga no celular | Transparência antes de adicionar ao carrinho |
| 18 | Mobile (painel) | Abas quebravam linha, tabelas com rolagem e formulário de 18 campos em coluna única | Navegação e cadastro desconfortáveis | Abas em grade 2×2, filtros empilhados, seções com respiro, barra de salvar fixa, alvos ≥ 44 px | Uso real no celular |

---

## B. Melhorias implementadas (resumo por área)

1. **Cadastro de produto** — reorganização completa da apresentação (seções A–E), sem tocar no payload,
   nas validações de negócio ou no contrato com `adminApi`.
2. **Painel** — navegação com ícones/descrições e seção atual explícita; indicadores agrupados;
   status legíveis; listas com contexto visual; filtros agrupados.
3. **Estoque** — formulário consistente com dicas e estado de envio; filtros rotulados.
4. **Loja pública** — hierarquia de cartão/preço, bloco de preço do produto, aviso de últimas unidades,
   total estimado, toolbar responsiva, contraste e alvos de toque.
5. **Testes** — duas suítes novas de usabilidade (11 testes) + as 151 existentes preservadas.

Nada foi duplicado: as telas continuam usando `ConfirmActionDialog`, `PeriodFilter`, `Icon`,
`useConfirmAction`, `adminApi` e os mesmos componentes de listagem/estado.

---

## C. Cadastro de produtos — antes × depois

### Antes

- Grade única com 18 campos (nome, slug, categoria, preço, custo, qtd. máxima, validade, rótulo,
  descrição curta, descrição, instruções, condições, modalidade, período, monograma, tema, URL de
  imagem, destaque).
- Erro só no alerta do topo; campos obrigatórios sem marca; imagem sem prévia.
- Botão de salvar apenas no fim; nenhuma proteção ao descartar; sem resumo.

### Depois

| Seção | Conteúdo | Ajuda embutida |
|---|---|---|
| 1. Informações principais | Nome*, slug (auto a partir do nome), categoria, modalidade, período, descrição curta, descrição completa | "Aparece no catálogo e no pedido", prévia do endereço final, slug travado na edição com explicação |
| 2. Imagens | URL da imagem + prévia 4:3 + "Limpar imagem" | Fallback explícito do monograma, erro de carregamento, validação `http(s)` |
| 3. Preços | Preço de venda*, custo de aquisição | Margem estimada ao vivo (valor e %) |
| 4. Estoque e validade | Qtd. máxima por pedido, validade em dias, rótulo da validade | Faixas aceitas (1–20, 1–3650) e onde cadastrar as unidades |
| 5. Publicação e aparência | Monograma, tema, instruções, condições, destaque | Onde o produto aparece, aviso para não colocar senhas |

**Comportamentos novos (todos de apresentação/estado):**

- Obrigatórios com `*` + `required`; erro inline + `aria-invalid` + foco no primeiro campo inválido.
- Resumo vivo antes de salvar: `Nome · Categoria · Preço · Publicado/Não publicado/Novo produto`.
- Barra de ações fixa: `Criar produto` / `Salvar alterações` + `Cancelar edição`, com `Salvando…`.
- Aviso de sucesso em `role="status"` (recebe foco, então leitores de tela anunciam).
- Diálogo "Descartar alterações?" ao trocar de produto, iniciar um novo ou cancelar edição com
  alterações pendentes.
- Criação e edição usam **o mesmo** formulário e as mesmas mensagens; na edição o slug fica
  desabilitado e o `PATCH` continua sem `slug` (contrato intacto).
- Lista de produtos acima do formulário ganha miniatura, slug, selo de estoque com contagens
  (disponível/reservada/vendida) e ação "Ativar" para inativos (a desativação segue com diálogo).

**O que NÃO mudou:** campos, tipos e nomes do payload (`price_cents`, `cost_cents`,
`access_validity_days`, `conditions[]`, `image_url`, `is_featured`, etc.), validações de negócio
(`> 0`, `1–20`, custo ≥ 0), slug gerado na criação, ausência de exclusão física, histórico de preço.

---

## D. Painel administrativo

- **Navegação:** cada aba tem ícone + rótulo; a aba atual tem `aria-current="page"` e fundo próprio;
  abaixo da barra aparece o título da seção com uma frase explicando o que se faz ali. No celular as
  abas viram uma grade 2×2 com borda e alvo de 44 px.
- **Visão geral:** receita do período em cartão de destaque; indicadores acumulados agrupados por
  assunto (receita/vendas, estoque, riscos/atendimento, produtos/entregas), mantendo todos os rótulos
  e critérios anteriores (inclusive `paid + refund_pending`).
- **Pedidos e recentes:** selo legível por estado/pagamento com o código cru em texto pequeno abaixo
  (auditoria e suporte continuam possíveis); filtros em bloco rotulado; "Limpar filtros"; selos de
  estado também no cabeçalho do detalhe.
- **Produtos:** miniatura, nome + slug, categoria, preço/custo/margem, selo de estoque com contagens,
  ações `Detalhes` / `Editar` / `Desativar`-`Ativar`.
- **Estoque:** resumo mantido; filtros rotulados; formulário de unidade com `form-control`, dicas,
  obrigatórios e `Cadastrando…`.

---

## E. Loja pública

- **Cartão de produto:** preço com mais peso, legenda de disponibilidade alinhada, descrição com
  contraste melhor e ações com altura mínima (44 px em toque).
- **Página do produto:** preço em bloco próprio, aviso "Últimas N unidades" quando há 1–2, "Total
  estimado" ao alterar a quantidade (`aria-live`), ação principal em largura total no celular,
  informações secundárias com mais respiro.
- **Catálogo:** busca e ordenação empilhadas no celular, chips com alvo de toque maior, contagem de
  resultados com mais destaque e ações agrupadas.
- **Cabeçalho:** alvos de toque padronizados (≥ 44 px em `pointer: coarse`).

Nenhum texto verificado por teste foi alterado (`DISPONÍVEL`/`INDISPONÍVEL`,
`N unidade(s) disponível(is)`, `Adicionar … ao carrinho`, `Finalizar pedido`, etc.).

---

## F. Testes e verificação

| Verificação | Comando | Resultado |
|---|---|---|
| Instalação limpa | `npm ci` | 143 pacotes, ok |
| Suíte frontend (antes) | `npm test` | 21 arquivos / **151 testes** aprovados |
| Suíte frontend (depois) | `npm test` | 23 arquivos / **162 testes** aprovados (151 preservados + 11 novos) |
| Tipos + build | `npm run build` (`tsc -b && vite build`) | ok — `dist/assets/index-*.css` 80,13 kB |
| Servidor de desenvolvimento | `VITE_ADMIN_DEMO=true npm run dev` | ok em `0.0.0.0:5173`; `/`, `/produtos`, `/admin`, `/carrinho` respondem 200 |
| Suíte de banco | `npm run test:db` | **não executada**: exige Postgres local (container) e não há banco neste ambiente; nenhuma migração foi criada ou rodada |

**Testes novos**

- `src/pages/admin/adminProductsUx.test.tsx` (10 testes): seções e formulário único; dicas e
  obrigatórios; erro inline com `aria-invalid`; prévia e limpeza de imagem; validação de URL; margem
  estimada; resumo + aviso de sucesso + payload (`price_cents`, slug `conta-gama`, `image_url: null`);
  proteção contra perda de dados (cancelar mantém, confirmar descarta); criar/editar no mesmo
  formulário com slug travado; confirmação ao cancelar edição e `PATCH` sem `slug`.
- `src/pages/admin/adminNavigationUx.test.tsx` (1 teste): abas com `aria-current`, título/descrição da
  seção atual e as quatro áreas acessíveis.

**Verificação manual (o que foi possível neste ambiente)**

- Reconhecimento completo de painel, cadastro, listagens, estoque, pedidos e loja pública.
- Build de produção e dev server validados; rotas públicas e `/admin` respondem.
- **Capturas de tela não foram possíveis**: o sandbox não tem navegador com interface gráfica.
  A verificação visual fica disponível pelo servidor de desenvolvimento (seção H) e a matriz de
  responsividade foi auditada no CSS (breakpoints 1100/900/700/640/480 px).
- O fluxo de compra foi revalidado pela suíte automatizada existente (catálogo, carrinho, checkout,
  acompanhamento, entrega), que continua verde.

---

## G. Segurança / ambiente

- Nenhum deploy, nenhuma publicação, nenhum merge: o trabalho existe **apenas** na branch
  `arena/b804eb72-prime-store`.
- Nenhuma migração criada ou executada; nenhuma tabela, função SQL, RLS ou Edge Function tocada.
- Nenhuma chamada ao Supabase real, nenhuma operação de pagamento (Mercado Pago/WyviPay).
- Nenhuma alteração em `.env`, `.env.example`, credenciais, secrets ou configuração de produção.
- Nenhuma mudança em autenticação, MFA, allowlist de administradores ou permissões.
- Nenhuma dependência adicionada (`package.json`/lockfile intactos).
- `adminApi` (contratos e tipos) e `src/services/**` não foram modificados.
- Funcionalidade removida: **nenhuma**. Ações destrutivas seguem com `ConfirmActionDialog`.

---

## H. Arquivos e evidências

**Branch / commits**

- Branch: `arena/b804eb72-prime-store`
- `0cf6111` — feat(ux): reorganiza cadastro de produtos e navegação do painel
- Commit seguinte — este relatório

**Arquivos modificados**

| Arquivo | Mudança |
|---|---|
| `src/pages/admin/AdminProducts.tsx` | formulário em seções, dicas, erros inline, prévia de imagem, margem, resumo, barra fixa, proteção de dados, lista com miniatura/selo de estoque |
| `src/pages/admin/AdminPage.tsx` | abas com ícone/descrição, `aria-current`, título da seção atual |
| `src/pages/admin/AdminOverview.tsx` | receita em destaque, indicadores agrupados, status legíveis |
| `src/pages/admin/AdminOrders.tsx` | selos legíveis + código cru, filtros rotulados, "Limpar filtros", selos no detalhe |
| `src/pages/admin/AdminStock.tsx` | filtros rotulados, formulário de unidade padronizado, estado de envio |
| `src/pages/ProductPage.tsx` | últimas unidades, total estimado, estrutura de compra |
| `src/components/Icon.tsx` | 7 ícones novos (`grid`, `box`, `layers`, `receipt`, `image`, `tag`) |
| `src/styles.css` | ~250 linhas de apresentação (painel, formulário, loja) sem alterar tokens de marca |
| `src/pages/admin/adminProductsUx.test.tsx` | **novo** — 10 testes de usabilidade do cadastro |
| `src/pages/admin/adminNavigationUx.test.tsx` | **novo** — 1 teste de navegação do painel |

**Como rodar e visualizar o protótipo**

```bash
git checkout arena/b804eb72-prime-store
npm ci
npm test            # 162 testes
npm run build       # tsc -b + vite build

# Painel em modo demonstração (dados fictícios em memória, sem rede):
VITE_ADMIN_DEMO=true npm run dev
# abra http://localhost:5173/admin → "Ver painel em modo demonstração"
#   Produtos: crie um produto (seções 1–5), veja erros inline, prévia de imagem,
#   margem, resumo, diálogo de descarte, edição com slug travado.
#   Estoque/Pedidos/Visão geral: abas, selos de estado e filtros.

# Loja pública completa exige backend configurado (VITE_SUPABASE_URL,
# VITE_SUPABASE_ANON_KEY, VITE_BACKEND_ENABLED=true) — não configurado aqui.
```

---

## I. Pendências e limitações (com motivo)

1. **Upload de arquivo de imagem** — o modelo guarda apenas `image_url` (texto). Implementar upload
   exigiria bucket, política de storage e mudança de contrato/API — proibido nesta missão. A solução
   entregue valida e pré-visualiza a URL, com fallback de monograma.
2. **Preço anterior/promocional** — não existe campo, coluna ou regra de preço promocional no sistema
   atual. Criar isso seria nova funcionalidade/estrutura de dados; não foi inventado. A seção "Preços"
   já está preparada para receber um campo futuro sem reorganizar nada.
3. **Múltiplas imagens e "imagem principal"** — o cadastro tem uma única imagem (`image_url`); não há
   galeria no modelo. A prévia indica claramente qual é a imagem de capa.
4. **Estados de produto além de ativo/inativo** — o banco só tem `is_active` (+ reserva de estoque).
   "Publicado/não publicado" foi traduzido para ativo/inativo sem criar novos estados.
5. **Capturas de tela antes/depois** — sem navegador gráfico no ambiente; evidências por testes e
   instruções de execução acima. Se desejado, posso gerar as capturas em uma sessão com navegador.
6. **`npm run test:db`** — exige Postgres local; não executado por ausência de banco no sandbox.
   Nenhuma migração foi criada, então a suíte de banco não é afetada pelas mudanças.
7. **Barra de compra fixa no celular (página do produto)** — avaliada e descartada: sobreporia o
   cabeçalho/rodapé e o aviso de pedido sem pagamento, contrariando o critério de clareza antes da
   estética. A ação principal já fica em largura total.
8. **Reordenação de seções do painel** — a ordem das abas foi mantida (Visão geral → Produtos →
   Estoque → Pedidos) para não quebrar atalhos e a expectativa dos operadores; a orientação foi
   adicionada via descrição de cada seção.

---

## Critérios de aprovação — checagem

| Critério | Situação | Evidência |
|---|---|---|
| Cadastro de produto claramente mais intuitivo | ✅ | seções A–E, dicas, erros inline, resumo (testes em `adminProductsUx.test.tsx`) |
| Edição consistente com a criação | ✅ | mesmo formulário, slug travado, `PATCH` sem slug (teste dedicado) |
| Painel mais fácil de navegar | ✅ | ícones/descrição, `aria-current`, título da seção (`adminNavigationUx.test.tsx`) |
| Interface adequada para celular | ✅ (CSS + testes de contrato) | abas 2×2, filtros empilhados, barra fixa, alvos ≥ 44 px; validação visual depende de navegador |
| Loja pública com melhorias proporcionais | ✅ | cartão, página do produto, catálogo, cabeçalho |
| Funcionalidades existentes preservadas | ✅ | 151 testes originais verdes + build |
| Testes relevantes executados | ✅ | `npm test` 162/162, `npm run build` |
| Código isolado em branch própria | ✅ | `arena/b804eb72-prime-store`, sem merge |
| Sem publicação/alteração em produção | ✅ | nenhum deploy, banco ou integração tocados |
---

## J. Redesign visual v2 (rodada de acabamento)

Reformulação **só de apresentação** — nenhum serviço, contrato de dados, rota ou regra de negócio foi
alterado. O objetivo foi tirar o painel do estado "formulário empilhado" e dar à loja uma composição
comercial consistente com a marca.

### J.1 Como está organizado

- `src/styles-v2.css` — camada nova importada depois de `styles.css` em `src/main.tsx`. Tokens `--v2-*`,
  shell do painel, componentes do dashboard, tabelas do admin e loja pública. As seções numeradas
  (1–15) registram a ordem das correções; o fim do arquivo vence a media query por ordem de declaração,
  então toda regra de desktop que precise ser desfeita no celular é reposta nas seções finais.
- `src/pages/admin/AdminPage.tsx` — shell com sidebar fixa (272 px), topbar com botão **Menu**
  (`aria-expanded` / `aria-controls="admin-navigation"`), pílulas de contexto, faixa de demonstração e
  backdrop do menu móvel.
- `src/pages/admin/AdminOverview.tsx` — faixa de receita + filtro de período, grade de KPIs, atalhos
  para as outras abas, "Pedidos recentes" reduzida de 6 para 4 colunas, reembolsos, estoque baixo,
  ranking e auditoria.
- `src/pages/admin/AdminProducts.tsx` — lista com miniatura, categoria, preço + custo/margem, estoque +
  reservas/vendas, situação (ATIVO + DESTAQUE) e três ações de mesmo peso; formulário em 6 cartões
  numerados, coluna lateral de preço/estoque, prévia de vitrine e barra de salvar com resumo.
- `src/pages/admin/AdminOrders.tsx` — 9 → 7 colunas (data dentro de Pedido, quantidade dentro de
  Produto/Qtd. e Valor, entrega com rótulo legível + código), tabela fixa no desktop e cartões com
  rótulo/valor no celular.
- `src/pages/HomePage.tsx` / `ProductPage.tsx` — hero com prévia real do destaque, quatro cartões de
  destaque, `buy-panel` com preço, quantidade, ações e aviso de pedido sem pagamento.

### J.2 Decisões de layout que resolveram problemas concretos

| Problema | Correção |
|---|---|
| Colunas da lista de produtos se espremiam e o selo "DESTAQUE" quebrava letra por letra | `table-layout: fixed` com larguras por `th:nth-child` + `white-space: nowrap` nos selos, selo de destaque movido para a coluna Situação |
| Metadados de preço/estoque sobrepunham a coluna vizinha | metadados com quebra de linha própria e colunas de 15% para preço/estoque |
| Tabela "Pedidos recentes" estourava o painel com 6 colunas | reescrita para 4 colunas (Pedido + data, Produto, Valor, Estado + pagamento) |
| Tabela de pedidos cortava "DETALHES" e cobria a coluna Entrega | 7 colunas com folga, `Entrega` traduzida (`ativa`, `não liberada`) e botão compacto alinhado à direita |
| Sidebar "acabava" em páginas longas (fundo aparecia abaixo dela) | `admin-shell::before` fixo pintando a coluna de 272 px em telas ≥ 1024 px |
| Cartões do celular mostravam valor em 9–10 px e colunas trocadas | grades de 2 colunas (rótulo / valor), todos os valores na 2ª coluna, fontes 12–16 px |
| `min-width` de desktop vencia a media query do celular | reposição explícita de `min-width: 0` no fim da folha para as três tabelas do painel |
| Faixa de demonstração ilegível no celular | altura automática, 10 px, centralizada (40–52 px) |

### J.3 Evidências

- `shots/antes/` — 7 capturas do estado anterior (1440×900).
- `shots/final/` — 19 capturas do estado atual: 9 telas em 1440×900 e as mesmas em 390×844, mais
  `admin-pedidos-360.png`. Arquivos `01-loja-*`, `02-loja-catalogo-*`, `03-loja-produto-*`,
  `04-admin-visao-geral-*`, `05-admin-produtos-*`, `06-admin-produto-novo-*`,
  `07-admin-produto-editar-*`, `08-admin-pedidos-*`, `09-admin-estoque-desktop`.
- `shots/v2/` — capturas intermediárias da rodada (inclui recortes de viewport por tela).

### J.4 Verificação

| Verificação | Resultado |
|---|---|
| `npx tsc -b` | sem erros |
| `npm run build` | ok (`dist` com CSS 118 kB / JS 325 kB + chunk do painel 328 kB) |
| `npm test` | **23 arquivos / 162 testes** verdes |
| Foco admin (`App`, `adminProducts*`, `adminRoute`, `adminOverview`, `adminDemo`, `adminNavigationUx`, `adminOrders`) | 8 arquivos / 80 testes verdes |
| Dados/serviços | `src/services/**` e `adminApi` intactos; payload de produto inalterado |

### J.5 Limites do que foi feito

- Tudo é CSS/JSX: nenhuma funcionalidade nova de backend (upload, galeria, preço promocional) foi
  simulada — as limitações da seção I continuam valendo.
- A barra de salvar do formulário é `sticky` no rodapé do cartão: em telas curtas ela cobre parcialmente
  o campo em edição durante a rolagem (comportamento esperado de barra de ação), e o resumo é limitado a
  duas linhas no celular.
- Contraste e tipografia foram ajustados por inspeção visual em Chromium headless; não houve auditoria
  formal de WCAG nesta rodada (as metas de alvo ≥ 44 px e foco visível seguem as da missão anterior).
