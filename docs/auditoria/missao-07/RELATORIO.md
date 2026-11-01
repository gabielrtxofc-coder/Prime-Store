# Missão 07 — hardening do backend e preparação para pré-produção

> Branch: `arena/08e7eb3e-prime-store` (o ambiente de execução fixa esta branch e
> não permite criar `arena/missao-07-backend-hardening`; ver seção 8).
> Commit de origem: `b4f0acd` (Missão 06). Data: 2026-11-01.
> Nada foi mesclado na `main`. Nada foi publicado em produção. Nenhum pagamento
> real foi gerado. Documento de trabalho: [`ACOMPANHAMENTO.md`](./ACOMPANHAMENTO.md);
> diagnóstico de migrações: [`04-reconciliacao-migracoes.md`](./04-reconciliacao-migracoes.md).

## 1. Resumo executivo

A missão tinha seis pendências herdadas. Cinco foram resolvidas com evidência e
uma foi diagnosticada até o fim sem correção destrutiva.

| Pendência | Situação |
| --- | --- |
| Webhook do Mercado Pago aceitava notificação sem assinatura (achado D da Missão 06) | **corrigida** e verificada no sandbox: notificação forjada não grava nada |
| Expiração de reserva dependia de alguém abrir a loja | **corrigida**: `pg_cron` executa a rotina a cada minuto no sandbox; pedido expirou sozinho |
| Rotas públicas sem controle de volume | **corrigida**: limite persistente no banco, por rota e por origem; `429` observado em HTTP real |
| Histórico de migrações: 27 registros × 30 arquivos | **diagnosticada**: os schemas são idênticos; a divergência é de nomenclatura. Nenhum registro alterado |
| Regressão geral depois do endurecimento | **aprovada**: 198 testes de banco, 70 de frontend, `tsc` limpo, build OK |
| Integração no sandbox | **feita parcialmente**: banco, agendador e 2 funções republicadas; 5 funções não puderam ser publicadas por falta de credencial de deploy no ambiente |

O que a missão pede como critério final está atendido, com duas ressalvas
explícitas: **o segredo do webhook não está configurado no sandbox** (por isso a
rota responde `503` e recusa tudo — o comportamento seguro) e **cinco Edge
Functions continuam em versões anteriores** à do repositório.

## 2. Problemas identificados

### A. Webhook aceitava qualquer notificação (crítico)

O handler `mp-webhook` gravava o evento e seguia para o provedor sem verificar
quem enviou. Comprovado no sandbox, na versão publicada (`v4`), antes de
qualquer alteração desta missão:

```
POST /functions/v1/mp-webhook        corpo: {"type":"payment","data":{"id":"123456789"}}
→ 503 {"error":"payment_not_configured"}
→ linha criada em public.payment_events:
   notification_id = "payment:123456789:no-request-id", signature_valid = null
```

Ou seja: uma requisição anônima e sem assinatura conseguiu **escrever no
histórico de pagamentos**. Se houvesse token do provedor configurado, ela teria
avançado sobre `apply_payment_status`.

### B. Reserva vencida só expirava com tráfego

Herdado da Missão 06: `expire_overdue_reservations` só rodava quando alguém
acessava catálogo, criava pedido ou consultava status. Loja parada = unidade
presa em `reserved` indefinidamente e produto anunciado como esgotado.

### C. Rotas públicas sem limite de volume

`catalog`, `create-order`, `order-status`, `delivery`, `demo-payment` e
`admin-api` não tinham nenhum controle. Um laço simples podia consumir estoque
de reservas, poluir `payment_events` ou derrubar a função por custo de execução.
Um contador em memória não resolveria: as Edge Functions rodam em várias
instâncias e cada uma tem memória própria.

### D. Histórico de migrações com duas linhagens

27 registros (`20261031003135` … `20261031153926`, nomes funcionais) contra 30
arquivos (`20261031120000_0001_…` … `20261031140000_0030_…`). Suspeita inicial de
schema desatualizado — **descartada por medição** (seção 5).

### E. Nenhum teste cobria assinatura inválida, limite ou agendamento

A suíte da Missão 06 testava o webhook com evento **sem assinatura**, o que
consagrava o comportamento inseguro.

## 3. Correções implementadas

### 3.1 Assinatura obrigatória no webhook (`4397e64`)

