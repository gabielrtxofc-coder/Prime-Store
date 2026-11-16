# Relatório final — preparação operacional da loja (WyviPay + catálogo)

**Projeto:** `prime-store-sandbox` (`eorlmqolbknrplvdbbtl`, `sa-east-1`)
**Produção:** `https://prime-store-gilt.vercel.app` (deploy `dpl_hW9QUY1PDt3SzHThb39KXcnbSznu`, commit `b978715`)
**Branch do trabalho:** `arena/101f7703-prime-store` (base `b978715`)
**Data:** 2026-11-13

> Objetivo: deixar TODO o resto pronto para que o responsável realize somente
> **(1)** inserir a chave WyviPay no configurador seguro e **(2)** cadastrar
> produtos reais. Este documento descreve o estado real de cada etapa; o que
> não foi executado está declarado como pendente.

---

## A — Configurador WyviPay seguro (`scripts/wyvipay-setup.mjs`)

**Estado: concluída.**

- **A1 — entrada da chave:** `readHidden()` opera em TTY real em modo raw com
  eco desativado (Enter, backspace, Ctrl+C/Ctrl+D, sequências CSI ignoradas);
  o terminal é restaurado em qualquer cenário (Enter, erro de stream, EOF,
  cancelamento). Sem TTY seguro a entrada é **recusada com erro explícito**
  (`Sem TTY seguro e sem WYVI_API_KEY`) — nunca fallback com eco. Nenhuma chave
  por argv. `WYVI_API_KEY` é aceito apenas como caminho de automação/CI (não
  interativo); o caminho manual normal é a digitação oculta.
- **A2 — instalação sem segredos em argv:** `installViaCli()` escreve os 3
  segredos num arquivo temporário exclusivo com permissão `0600` e usa
  `supabase secrets set --env-file <arquivo> --project-ref <ref>` (sintaxe
  confirmada na fonte: Go CLI v2.75.0 e TS v3). O arquivo é removido em
  `finally`, inclusive em falha. Pré-check via `secrets set --help` exige
  suporte a `--env-file`; sem suporte ⇒ bloqueio explícito (sem fallback argv).
  Management API permanece o caminho preferido quando `SUPABASE_ACCESS_TOKEN`
  já está autorizado. Valores remotos nunca são buscados nem impressos — a
  verificação é apenas por **nomes** (`secrets list` / GET da Management API).
  Erros passam por `redactDetail` (nenhum valor de segredo em logs).
- **A3 — fluxo completo preservado:** validação do formato da chave, escolha do
  ambiente (`teste`/`produção`), prova de escopo sem cobrança real
  (`valor_centavos: 0`), criação/recuperação de destino de webhook idempotente
  (`whsec_`, reutilização sem duplicar), instalação e verificação dos 3
  `WYVI_*`, recuperação por reexecução (`--recreate` quando o whsec local se
  perdeu).
- **A4 — testes:** `tests/unit/wyvipay-setup.test.ts` (36 testes: readHidden
  com TTY fake — raw, eco zero, restauração em Enter/erro/Ctrl+C/EOF, recusa sem
  TTY; CLI — nenhum valor em argv, temp `0600` criado e removido, verificação
  por nomes, bloqueio sem `--env-file`, redação de detalhe), PTY real via
  `/usr/bin/script` (`wyvipay-setup-pty.test.ts`, 3 testes: eco zero em TTY
  alocado, Ctrl+C → exit 130 com restauração, backspace sem eco) e E2E de
  subprocesso (`wyvipay-setup-e2e.test.ts`, 9 testes: fluxo completo com API
  falsa, reexecução sem duplicar destino, `--recreate`, 401/403/500, formato
  inválido, **sem chave e sem TTY ⇒ falha explícita**).

## B — Modo demonstrativo desativado

**Estado: concluída (fato consumado em produção).**

- Secret `DEMO_PAYMENT_ENABLED=false` + `app_settings.demo_payments_enabled=false`
  (ledger `20261116180421`); evidências: capabilities `demo_enabled:false`,
  rotas demo `404`, `create-order` responde `404 product_unavailable` para
  produto indisponível, estoque 27→27 (nenhuma perda), CORS restrito à origem
  da produção.

## C — Reconstrução de conteúdo perdido, commits e PR

**Estado: concluída neste PR.**

- **C(a)** migração `20261117000000_0044_wyvi_worker_cron.sql` resiliente:
  4 blocos `begin/exception insufficient_privilege → raise notice … end`
  (propriedade pgsodium/vault pode não pertencer ao role do loop `foreach`).
