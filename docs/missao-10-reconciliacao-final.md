# Missão 10 — Reconciliação e validação final

Data: 2026-11-09 (UTC). Este registro separa integração de código de lançamento.

## Baseline e proteção

| Referência | SHA inicial completo |
|---|---|
| main | `8f37527e9fe41997020a8bab86cbb3b9272dcf8d` |
| arena/66cda9f6-prime-store | `12a427991f94e34c85e967e296fd0a2089cd01fd` |
| arena/529cc4db-prime-store | `1de28ddbc0f568ab5de26bcc67a3d8a36bf0a318` |
| arena/3b67fee3-prime-store (sessão) | `12a427991f94e34c85e967e296fd0a2089cd01fd` |

Consultas: `git ls-remote --heads --tags origin`, fetch completo (`--unshallow`),
`git log --all`, `git merge-base`, `git rev-list --left-right --count` e API GitHub.
O clone era raso; a análise de ancestralidade só foi feita após completá-lo.
A branch da sessão foi publicada no SHA inicial antes da integração local.
Proteção equivalente durável: a secundária remota preservada contém o SHA oficial
inicial como pai imediato; a main também está preservada em
`integration/prime-store-to-main-20261109` no mesmo SHA. Nenhuma referência
existente foi apagada, forçada ou renomeada; não houve criação/movimentação de tag.

## Origem e reconciliação

O pai único de `1de28ddbc0f568ab5de26bcc67a3d8a36bf0a318` é
`12a427991f94e34c85e967e296fd0a2089cd01fd`, também merge-base com a oficial.
A diferença simétrica oficial/secundária é **0/1 commits**. A main é ancestral
das duas. Isso comprova a base de conteúdo/histórico da secundária na ponta
oficial da M08, não um fork diretamente da ponta atual da main. Git não registra
qual nome de referência foi usado no comando original de criação; o registro
M09 confirma a mesma base, mas não há evento independente de criação da branch.

Recuperado integralmente por fast-forward **na branch fixa desta sessão**:
`1de28ddbc0f568ab5de26bcc67a3d8a36bf0a318`. Nenhum conflito, cherry-pick ou
reescrita. Os cinco arquivos recuperados são:

- `docs/PROGRESSO.md` (modificado);
- `docs/missao-08-reconciliacao-supabase.md` (modificado);
- `docs/missao-09-fechamento-operacional.md` (novo);
- `scripts/provision-admin.sql` (modificado: inserções agora comentadas);
- `scripts/smoke-edge-functions.mjs` (modificado: remoção do modo de pedido real).

Nenhum arquivo removido; nenhuma outra alteração exclusiva M09 encontrada.
As missões anteriores já presentes na oficial não foram duplicadas.
Integração controlada: PR da sessão para `arena/66cda9f6-prime-store`, com merge
commit para preservar os SHAs; depois, exclusivamente PR #2 para main.

## Compatibilidade e revisão

A chamada corrigida não foi criada na M09: `git log -S'p_reason: status'`
identifica `f046a826c2f81704361acb5bc75d1e475aa06e54` (M07).
Em `supabase/functions/_shared/handlers/adminApi.ts`, `stock.setStatus` envia
`p_stock_unit_id`, `p_status`, `p_reason`, `p_note`. A migração 0038 declara
respectivamente `uuid,text,text,text`; remove a assinatura antiga, preserva
`assert_admin()`, `search_path` explícito, bloqueio de linha, auditoria e revoke
de public/anon. O gateway verifica o usuário e usa seu JWT nas RPCs; não substitui
a autorização administrativa por service role. Testes HTTP→banco exercitam o
contrato e falhas de autenticação/autorização. AAL2/allowlist permanecem no banco.

Revisados os grupos do diff main→candidata: rota lazy `/admin`, telas e filtros,
confirmações, validação do gateway, migração 0038, testes, CSS, scripts e documentos.
Evidências PNG/JSON da M05 são documentação preexistente, não caches novos.
Dados demo já versionados são fixtures locais, não inserções remotas desta missão.
`package.json`, lockfile e configuração Supabase não diferem da main. Nenhuma
integração de pagamento foi alterada ou ativada; a rota de pagamento segue fora
do roteador. Não foram incluídos logs, bundles, banco local ou arquivos .env.

### Tag M07

Nenhuma tag local ou remota foi encontrada. O documento M07 versionado cita
`safety/m07-start-cd87b3d` e o baseline `cd87b3d`, cujo commit completo é
`cd87b3da734c6c79479f6a8e56246016bf390ffa`. Isso é evidência documental da intenção,
não prova do objeto/tag original nem do seu destino exato. **Não recriada**.
O commit permanece alcançável nas branches preservadas.

## Validações executadas

