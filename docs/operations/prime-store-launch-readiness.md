# Prime Store — decisão de lançamento | 20/11/2026 UTC

> **Atualização da Missão 15 — 22/11/2026 UTC.** O bloco abaixo registra a decisão
> histórica da Missão 09; não o use como inventário remoto atual. Nesta rodada,
> a base local inclui a PR #12 integrada sem conflitos sobre a main que já
> continha a PR #13. A validação read-only do projeto Supabase `prime-store`
> confirmou o histórico das migrations 0043, 0044, 0045 e de isolamento de estoque;
> há um único job ativo `prime-store-wyvi-worker`, a cada minuto, e uma entrada
> Vault `wyvi_worker_jwt`. O JWT não é gravado neste documento nem no comando
> persistido; o destino é derivado do claim `ref` e a chamada exige
> `role=service_role`. As execuções do cron nas últimas 24 horas foram 1.440
> bem-sucedidas, sem alteração remota nesta rodada.
>
> Evidência local atual (Missão 15.1): `npm test` 168/168,
> `npm run test:db` 475/475 usando
> exclusivamente `postgresql://postgres:postgres@127.0.0.1:55432/postgres`,
> typecheck/build/bundle (10 funções) e `npm audit --omit=dev` sem falhas. A
> jornada E2E foi executada com Chromium real e WyviPay simulada; o CI também
> instala Chromium antes de executá-la. Nenhum pedido, cobrança, secret ou
> deployment foi criado/alterado por essa validação. A homologação externa da
> WyviPay, publicação das funções e promoção Vercel permanecem pendentes até os
> checks remotos da revisão publicada e as ações do proprietário.

## Decisão histórica — Missão 09: BLOCKED para produção