- `_shared/mercadopago.ts`: `verifyWebhookSignature`, `isSignatureTimestampFresh`,
  `SIGNATURE_MAX_AGE_SECONDS` (24 h) e `SIGNATURE_CLOCK_TOLERANCE_SECONDS` (5 min),
  comparação de HMAC em **tempo constante**.
- `handlers/mpWebhook.ts`: ordem nova de decisão — segredo ausente → `503
  webhook_not_configured`; cabeçalhos incompletos → `401 invalid_signature`;
  HMAC divergente → `401 invalid_signature`; `ts` velho/futuro → `401
  stale_signature`; **só então** `record_payment_event` e a reconferência do
  pagamento em `GET /v1/payments/{id}` (que continua sendo a fonte de verdade).
- Nenhuma linha é gravada antes da validação. Nem o segredo nem a assinatura
  completa vão para o log (só o `notification_id` e o motivo).
- Não há rota de bypass, cabeçalho de "modo teste" nem variável que relaxe a
  checagem.
- O teste herdado que aceitava evento sem assinatura foi **reavaliado**: passou a
  assinar o payload com o segredo fictício. Não foi removido.

### 3.2 Expiração automática (`d970357`)

- Migração `0031_agendamento_expiracao_reservas`: `public.job_health` (interna,
  RLS ligada, sem política, sem acesso para `anon`/`authenticated`) e
  `public.run_reservation_expiry(p_source text)`, que **reusa**
  `expire_overdue_reservations` — a regra de negócio continua em um único lugar.
- Concorrência: `pg_try_advisory_xact_lock`; se o ciclo anterior ainda roda, o
  novo apenas registra `skipped` e não duplica devolução.
- Falha: grava apenas o **SQLSTATE** em `job_health.last_error_code` e incrementa
  `consecutive_failures`. Nenhuma mensagem de erro (que pode conter valor de
  coluna) é persistida.
- Agendamento: `pg_cron` `* * * * *` **quando a extensão existe**; sem ela a
  migração é no-op e o fallback preguiçoso continua valendo.

### 3.3 Limite de requisições (`9b2b07c`)

- Migração `0032_limite_requisicoes`: `public.rate_limit_counters`
  (`route, subject_hash, window_start, hits`), RLS ligada, sem política, sem
  privilégio para `anon`/`authenticated`; e `consume_rate_limit(route, subject,
  limit, window)`, que incrementa em **uma instrução atômica**
  (`insert … on conflict do update … returning`) — não existe leitura seguida de
  escrita, logo não há corrida entre instâncias. `prune_rate_limit_counters`
  limpa janelas antigas (cron de hora em hora).
- `_shared/rateLimit.ts`: limites por rota — `catalog` 120/min, `create-order`
  10/min, `order-status` 60/min, `delivery` 30/min, `demo-payment` 30/min,
  `admin-api` 120/min; ajustáveis por `RATE_LIMIT_OVERRIDES` (`rota=valor,…`).
- Origem: `x-forwarded-for` lido da **última** entrada (a que o proxy escreve),
  com alternativas `cf-connecting-ip`/`x-real-ip`; IPv6 agrupado por `/64` e
  IPv4 mapeado em IPv6 normalizado. O banco guarda **HMAC-SHA256 truncado** do
  IP, nunca o IP.
- Resposta: `429` com `Retry-After` e `retry_after_seconds`; CORS preservado pelo
  `index.ts`.
- Indisponibilidade do contador → **fail-open** com log `rate_limit.unavailable`:
  o medidor não pode derrubar a loja.
- `mp-webhook` fica **fora** do limite por decisão de projeto: o provedor envia de
  vários IPs e reenvia notificações por horas; bloquear por origem pode descartar
  uma aprovação legítima. A proteção dele é assinatura + deduplicação.

### 3.4 Correção de infraestrutura de teste (`af98ace`)

`tests/db/pgRpc.ts` passou a serializar parâmetros `jsonb` como JSON, replicando o
PostgREST. Sem isso `demo_seed_stock` recebia um array literal e falhava com
`invalid input syntax for type json` — o handler estava certo, o dublê de RPC é
que divergia do contrato real.

## 4. Segurança

