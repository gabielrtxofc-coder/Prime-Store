# Prime Store — frontend demonstrativo

Protótipo de uma loja digital responsiva feito com React, TypeScript e Vite. O catálogo, os preços e o checkout são demonstrativos: não existe backend, cobrança, integração de pagamento, atendimento real ou entrega de produtos.

## Requisitos

- Node.js `^22.22.2`, `^24.15.0` ou `>=26.0.0` (faixa compatível com todas as ferramentas, incluindo Vitest e jsdom)
- npm

## Executar localmente

```bash
npm ci
npm run dev
```

`npm ci` instala exatamente as versões registradas no `package-lock.json`; ao alterar dependências, atualize e versione o lockfile junto com `package.json`.

O Vite inicia em `http://localhost:5173` e aceita acesso externo para a prévia do ambiente. Para gerar e servir a versão de produção:

```bash
npm run build
npm run preview
```

## Verificações

```bash
npm test
npm run build
```

Os testes automatizados cobrem todas as rotas e títulos, pesquisa/filtros/ordenação, fluxo demonstrativo de compra, recarga do carrinho, fallback da confirmação após recarga, consolidação de IDs duplicados, quantidades inválidas, carrinho vazio, validações de checkout e atendimento, acessibilidade por teclado e formatação monetária.

## Organização

- `src/data/`: catálogo, categorias, FAQ, configurações e rascunhos de conteúdo.
- `src/components/`: componentes reutilizáveis da navegação, cartões, acordeão e resumos.
- `src/context/`: estado compartilhado do carrinho, pedido demonstrativo e feedback.
- `src/pages/`: telas das rotas da loja.
- `src/services/`: adaptadores locais para catálogo e pedido; a integração de pagamento está explicitamente desativada.
- `src/lib/`: cálculo centralizado de valores, formatação e validações.

O carrinho grava somente identificadores de produtos e quantidades no armazenamento local do navegador. Os dados pessoais do checkout ficam apenas em memória, para exibição na confirmação da sessão atual. Nenhum dado é enviado a serviços externos.

## Rotas disponíveis

`/`, `/produtos`, `/produto/:slug`, `/carrinho`, `/checkout`, `/pedido-confirmado`, `/faq`, `/ajuda`, `/sobre`, `/termos`, `/privacidade` e `/reembolsos`. Endereços desconhecidos exibem uma página 404.

Termos, privacidade, atendimento, regras comerciais e itens de catálogo são conteúdos provisórios e devem ser revisados/configurados antes de qualquer publicação comercial.
