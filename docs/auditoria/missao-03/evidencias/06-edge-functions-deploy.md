# Evidência 06 — Edge Functions implantadas

Projeto: `eorlmqolbknrplvdbbtl`. Todas respondem `status: ACTIVE`, `version: 1` no
momento da criação. `verify_jwt` foi decidido **por função** (nunca desligado em bloco).

| Slug | ID | `verify_jwt` | Justificativa |
| --- | --- | --- | --- |
| `catalog` | `3ec7b23b-67f0-4406-a15f-422b9ed5460e` | `false` | Catálogo público; lê apenas a view `public_catalog` via `get_catalog` com `service_role`. Nenhum dado de usuário. |
| `create-order` | `5f021db7-2482-4ada-acb7-e05fb9a34df2` | `false` | Checkout sem login (comprador anônimo). Validação de payload + limite de estoque + idempotência no banco. |
| `order-status` | `e28fd8f8-01d7-4b4d-9022-4125182a254e` | `false` | Consultado pelo comprador com token privado; `get_order_status` exige hash do token. |
| `delivery` | `429d6811-e759-4a0e-860b-d05e1a769c49` | `false` | Link privado de entrega (token como prova de posse); decifra somente no servidor. |
| `mp-webhook` | `6dfd5a4e-7e27-4126-9ab5-c7448c3bf7f9` | `false` | Notificação do Mercado Pago não carrega JWT. A autenticidade é validada por HMAC-SHA256 (`x-signature` + `x-request-id` + `data.id`) com `MP_WEBHOOK_SECRET`, mais deduplicação por `notification_id` e consulta do estado real no provedor. |
| `admin-api` | `0abc6c53-414c-499a-b4f0-caea66c7c302` | **`true`** | Painel administrativo: gateway valida JWT **e** o banco exige allowlist + AAL2 (`assert_admin`). |

## Como o artefato foi gerado

```bash
node scripts/bundle-functions.mjs                 # ESM, sem imports externos
npx esbuild supabase/functions/<slug>/index.ts --bundle --minify --format=esm \
  --platform=neutral --target=es2022
```

O código-fonte canônico é `supabase/functions/**`; o bundle minificado foi usado apenas
para caber no envio via API. **Verificação pós-deploy:** os corpos de `admin-api` e
`order-status` foram relidos da plataforma (`get_edge_function`) e conferem com os bundles
locais — inclusive os trechos da missão 03 (`client_token`, `get_delivery_token_enc`,
`idempotency_conflict` → 409). As outras quatro foram publicadas na mesma execução de
`scripts/bundle-functions.mjs`, a partir da mesma árvore de código já commitada.

`list_edge_functions` no fim da sessão: **6 itens, todos `ACTIVE`, `version: 1`**, sem
duplicatas de slug.

## Procedimento alternativo (CLI, para quem tem rede)

```bash
supabase link --project-ref eorlmqolbknrplvdbbtl
supabase db push
node scripts/bundle-functions.mjs
supabase functions deploy catalog create-order order-status delivery admin-api
supabase functions deploy mp-webhook --no-verify-jwt
```

## Estado da plataforma (consulta real)

```json
[{"slug":"catalog","status":"ACTIVE","version":1,"verify_jwt":false},
 {"slug":"create-order","status":"ACTIVE","version":1,"verify_jwt":false},
 {"slug":"order-status","status":"ACTIVE","version":1,"verify_jwt":false},
 {"slug":"delivery","status":"ACTIVE","version":1,"verify_jwt":false},
 {"slug":"mp-webhook","status":"ACTIVE","version":1,"verify_jwt":false},
 {"slug":"admin-api","status":"ACTIVE","version":1,"verify_jwt":true}]
```

## Pendente (e como fechar)

Invocação HTTP real: este ambiente não tem egress para `*.supabase.co`, então as funções
foram verificadas por metadados/configuração, **não por requisição**. Para fechar a lacuna,
o repositório traz um smoke test executável (`scripts/smoke-edge-functions.mjs`,
`npm run smoke:functions`), que ele mesmo **não foi executado aqui**:

```bash
SUPABASE_URL=https://eorlmqolbknrplvdbbtl.supabase.co \
SUPABASE_ANON_KEY=<anon key> \
PRODUCT_ID=<uuid de produto ativo> \
node scripts/smoke-edge-functions.mjs
```

Verificações que o script faz (todas com asserção de status HTTP): catálogo 200;
`create-order` 422 com payload inválido e 404/409 com produto inexistente; criação +
repetição idempotente do mesmo payload; `order-status` recusando token errado;
`delivery` recusando token inventado (404); `mp-webhook` recusando assinatura inválida
(400/401/403); `admin-api` sem JWT (401) e com JWT AAL2 (200/403).
Nenhum segredo é impresso e o script sai com código 1 se algo divergir.
