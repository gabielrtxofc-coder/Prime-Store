# Missão 09 — Fechamento operacional e validação da Prime Store

**Data:** 2026-11-09 (UTC)
**Commit inicial:** `12a427991f94e34c85e967e296fd0a2089cd01fd`
**Branch efetiva desta sessão:** `arena/529cc4db-prime-store` (fixada pelo ambiente Arena)
**Branch solicitada na missão:** `arena/66cda9f6-prime-store` — não foi possível/permitido trocar a branch desta sessão. No GitHub ela ainda aponta para o commit de referência.
**Projeto Supabase:** `eorlmqolbknrplvdbbtl` (`prime-store-sandbox`, `sa-east-1`)
**PR #2:** aberto, draft, origem `arena/66cda9f6-prime-store`, destino `main`; permaneceu sem merge.

## 1. Resumo executivo

A missão identificou o projeto Supabase correto, comprovou migrações 0034–0038, a assinatura SQL pós-0038, as oito funções remotas e a integridade das contagens de dados. A função local `admin-api` já continha a chamada de quatro argumentos correta; o remoto permanece na versão 4 e não foi republicado. `verify_jwt` remoto está `true`. O conector oferece ferramentas de consulta e uma operação de atualização de Edge Function, mas não fornece um caminho de upload/execução HTTP do workspace: não foi possível enviar o pacote local de modo verificável nesta sessão. Não houve escrita remota, provisionamento, ativação de pagamentos nem merge.

Mudanças locais desta sessão: o smoke script foi tornado estritamente read-only (removida a opção de criar pedido real) e o SQL de provisionamento deixou de conter UUID/nome fictícios executáveis. A documentação foi atualizada. Testes: `npm test` 127/127; `npm run test:db` 294/294 após iniciar o PostgreSQL local; typecheck, build e bundle das oito funções concluídos. O smoke HTTP real não foi executado, pois não havia uma ferramenta de invoke e nem chave pública disponível para teste no ambiente. Backup não verificável pelo conector. Estado final: **PARCIAL**, sem prontidão para lançamento.

## 2. Estado inicial e continuidade

- Checkout: repositório `gabielrtxofc-coder/Prime-Store`; HEAD inicial `12a4279`, mensagem correspondente ao fechamento M08; working tree inicialmente limpo.
- Branch atual no checkout: `arena/529cc4db-prime-store`. A branch pedida pelo usuário era `arena/66cda9f6-prime-store`, que existe no remoto no commit de referência. Por regra do ambiente, a branch ativa não foi alterada.
- `main` remota consultada: `8f37527e9fe41997020a8bab86cbb3b9272dcf8d`; não foi alterada.
- Tag `safety/m07-start-cd87b3d`: ausente tanto nas tags locais quanto no resultado de `git ls-remote --tags origin`. Portanto, a existência/integridade afirmada historicamente em M08 não foi confirmada agora.
- PR #2: OPEN, draft, head `arena/66cda9f6-prime-store` → `main`, sem checks reportados. Este checkout não é a branch head do PR; não foi possível atualizar PR #2 sem sair da branch vinculada à sessão.
- Supabase `list_projects` e `get_project` confirmaram o ref esperado, status `ACTIVE_HEALTHY`, PostgreSQL 17.11.0.011. Serviços de banco, Auth, REST, Storage e pooler saudáveis.
- Migrations: histórico remoto contém `m08_0034_pedidos_multiproduto` até `m08_0038_motivos_ajuste_estoque`, todas presentes. Nenhuma migração foi aplicada nesta sessão.
- Edge Functions remotas: oito ACTIVE: `catalog` v6, `delivery` v4, `create-order` v7, `order-status` v5, `mp-webhook` v5, `admin-api` v4, `demo-payment` v3, `order-request` v1. Apenas `admin-api` tem `verify_jwt=true` (confirmado por listagem e detalhe).
- Auth: signup desabilitado, e-mail ativo, MFA TOTP disponível; configuração não foi modificada. As chaves de segredo/API foram inspecionadas somente quanto à presença e seus valores não foram consultados nem reproduzidos.

## 3. Correção da admin-api e segurança

- Migração local `20261109130000_0038_motivos_ajuste_estoque.sql`: remove o overload antigo `admin_set_stock_unit_status(uuid,text)` e cria `admin_set_stock_unit_status(uuid,text,text,text)` com `p_reason` e `p_note`; política de motivo obrigatório para desativar, exceção `other` com nota mínima e motivo limpo ao reativar.
- Consulta somente de leitura ao banco confirmou a assinatura real `p_stock_unit_id uuid, p_status text, p_reason text, p_note text`, retorno `jsonb`, `SECURITY DEFINER` e `search_path=public, pg_temp`. `admin_list_stock` mantém a assinatura esperada e também é `SECURITY DEFINER` com search_path fixo.
- Código atual `supabase/functions/_shared/handlers/adminApi.ts` usa a nova RPC com `p_stock_unit_id`, `p_status`, `p_reason`, `p_note`, valida enum/nota antes da chamada e mantém a chamada antiga ausente. O bundle gerado confirma os quatro argumentos. As pesquisas não encontraram chamada ativa com a assinatura antiga no código-fonte; menções no histórico/documentação são narrativas.
- O handler verifica Bearer JWT por `/auth/v1/user`, falha fechada em erro de Auth, executa RPC administrativa usando JWT do usuário (nunca service role), e as funções no banco chamam `assert_admin()`; operações administrativas exigem AAL2. `verify_jwt=true` foi preservado no remoto.
- Os testes DB 20 e 21 cobrem não autenticado, validação, motivos, chamada via handler, persistência/auditoria controlada no DB local e recusa sem alterar estado. Nenhuma escrita foi feita no banco de produção.

