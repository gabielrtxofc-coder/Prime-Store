# Supabase Advisor — classificação dos três grupos de avisos

**Missão 15.1 · Tarefa 03** · Projeto de produção `audsosvbdybifvxsmqpi`
**Data:** 2026-11-22 · **Modo:** somente leitura (nenhuma alteração em produção)

Este documento fecha a pendência 3 da Missão 15: cada grupo de avisos do
Security Advisor foi **investigado**, **classificado** e **justificado**. O
critério não é "a contagem zerou" — é "o aviso descreve um risco que existe?".
Onde o risco existe, ele está nomeado com a proteção compensatória; onde é
falso positivo, a razão está demonstrada. **Nenhum aviso foi silenciado por
concessão genérica, política pública artificial ou revogação indiscriminada.**

## Resumo

| # | Grupo | Avisos | Risco real? | Ação | Estado |
|---|-------|--------|-------------|------|--------|
| 1 | Tabelas com RLS sem política | 21 | **Não** (negado por padrão) | Nenhuma política criada | Aceito |
| 2 | `pg_net` instalada em `public` | 1 | **Residual, não alcançável** | Revogação condicional (0046) | Mitigado |
| 3 | Funções `SECURITY DEFINER` executáveis | 24 | **1 de 24** | `REVOKE` de 1 órfã (0046) | Reduzido a 23 |

---

## Grupo 1 — 21 tabelas com RLS habilitada e nenhuma política

### O aviso

> `rls_enabled_no_policy`: *Table `public.X` has Row Level Security enabled but
> no policies. This is usually a mistake and will prevent all access to the
> table for `anon` and `authenticated` roles.*

O texto do próprio Advisor entrega a classificação: **"this is usually a
mistake"** — um aviso de *possível engano de configuração*, não de exposição.

### O que está de fato configurado

As 21 tabelas (`admin_audit_log`, `admin_users`, `app_settings`, `deliveries`,
`delivery_units`, `import_batches`, `job_health`, `order_events`, `order_items`,
`orders`, `payment_events`, `payments`, `product_categories`,
`product_price_history`, `products`, `provider_api_gates`,
`rate_limit_counters`, `refund_requests`, `stock_reservation_units`,
`stock_reservations`, `stock_units`) têm:

- **RLS habilitada** (`relrowsecurity = true`);
- **zero políticas** (`pg_policies` → 0 linhas por tabela);
- **zero GRANT** para `anon`, `authenticated` ou `PUBLIC`
  (`role_table_grants` → **0 linhas** para esses três papéis em todo o schema
  `public`);
- acesso apenas por `postgres` e `service_role`.

São **duas** barreiras independentes, não uma: sem GRANT, o pedido é recusado
antes de o RLS ser avaliado (`permission denied for table`); se um GRANT
aparecesse por engano, o RLS sem política ainda negaria tudo (negar é o padrão
do RLS com zero políticas). O Compose é *defense in depth*, não uma única
trava.

### Por que a ausência de políticas é a arquitetura, e não um esquecimento

O produto **não expõe o banco ao navegador**. O frontend nunca fala com o
PostgREST diretamente:

- `src/` tem **zero** chamadas `.rpc(` (verificado por varredura);
- o fluxo administrativo passa por `invokeFunction('admin-api')`
  (`src/services/adminAuth.ts:254`);
- `admin-api` chama o banco com `service_role` (contexto de sistema) ou
  repassa o **JWT do administrador** (`adminApi.ts:136`, `rpcForUser`) para que
  as funções `SECURITY DEFINER` imponham `assert_admin` **dentro do banco**.

Ou seja: a autorização não mora em políticas RLS — mora em `assert_admin()`,
que valida allowlist (`admin_users`), papel (`owner`/`admin`) e nível de
autenticação (`aal2`). Criar políticas RLS aqui **não acrescentaria segurança**;
acrescentaria um segundo modelo de autorização, divergente do primeiro, para
satisfazer um contador.

### Situação de `admin_users` (a tabela que autoriza)

É a mais sensível das 21 e merece prova individual:

| Verificação | Resultado |
|---|---|
| RLS habilitada | sim |
| Políticas | **0** |
| ACL | `postgres`, `service_role` (nenhum papel de usuário) |
| Escrita pela API | **impossível** — nenhum GRANT |
| Única função que escreve | `bootstrap_admin_register` (`SECURITY DEFINER`, `service_role` apenas) |
| Gatilho em `auth.users` que promove | **nenhum** (9 gatilhos não internos, todos `updated_at`/isolation) |
| Auto-promoção por cadastro | bloqueada: `disable_signup = true` **e** ausência de gatilho |

