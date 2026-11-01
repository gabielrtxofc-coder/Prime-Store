# Missão 05 — Revisão final da Prime Store V1

**Data:** 1º de novembro de 2026
**Branch:** `arena/a81a96ef-prime-store` (base `main` em `ef50d59`, sem merge)
**Projeto Supabase usado:** `prime-store-sandbox` — ref `eorlmqolbknrplvdbbtl` (único alterado)
**Resultado geral:** as 3 pendências técnicas da revisão da missão 04 foram
resolvidas e verificadas ao vivo; nenhum pedido, produto ou unidade de estoque
foi apagado. **A V1 NÃO está pronta para produção** — ver seção 5.

---

## 1. O que foi corrigido

### 1.1 Catálogo público exposto direto no PostgREST (segurança)

**Problema.** A view `public_catalog` estava legível por `anon`. Qualquer pessoa
com a chave pública (que está no bundle por design) podia ler
`GET /rest/v1/public_catalog` direto, sem passar pela Edge Function `catalog`.

**Correção.** Migração `20261031140000_0030_catalogo_view_sem_acesso_publico.sql`:

- `alter view public.public_catalog set (security_invoker = true)` — a view passa
  a respeitar o RLS/privilégios de quem consulta;
- `revoke select on public.public_catalog from anon, authenticated` e
  `grant select ... to service_role` (mantém leitura server-side);
- comentário na migração explicando por que a view existe e por que não é
  pública.

**Verificação ao vivo**

| Teste | Resultado |
| --- | --- |
| `GET /rest/v1/public_catalog` com chave anon | `401` `42501 permission denied for view public_catalog` |
| `GET /rest/v1/public_catalog` com chave service_role (Authorization) | `200` (leitura interna preservada) |
| `GET /functions/v1/catalog` | `200`, 2 produtos — loja intacta |
| `reloptions` | `{security_invoker=true}` |
| `has_table_privilege('anon' / 'authenticated')` | `false` / `false` |

O catálogo da loja continua funcionando porque `get_catalog()` é
`SECURITY DEFINER` com `search_path = public, pg_temp` e só é executável por
`service_role`.

### 1.2 CORS aceitava qualquer origem

**Problema.** As 7 Edge Functions respondiam
`Access-Control-Allow-Origin: *`, inclusive `admin-api` (que expõe dados
administrativos).

**Correção.** Arquivo novo `supabase/functions/_shared/cors.ts` + ajustes em
`_shared/config.ts`, `_shared/http.ts` e nos 7 `index.ts`:

- `allowedOrigins` lê o segredo `ALLOWED_ORIGINS` (lista separada por vírgula) e
  soma `STORE_URL`; cada entrada é normalizada para `protocolo//host`
  (comparação exata, sem regex, sem curinga, sem `*`);
- `withCors()` aplica `Vary: Origin`, `Allow-Methods`, `Allow-Headers` e
  `Max-Age`, e **só** emite `Access-Control-Allow-Origin` quando o `Origin` da
  requisição está na lista;
- `preflight()` responde `204` com os mesmos cabeçalhos;
- `json()`/`errorResponse()` deixaram de embutir `*` fixo;
- segredo `ALLOWED_ORIGINS` criado no sandbox com
  `https://5173-i1chcaxiuf17fn1ectuv9.e2b.app,http://localhost:5173,http://127.0.0.1:5173`.

**Deploy (todas as 7 funções reimplantadas e `ACTIVE`)**

| Função | Versão | `verify_jwt` |
| --- | --- | --- |
| `catalog` | 5 | false |
| `create-order` | 5 | false |
| `order-status` | 4 | false |
| `delivery` | 4 | false |
| `demo-payment` | 3 | false |
| `mp-webhook` | 4 | false |
| `admin-api` | 4 | true |

**Verificação ao vivo**

