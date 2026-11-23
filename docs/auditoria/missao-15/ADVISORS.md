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
| 2 | `pg_net` instalada em `public` | 1 | **Residual, não alcançável** | Descoberta dinâmica + verificação (0046); fecha só com posse | **Aberto (P7)** |
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

### Proteção aplicada — e a limitação que a Missão 15.1 escondeu

**Primeiro, o que a 15.1 errou.** A versão anterior revogava usando
assinaturas **escritas à mão**:

```sql
-- ERRADO (15.1)
revoke execute on function net.http_post(text, jsonb, jsonb, text, integer) ...
revoke execute on function net.http_delete(text, jsonb, jsonb, integer) ...
```

O catálogo real (pg_net 0.20.4) diz outra coisa:

| Função | Assinatura real | O que a 15.1 usou |
|---|---|---|
| `http_post` | `(text, jsonb, jsonb, **jsonb**, integer)` | 4º arg `text` ❌ |
| `http_get` | `(text, jsonb, jsonb, integer)` | correto |
| `http_delete` | `(text, jsonb, jsonb, integer, **jsonb**)` | 4 args ❌ |

**Segundo, o erro maior — que assinatura certa não teria consertado.** Em
produção, `net.*` e o schema `net` pertencem a **`supabase_admin`**, e o
`postgres` **não é superusuário** (`rolsuper = false`) nem membro daquele papel.
Nessa condição, `REVOKE ... FROM PUBLIC` **não levanta exceção e não altera a
ACL** — é um no-op silencioso. Comprovado em laboratório
(`tests/db/29_pg_net_permissoes.test.ts`, cenário B):

```
ACL antes  = {=X/net_ext_owner, net_ext_owner=X/net_ext_owner}
ACL depois = {=X/net_ext_owner, net_ext_owner=X/net_ext_owner}   (idêntica)
```

Ou seja: **mesmo com as assinaturas corretas, a versão anterior não teria
revogado nada em produção.** Foi a suíte que a 15.2 acrescentou que revelou
isso — a suíte anterior só cobria "ambiente sem `pg_net`".

**Terceiro — revogar de `PUBLIC` quebraria o worker.** O `postgres` só executa
`net.http_post` **porque `PUBLIC` pode** (`proacl = NULL` ⇒ privilégios padrão).
Ele não é dono e não tem `GRANT` nominal. Fechar `PUBLIC` sem conceder
explicitamente a `postgres` derrubaria o cron job `prime-store-wyvi-worker`.

### O que a migração 0046 faz agora

1. **Descobre os alvos no catálogo**, nunca por assinatura digitada
   (`pg_proc` + `pg_namespace` + `oid::regprocedure`).
2. **Só executa `REVOKE` se a sessão realmente puder** (dono do schema ou
   superusuário). Não finge sucesso.
3. **Verifica o resultado** com `has_function_privilege` e `aclexplode`
   (`grantee = 0` = PUBLIC) e **lança exceção** se a ACL continuar aberta.
4. **Quando não pode revogar**, emite `RAISE WARNING` nomeando o dono e a ação
   necessária — a pendência fica visível no log do `db push`, não silenciosa.
5. **Nunca engole erro**: não há `WHEN OTHERS THEN NULL`. Se `pg_net` existe e
   nenhuma das três funções é encontrada, **levanta exceção** pedindo
   investigação — exatamente o caso que um `exception when undefined_function`
   esconderia.
6. **Bloco condicional** para ambiente sem a extensão (local/CI não a instalam).

**Efeito real hoje:**

| Ambiente | Resultado da 0046 |
|---|---|
| local/CI (sem `pg_net`) | conclui; aplica só a revogação da órfã |
| Supabase (dono `supabase_admin`, sessão `postgres`) | conclui **com WARNING**; `net.*` permanece aberto |