Testes que travam isso: `tests/db/22_admin_guardia_aal2.test.ts`
(*"nenhum gatilho em auth.users promove usuário a administrador"* e
*"usuário comum não escreve na allowlist nem por RPC nem por tabela"*).

### Classificação

**Falso positivo para segurança.** Mantido como está, de propósito. Qualquer
política criada aqui para "zerar o aviso" abriria uma segunda porta de
autorização sem necessidade — e a Missão 15.1 proíbe explicitamente esse
atalho.

---

## Grupo 2 — `pg_net` instalada no schema `public`

### O aviso

> `extension_in_public`: *Extension `pg_net` is installed in the `public`
> schema. …*

### O que está instalado

`pg_net` **0.20.4** em `public` (schema em que a extensão é criada por padrão no
Supabase). Ela traz três funções de disparo HTTP e duas tabelas internas:

| Objeto | ACL observada | Risco |
|---|---|---|
| `net.http_post` / `http_get` / `http_delete` | `PUBLIC` pode EXECUTE; `anon`/`authenticated` = true | **é a superfície real** |
| `net._http_response` | RLS desligada, privilégios totais a `PUBLIC` | resposta de requisições |
| `net.http_request_queue` | RLS desligada, privilégios totais a `PUBLIC` | fila de requisições |

O `GRANT EXECUTE ... TO PUBLIC` **não é escolha do projeto**: vem da própria
distribuição da extensão. É por isso que o Advisor acusa — e por isso "revogar
da extensão" não é a mesma operação que "revogar de uma função nossa".

### O que torna o risco residual em vez de ativo

`pg_net` é executável apenas por quem alcança o **PostgREST com o schema `net`
exposto**, ou por quem já tem sessão SQL. Verificações:

| Caminho | Verificação | Resultado |
|---|---|---|
| PostgREST expõe `net`? | `supabase/config.toml` → `schemas = ["public"]` | **não** |
| Override em runtime? | `pgrst.db_schemas` | **null** |
| Override por role? | `pg_db_role_setting` para `authenticator` | **nenhum** |
| Suposição de busca? | `authenticator` = `supautils` + `safeupdate` | sem `net` |

Conclusão: hoje o caminho **não existe**. Para explorar, um atacante precisaria
primeiro de credenciais que já permitissem SQL — e nesse ponto `pg_net` é o
menor dos problemas.

Quem **usa** `pg_net` legitimamente: o **pg_cron**, job `prime-store-wyvi-worker`
(jobid 3), que roda como `postgres` e chama `net.http_post` para acordar
`wyvi-worker`. Superusuário mantém EXECUTE independentemente de `REVOKE` de
`PUBLIC`/`anon`/`authenticated` — por isso a revogação é segura.

### Proteção aplicada (local, versionada)

A migração **`20261122120000_0046_reduzir_superficie_rpc.sql`** revoga
`EXECUTE` de `PUBLIC`, `anon` e `authenticated` em `net.http_post`,
`net.http_get` e `net.http_delete`, dentro de um bloco **condicional**:

```sql
if exists (select 1 from pg_extension where extname = 'pg_net') then …
```

A condição não é cosmética: **o banco local e o do CI não instalam `pg_net`**
(`bootstrap_local.sql` não a cria). Um `REVOKE` incondicional em função
inexistente abortaria `resetDatabase()` e derrubaria as **475** provas de banco.
A migração é idempotente e tolera versões da extensão com assinatura diferente
de `http_delete` (captura `undefined_function`).

### O que esta migração NÃO faz, e por quê

- **Não move `pg_net` para outro schema.** O schema é gerenciado pela
  plataforma; mover extensão não é operação suportada e o objeto pode ser
  recriado pelo Supabase. O Advisor continuaria apontando, e um `DROP`/`CREATE`
  arriscaria o cron de pagamentos — proibido nesta missão.
- **Não revoga das tabelas `net.*`.** `net._http_response` e
  `net.http_request_queue` são internas da extensão, sem RLS, e o acesso é o
  mesmo caminho não alcançável descrito acima. Revogar ali quebraria a leitura
  de respostas pelo `pg_cron` sem ganho de superfície.

### Classificação

**Risco residual, não alcançável na configuração atual.** O aviso permanecerá
visível no Advisor (o schema não muda) — e isso é aceitável e documentado. O
que mudou foi a superfície: papéis de usuário final não conseguem mais
disparar `net.http_*` **se** `net` for exposto no futuro.

---

## Grupo 3 — 24 funções `SECURITY DEFINER` executáveis por `authenticated`

### O aviso

> `*_security_definer_function_executable`: *Function `public.X` is
> `SECURITY DEFINER` and can be executed by the `authenticated` role.*