| Teste | Resultado |
| --- | --- |
| `OPTIONS /catalog` com origem permitida | `204` + `access-control-allow-origin: https://5173-i1chcaxiuf17fn1ectuv9.e2b.app` (valor exato) + `access-control-allow-methods: GET, POST, OPTIONS` |
| `OPTIONS /admin-api` com origem permitida | `204` + `ACAO` exato (preflight passa mesmo com `verify_jwt: true`) |
| `OPTIONS /mp-webhook` com origem permitida | `204` + `ACAO` exato |
| `OPTIONS` de `create-order`, `order-status`, `demo-payment`, `delivery` com `https://site-malicioso.example` | `204` **sem** `ACAO` |
| `OPTIONS` de `admin-api`, `mp-webhook` com origem estranha | `204` **sem** `ACAO` |
| `GET /catalog` de origem estranha | `200`, porém **sem** `ACAO` → o navegador não entrega o corpo |
| `POST /create-order` origem permitida | `201` + `ACAO` presente |
| `POST /admin-api` sem sessão (origem permitida) | `401 UNAUTHORIZED_NO_AUTH_HEADER` + `ACAO` (proteção intacta) |
| `POST /admin-api` com JWT anon no `Authorization` | `401` `unauthorized`, sem dados de estoque |

> **Sensibilidade a mudar de endereço:** a lista é explícita. Ao publicar a loja
> em outro domínio ou abrir outro preview, é preciso acrescentar a nova origem
> em `ALLOWED_ORIGINS` (seção 4).

### 1.3 Diferença nos números de estoque entre os testes

**Investigação.** Não havia inconsistência de dados nem venda perdida. Duas
coisas explicam a diferença: (a) a semeadura de demonstração da missão 04 (2
lotes de 5 unidades fictícias por produto, o segundo em 01/11 02:35) e (b)
vendas de teste, que retiram unidades de "disponíveis".

**Reconciliação (unidades por produto, todas `is_demo = true`, conferidas por
`created_at` + `notes`)**

| Produto | Criadas em 31/10 15:40 | Semeadas em 01/11 02:35 | Vendas | Total | Disponíveis |
| --- | --- | --- | --- | --- | --- |
| acesso mensal | 4 | +10 | 2 (missão 04) + 1 (esta missão) | 14 | 11 |
| acesso avulso | 3 | +10 | 0 | 13 | 13 |

A leitura "6" vista no meio dos testes era a contagem de unidades
**disponíveis** naquele instante — unidades reservadas (30 min) ou já vendidas
não entram nessa conta. Depois da semeadura e das vendas, a mesma consulta passa
a mostrar 13. Ou seja: o número mudou porque o estoque **cresceu** (semeadura de
demonstração) e porque vendas/reservas movem unidades entre estados — não houve
perda nem exclusão. O ledger (`stock_units` + `stock_reservations` +
`stock_reservation_units`) fecha: `disponíveis + vendidas + reservadas = total`.

### 1.4 Contenção do pagamento demonstrativo (item 5)

O modo simulado tem três travas independentes, todas verificadas:

1. **Segredo** — `DEMO_PAYMENT_ENABLED` (se ausente/`false`, a rota responde
   `404 demo_unavailable`) e `DEMO_ALLOWED_PROJECT_REFS` (só `eorlmqolbknrplvdbbtl`);
2. **Banco** — `demo_payments_enabled()` lê `app_settings.demo_payments_enabled`,
   que nasce `false` em migração (nenhuma migração liga o modo);
3. **Função SQL** — `demo_approve_payment` recusa `demo_disabled`,
   `demo_not_allowed` (produto não `is_demo`), `demo_real_stock_blocked` (alguma
   unidade reservada sem `is_demo`), `demo_reservation_expired`,
   `demo_reservation_missing` e `demo_order_not_payable` (pedido já pago).

Além disso: a aprovação simulada **não cria cobrança** (`payment_events = 0`), o
pagamento fica com `provider = 'demo'`, o `provider_payment_id` é
`DEMO-<referência>` e o pedido recebe o evento `demo_payment_approved` — a tela
mostra "demonstração", nunca PIX real.

**Verificação ao vivo**