O fechamento de `net.*` **exige o proprietário** (`supabase_admin`) — é a
pendência **P7** de `DEPENDENCIAS-HUMANAS.md`. A migração entrega o
diagnóstico comprovado e o caminho, e passa a **falhar alto** em vez de
registrar sucesso falso.

### Schema `net` — USAGE

`pg_namespace.nspacl` mostra `anon` e `authenticated` com `USAGE` no schema
`net` (`=U/supabase_admin` para PUBLIC + concessões explícitas). Pelo mesmo
motivo (posse), não é revogável pela migração. Não é alcançável hoje porque
`db-schemas = public`; entra na **P7**.

### Classificação

**Risco residual, não alcançável na configuração atual — e NÃO corrigido pela
0046.** O aviso continuará visível. A migração **não** fecha `net.*` em
produção porque a sessão de migração não é dona (`supabase_admin`). Quando
executada por um papel com posse, ela fecha e comprova; quando não, **avisa e
não mente**. Fechar exige ação do proprietário (P7).

---

## Grupo 3 — 24 funções `SECURITY DEFINER` executáveis por `authenticated`

### O aviso

> `*_security_definer_function_executable`: *Function `public.X` is
> `SECURITY DEFINER` and can be executed by the `authenticated` role.*

### Correção de uma imprecisão da Missão 15.1

A versão anterior deste documento afirmava que **todas as 24** chamam
`assert_admin()`. Isso estava errado e a diferença importa: **23 não são o mesmo
tipo de objeto**. Tratar as três classes como uma só esconderia a única que
realmente era superfície sem função.

O inventário real (contado no código, não estimado):

| Grupo | Quantidade | O que é | Proteção | Estado após 0046 |
|---|---|---|---|---|
| **Administrativas usadas** | **22** | operações de painel, chamadas por `admin-api` | `assert_admin()` completo | **mantidas** (`authenticated` executa) |
| **Consulta `is_admin`** | **1** | booleano de UI, sem efeito colateral | `auth.uid()` + `admin_users` + AAL | **mantida** |
| **Administrativa órfã** | **1** | `admin_stock_summary()`, sem chamador | tinha `assert_admin()`, mas ninguém chama | **`EXECUTE` revogado** |
| **Total** | **24** | | | 23 executáveis |

O número 22 é verificável: `adminApi.ts` faz **22 chamadas `rpc(...)` a
`admin_*`** + **1 a `is_admin`** (contagem por varredura do arquivo, não
estimativa). Somando a órfã, fecham as 24 do Advisor.

### Matriz por função

As 22 administrativas usadas, todas com a mesma proteção:

