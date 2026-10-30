# Prime Store — auditoria funcional, fase 2

Data: 30/10/2026. Branch: `arena/35d222bc-prime-store`.

## Diagnóstico inicial (registrado antes das correções)

### Estado do ambiente e documentação

- A aplicação já estava implementada em React 18, TypeScript, React Router 7 e Vite 8, com páginas institucionais, catálogo, carrinho, checkout demonstrativo, dados locais e testes.
- Ao iniciar esta auditoria não havia processo Vite nem listener na porta 4173, e `node_modules` não estava presente no snapshot. As primeiras tentativas de `npm test` e `npm run build` falharam porque `vitest` e `tsc` não estavam instalados. `npm ci` restaurou as dependências sem atualizar versões.
- Runtime: Node.js 22.22.3 e npm 10.9.8. O README inicial declarava `^20.19.0 || >=22.12.0`, compatível com Vite 8, mas essa faixa não correspondia aos requisitos de todas as ferramentas e não estava declarada no `package.json`.
- Não foi encontrado navegador instalado nesta sessão; não seria correto declarar inspeção visual em navegador.

### Cobertura existente antes das alterações

As suítes iniciais tinham 24 testes: 19 de interface/fluxo e cinco de cálculo/formulários. Cobriam navegação, pesquisa, filtros, ordenação, operações básicas do carrinho, persistência simples, validação, pedido demonstrativo, páginas auxiliares, acordeão por teclado, menu/busca mobile e atendimento. Não cobriam especificamente carrinho vazio no cálculo financeiro, quantidades inválidas, IDs repetidos vindos de armazenamento antigo, falha/repetição de criação de pedido, nem recarga após a confirmação.

### Problemas identificados antes das correções

1. **Carrinho duplicado:** `getCartLines` emitia uma linha por entrada, sem consolidar IDs repetidos. Um armazenamento duplicado/obsoleto podia mostrar o mesmo produto várias vezes e inflar contagem e total.
2. **Quantidade não finita:** `addItem` aplicava `Math.floor` a `NaN`; isso podia gravar `NaN` no estado e, após serialização, `null` no armazenamento, divergindo da linha normalizada exibida.
3. **Cobertura incompleta de carrinho e sessão:** faltavam testes explícitos para vazio, produtos desconhecidos, `NaN`, infinitos, negativos e frações; faltava garantir que recarregar a confirmação não apresentasse como persistente um pedido que existe só em memória.
4. **Reprodutibilidade:** a instalação documentada usava `npm install`; a faixa de Node estava apenas no README, não no manifesto.
5. **Inspeção visual:** CSS declarava breakpoints para desktop/tablet/mobile, mas não havia navegador para validar renderização real nas dimensões solicitadas.

### Achados adicionais antes dos ajustes de estilo

A medição estática de combinações de cores e alvos de toque encontrou: texto branco sobre o azul primário `#3b82f6` com contraste 3,68:1; placeholder do checkout com 4,11:1; placeholder da busca do cabeçalho com 4,499:1; e controles +/- mobile de 23×25 px. Esses valores foram registrados antes da correção pontual em `src/styles.css`; não equivalem a uma avaliação visual de viewport.

## Correções realizadas