- **C(b)** `docs/limitacoes-e-pendencias.md`: seções sobre REVOKE (`42501`/no-op;
  `net` mantém `USAGE` p/ `anon`; mitigações) e URL pública
  (`prime-store-gilt.vercel.app`, deploy `dpl_hW9QUY1PDt3SzHThb39KXcnbSznu`/`b978715`,
  4 env `VITE_*`).
- **C(c)** este relatório (`RELATORIO-FINAL.md`), recriado — o original estava
  entre os objetos git perdidos (`3cede1a`/`a40bc8a`/`654ff44` inexistentes).
- **C(d)** commits organizados e **um único PR** desta branch para `main`,
  incluindo apenas: correções da Etapa A (script + testes), conteúdo da Etapa B
  já consumado, reconstruções C(a)–C(c) e docs relevantes (`docs/wyvipay.md` §3,
  `docs/setup-local.md`, `docs/limitacoes-e-pendencias.md`).
- Verificação local antes do PR: `test:db` 424/424, `npm test` 151/151,
  `typecheck` OK, `build` OK, 10 bundles de funções OK.

## D — Pós-merge (publicação e operação)

**Estado: concluída.**

- [x] Funções: as 11 Edge Functions estão `ACTIVE` no projeto remoto (nenhuma
      alterada neste PR — só script/docs/testes/migração).
- [x] Migrações: ledger remoto com `0044_wyvi_worker_cron` e
      `disable_demo_payments` aplicadas (46 no total) — nenhuma nova
      necessária; ledger = main.
- [x] Cron ativo (jobid3: 15 execuções `succeeded` nos últimos 15 min) e
      worker autenticado (Vault `wyvi_worker_jwt` presente).
- [x] Deploy Vercel validado em produção: `96ed5d6` →
      `dpl_BQJrmHY9u3DwqSR3DAPwAqVeskLu` `READY`/`PROMOTED`; domínio
      `prime-store-gilt.vercel.app` respondendo 200.
- [x] Catálogo vazio (`{"products":[]}`; os 2 produtos existentes estão
      arquivados + inativos) e painel admin com 2 contas (`admin_users=2`).
- [x] Cadastro de produtos funcional (`admin-api` ACTIVE; CRUD coberto pela
      suíte local `test:db`).
- [x] Correção de deep-links SPA: `vercel.json` com rewrite → `/index.html`
      (exceto `/assets/`), habilitando `/admin`, `/produtos` e
      `/entrega/:token` (antes: 404 da Vercel no link direto). Revalidado
      pós-deploy: `/admin` → painel ("Duas contas administrativas"),
      `/produtos` → catálogo, `/` → home íntegra.

## E — Validação final

**Estado: concluída.**

- [x] `npm test` 151/151, `test:db` 424/424, typecheck OK, build OK,
      10 bundles OK no commit final.
- [x] CI verde em todos os PRs desta missão (typecheck + testes + bundle).
- [x] Tabela HTTP (via `verif.http` no banco remoto):
  - página `https://prime-store-gilt.vercel.app/` → **200** (HTML);
  - catálogo → **200** com `{"products":[]}` (vazio);
  - CORS: `Access-Control-Allow-Origin: https://prime-store-gilt.vercel.app`
    e preflight `OPTIONS` → **204**;
  - demo desativado: `approve`/`seed` → `{"demo_enabled":false,
    "mode":"disabled"}` (+ `app_settings` e secret);
  - pedido sem chave → **503 `payment_not_configured`** (fail-closed; pedido
    criado e reserva liberada — stock `available` de volta, evento
    `reservation_released` auditado); produtos de teste re-arquivados após a
    prova;
  - worker: fila `payment_events` com os eventos `failed` +
    `last_error=payment_not_configured` — **nenhum evento perdido**;
  - cron recorrente ✓; admin OK (2 contas) ✓; produtos OK (arquivados,
    CRUD funcional) ✓;
  - WyviPay pronta para receber a chave: 12 segredos presentes, nenhum
    `WYVI_*` (esperado — a chave é do responsável), fluxo completo do
    configurador coberto pelos testes.

## F — Ações comerciais do responsável (somente estas)

**Estado: pendente — são as ÚNICAS ações que dependem do responsável.**

1. **Inserir a chave WyviPay** no configurador seguro:
   `npm run wyvi:setup` em terminal (a chave é digitada oculta; nunca em argv,
   logs ou Git).
2. **Cadastrar produtos reais** no painel admin.

---

*Chave WyviPay: não fornecida, não solicitada, não versionada. Nenhum segredo
em código, logs, respostas ou GitHub. Nenhuma cobrança real realizada.*
