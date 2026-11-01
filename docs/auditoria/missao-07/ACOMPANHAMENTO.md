# Missão 07 — acompanhamento (backend hardening)

Documento de trabalho: registra reconhecimento, decisões e evidências conforme a
missão avança. O relatório final é [`RELATORIO.md`](./RELATORIO.md).

## Etapa 00 — reconhecimento

### Branch e estado do repositório

- A missão pede uma branch nova (`arena/missao-07-backend-hardening`). Este
  ambiente de execução **fixa** a branch `arena/08e7eb3e-prime-store` e não
  permite criar nem trocar de branch; portanto todo o trabalho continua nela.
  O commit de origem é `b4f0acd` (Missão 06), já com `4bb31d6` e `6c51f18`.
- O checkout do sandbox chegou com a árvore de trabalho dessincronizada do
  remoto (HEAD em `84226d9`, conteúdo das Missões 01–06 como arquivos não
  rastreados). Antes de qualquer alteração, o conteúdo foi copiado para
  `/home/user/scratch/backup-pre07` e comparado: **idêntico** ao commit
  `b4f0acd` do remoto. Em seguida `git reset --hard FETCH_HEAD` deixou a árvore
  limpa no commit da Missão 06 — nada foi perdido.

### Ambiente local reconstruído

- `npm ci` (dependências) e PostgreSQL 18.6 embutido
  (`@embedded-postgres/linux-x64` em `/tmp/pgdata`, trust auth, socket em
  `/tmp/pgdata`). `DATABASE_URL='postgresql://postgres@/postgres?host=/tmp/pgdata'`.
- O PostgreSQL local **não** oferece `pg_cron` (só `pgcrypto` disponível). Isso
  define o desenho da Etapa 02: a migração precisa ser no-op quando o mecanismo
  não existe, e os testes exercitam a função de execução, não o agendador.

### Sandbox

- Projeto conectado: `prime-store-sandbox` (`eorlmqolbknrplvdbbtl`, PostgreSQL
  17.11, região sa-east-1) — **é o sandbox**, único projeto acessível.
- `pg_cron` está **disponível** (`default_version 1.6.4`) mas **não instalado**;
  `pg_net 0.20.4` e `http 1.6` também disponíveis (`http` já instalado).
- Histórico remoto: **27 registros**, com nomes/versões de outra linhagem
  (`20261031003135 foundation` … `20261031153926 demo_semeadura_privilegios`),
  enquanto o repositório tem **30 arquivos** `20261031120000_0001_…` a
  `20261031140000_0030_…`. Diagnóstico completo na Etapa 04.
- Edge Functions publicadas (verificadas por API): `catalog` v6, `create-order`
  v6, `order-status` v4, `delivery` v4, `mp-webhook` v4, `admin-api` v4,
  `demo-payment` v3.

### Arquivos-chave mapeados

| Assunto | Arquivo |
| --- | --- |
| Webhook do provedor | `supabase/functions/_shared/handlers/mpWebhook.ts`, `_shared/mercadopago.ts` |
| Expiração de reservas | `supabase/migrations/…0011_funcoes_nucleo.sql` (`expire_overdue_reservations`), `handlers/catalog.ts` |
| Catálogo | `handlers/catalog.ts`, `_shared/mappers.ts` |
| Criação de pedidos | `handlers/createOrder.ts` |
| Pagamento demonstrativo | `handlers/demoPayment.ts`, migrações `0026`–`0029` |
| Permissões | `…0014_seguranca_rls_grants.sql`, `…0022_privilegios_finais.sql`, `…0024`, `…0029` |
| Migrações | `supabase/migrations/` (30 arquivos) |

## Etapa 01 — assinatura do webhook (concluída)

`mpWebhook.ts` valida autenticidade **antes** de qualquer leitura de dados:

| Situação | Resposta |
| --- | --- |
| `MERCADOPAGO_WEBHOOK_SECRET` ausente | `503 webhook_not_configured` |
| `x-signature` / `x-request-id` / `data.id` ausentes | `401 invalid_signature` |
| HMAC divergente | `401 invalid_signature` (comparação em tempo constante) |
| `ts` com mais de 24 h ou mais de 5 min no futuro | `401 stale_signature` |
| assinatura válida | processa e **reconfirma o pagamento no provedor** |

- Nada é gravado em `payment_events` antes da validação; o segredo e a
  assinatura completa não vão para o log.
