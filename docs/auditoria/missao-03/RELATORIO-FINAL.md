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

**Estado: pendente — executa-se somente após o merge com verificações verdes.**

- [ ] Publicar funções alteradas (paridade com `.local/functions-build/`).
- [ ] Aplicar somente migrações novas estritamente necessárias (ledger = main).
- [ ] Cron ativo (jobid3 recorrente) e worker autenticado.
- [ ] Deploy Vercel do commit final de `main`; domínio
      `prime-store-gilt.vercel.app` respondendo.
- [ ] Catálogo vazio e painel admin disponível para as 2 contas existentes.
- [ ] Cadastro de produtos funcional.

## E — Validação final

**Estado: pendente — após a Etapa D.**

- [ ] `npm test`, `test:db`, typecheck, build e bundles verdes no commit final.
- [ ] CI verde no PR/merge.
- [ ] Tabela HTTP: página 200; catálogo 200 vazio; CORS com origem da
      produção; demo desativado; pedido sem chave fail-closed; worker
      `payment_not_configured` sem perda; cron recorrente; admin OK; produtos
      OK; WyviPay pronta para receber a chave.

## F — Ações comerciais do responsável (somente estas)

**Estado: pendente — são as ÚNICAS ações que dependem do responsável.**

1. **Inserir a chave WyviPay** no configurador seguro:
   `npm run wyvi:setup` em terminal (a chave é digitada oculta; nunca em argv,
   logs ou Git).
2. **Cadastrar produtos reais** no painel admin.

---

*Chave WyviPay: não fornecida, não solicitada, não versionada. Nenhum segredo
em código, logs, respostas ou GitHub. Nenhuma cobrança real realizada.*