| Teste | Resultado |
| --- | --- |
| `POST /demo-payment {action:"capabilities"}` | `200 {demo_enabled:true, mode:"demo"}` |
| Aprovação com pedido + token privado corretos | `200 {demo:true, result:"approved", order_status:"paid", delivery_status:"ready"}` |
| Repetir a aprovação | `409 demo_order_not_payable` |
| Aprovação com token privado errado | `404 not_found` |
| `payment_events` após todas as aprovações | `0` (nenhum evento do Mercado Pago) |

---

## 2. O que foi testado e resultados

### 2.1 Suítes automatizadas (todas verdes)

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` (`tsc -b`) | sem erros |
| `npm test` (frontend, jsdom) | **68/68** em 8 arquivos |
| `npm run test:db` (PostgreSQL 17.11 real, local, em `/tmp/pgdata`) | **139/139** em 11 arquivos |
| `npm run build` | sucesso (`dist/index.html`, CSS 64,4 kB, público 285,7 kB, admin 272,1 kB) |

Composição dos 139 testes de banco/unitários: `01_schema_security` 7,
`02_orders_reservations` 12, `03_payments_webhooks` 12,
`04_admin_delivery` 14, `05_end_to_end_flow` 6, `06_hardening_integridade` 20,
`07_create_order_http` 12, `08_privilegios_funcoes` 14,
**`09_modo_demonstrativo` 10 (novo)**, `unit/crypto_csv_mp` 19, `unit/cors` 13
(novo).

**Teste novo `tests/db/09_modo_demonstrativo.test.ts`** — cobre as migrações
`0026`–`0029`, que não tinham teste automatizado:

1. o modo nasce desligado e recusa aprovação;
2. `demo_approve_payment` e `demo_seed_stock` **não** são executáveis por
   `anon`/`authenticated` (só `service_role`);
3. aprovação feliz reutiliza `apply_payment_status` (pedido `paid`, pagamento
   `provider='demo'`, entrega `active`, reserva `consumed`, unidade `sold`,
   evento `demo_payment_approved`, zero eventos de Mercado Pago);
4. exige o hash do token privado do pedido;
5. recusa produto que não é `is_demo`;
6. **bloqueia quando alguma unidade reservada é real** (`demo_real_stock_blocked`);
7. recusa reserva vencida e o processo de expiração devolve as unidades ao
   estoque;
8. não permite aprovar duas vezes;
9. volta a recusar quando a chave é desligada;
10. semeadura fictícia exige produto `is_demo` e respeita o limite de 20.

### 2.2 Verificação ao vivo, ponta a ponta (catálogo → pedido → reserva → demo → entrega)

Executada contra as funções implantadas, com `Origin` permitida, usando o schema
auxiliar `verif` (o shell não tem egress para `*.supabase.co`).

| Etapa | Resultado |
| --- | --- |
| `GET /catalog` | `200`, 2 produtos, sem `cost_cents`/credenciais, `ACAO` presente |
| `POST /create-order` (mensal, qty 1) | `201`, `PS-Q56ZCP`, `payment_mode:"demo"`, `demo_notice` presente, `reservation_expires_at` = +30 min |
| Estado no banco após criar | pedido `pending_payment`, reserva `active` com 30 min, 11 unidades disponíveis (1 reservada) |
| `POST /order-status` (pedido + token) | `200`, `status:"pending_payment"`, `delivery:null`, `availability.available_units: 11` |
| `POST /demo-payment {approve}` | `200`, `approved` |
| Estado no banco após aprovar | pedido `paid`, `paid_at` preenchido, pagamento `demo`, 1 unidade `sold` (`is_demo`), entrega `active`, reserva `consumed` |
| `GET /delivery?token=…` (token válido) | `200` com referência, produto e credencial fictícia decifrada |
| `GET /delivery?token=…` (token inexistente) | `404 not_found` |
| Contador de visualizações | `view_count = 1`, `last_viewed_at` gravado |

> Para testar a entrega sem conhecer o token (o servidor nunca o devolve), o
> `token_hash` da entrega recém-criada foi trocado pelo hash de um token de
> teste e **restaurado ao valor original** logo depois — evidenciado pelo
> `token_hash` idêntico ao inicial. Nenhum registro foi removido.

### 2.3 Revisão dos subsistemas (item 6)

| Subsistema | Situação |
| --- | --- |
| Catálogo | OK — só produtos ativos, com preço/estoque, sem custo nem credencial; view restrita |
| Estoque | OK — ledger fecha; unidades `is_demo` marcadas; nenhuma exclusão feita |
| Pedidos | OK — `pending_payment` → `paid`; total = preço × quantidade; referência `PS-XXXXXX` |
| Reservas | OK — 30 minutos, `active` → `consumed`; expiração devolve unidades (`expired`) |
| Entrega | OK — só pedido pago gera entrega ativa; token privado com hash no banco; credenciais cifradas (AES-256-GCM) |
| Pagamento demonstrativo | OK — contido no sandbox, sem cobrança, rastreável como `demo` |
| Pagamento real (Mercado Pago) | **Não verificável** — sem `MP_ACCESS_TOKEN`/`MP_WEBHOOK_SECRET` |
| Painel administrativo | Código e RPCs testados; **sem administradores cadastrados** (falta e-mail real) |

### 2.4 Como validar agora (sem depender de credenciais)

```bash
cp .env.example .env.local   # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (públicas), VITE_BACKEND_ENABLED=true
npm run dev                  # http://localhost:5173
```

O backend responde porque `ALLOWED_ORIGINS` contém `http://localhost:5173`,
`http://127.0.0.1:5173` e o preview do sandbox
(`https://5173-i1chcaxiuf17fn1ectuv9.e2b.app`). Roteiro sugerido: abrir a loja →
produto de exemplo → quantidade → checkout → tela de pagamento (modo
demonstração) → aprovar → link privado de entrega. O painel `/admin` abre em modo
demonstrativo local (`VITE_ADMIN_DEMO=true`), sem falar com o backend.