| Controle | Estado | Evidência |
| --- | --- | --- |
| Assinatura do webhook | exigida, fail-closed | sandbox: forjada → `503`, **zero** linhas em `payment_events` |
| Segredo do webhook exposto | não escrito em log nem em resposta | revisão do handler + testes |
| RLS nas tabelas | 19/19 ligadas (2 novas incluídas) | contagem no banco |
| `anon` | nenhuma tabela/view, nenhuma função | `has_table_privilege`/`has_function_privilege` = falso |
| `authenticated` | sem `SELECT` direto; 23 funções `admin_*` que chamam `is_admin()` | suíte 08 + 14 |
| Funções internas novas | `run_reservation_expiry`, `consume_rate_limit`, `prune_rate_limit_counters` só `service_role` | consulta de privilégios no sandbox |
| Dado pessoal em log/tabela | IP vira HMAC truncado; erro guarda SQLSTATE | `rateLimit.ts`, migração 0031 |
| Autorização de admin | inalterada (allowlist + AAL2 no banco) | suíte 06/08 sem mudança |
| CORS | inalterado | cabeçalhos observados no `429` real |

Nenhuma proteção anterior foi enfraquecida. As duas tabelas novas nascem com o
mesmo padrão de negação das migrações `0022`/`0029`: RLS ligada, `revoke` de
`public`/`anon`/`authenticated`, `grant` apenas para `service_role`.

## 5. Banco de dados

- **Novas migrações**: `20261101090000_0031_agendamento_expiracao_reservas.sql` e
  `20261101091000_0032_limite_requisicoes.sql` (renomeadas de `20261031150000`/
  `20261031151000` para ficarem depois do último registro remoto — são arquivos
  novos, nunca aplicados em nenhum banco).
- **Reconciliação da etapa 04**: schema do sandbox e schema gerado pelos 30
  arquivos do repositório são **idênticos** — 17 tabelas, 174 colunas, 47 funções,
  6 enums, 56 índices, 6 triggers, 1 view, constraints 98 × 98 com diferença
  vazia e a mesma matriz de privilégios. Detalhe e método em
  [`04-reconciliacao-migracoes.md`](./04-reconciliacao-migracoes.md).
- Nenhum registro de `schema_migrations` foi apagado ou reescrito. As duas
  versões efetivamente aplicadas foram registradas **depois** de aplicadas, com
  comprovação nos objetos criados.
- Aplicado no sandbox: `0031` (tabela, função, `pg_cron` e 2 jobs) e `0032`
  (tabela, 2 funções, 1 job de limpeza). `pg_cron` foi habilitado **apenas no
  sandbox confirmado**; é reversível com `drop extension pg_cron`.

## 6. Testes

Ambiente: PostgreSQL 18.6 embutido (`/tmp/pgdata`), 32 migrações aplicadas do
zero a cada arquivo de teste; React/jsdom para o frontend.

| Verificação | Missão 06 | Missão 07 | Variação |
| --- | --- | --- | --- |
| `npx tsc -b` | limpo | limpo | — |
| Frontend (`npx vitest run`) | 70/70 em 9 arquivos | **70/70 em 9 arquivos** | — |
| Banco (`npx vitest run --config vitest.db.config.ts`) | 148/148 em 12 arquivos | **198/198 em 16 arquivos** | +50 casos |
| `npx vite build` | OK | OK | — |
| `npm run bundle:functions` | 7 bundles | 7 bundles | — |

Arquivos novos desta missão:

| Arquivo | Casos | Cobre |
| --- | --- | --- |
| `tests/db/11_webhook_assinatura.test.ts` | 9 | assinatura válida, inválida, ausente, segredo ausente, cabeçalhos incompletos, dados inválidos, repetição, evento válido com consulta simulada ao provedor, notificação inválida que não altera pedido |
| `tests/db/12_expiracao_automatica.test.ts` | 7 | wrapper, idempotência, trava de concorrência, `job_health` em sucesso e falha, privilégios, no-op sem `pg_cron` |
| `tests/db/13_limite_requisicoes.test.ts` | 16 | limites padrão por rota/origem, `429` com `Retry-After`, persistência entre instâncias, concorrência, expiração de janela, checkout completo dentro do limite, idempotência preservada, tabelas internas inacessíveis, webhook isento, normalização de endereço |
| `tests/db/14_regressao_missao07.test.ts` | 18 | estoque (8 checkouts simultâneos → 1 criado, sem oversell), consumo e expiração de unidade, replay idempotente, `409 previous_attempt_closed`, replay de pedido pago, ausência de campos internos nas respostas, três travas do modo demo, ausência de chamada ao provedor na aprovação simulada, permissões e coerência das migrações |