## 4. Publicação da função

- Ferramenta de atualização está listada pelo conector Supabase; detalhe remoto mostra a v4 ativa, `verify_jwt=true` e corpo implantado disponível no detalhe (retorno extenso). A versão continua sendo a v4 no estado consultado; não há evidência de publicação de uma versão corrigida.
- Foi gerado bundle autocontido da `admin-api` (45.242 bytes), sem dependências externas e sem credenciais incluídas. O pacote compila com o empacotador do repositório.
- Não foi feita atualização remota: a ferramenta do conector recebe o fonte como texto, sem aceitar diretório/arquivo do workspace ou artefato de pacote, e o bundle não foi transferido pela interface do conector nesta execução. Não tentamos editar o corpo remotamente parcialmente nem usar outra função como atalho. A função permanece v4; a publicação está **bloqueada**, não concluída.
- Não foram alteradas outras funções, segredos ou configurações. A versão corrigida está preservada no repositório e no pacote ignorado `.local/functions-build/admin-api.ts` (gerável novamente via `npm run bundle:functions`).

## 5. Testes HTTP das funções

O conector não lista uma ferramenta de invocação de Edge Functions. O ambiente de shell também não fornece uma credencial pública de API; valores de API keys/secrets não foram lidos para tentar contornar isso. O smoke HTTP não foi chamado sem credenciais nem se criou teste real. Estado: **BLOQUEADO**.

O arquivo `scripts/smoke-edge-functions.mjs` foi atualizado para remover a opção `PRODUCT_ID` que criava pedidos reais e a opção de JWT admin; agora faz só chamadas que devem ser recusadas, inclusive JWT inválido, e não modifica pedidos, estoque, entregas ou pagamentos. Para execução externa, usar URL e chave pública autorizada conforme o ambiente local; não incluir JWT administrativo em logs. Resultados HTTP continuam pendentes para todas as funções. A simples existência/estado ACTIVE não foi tratada como prova funcional.

## 6. Segurança, banco e dados

- Remoto: 20/20 tabelas públicas com RLS; zero policies; contagem de policies zero em todas as tabelas. Isso mantém o modelo restritivo constatado anteriormente. A consulta foi somente de leitura.
- Migrations 0034–0038 constam no histórico remoto; não houve reaplicação. Configurações confirmadas: `max_items_per_order=10`, `internal_confirmation_enabled=false`.
- Contagens atuais, consultadas remotamente: products 2; orders 8; order_items 2; deliveries 3; stock_units 27; stock_reservations 7; payments 3; admin_users 0; auth.users 0. Coincidem com as referências M08 (para `order_items`, `stock_reservations` conforme tabela real). Nenhum registro remoto foi alterado.
- Os privilégios das funções relevantes foram inspecionados na migração e assinaturas; não houve concessão nova, mudança de RLS, configuração de Auth, alteração do fluxo de pagamentos ou ativação de integrações.
- Segredos: consulta de presença retornou nomes/metadados, sem leitura dos valores. Não se concluiu que os segredos de processamento de pagamento estejam configurados, nem foram mudados.
- Saúde do Realtime nesta consulta aparece como `ACTIVE_HEALTHY`; isso difere da observação histórica M08. Não é necessário para o polling usado pelo app. Nenhuma ação foi feita.

## 7. Backup e recuperação

**Classificação: INDISPONÍVEL PARA VERIFICAÇÃO PELO AMBIENTE.** As ferramentas disponíveis não incluem listagem de backups/PITR/restore. Nenhuma restauração, alteração de plano ou ativação de recurso ocorreu. Operador deve consultar o projeto `prime-store-sandbox` no painel Supabase, seção de backups/PITR, e confirmar data da última cópia, política de retenção, janela de recuperação e disponibilidade do restore/PITR para o plano. Banco saudável não comprova backup recuperável.

## 8. Administradores

`auth.users=0` e `admin_users=0`, confirmados novamente. O script `scripts/provision-admin.sql` foi ajustado para que o bloco de inserção fique comentado e exija UUID/nome reais; não existe usuário fictício ativo. Dados necessários para cada pessoa: nome de exibição, e-mail real autorizado e confirmação da função (owner/admin). Operador cria usuário Auth com senha forte, associa UUID em `admin_users`, e cada administrador cadastra TOTP em `/admin`. Validar login e `aal2`/`is_admin=true`; qualquer falha de associação ou MFA deve permanecer sem acesso.