Branch `arena/08e0931c-prime-store`, [PR #12](https://github.com/gabielrtxofc-coder/Prime-Store/pull/12), entrada limpa em `6d5061c` (todos os três checks passaram). **Candidato de código: `047317bfa2cb09d0ff8a03426d2f6c06ff492e95`**; alterações seguintes de relatório não mudam o runtime. A versão publicada não foi alterada. [Roteiro do proprietário](prime-store-owner-actions.md).

| Frente | Evidência nova e decisão |
|---|---|
| A — continuidade | PASS: PR aberta para main, sem duplicação ou merge. Consulta agregada ao projeto de produção: 44 entradas no histórico; zero entradas para a versão da 0045. Lista de funções: oito ACTIVE v5, incluindo `wyvi-worker` e `admin-api` com `verify_jwt=true`. Não é prova de equivalência de código. |
| B — worker | PASS em laboratório / BLOCKED na produção: zero jobs ativos com o nome esperado e zero entradas no Vault para `wyvi_worker_jwt`. Sem nova migration: 0045 existente agenda pelo nome e dono; o teste 27 reaplicou o bloco duas vezes com semântica de upsert e inspecionou um único comando. O simulador não prova execução real de pg_net. |
| C — admin | PASS local / BLOCKED operacional: zero admins ativos na produção e zero tabelas ordinárias públicas sem RLS. DB 08, 20, 22 e UI admin testam não autenticado, usuário comum, AAL1 e admin autorizado com AAL2. Não criar rota de bootstrap, conta ou papel real. |
| D — catálogo | PASS funcional / BLOCKED comercial: leitura direta agregada em produção deu 0 produtos e 0 unidades, portanto não é apenas uma lista vazia por erro de tela. DB 20/21/25, regressão 14 e UI admin/catálogo cobrem CRUD, preço, arquivamento, mudança na vitrine, estoque, vazio e concorrência. Checklist de cadastro no roteiro, sem seed comercial. |
| E — publicação | PASS para build candidato; BLOCKED para promoção. Vercel `list_deployments` retornou production READY/PROMOTED `8a9afbc`. `git diff --name-only 8a9afbc 047317b` reproduz as diferenças (incluem HomePage/ProductPage, pagamento, painel de produtos/estoque/pedidos, estilos, cron e handlers). As variáveis compiladas no bundle servido não foram verificadas; preview não comprova produção. |
| F — WyviPay | PASS local: DB 03/24/26, unitários e Chromium. Assinatura, reconsulta, valor/referência, idempotência, eventos atrasados, expiração e falhas exercitados sem tocar na API live. Homologação externa **NOT VERIFIED**, dependência **BLOCKED** até evidência independente via ambiente de testes. Nenhuma nova chave/API/webhook live solicitada. |

**O que mudou:** `handlers/wyviWorker.ts` e `_shared/wyviEvents.ts` reivindicam eventos individualmente, evitando que um lote sequencial gaste a lease de 60 s antes de chegar ao último item. O worker limita dez itens e para de iniciar novas tentativas após 30 s; PostgreSQL usa `FOR UPDATE SKIP LOCKED`. O contador reflete a gravação do resultado (inclusive última tentativa terminal); falha ao gravar gera 500 genérico, lease recuperável e log sem a mensagem bruta. Retry respeita o maior entre backoff local e Retry-After limitado. A autenticação de plataforma permanece obrigatória. `tests/db/26*` verifica falha de persistência; `tests/db/27*` verifica repetição do agendamento. Não se promete exclusão indefinida se uma chamada exceder a lease: a aplicação financeira continua idempotente.

**Rodada local registrada anteriormente:** `npm ci`, `npm run typecheck`, `npm run build`, `npm run bundle:functions` (10), `npm test` **162/162**, `npm run test:db` **429/429** e `npm run test:e2e` com Chromium **1/1**; `npm audit` zero advisories. Essa contagem é histórica e não representa a rodada atual. Na rodada atual, o E2E também foi executado com Chromium real e os checks devem ser conferidos no CI para a revisão publicada. Sem operação financeira ou escrita remota.

**Decisão:** candidato apto à homologação isolada. Não aprovar publicação comercial: faltam worker ativo e observado, homologação, administrador legítimo, catálogo/estoque, documentos/atendimento, recuperação e aceite de publicação. Nenhuma configuração externa foi considerada resolvida por passar em teste local.

---

## Registro histórico — Missão 08

## A. Executive Summary

**NOT READY.** O percurso de compra funciona no laboratório: um navegador criou um pedido, recebeu PIX simulado, e só mostrou confirmação depois do webhook, da reconsulta e da atualização no PostgreSQL. Isso não descreve a loja publicada. Na produção identificada pelo conector há **zero produtos, zero unidades de estoque e zero registros de administradores**. O worker financeiro está publicado, mas não há job ativo para chamá-lo. O frontend promovido antecede a configuração de produção hoje visível na Vercel. Não abrir a loja.

Escala: **PASS** = observado, no ambiente indicado; **FAIL** = requisito não atendido; **BLOCKED** = exige acesso ou ação externa; **NOT VERIFIED** = sem prova. Nenhum pagamento, pedido, deploy, alteração de domínio, migration ou configuração foi executado na produção. Não foram consultados clientes, pedidos individuais, valores de secrets ou conteúdo de entregas remotas.

## B. Architecture (descoberta, fase 0)

`gh repo view` confirmou `gabielrtxofc-coder/Prime-Store`, padrão `main`. `git status -sb` inicial limpo em `arena/08e0931c-prime-store`, base `1928b95` (merge do PR #11). A branch antiga não é a desta missão. `gh api .../compare/f6f3405...1928b95`: `ahead`. Histórico: `docs/missao-07-ativacao-operacional.md`, relatórios posteriores em `docs/` e `RELATORIO-INTEGRACAO.md`; nenhum substitui leitura do projeto de produção.

```
Vercel / React + Vite (loja e /admin na mesma SPA)
  catálogo, carrinho local → create-order → banco calcula centavos e reserva unidades
      → WyviPay v2 PIX → QR/txid; solicitação sem cobrança é fluxo distinto
  WyviPay → wyvi-webhook (HMAC) → payment_events → wyvi-worker / poll order-status
      → GET da cobrança → apply_payment_status → estoque / entrega digital privada
  painel → Supabase Auth + MFA → admin-api → RPCs com guardas → produtos/pedidos/estoque
```

Contratos: `supabase/config.toml`, `supabase/functions/_shared/handlers`, migrations SQL ordenadas, `.env.example` e `.env.functions.example`. O navegador só deve receber configuração pública. `vercel.json` bloqueia publicação automática da main. Inicialmente era preciso distinguir a build publicada da branch, reproduzir as 198 verificações e determinar projeto, fila, estoque, administradores e prontidão comercial reais.

## C. Completed Work — o que foi confirmado

| Fase | Resultado, ambiente e evidência |
|---|---|
| 1 — schema, backend | **PASS local**: bootstrap + migrations do zero; suítes DB 01–08, 12–14, 17–23 exercitam constraints, referências, índices, transações, estoque concorrente, idempotência, permissões, limites por janela e estados inválidos. A identificação do comprador está no pedido, não se exige nova tabela de clientes. Reserva/unidade, item, pagamento, evento e entrega têm ciclos distintos. **PASS produção (metadados)**: 21 tabelas ordinárias em `public`, todas com RLS; zero com SELECT para anon, zero com escrita direta para authenticated, zero funções SECURITY DEFINER públicas executáveis por anon. Isso não é um teste HTTP de todas as políticas publicadas. |
| 2 — PIX | **PASS isolado**: `tests/unit/wyvipay.test.ts`, DB 03, 06, 24, 26. `POST /api/v2/cobrancas`, Bearer, `Idempotency-Key` por pedido, referência, PIX em centavos, `txid` persistido; sucesso, recusa, timeout, repetição, recuperação incerta. HMAC-SHA256 sobre carimbo e corpo com janela temporal; assinatura inválida não grava evento. Assinatura válida enfileira, não aprova. Só a reconsulta pode aprovar; divergência de total bloqueia entrega. Preço adulterado no corpo não altera o total. |
| 2 — estados e reconciliação | **PASS local**: pendente, concluída→aprovação, cancelada, falhou→encerramento/expiração, estornada→reembolso no mapeamento; não foi inventado estado remoto para “recusado”. Testes SQL incluem recusa, notificação atrasada, aprovação após expiração com e sem estoque, reembolso e efeito único de entrega. DB 24 simula API ainda pendente apesar do webhook pago, webhook duplicado e poll limitado; 26 exercita o worker. O contrato implementado é PIX/BRL em centavos, não há negociação de moeda. **NOT VERIFIED**: contrato observado em sandbox do provedor, credenciais válidas, entrega real de webhook e comportamento com outras moedas. |
| 3 — loja | **PASS local**: `App.test.tsx`, `CartContext`, `checkout*`, `paymentDelivery`, `deliveryMultiItem`, DB 25 e E2E. Catálogo da API, vazio/erro sem inventar produto, quantidades e persistência, remoção, estoque insuficiente, validação de comprador e retry. `/pedido-confirmado` não é prova de pagamento. Token de outro comprador não dá acesso. Smoke Chromium: seis rotas (início, produtos, carrinho, checkout, pedido-confirmado, admin) a 390 e 1440 px, título visível e sem overflow horizontal no build desconectado. Teclado/menu têm testes jsdom, **NOT VERIFIED** auditoria WCAG completa e checkout mobile no domínio final. |
| 4 — painel | **PASS local**: suítes `src/pages/admin`, DB 04, 20–22. Ações de produtos, alterações de preço e disponibilidade, arquivamento, URL de imagem, entradas de unidades e trilha de auditoria; consulta de pedido inclui comprador/itens quando autorizado. Admin sem AAL2 recusado no servidor. Períodos, ranking, totais pagos vs solicitações, vazio e erro testados. E2E confirmou o pedido pago na RPC usada pelo painel. **NOT VERIFIED** login/logout de um operador real, dashboard com vendas reais e criação de categorias arbitrárias. Nenhum usuário de produção foi criado. |
| 5 — segurança | **PASS local nos casos testados**, não certificação: CORS por origem, rate limiting e RPCs protegidas, token privado de consulta, invalidação de entrega, não exposição de custo no catálogo, entradas inválidas e mensagens de falha. `npm audit`: 0 advisories. Ver F. |
| 6 — operação | **FAIL produção**: acervo comercial e contato ausentes. Entrega implementada é digital; endereço, frete, transportadoras e rastreio físico não fazem parte do fluxo testado. **BLOCKED** se o escopo incluir bens físicos. Acompanhamento privado existe; política, SLA, titular e procedimento de troca/reembolso não estão aprovados. |
| 7 — infraestrutura | **PASS pontual**: `get_project_health` retornou auth/db/rest/storage saudáveis em `prime-store-production` (PG17). `list_edge_functions`: oito ACTIVE: catalog, create-order, order-request, order-status, delivery, admin-api, wyvi-webhook, wyvi-worker; JWT da plataforma ligado em admin-api/worker. As duas funções legadas/demo do repo não constam nessa lista. **Não** prova equivalência de artefatos nem sucesso de requisição. Projetos production e sandbox distintos; a referência de preview Vercel é diferente da de produção. |

**Evidência remota reproduzível**, somente leitura e agregados (20/11): `list_projects` Supabase/Vercel; `execute_query` contando linhas de `products`, `stock_units`, `admin_users`; `pg_class.relrowsecurity`, `has_table_privilege`, `pg_proc.prosecdef`/`has_function_privilege`. O histórico remoto tem **44 entradas**, última `20261120144433`, incluindo restaurações; havia **45 arquivos locais na base**. Contagem não autoriza presumir qual migration aplicar. Jobs ativos retornados: `prime-store-expire-reservations`, `prime-store-rate-limit-prune`; `cron.job_run_details` em 24h: 54 sucessos, zero falhas. Não incluem o worker. `count(*)` de `vault.secrets` pelo nome do JWT do worker: 0. Não confundir esse JWT interno com a chave da WyviPay.

Vercel: projeto `prime-store`, target production `READY/PROMOTED` em **`8a9afbc`**, alias `prime-store-gilt.vercel.app`. A configuração atual mostra bindings públicos Supabase para produção atualizados **depois** do build promovido. Vite incorpora configuração no build. **NOT VERIFIED** qual backend esse bundle acessa, domínio comercial, certificado, CORS do domínio final e disponibilidade ponta a ponta. O conector lista metadata de projeto; não foi pedida descriptografia. A configuração WyviPay relatada pelo responsável foi preservada: o inventário de funções confirma endpoint publicado, não que o provedor configurou o destino correto ou que a chave autentica. Sem consulta a secrets que possa devolver valores.

## D. Changes Made (fase 8; somente branch)

| Arquivos | Correção e motivo |
|---|---|
| `supabase/functions/_shared/{wyvipay.ts,wyviEvents.ts,handlers/orderStatus.ts}` | Verificar identidade (referência e txid) da resposta antes de usar status; na criação conferir valor. HTTP ambíguo não libera reserva; 5xx não vira recusa por texto/código de autenticação no corpo. Mesma chave para recuperar. |
| `tests/unit/wyvipay.test.ts`, `tests/db/24_wyvipay_fluxo.test.ts` | Regressão de timeout por abort, referência divergente, status desconhecido e preço/total enviados pelo comprador. |
| `supabase/migrations/20261120160000_0045_worker_destino_por_projeto.sql`, `tests/db/27_worker_schedule.test.ts`, `docs/wyvipay.md` | 0044 gravava host de sandbox no comando do cron. Nova migration usa a referência restrita do JWT de serviço provisionado no Vault; o comando não contém o token literal. Teste executa o SQL com substitutos de cron/net/Vault sem tráfego. Não retroeditar migrations aplicadas. Em instalação nova migrar **antes** de provisionar segredo; nunca reexecutar 0044 isoladamente. Usar 0045 com o proprietário do job, depois de validar o projeto do JWT. |
| `tests/db/helpers.ts`, `docs/setup-local.md`, `docs/testes.md` | Harness que apaga schemas recusa URL diferente da instância descartável da CI/local antes de conectar. Não usar túnel nem outro banco nessa porta. |
| `src/data/legalContent.ts`, `src/pages/PaymentPage.tsx` | Removidas alegações incorretas de que o comprador não envia dados ao servidor, de ausência de cobrança/entrega e de prazo fixo. Rascunhos continuam identificados; não foi criada política jurídica. |
| `tests/e2e/checkout.ts`, `package.json`, `package-lock.json`, `.github/workflows/ci.yml` | Jornada repetível Chromium + Vite + handlers de aplicação + banco real + gateway em memória. Playwright **somente dev**. Requisições do navegador confinadas à origem de teste; runner verifica a consulta administrativa com role autenticada e claims de teste. Não simula autenticação humana como prova de login real. |
| `docs/operations/prime-store-launch-readiness.md` | Registro de decisão, reprodução e critérios de reabertura. |

## E. Test Evidence (fase 9)

Node 22.22.3; sem Docker, PG embarcado 18 em loopback, não o Supabase hospedado. Rodar sequencialmente (as suítes DB e E2E reinicializam o mesmo banco):

```sh
npm ci
npm run db:local  # deixar em outro terminal, porta 55432 dedicada e descartável
npm run typecheck && npm run build
npm test
npm run test:db
npm run bundle:functions
CHROMIUM_PATH="$(command -v chromium || command -v google-chrome)" npm run test:e2e
npm audit
```

| Execução final | Resultado |
|---|---|
| Instalação pelo lock, typecheck, build Vite | PASS; 129 módulos no build da jornada. Sem script oficial de lint; **NOT VERIFIED** lint. |
| Vitest jsdom | **162 aprovados, 0 reprovados** (23 arquivos). |
| Vitest DB + unitários | **428 aprovados, 0 reprovados** (35 arquivos); não são 428 testes exclusivamente SQL. Base deste turno antes das alterações: 424. |
| E2E Chromium | **1 aprovado, 0 reprovados**; `npm run test:e2e`, binário local via `CHROMIUM_PATH`. Seleção, duas unidades, checkout, PIX pendente, webhook assinado simulado, fila, confirmação no navegador, duas unidades vendidas e pedido visível na consulta administrativa. HTTP do navegador entregue aos handlers locais, não ao ingress Supabase/Deno. |
| Smoke responsivo desconectado | PASS 12 combinações rota/largura; não conta como teste de compra. |
| Empacotamento e dependências | PASS: 10 bundles, 0 vulnerabilidades conhecidas reportadas. |
| Histórico M07 | PASS: `git archive f6f3405` em diretório temporário, `npm run test:db` com dependências instaladas nesta sessão e URL explícita do PG descartável: **198/198**. Primeira tentativa com default antigo falhou por socket inexistente; corrigida a invocação, não os testes. Arquivos DB 01–14 preservados, 166 títulos literais ainda presentes. Não se somam esses 198 à suíte atual. |
| Guarda de reset | PASS: processo com `DATABASE_URL` de host `.invalid` recusado antes da conexão. |
| Homologação externa | **BLOCKED**: exercício do sandbox do provedor com credenciais exclusivamente de teste, callback pela internet, worker agendado e observação no dashboard. Nenhuma cobrança real ou teste em pedido comercial. |

Fontes primárias reexecutáveis: testes e comandos acima, CI do PR. Não foram versionados logs brutos de infraestrutura, dumps, headers ou recibos. O módulo DB 03 é evidência da máquina de estados SQL, não de recepção de todos esses eventos pela WyviPay real. A cobertura de falha é dividida entre UI, handlers e banco; não se repetiu cada falha em um navegador com serviços hospedados.

## F. Security Findings

| Gravidade | Achado / estado |
|---|---|
| HIGH | **FAIL na base / PASS local após correção**: destino fixo na 0044 podia enviar Bearer privilegiado ao projeto errado após provisionamento. Não foi observado esse tráfego na produção; o job está ausente. Revisar o destino, dono e privilégios antes de ativar. |
| HIGH | **PASS local após correção**, pendente publicação: referência da cobrança reconsultada não era comparada ao pedido em todos os caminhos. Na fila e no poll agora vincula-se a resposta do provedor; assinatura por si só continua insuficiente. |
| HIGH | **PASS local após correção**: harness destrutivo aceitava URL herdada. Jamais executar em infraestrutura hospedada. |
| MEDIUM | **PASS local após correção**: resultado incerto na criação podia liberar a reserva. Não há prova de como o gateway externo responde a todas as falhas. |
| MEDIUM | **FAIL operacional**: rascunho de privacidade e falta de canal. Dados de comprador no servidor, código privado de acompanhamento no navegador: evitar dispositivos compartilhados e excluir esses dados de logs e analytics. |
| LOW | **NOT VERIFIED**: lint sem comando oficial; verificação manual de acessibilidade e auditoria de uploads/importação CSV em ambiente publicado não concluídas. Imagens no cadastro são URLs, não upload irrestrito de binários. |

Escopo: sem testes de intrusão externos. Revisão estática de renderização (sem ocorrência de `dangerouslySetInnerHTML` no `src`), RPCs parametrizadas, CORS e tokens em vez de autorização por mera presença de botão; não é prova universal de ausência de XSS, SQLi ou CSRF. Permissões administrativas e rejeição de entradas inválidas exercitadas com dados sintéticos. Não foram extraídos usuários, sessões, backups, segredo de webhook ou chaves para validar permissões.

## G. Remaining Blockers — critérios para encerrar cada um

| Estado / dono | Impacto e ação exigida |
|---|---|
| FAIL — responsável comercial | Zero produtos/unidades: impossível vender. Cadastrar itens definitivos, direitos de distribuição, imagens, descrição, categoria, preço, validade e estoque. Confirmar visibilidade e ausência de demos no catálogo público. |
| FAIL — responsável de acesso | Zero admins: sem operação do painel. Provisionar operadores identificados, exigir MFA e verificar login, logout, revogação e acesso de emergência. Não usar contas de demonstração. |
| FAIL — Arena + operador de infraestrutura | Fila pode depender de poll do cliente; não há worker cron nem JWT de worker. Comparar corpos/assinaturas/grants do schema remoto com migrations (incluindo restauros), preparar plano revisado; homologar 0045 e privilégios de 0044, provisionar pelo mecanismo seguro do operador, verificar chamada 2xx e drenagem **sem comprador online**. Não aplicar histórico integral sobre produção. |
| BLOCKED — responsável WyviPay + Arena | Confirmar no painel do provedor escopo/ambiente da chave, URL, eventos e assinatura, sem revelar valores. Em ambiente isolado vincular pedido sintético, simular confirmação, expiração e reconciliação. Registrar códigos HTTP, atrasos e contagens sem headers/PII. Não usar chave live para homologar. |
| FAIL — Arena + responsável pela publicação | Bundle promovido não é a revisão testada. Validar preview isolado (inclusive binds de ambiente), paridade de funções/migrations, HTTPS, domínio, origins, status por token e demo desligada no artefato final. Só promover com autorização posterior. |
| BLOCKED — responsável comercial/jurídico | Definir canal ativo, identificação, condições de entrega digital, termos, privacidade/retenção, troca/cancelamento/reembolso e pós-venda. Validar reposição por tipo de produto; não assumir reposição automática de credencial já revelada. |
| NOT VERIFIED — responsável infra + Arena | Backup: sem evidência atual de frequência, retenção, RPO/RTO ou restore da produção. Registrar política e simular restore em destino isolado; verificar integridade, chaves de entrega e acessos sem expor conteúdo. Monitoramento: além do status/contadores consultados, faltam prova de alertas e responsável de plantão para 5xx, webhook rejeitado/atrasado, fila sem progresso, divergências e falhas de deploy. |

## H. Production Checklist (ordem sugerida)

- [ ] Operador confirma origem/destino de cada ambiente e backup restaurável; documenta rollback de build e plano de compatibilidade do banco.
- [ ] Revisão do PR e CI; comparar banco remoto sem escrita. Validar em staging real os grants, Vault, pg_net, pg_cron e a criptografia de entrega.
- [ ] Provisionar admins MFA, catálogo comercial e estoque; publicar documentação comercial aprovada e canal atendido.
- [ ] Executar homologação WyviPay **sandbox**, inclusive com página fechada; confirmar fila sem atraso, estoque único e status consultável. Investigar divergência antes de reprocessar; nunca marcar pago manualmente por screenshot.
- [ ] Validar domínio, HTTPS, CORS, variáveis apenas por presença/escopo, versão efetiva dos artefatos, health checks e alertas com operador responsável.
- [ ] Ensaiar pós-venda e recuperação em ambiente isolado. Anexar evidências sanitizadas e obter autorização humana separada para publicar. **Não liberar** enquanto algum bloqueador crítico permanecer.

## I. Final Readiness Verdict (fase 10)

**NOT READY.** Há prova positiva do fluxo implementado e prova negativa de condições necessárias na produção. A próxima decisão não depende de outro build verde: depende de catálogo vendável, administradores, processamento independente do navegador, homologação externa, operação e versão efetivamente publicada.