Ambiente: Node v22.22.3, npm 10.9.8, PostgreSQL local 18.6, porta 55432,
dados isolados em `.local/m10-pg`. `DATABASE_URL` foi explicitamente fixada em
loopback nos testes; nenhuma migração foi aplicada ao Supabase. As migrações
foram usadas apenas para construir o banco descartável dos testes.

| Comando | Resultado real |
|---|---|
| `npm ci` | sucesso; audit de 143 pacotes, 0 vulnerabilidades |
| `npm test` | 16 arquivos, **127 aprovados, 0 reprovados** |
| `npm run test:db` (URL local explícita) | 24 arquivos, **294 aprovados, 0 reprovados** |
| suíte `20_admin_api_http` (incluída acima) | 12/12 |
| suíte `21_stock_adjustment_reason` (incluída acima) | 10/10 |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0, 123 módulos; chunk admin separado |
| `npm run bundle:functions` | 8/8: admin-api, catalog, create-order, delivery, demo-payment, mp-webhook, order-request, order-status |
| `npm audit --omit=dev` | 0 vulnerabilidades |
| `git diff --check` | sem erros |

Contagens iguais à referência M09. As suítes incluem estoque, pedidos, RLS,
privilégios, idempotência, segurança e resiliência. Testes não foram alterados.
Logs locais (não versionados): `.local/m10/test.log` e `.local/m10/db.log`.

Busca por padrões de chave privada, tokens GitHub/AWS/Supabase e JWT completos
nos patches dos **8 commits main..M09**: zero correspondências. Revisão de
arquivos/configurações não identificou credenciais reais. Essa varredura é
limitada aos padrões e escopo descritos; não constitui prova matemática de
inexistência de segredo. Nenhum segredo foi incluído nesta missão.

## GitHub e critérios de merge

PR oficial: https://github.com/gabielrtxofc-coder/Prime-Store/pull/2
Origem `arena/66cda9f6-prime-store`, destino `main`; inicialmente OPEN/DRAFT,
posteriormente consulta de mergeabilidade retornou MERGEABLE/CLEAN.
`statusCheckRollup=[]`, reviews vazias, runs vazios e **0 workflows**.
Não há CI aprovado a declarar: os testes desta missão são locais.

Endpoint detalhado `/branches/main/protection`: HTTP 403 por escopo da integração.
Alternativas de leitura bem-sucedidas: endpoints de ambas as branches retornam
`protected=false`, proteção desativada, checks vazios; `/rulesets` e
`/rules/branches/main` retornam `[]`. Merge commit permitido e
`delete_branch_on_merge=false`. Nenhum bypass/admin/auto-merge será usado.
A decisão final exige repetir consulta de SHAs, árvore, conflitos e checks após
integração intermediária; o resultado efetivo será registrado no encerramento.

## Supabase: evidência histórica, não consulta atual

`list_connector_tools("supabase")` retornou **disabled** nesta missão. Não houve
consulta remota nem deploy. É necessário ativar o conector para novas leituras;
rede do workspace permite apenas hosts de GitHub e registros de pacotes.

M08/M09 registram: oito funções; admin-api v4 com verify_jwt=true; 0034–0038
aplicadas; RLS 20/20; nenhum administrador; PRIME_ENCRYPTION_KEY via fallback
Vault; pagamentos congelados. **Não são provas atuais**. O contrato SQL foi
validado nesta missão no código e PostgreSQL local, não na instância remota.
Não há indicação nova de incompatibilidade, mas produção não está validada.

Pendências reais e procedimento de confirmação (fora desta missão):

1. Operador com acesso ao projeto deve consultar migrações, assinatura RPC,
   RLS, funções e configurações sem expor valores secretos; comparar com os
   registros anteriores e registrar resultados datados.
2. Publicar somente admin-api a partir do código integrado, via CLI/painel
   autorizado, mantendo verify_jwt=true. Não reaplicar migrações. Confirmar
   nova versão e comportamento antes de liberar operações administrativas.
3. Testar HTTP autenticado com administrador real e TOTP/AAL2 autorizado;
   validar negações sem JWT/AAL1/não-admin e leitura permitida em AAL2.
   O smoke existente não substitui essa validação: cobre seis slugs, não todas
   as oito funções; pode gerar rate-limit/auditoria e suas expectativas HTTP
   dependem do gateway/configuração. Não executado nesta missão e não é garantia
   de ausência absoluta de escrita. Não o executar em produção sem revisão.
4. Conferir backup/PITR no painel com timestamps, retenção e restauração
   disponível, sem restaurar produção. Falta acesso/evidência do plano.
5. Provisionar somente pessoas reais autorizadas, usando o roteiro comentado,
   e configurar TOTP individual; nenhuma conta foi criada nesta missão.
6. Esclarecer a tag M07 com evidência original antes de qualquer recriação.

Integração de código não publica Edge Function nem autoriza lançamento.
