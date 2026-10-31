# Registro de progresso — Missão 02 (backend)

> Atualizado em 2026-10-31. Este arquivo existe para que outra sessão consiga
> retomar o trabalho sem depender do histórico de conversa.

## Passo atual

Backend completo e testado localmente; frontend integrado; documentação escrita.
Falta apenas o que depende de acesso externo: deploy das Edge Functions no
projeto Supabase, provisionamento dos dois administradores e execução real no
sandbox do Mercado Pago.

## Concluído

### Banco de dados (`supabase/migrations`, 16 arquivos)

- `0001` tipos/enums · `0002` fundação/configuração · `0003` administração ·
  `0004` catálogo/produtos · `0005` estoque · `0006` pedidos/reservas ·
  `0007` pagamentos · `0008` entregas · `0009` integridade/índices ·
  `0010` view pública · `0011` funções de núcleo · `0012` funções admin ·
  `0013` triggers · `0014` RLS/grants · `0015` comentários · `0016` seeds.
- 17 tabelas, 41 funções, 6 enums, 1 view pública, RLS em todas as tabelas.
- Aplicado e verificado no projeto sandbox `prime-store-sandbox`
  (`eorlmqolbknrplvdbbtl`): 17 tabelas, 17 com RLS, 41 funções, 18 enums,
  1 view; `app_settings` com reserva/PIX de 30 min.

### Edge Functions (`supabase/functions`)

- `_shared/`: `crypto`, `http`, `config`, `rest`, `mercadopago`, `csv`,
  `validation`, `mappers`, `deps` + handlers.
- Endpoints: `catalog`, `create-order`, `order-status`, `delivery`, `mp-webhook`,
  `admin-api` (17 ações administrativas).
- Bundle autocontido: `node scripts/bundle-functions.mjs` → `.local/functions-build/`.

### Frontend

- `src/services/backend/` (config, http, catálogo), `orderService`,
  `adminAuth`, `adminApi`.
- Catálogo real com fallback local (`catalogService` + `useCatalog`).
- Checkout de produto único → `create-order` → `/pagamento` (QR, copia-e-cola,
  polling, contagem regressiva) → `/entrega/:token`.
- Painel `/admin` (carregado sob demanda): login, TOTP, visão geral, produtos,
  estoque (incluindo importação CSV com prévia), pedidos.
- Novas rotas e estilos; bundle dividido (público ~278 kB, admin ~257 kB).

### Testes

- `npm run test:db` → **70/70** (6 arquivos: banco, handlers e unitários).
- `npm test` → **57/57** (frontend, jsdom). `npm run test:all` → **127/127**.
- `npx tsc -b` e `npm run build` sem erros.

## Arquivos criados/modificados nesta missão

```
supabase/config.toml                          (novo)
supabase/local/bootstrap_local.sql            (novo, somente local)
supabase/migrations/*.sql                     (16 arquivos)
supabase/functions/**                          (6 funções + _shared)
scripts/bundle-functions.mjs                  (novo)
tests/db/{helpers,pgRpc,0*.test.ts}           (novo)
tests/unit/{crypto_csv_mp.test.ts,fakeMp.ts}  (novo)
src/services/backend/*                        (novo)
src/services/{catalogService,orderService,adminAuth,adminApi}.ts
src/pages/{PaymentPage,DeliveryPage}.tsx      (novo)
src/pages/admin/*                             (novo)
src/hooks/useCatalog.ts, src/lib/{links,format}.ts
src/App.tsx, src/types.ts, src/pages/CheckoutPage.tsx, src/data/faqs.ts
src/styles.css
.env.example, package.json, package-lock.json
docs/*                                        (novo)
```

## Problemas encontrados e correções

| Problema | Correção |
| --- | --- |
| `anon`/`authenticated` sem USAGE no schema `public` (schema recriado pelo bootstrap) | `grant usage on schema public` na migração `0014` |
| `create_order`, `get_catalog`, `resolve_delivery` acessíveis por `anon` | Nenhuma função é executável por `anon`; cliente passa sempre pelas Edge Functions |
| Handler administrativo usava cliente com a service role (auth.uid() nulo) | `rpcForUser(authorization)` — RPC com o JWT do usuário |
| `bytea` retornado do PostgREST em hex | Funções devolvem `encode(...,'base64')` |
| Migration de grants criada depois das funções de catálogo (`admin_stock_fingerprints` ficou pública) | Regras consolidadas em `0014` (revoke global + concessões explícitas) |
| `resolve_delivery` devolvia credenciais de pedido não pago em cenário artificial | Teste garante negação para pedido não pago |
| Frontend: link de entrega absoluto quebrava roteamento interno | `deliveryPath()` mantém sempre a rota `/entrega/:token` |

## Pendências

1. Deploy das 6 Edge Functions no projeto sandbox (bloqueio de rede local).
2. Criar 2 usuários no Supabase Auth + registrar UUIDs em `admin_users`.
3. Configurar secrets: `PRIME_ENCRYPTION_KEY`, `STORE_URL`,
   `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `MP_NOTIFICATION_URL`.
4. Executar o checklist de sandbox do Mercado Pago (`docs/mercado-pago.md`).

## Próxima ação sugerida

```bash
supabase link --project-ref eorlmqolbknrplvdbbtl
supabase db push
node scripts/bundle-functions.mjs
supabase functions deploy catalog create-order order-status delivery admin-api
supabase functions deploy mp-webhook --no-verify-jwt
```

Depois: criar os administradores, cadastrar 1 produto + 1 unidade de estoque pelo
painel e percorrer o fluxo de compra com uma conta de teste do Mercado Pago.