Os testes que não são sobre limite usam `RELAXED_RATE_LIMIT_OVERRIDES`
(100 000 por rota) porque falam com os handlers em sequência, muito acima do que
um cliente real faz; o limite **de produção** é exercitado em `13` com a
configuração padrão.

## 7. Integração no sandbox

Projeto confirmado: **`prime-store-sandbox` (`eorlmqolbknrplvdbbtl`)**,
PostgreSQL 17.11, `sa-east-1`. Pagamento real desligado (não existe
`MP_ACCESS_TOKEN`), modo demonstrativo intacto, nenhuma credencial, admin, CORS ou
domínio alterado. Requisições HTTP feitas de dentro do banco (`verif.http`).

| Passo | Resultado |
| --- | --- |
| `0031` aplicada | `job_health` criada, RLS ligada, `service_role` executa, `anon` não |
| `pg_cron` | 2 jobs: `prime-store-expire-reservations` (`* * * * *`) e `prime-store-rate-limit-prune` (`7 * * * *`) |
| Execuções do cron | 4 execuções, última `succeeded`; `job_health.last_success_at` atualizado, `consecutive_failures = 0` |
| Expiração automática **sem nenhuma chamada de cliente** | pedido envelhecido por SQL → `orders.status = expired`, reserva `expired`, `0` unidades reservadas, `last_processed = 1` |
| `0032` aplicada | `rate_limit_counters` criada, `consume_rate_limit` responde, `anon` sem acesso |
| `mp-webhook` publicado (**v5**) | notificação forjada → `503 webhook_not_configured`; `payment_events` continua com **2** linhas (nenhuma nova) |
| `create-order` publicado (**v7**) | checkout demo real → `201`, pedido `PS-RHT8MA`, `payment_mode: demo`, nenhuma cobrança |
| Limite em HTTP real | 30 requisições rápidas → `27 × 422` + **`3 × 429`** com `retry_after_seconds` 40–41 e cabeçalho `retry-after` |
| CORS no `429` | `access-control-allow-methods`, `access-control-max-age` e `vary` preservados |
| `. http://` do catálogo | `200`, 2 produtos, `availableUnits` real |

Antes/depois do webhook, medido no mesmo banco:

| Momento | Requisição | Resposta | `payment_events` |
| --- | --- | --- | --- |
| `v4` (publicada antes desta missão) | forjada, sem assinatura | `503 payment_not_configured` | **2** (linha nova criada às 06:10:40) |
| `v5` (esta missão) | forjada, sem assinatura | `503 webhook_not_configured` | **2** (nenhuma linha nova) |

Observação de campo relevante para o limite: as requisições saem por **IPs de
egresso diferentes**, então o orçamento por origem se divide entre eles — foi
necessário volume para observar o `429`. Também foi verificado que um
`x-forwarded-for` forjado pelo cliente **não** é usado como sujeito: o gateway
acrescenta o IP real ao final e a leitura da última entrada o descarta.

## 8. Pendências

1. **Publicar as cinco funções restantes** — `catalog` (v6), `order-status`
   (v4), `delivery` (v4), `demo-payment` (v3) e `admin-api` (v4) continuam nas
   versões anteriores; o código novo está no repositório e nos bundles. O
   ambiente de execução não tem `supabase` CLI nem token de deploy; `mp-webhook`
   e `create-order` foram publicados pelo conector. Comando previsto:
   `npm run bundle:functions && supabase functions deploy <slug> --project-ref
   eorlmqolbknrplvdbbtl` (respeitando `verify_jwt` de `supabase/config.toml`).
   Consequência atual: no sandbox, o limite vale apenas para `create-order`.
2. **Configurar `MP_WEBHOOK_SECRET`** no projeto, com o segredo da seção
   *Webhooks* do painel do Mercado Pago. Sem ele, o webhook recusa tudo com
   `503` (seguro, mas o fluxo de pagamento real não funciona). Não foi feito
   porque é credencial e a missão proíbe alterar credenciais sem autorização.