Se o preview abrir em outro endereço, acrescente-o em `ALLOWED_ORIGINS` antes de
testar (seção 4).

---

## 3. Arquivos alterados nesta missão

```
supabase/migrations/20261031140000_0030_catalogo_view_sem_acesso_publico.sql   (novo)
supabase/functions/_shared/cors.ts                                            (novo)
supabase/functions/_shared/config.ts                                          (allowedOrigins)
supabase/functions/_shared/http.ts                                            (sem ACAO fixo)
supabase/functions/{catalog,create-order,order-status,delivery,demo-payment,mp-webhook,admin-api}/index.ts
tests/unit/cors.test.ts                                                       (novo, 13 testes)
tests/db/09_modo_demonstrativo.test.ts                                        (novo, 10 testes)
tests/db/08_privilegios_funcoes.test.ts                                       (view pública)
docs/auditoria/missao-05/RELATORIO.md                                         (novo)
docs/{PROGRESSO,seguranca,testes,limitacoes-e-pendencias,setup-local}.md      (atualizados)
```

Infra aplicada no sandbox: migração `0030`, segredo `ALLOWED_ORIGINS`, redeploy
das 7 Edge Functions.

---

## 4. O que depende de você (ação manual)

1. **Cadastrar os administradores.** Sem e-mails reais o painel não passa do
   login. Passo a passo em `docs/painel-admin.md`: criar os usuários no Supabase
   Auth, ativar TOTP e inserir os UUIDs em `admin_users`. Nada foi inventado no
   repositório.
2. **Definir o endereço oficial da loja.** Atualize o segredo `STORE_URL` e
   acrescente o domínio em `ALLOWED_ORIGINS`
   (`https://loja.exemplo,https://www.loja.exemplo`). Sem isso o navegador
   bloqueia as chamadas por CORS — o comportamento é intencional.

   ```bash
   supabase secrets set STORE_URL=https://loja.exemplo \
     ALLOWED_ORIGINS=https://loja.exemplo,https://www.loja.exemplo --project-ref <REF>
   ```

   Em desenvolvimento, abrir o Vite em outra porta/host exige incluir essa origem
   na lista (as três atuais são `localhost:5173`, `127.0.0.1:5173` e o preview
   `https://5173-i1chcaxiuf17fn1ectuv9.e2b.app`).
