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