## 9. Testes gerais e revisão

- `npm test`: **127/127**.
- `npm run test:db`: **294/294** após inicializar o PostgreSQL efêmero local (o primeiro intento, antes do serviço local iniciar, falhou por `ECONNREFUSED`; após iniciar o banco a suíte completa passou).
- `npm run bundle:functions`: **8/8** bundles, total 219.982 bytes; bundle `admin-api` 45.242 bytes.
- `npm run typecheck`: passou.
- `npm run build`: passou.
- Teste específico `tests/db/20_admin_api_http.test.ts` e `tests/db/21_stock_adjustment_reason.test.ts` fazem parte da suíte DB aprovada. Não houve desligamento ou redução de testes.
- O teste `smoke:functions` não foi executado por ausência de invoke/credencial no ambiente; testes HTTP locais pelo handler passaram dentro dos testes de banco.
- `git diff --check`, busca de referências antigas, segredo acidental e revisão final devem ser reexecutados depois das alterações documentais desta sessão; nenhum segredo foi colocado nos arquivos.

## 10. Pendências manuais realmente necessárias

1. **Publicar admin-api corrigida:** no Supabase CLI/painel com acesso ao projeto correto, executar o bundle fonte de `supabase/functions/admin-api` após sincronização; manter `verify_jwt=true`. Confirmar versão nova por consulta de estado e comparar comportamento/versão antes de declarar concluído. Não publicar as demais sete funções.
2. **Validar endpoints remotos read-only:** de uma máquina com acesso ao projeto, executar `scripts/smoke-edge-functions.mjs` com `SUPABASE_URL` e `SUPABASE_ANON_KEY` públicos válidos; sem passar `PRODUCT_ID`/JWT admin (opções removidas). Registrar resultados HTTP por função. Testes admin autorizados dependem da criação real dos administradores.
3. **Comprovar backup/PITR:** painel do Supabase → backups/PITR, registrar timestamp/retention/restore disponível. Não restaurar produção.
4. **Provisionar administradores reais:** obter nomes/e-mails e autorização; criar usuários em Authentication → Users, associar seus UUIDs pelo SQL preparado, configurar TOTP individual e validar painel com AAL2.
5. **Resolver continuidade do GitHub:** a missão exige atualizar PR #2 originado de `arena/66cda9f6-prime-store`, enquanto o ambiente fixou esta sessão em `arena/529cc4db-prime-store`. Os commits nesta sessão não poderão atualizar PR #2 sem integração/rebase autorizados na branch de origem. A tag de segurança também não foi encontrada remotamente e requer esclarecimento do responsável antes de qualquer recriação.

## 11. Classificação por grupo

| Grupo | Objetivo | Estado | Evidência |
|---|---|---|---|
| A | Ambiente e continuidade | PARCIAL | Projeto correto; branch fixada difere da solicitada; PR draft confirmado; tag ausente no remoto. |
| B | Correção da admin-api | APROVADO | Código local chama assinatura 4-args; SQL remoto confirma assinatura e segurança; testes 20/21 passaram. |
| C | Publicação | BLOQUEADO | v4 remota preservada com `verify_jwt=true`; bundle gerado, mas não enviado pela interface disponível. |
| D | Testes reais | BLOQUEADO | Sem invoke HTTP e credenciais para smoke; script foi restrito a operações read-only. |
| E | Segurança e banco | APROVADO | 0034–0038 aplicadas, RLS 20/20, contagens coincidentes e configurações de segurança verificadas. |
| F | Backup | BLOQUEADO | Connector sem ferramenta de backup/PITR; estado não confirmado. |
| G | Administradores | PENDENTE DO OPERADOR | Nenhuma conta; script preparado sem UUID fictício; nomes/e-mails/autorização ausentes. |
| H | Testes gerais | APROVADO | 127/127, 294/294, bundles 8/8, typecheck e build passaram. |
| I | Documentação | APROVADO | Relatório M08 complementado, este relatório e progresso atualizados. |
| J | GitHub e PR | PARCIAL | PR #2 confirmado draft/aberto; branch de sessão não é head do PR; sem merge. |
| K | Pagamentos preservados | APROVADO | Nenhuma ativação/configuração/alteração de pagamentos ou checkout nesta sessão. |

## 12. Veredito

**MISSÃO PARCIAL.** A Prime Store não está pronta para lançamento. A aprovação exige no mínimo publicação comprovada da `admin-api`, validação HTTP real, evidência de backup recuperável, administradores reais com TOTP/AAL2 e resolução da branch/PR. Nenhuma pendência foi declarada concluída sem prova.

## Nota de reconciliação M10

Este documento registra evidências históricas, não o estado remoto atual.
Veja [Missão 10](missao-10-reconciliacao-final.md) para ancestralidade, recuperação
do commit M09 e validações reexecutadas. A chamada administrativa de quatro
argumentos foi introduzida em M07 (`f046a82`), não corrigida em M09. O smoke
não comprova oito funções nem ausência absoluta de efeitos de auditoria ou
rate-limit; não foi executado remotamente na M10.