3. **Credenciais de teste do Mercado Pago** (`MP_ACCESS_TOKEN`,
   `MP_WEBHOOK_SECRET`, `MP_NOTIFICATION_URL`) e execução do roteiro de
   `docs/mercado-pago.md`. Sem elas o checkout responde
   `503 payment_not_configured` por decisão de projeto.
4. **Desligar o modo demonstrativo antes de qualquer uso real:**
   `scripts/enable-demo-mode.sql` (desligar `app_settings.demo_payments_enabled`
   e remover `DEMO_PAYMENT_ENABLED`).
5. **Decidir sobre os dados de teste.** Existem 3 pedidos de demonstração, 14 + 13
   unidades fictícias e 3 entregas no sandbox. Eles **não foram apagados** (regra
   da missão). Se quiser um ambiente limpo, a decisão e a execução são suas.
6. **Aprovar os textos legais/identidade visual finais** e a publicação em
   domínio próprio.

---

## 5. Avaliação de prontidão para produção

**A V1 ainda NÃO está pronta para produção.** O que bloqueia não é o código das
funcionalidades, mas validações e provisionamentos externos:

| Bloqueio | Impacto |
| --- | --- |
| Nenhuma cobrança real foi executada (sem credenciais MP) | o caminho de pagamento/PIX/webhook nunca rodou contra o provedor; não há como afirmar que está correto em produção |
| Nenhum administrador cadastrado / TOTP não validado | o painel administrativo não pode ser usado de ponta a ponta |
| Modo demonstrativo ligado no sandbox | precisa ser desligado; se ficar ligado em produção, permite "aprovar" pedidos sem pagar |
| `ALLOWED_ORIGINS`/`STORE_URL` ainda apontam para endereços de desenvolvimento | CORS bloquearia (ou liberaria endereço errado) no domínio final |
| Dados de demonstração no banco | não podem ir para produção |
| Sem rate limiting/CAPTCHA no `create-order` | risco de abuso (reserva massiva de estoque) |

O que **está** pronto e verificado: catálogo, criação de pedido com idempotência,
reserva de 30 minutos, acompanhamento do pedido, entrega privada por token,
disputa/reembolso no banco, permissões (RLS + `SECURITY DEFINER` + `search_path`),
CORS por lista, e as suítes de teste (68 frontend + 139 banco/unitários) verdes.

**Classificação:** pronto para *validação funcional em sandbox*; **não** pronto
para produção até (i) o fluxo real do Mercado Pago ser exercitado, (ii) os
administradores existirem, (iii) o modo demonstrativo ser desligado e (iv) o
domínio/CORS estarem configurados.

---

## 6. Pendências remanescentes

| # | Pendência | Responsável | Bloqueia produção? |
| --- | --- | --- | --- |
| 1 | Validar pagamento PIX real + webhook assinado (10 passos de `docs/mercado-pago.md`) | você (credenciais) | Sim |
| 2 | Criar 2 administradores + TOTP | você (e-mails) | Sim |
| 3 | Desligar modo demonstrativo antes de uso real | você (script pronto) | Sim |
| 4 | Configurar domínio final em `STORE_URL`/`ALLOWED_ORIGINS` | você | Sim |
| 5 | Rate limiting / CAPTCHA no `create-order` | desenvolvimento futuro | Não (recomendado) |
| 6 | Rotação de `PRIME_ENCRYPTION_KEY` com re-cifragem | desenvolvimento futuro | Não |
| 7 | E-mail de confirmação do pedido | fora do escopo da V1 | Não |
| 8 | "Tenho interesse" definitivo | fora do escopo da V1 | Não |

Não há pendência de segurança conhecida em aberto no backend depois desta
missão: a exposição do catálogo foi fechada, o CORS deixou de aceitar qualquer
origem e todas as funções `SECURITY DEFINER` continuam com
`search_path = public, pg_temp`.