O aviso está **tecnicamente correto** e, para 23 das 24, é **necessário**:
`admin-api` chama essas funções com o **JWT do administrador**
(`adminApi.ts:136`), e o PostgREST troca o papel pelo `sub` do token. Revogar
`EXECUTE` de `authenticated` **quebraria o painel** — não é hipótese, é o
mecanismo de autorização.

### Como cada uma se protege

Todas as 24 chamam `assert_admin()`, que valida em três camadas e falha em
códigos distintos (o que permite teste cirúrgico):

| Camada | Condição | Erro |
|---|---|---|
| Sessão | sem `sub` | `not_authenticated` (28000) |
| Allowlist | não está em `admin_users` ativo | `not_admin` (42501) |
| MFA | `mfa_required` e `aal <> aal2` | `mfa_required` (42501) |

`is_admin()` é a 24ª e é o **booleano de UI**: não opera nada, devolve
`false` para quem não é admin, e é o único ponto que o frontend consulta para
decidir se mostra a tela.

### A única que era superfície sem função

`admin_stock_summary()` (criada na 0012, `GRANT` na 0014) **não tinha
chamador**: nenhuma referência em `supabase/functions/`, `src/` ou `scripts/`;
substituída por `admin_stock_summary_by_product()` na 0045. Varredura das 24
nomes contra todo o código de produção confirmou **1 sem referência** — ela.

A 0046 revoga `EXECUTE` de `public`, `anon` e `authenticated`; mantém
`postgres` e `service_role` para diagnóstico. Resultado: a recusa dela deixou
de ser `mfa_required`/`not_admin` (que pressupõe entrar no corpo) e passou a ser
`permission denied` — barreira **mais forte**, aplicada antes da função rodar.

### Cobertura de prova (4 cenários × 24 funções)

| Cenário | Papel | Resultado esperado | Onde está provado |
|---|---|---|---|
| A — visitante | `anon` | `permission denied` em todas | teste 08 (anon sem funções) + teste 22 |
| B — autenticado comum | `authenticated`, AAL2 | `not_admin` em todas | teste 22 (varredura dinâmica) |
| C — admin sem MFA | `authenticated`, AAL1 | `mfa_required` em 23; `permission denied` em `admin_stock_summary` | teste 22 + teste 28 |
| D — admin com MFA | `authenticated`, AAL2 | sucesso | teste 22 (controle positivo) + teste 28 |

Testes relevantes: `tests/db/22_admin_guardia_aal2.test.ts` (varredura
dinâmica de `admin\_%` + `is_admin` + tentativas de escalada),
`tests/db/08_privilegios_funcoes.test.ts` (nenhum GRANT a anon; universo de
`authenticated` = `admin_*`/`is_admin`),
`tests/db/23_search_path_total.test.ts` (`search_path` fixo em definer e
invoker), `tests/db/28_reducao_superficie_rpc.test.ts` (as 22 do painel
continuam executáveis; a órfã não; o conjunto é exatamente `admin_*` +
`is_admin`).

### Por que as outras 23 não são revogadas

Revogar `EXECUTE` de `authenticated` numa função usada pelo painel faz o painel
responder `permission denied` ao administrador legítimo. O requisito da missão
é **provar que não quebra antes de remover** — e a prova aqui aponta o
contrário: são *load-bearing*. A superfície dessas 23 é o próprio mecanismo de
autorização, e ele já está provado nos quatro cenários.

### Classificação

**23 necessárias e provadas. 1 eliminada.** O aviso continuará listando 23 no
Advisor; é o número correto para esta arquitetura.

---

## O que foi feito e o que permanece

| Grupo | Antes | Depois | Fica no Advisor? |
|---|---|---|---|
| RLS sem política | 21 | 21 | Sim (aceito — negar é o desenho) |
| `pg_net` em `public` | 1 | 1 | Sim (schema gerenciado; superfície fechada) |
| Funções executáveis | 24 | 23 | Sim (23 são o mecanismo de autorização) |

**Nenhum aviso foi escondido.** A diferença entre esta auditoria e "zerar o
painel" é que cada linha acima tem uma razão escrita e um teste que a trava.

### Limitações registradas

1. A migração 0046 está **versionada e provada localmente**, mas **não foi
   aplicada em produção** — a Missão 15.1 é somente leitura. O bloqueio de
   `admin_stock_summary` e de `net.*` em produção só vale após
   `supabase db push` autorizado pelo operador.
2. Enquanto não for aplicada, produção permanece com 24 funções executáveis e
   `net.http_*` aberto a `PUBLIC` — o cenário descrito em "Grupo 2" como não
   alcançável continua sendo a única proteção em produção.
3. O Advisor não avalia comportamento: ele não vê que `assert_admin` existe.
   Um aviso classificado aqui como "necessário" precisa desta justificativa
   junto, senão um futuro revisor o tratará como pendência aberta.
