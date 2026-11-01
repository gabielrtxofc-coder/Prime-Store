# Prime Store

Loja digital responsiva (React + TypeScript + Vite) com backend em Supabase:
catálogo público, checkout PIX via Mercado Pago (Checkout Transparente),
reserva de estoque, entrega privada de credenciais e painel administrativo.

O frontend é estático e hospedado fora do Supabase; o Supabase fornece
PostgreSQL, Auth e Edge Functions. Nenhum segredo privilegiado entra no bundle.

## Requisitos

- Node.js `^22.22.2`, `^24.15.0` ou `>=26.0.0`
- PostgreSQL 15+ (testes locais) ou Supabase CLI com Docker
- Projeto Supabase (sandbox) e aplicação Mercado Pago de teste

## Executar localmente

```bash
npm ci
cp .env.example .env      # opcional: sem isso a loja roda em modo demonstração
npm run dev
```

Sem `VITE_BACKEND_ENABLED=true` a aplicação funciona em **modo demonstração**
(catálogo local, checkout simulado, nenhuma cobrança). Com a flag ligada e as
variáveis públicas preenchidas, catálogo, checkout, pagamento, entrega e painel
usam o backend real.

```bash
npm run build && npm run preview     # produção
```

## Verificações

```bash
npm test             # 57 testes de frontend (jsdom)
npm run test:db      # 70 testes de banco/back-end + unitários
npm run test:all     # tudo (127)
npm run typecheck
npm run build
```

Os testes de banco recriam o schema a partir das migrações em um PostgreSQL real
e exercitam RLS, concorrência, idempotência de webhooks e autorização com MFA.
Detalhes e a matriz de cenários críticos estão em [`docs/testes.md`](./docs/testes.md).

## Organização

```
src/                     frontend (componentes, páginas, contexto, serviços)
src/services/backend/    cliente HTTP das Edge Functions e adaptação do catálogo
src/pages/admin/         painel administrativo (carregado sob demanda)
supabase/migrations/     16 migrações versionadas e reaplicáveis do zero
supabase/functions/      6 Edge Functions (Deno) + módulos compartilhados
supabase/local/          bootstrap LOCAL do que o Supabase já oferece
tests/db, tests/unit     testes de banco/back-end e unitários
docs/                    documentação técnica completa
scripts/                 empacotamento das Edge Functions
```

## Rotas

Públicas: `/`, `/produtos`, `/produto/:slug`, `/carrinho`, `/checkout`,
`/pagamento`, `/entrega/:token`, `/pedido-confirmado`, `/faq`, `/ajuda`,
`/sobre`, `/termos`, `/privacidade`, `/reembolsos`. Administrativa: `/admin`.

## Documentação

Comece por [`docs/README.md`](./docs/README.md):

- [`docs/setup-local.md`](./docs/setup-local.md) — ambiente, banco, deploy
- [`docs/backend.md`](./docs/backend.md) — schema, funções SQL, endpoints
- [`docs/mercado-pago.md`](./docs/mercado-pago.md) — PIX, webhook, sandbox
- [`docs/painel-admin.md`](./docs/painel-admin.md) — login, MFA, provisionamento
- [`docs/seguranca.md`](./docs/seguranca.md) — RLS, criptografia, tokens, auditoria
- [`docs/testes.md`](./docs/testes.md) — suítes e resultados reais
- [`docs/limitacoes-e-pendencias.md`](./docs/limitacoes-e-pendencias.md) — bloqueios
- [`docs/PROGRESSO.md`](./docs/PROGRESSO.md) — registro para retomar o trabalho

## Aviso sobre conteúdo

Textos comerciais, FAQ, termos, política de privacidade e regras de reembolso
continuam sendo rascunhos que precisam de revisão antes de qualquer operação
comercial real. O ambiente configurado é de **sandbox**: nenhuma cobrança real
deve ser feita com estas credenciais.