| Função | Chamador | Autorização | Exige MFA | Papel que executa |
|---|---|---|---|---|
| `admin_add_stock_unit` | `admin-api` | `assert_admin` | sim (`mfa_required`) | `authenticated` (admin) |
| `admin_audit_log` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_create_product` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_expire_reservations` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_get_order` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_get_product` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_import_stock_units` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_indicators` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_list_orders` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_list_products` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_list_refund_requests` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_list_stock` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_resolve_dispute` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_resolve_refund` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_revoke_delivery` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_rotate_delivery_token` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_set_product_active` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_set_stock_unit_status` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_stock_fingerprints` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_stock_summary_by_product` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_update_product` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |
| `admin_update_stock_unit` | `admin-api` | `assert_admin` | sim | `authenticated` (admin) |

A função de consulta — **não** é operação administrativa:

| Função | Chamador | Autorização | Exige MFA | Papel que executa | Comportamento |
|---|---|---|---|---|---|
| `is_admin(p_require_mfa boolean)` | frontend + `admin-api` | `auth.uid()` → `admin_users` (`is_active`, `role`) + comparação `aal` | **não lança**; devolve `false` | `authenticated` | `false` para anon, estranho e AAL1 com MFA exigido; `true` só para admin em AAL2 |

A órfã — **única revogada**:

| Função | Chamador | Autorização | Estado |
|---|---|---|---|
| `admin_stock_summary()` | **nenhum** (0 referências em `supabase/functions/`, `src/`, `scripts/`) | tinha `assert_admin`, mas sem chamador é superfície pura | **`EXECUTE` revogado de `public`/`anon`/`authenticated`**; mantido para `postgres`/`service_role` |

### Por que a órfã era o único alvo seguro

`admin-api` chama as 22 com o **JWT do administrador** (`adminApi.ts:136`,
`rpcForUser`), e o PostgREST troca o papel pelo `sub` do token. Revogar
`authenticated` nas 22 **quebraria o painel** — o `EXECUTE` de `authenticated`
*é* o mecanismo de autorização. Na órfã, o raciocínio se inverte: sem chamador,
o `EXECUTE` não protege nada e só amplia a superfície.

Consequência observável: a recusa dela deixou de ser `mfa_required`/`not_admin`
(que pressupõem entrar no corpo) e passou a ser `permission denied`, aplicada
**antes** da função rodar.

### Como as três camadas falham

| Camada | Condição | Erro |
|---|---|---|
| Sessão | sem `sub` no JWT | `not_authenticated` (28000) |
| Allowlist | não está em `admin_users` ativo | `not_admin` (42501) |
| MFA | `mfa_required` e `aal <> aal2` | `mfa_required` (42501) |

### Cobertura de prova

| Cenário | Papel | Resultado esperado | Onde está provado |
|---|---|---|---|
| A — visitante | `anon` | `permission denied` em todas | teste 08 + teste 22 |
| B — autenticado comum | `authenticated`, AAL2 | `not_admin` em 22; `permission denied` na órfã | teste 22 (varredura dinâmica) |
| C — admin sem MFA | `authenticated`, AAL1 | `mfa_required` em 22; `permission denied` na órfã | testes 22 + 28 |
| D — admin com MFA | `authenticated`, AAL2 | sucesso | testes 22 + 28 (controle positivo) |
| E — `is_admin` | anon/estranho/AAL1/AAL2 | `false`/`false`/`false`/`true` | teste 22 |
| F — auto-promoção | `authenticated` | `permission denied for table`; nenhum gatilho em `auth.users`; 0 RPCs de escrita na allowlist | teste 22 |

Testes: `tests/db/22_admin_guardia_aal2.test.ts`,
`tests/db/08_privilegios_funcoes.test.ts`,
`tests/db/23_search_path_total.test.ts`,
`tests/db/28_reducao_superficie_rpc.test.ts`.

---

## O que foi feito e o que permanece

| Grupo | Antes | Depois | Fica no Advisor? |
|---|---|---|---|
| RLS sem política | 21 | 21 | Sim (aceito — negar é o desenho) |
| `pg_net` em `public` | 1 | 1 | Sim (schema gerenciado; superfície fechada) |
| Funções executáveis | 24 | 23 | Sim (23 são o mecanismo de autorização) |

**Nenhum aviso foi escondido — e nenhuma correção foi declarada sem prova.**
A diferença entre esta auditoria e "zerar o painel" é que cada linha tem razão
escrita e teste que a trava. E a diferença entre esta versão e a anterior é que
a 15.2 **descobriu que a 15.1 declarava mitigado algo que continuava aberto**.

### Limitações registradas

1. A migração 0046 está **versionada e provada localmente (10 cenários)**, mas
   **não foi aplicada em produção** — a missão é somente leitura.
2. **Mesmo após `db push`, `net.*` continuaria aberto**: a sessão de migração
   (`postgres`) não é dona. O fechamento exige `supabase_admin` (P7). Este é o
   achado central da 15.2 e o motivo de a migração não declarar sucesso falso.
3. A revogação da órfã (`admin_stock_summary`) **essa sim** funciona, porque a
   função pertence a `postgres` em produção (confirmado por consulta).
3. O Advisor não avalia comportamento: ele não vê que `assert_admin` existe.
   Um aviso classificado aqui como "necessário" precisa desta justificativa
   junto, senão um futuro revisor o tratará como pendência aberta.