- Não existe rota de bypass nem interruptor de "modo teste" para a validação.
- `mercadopago.ts` ganhou `SIGNATURE_MAX_AGE_SECONDS`,
  `SIGNATURE_CLOCK_TOLERANCE_SECONDS`, `isSignatureTimestampFresh` e um
  verificador único usado pelo handler e pelos testes
  (`tests/db/mpSignature.ts` gera a assinatura como o provedor).
- O teste herdado da Missão 04 que aceitava evento sem assinatura foi
  **reavaliado**: agora ele assina o payload. Não foi removido — passou a
  representar o comportamento seguro.
- `tests/db/11_webhook_assinatura.test.ts`: 9 casos (válida, inválida, ausente,
  segredo ausente, cabeçalhos incompletos, dados inválidos, repetição, evento
  válido com consulta simulada ao provedor, notificação inválida não altera
  pedido). Commit `4397e64`.

## Etapa 02 — expiração automática de reservas (concluída)

- Migração `0031_agendamento_expiracao_reservas` cria `public.job_health`
  (uso interno, RLS, sem acesso para `anon`/`authenticated`) e
  `public.run_reservation_expiry()`, que **reusa** `expire_overdue_reservations`
  — a regra de negócio continua em um único lugar.
- Concorrência: `pg_try_advisory_lock` por execução; a função é idempotente
  (reexecutar não devolve unidade duas vezes, coberto por teste).
- Agendamento: `pg_cron` a cada minuto, **apenas quando a extensão existe**
  (no PostgreSQL local é no-op; o teste detecta pela presença do schema `cron`).
  Nenhuma extensão foi habilitada remotamente ainda.
- Falhas ficam em `job_health` (`released_units`, `consecutive_failures`,
  `last_error_code`, `last_run_at`) sem dados sensíveis.
- `tests/db/12_expiracao_automatica.test.ts`: 7 casos. Commit `d970357`.

## Etapa 03 — limite de requisições (concluída)

- Migração `0032_limite_requisicoes`: tabela interna
  `public.rate_limit_counters` (RLS ligada, **sem** privilégio para `anon` nem
  `authenticated`) e `public.consume_rate_limit(route, subject, limit, window)`,
  que incrementa a janela em **uma única instrução atômica**
  (`insert … on conflict do update … returning`) — não há leitura seguida de
  escrita, logo não há corrida entre instâncias. `prune_rate_limit_counters`
  limpa janelas antigas (pg_cron de hora em hora, quando disponível).
- `_shared/rateLimit.ts`: limites por rota — `catalog` 120/min,
  `create-order` 10/min, `order-status` 60/min, `delivery` 30/min,
  `demo-payment` 30/min, `admin-api` 120/min. Ajustáveis por
  `RATE_LIMIT_OVERRIDES` (formato `rota=valor,…`).
- A origem vem do `x-forwarded-for` (última entrada, escrita pelo proxy), não de
  campo enviado pelo navegador. O banco guarda um **HMAC truncado** do IP com
  `RATE_LIMIT_SECRET`, não o IP. IPv6 é agrupado por `/64` e IPv4 mapeado em
  IPv6 é normalizado para o IPv4 equivalente.
- Resposta ao exceder: `429` com `Retry-After` (segundos restantes da janela) e
  `retry_after_seconds` no corpo; o `index.ts` continua aplicando CORS.
- Falha do contador (RPC indisponível) **libera** a rota e registra
  `rate_limit.unavailable` — indisponibilidade do medidor não derruba a loja.
- `mp-webhook` fica **fora** do limite por decisão de projeto: bloquear por
  origem pode descartar aprovação legítima reenviada pelo provedor; a proteção
  dele é assinatura HMAC + deduplicação.
- `tests/db/13_limite_requisicoes.test.ts`: 16 casos (limite por rota e por
  origem, 429 com `Retry-After`, persistência entre instâncias, concorrência,
  expiração de janela, checkout completo dentro do limite, idempotência
  preservada, tabelas internas inacessíveis, webhook isento, normalização de
  endereço).

## Etapa 04 — reconciliação das migrações (concluída)

Diagnóstico com medição, não com suposição: schema do sandbox e schema gerado
pelos 30 arquivos do repositório são **idênticos** (tabelas, colunas, funções,
enums, índices, triggers, view, RLS, constraints e privilégios). A divergência é
só de nomenclatura/carimbo de tempo. Detalhes e evidência:
[`04-reconciliacao-migracoes.md`](./04-reconciliacao-migracoes.md). Nenhum
registro de histórico foi alterado; nenhuma migração destrutiva foi executada;
`0031`/`0032` foram renomeadas para carimbos posteriores ao último registro
remoto.