- `src/lib/cart.ts`: centralizei a normalização de quantidades; descartei produtos desconhecidos/indisponíveis; consolidei IDs repetidos e limitei a quantidade resultante às regras do produto; mantive preços e totais derivados exclusivamente do catálogo local.
- `src/context/CartContext.tsx`: normalizei adições inválidas e removi duplicatas ao alterar ou acrescentar um item.
- `src/pages/CheckoutPage.tsx`: associei a mensagem de erro ou dica do consentimento ao checkbox com `aria-describedby`.
- `src/context/ToastContext.tsx`: erros agora usam `aria-live="assertive"`; sucessos/informações continuam `polite`.
- `src/styles.css`: medi combinações de contraste estático e corrigi texto branco sobre o azul primário (antes 3,68:1), placeholder de checkout (4,11:1) e placeholder da busca do cabeçalho (4,499:1). O novo azul `#3272df` tem 4,56:1 com branco; os placeholders revistos têm 4,98:1 e 4,56:1 nos fundos usados. Mantive a paleta azul e o hover existente. Aumentei os botões +/- mobile de 23×25 para 24×26 px.
- `src/App.test.tsx`, `src/lib/cart.test.ts` e novo `src/context/CartContext.test.tsx`: ampliei a suíte para 39 testes, incluindo todas as rotas e títulos, fluxo completo, estados vazio/erro, retry, clique duplo, persistência e normalização do armazenamento, limites, quantidades inválidas, acessibilidade e filtros da FAQ.
- `src/test/setup.ts`: restaura mocks após cada teste.
- `package.json`, `package-lock.json` e `README.md`: alinhei requisitos de runtime, lockfile e instrução reproduzível `npm ci`.

### Compatibilidade Node/dependências

A inspeção dos `engines.node` revelou que a faixa antiga era ampla demais para o conjunto instalado: Vitest 5.0.5 exige `^22.12.0 || ^24.0.0 || >=26.0.0`, enquanto jsdom 30.1.3 exige `^22.22.2 || ^24.15.0 || >=26.0.0`. A interseção dos requisitos diretos foi registrada no manifesto e no README como `^22.22.2 || ^24.15.0 || >=26.0.0`. O runtime instalado, Node 22.22.3, satisfaz a faixa. Revisei as dependências diretas contra imports/configuração: cada uma é usada pelo app, build ou testes; não identifiquei pacote direto sem uso. Não atualizei nem substituí versões de dependências; o lockfile continua íntegro.

## Verificações finais

| Verificação | Resultado |
|---|---|
| `npm ci` | Aprovado; 110 pacotes instalados, 0 vulnerabilidades reportadas na instalação. |
| `npm test` | Aprovado; 3 arquivos de teste, 39/39 testes. |
| `npm run build` | Aprovado; `tsc -b` e Vite 8.3.5, 56 módulos transformados. |
| `npm ls --depth=0` | Aprovado; dependências diretas instaladas e consistentes. |
| `package.json` × `package-lock.json` | Aprovado; dependências, devDependencies e `engines.node` do lockfile correspondem ao manifesto. |
| `npm audit --audit-level=moderate` | Aprovado; 0 vulnerabilidades. |
| `git diff --check` | Aprovado. |
| Contraste estático (combinações principais) | Aprovado após correções; CTA e placeholders verificados ≥4,5:1. Não equivale a auditoria WCAG completa. |
| Smoke HTTP de rotas diretas | Aprovado; 15/15 caminhos (incluindo rota desconhecida e busca por query) responderam HTTP 200 pelo preview Vite. |
| Inspeção visual real em navegador | Não executada: navegador indisponível no ambiente. |

O smoke HTTP atingiu diretamente: `/`, `/produtos`, `/produto/musica-individual`, `/produto/slug-inexistente`, `/carrinho`, `/checkout`, `/pedido-confirmado`, `/faq`, `/ajuda`, `/sobre`, `/termos`, `/privacidade`, `/reembolsos`, `/nao-existe` e `/produtos?q=notion`.

### Escopo e limitações

- A avaliação de responsividade foi estática: o CSS contém breakpoints em 1100, 900, 700 e 480 px, cobrindo as faixas de 1024, 768, 390 e 360 px; a aparência nas dimensões 360×800, 390×844, 768×1024, 1024×768 e 1440×900 **não foi confirmada visualmente**.
- Os testes de interface usam jsdom; não substituem um navegador nem permitem validar pixels, layout real, console de navegador ou comportamento dependente de APIs visuais. A revisão de acessibilidade cobre semântica, estados/nomes acessíveis e alguns fluxos por teclado; não houve auditoria automatizada WCAG/axe nem teste com leitor de tela.
- O pedido criado permanece em memória; o carrinho persiste somente IDs e quantidades. Não foram adicionados backend, APIs, serviços externos, pagamento real, entrega ou deploy.