3. **Linhagem de migrações** — `supabase db push` continua perigoso neste
   projeto enquanto os 27 registros antigos existirem (ele tentaria reaplicar os
   30 arquivos). O reparo exige decisão externa (reset controlado do sandbox ou
   adoção de histórico novo). Enquanto isso, migração se aplica por SQL e se
   registra a versão efetivamente aplicada.
4. **`pg_cron` habilitado no sandbox e não em produção.** Levar `0031`/`0032`
   para produção exige habilitar a extensão no projeto de produção (decisão do
   responsável) — ou aceitar o fallback.
5. **Nome da branch** — a missão pede `arena/missao-07-backend-hardening`; o
   ambiente fixa `arena/08e7eb3e-prime-store`. Todo o trabalho está nela.
6. **Cinco funções publicadas por fora do CLI** — o `mp-webhook` e o
   `create-order` foram enviados minificados pelo painel/conector; o build
   canônico continua sendo `npm run bundle:functions`.

## 9. Riscos restantes

1. **Limite por IP atrás de NAT**: vários clientes no mesmo IP (rede
   corporativa, operadora CGNAT) compartilham o orçamento. Os limites foram
   escolhidos com folga para uso humano (10/min de checkout, 120/min de catálogo),
   mas tráfego legítimo concentrado pode receber `429`. Mitigação disponível sem
   tocar em dados: `RATE_LIMIT_OVERRIDES`.
2. **Fail-open do medidor**: se o RPC do contador falhar, a rota é liberada. É
   deliberado (disponibilidade > limite), e fica registrado em log.
3. **Assinatura não cobre todos os tipos de notificação**: segundo a documentação
   do provedor, notificações de Código QR não podem ser verificadas por
   assinatura. O handler hoje trata como "sem efeito" o que não é de pagamento,
   mas esse tipo precisa de conferência quando o QR integrado for usado.
4. **Confiança no `x-forwarded-for`**: depende de o gateway sempre acrescentar o
   IP real ao final. Verificado no sandbox; um proxy intermediário mal
   configurado poderia inverter a semântica. Por isso o sujeito é pseudonimizado
   e o limite é apenas uma camada.
5. **Reprocessamento do webhook**: deduplicação é por `notification_id` +
   `payload_hash`; notificações repetidas do provedor continuam sendo
   reconferidas no provedor (fonte de verdade), como antes.
6. **Versões mistas no sandbox** (pendência 1): enquanto `catalog`/`order-status`
   não forem republicados, o comportamento observado no sandbox não é o do
   repositório para essas rotas.
7. **`job_health` cresce em linhas?** Não: é uma linha por trabalho
   (`job_name` é chave primária). `rate_limit_counters` cresce em janelas e é
   podada de hora em hora — se o cron falhar, o `consume_rate_limit` também
   limpa oportunisticamente a própria chave.

## 10. Conclusão honesta

O que **foi implementado e verificado de verdade**:

- o webhook exige assinatura; no sandbox, uma notificação forjada deixou de
  escrever em `payment_events` (medido antes e depois, no mesmo banco);
- a expiração automática roda sozinha no sandbox e um pedido sem nenhum acesso
  de cliente passou a `expired`, devolvendo a unidade;
- o limite de requisições é persistente, atômico, pseudonimizado, e responde
  `429` com `Retry-After` em HTTP real, preservando CORS;
- a regressão está verde: 198 testes de banco, 70 de frontend, `tsc` limpo,
  build e bundles OK — 50 casos a mais que a Missão 06, sem nenhum teste antigo
  removido ou afrouxado;
- o descompasso de migrações foi resolvido como **diagnóstico**: os schemas são
  idênticos, medido objeto por objeto.

O que **não** está pronto, sem maquiagem:

- cinco Edge Functions do sandbox continuam nas versões antigas por falta de
  credencial de deploy no ambiente — o código está versionado, mas não publicado;
- o segredo do webhook não foi configurado, então o fluxo real de pagamento no
  sandbox está bloqueado por desenho (`503`);
- nada disso foi exercitado com pagamento real, e sandbox não é produção: as
  evidências mostram que o mecanismo funciona naquele projeto, não que a operação
  de produção está liberada.

Os critérios finais da missão estão cumpridos, exceto a publicação completa das
funções, registrada como pendência operacional objetiva.
