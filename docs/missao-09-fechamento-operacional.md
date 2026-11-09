# Missão 09 — Fechamento operacional e validação da Prime Store

> Data: 2026-11-09 (UTC) · Commit de referência: `12a4279` · Projeto: `eorlmqolbknrplvdbbtl` (`prime-store-sandbox`).
> Branch desta sessão: `arena/aa4e6a29-prime-store` (o ambiente fixou esta branch; não foi possível trabalhar na branch solicitada `arena/66cda9f6-prime-store`).
> Estado final: **PARCIAL**. Não declarar pronta para lançamento. **Nenhum merge foi feito; pagamentos permaneceram congelados.**

## 1. Resumo executivo

O projeto Supabase esperado foi confirmado e está acessível pelo conector. O schema remoto confirma migrações 0034–0038, a assinatura nova do RPC de estoque, dados iguais às referências históricas, RLS em todas as 20 tabelas e autenticação com cadastro fechado. A `admin-api` remota segue ativa em v4 com `verify_jwt=true`; o código local em `12a4279` já usa a assinatura corrigida de quatro argumentos da migração 0038. O pacote `admin-api` foi reconstruído (45.242 bytes, SHA-256 `69e34f97bc87b01076192ad0e9ce2d6ebaee784d263e00c029cd91c7dc47bcaf`) e as oito funções locais foram empacotadas.

A conexão atual disponibiliza operações de atualização de função no catálogo do conector, mas não há invocação HTTP, execução de smoke remoto ou uma forma segura de fornecer ao atualizador o pacote local completo a partir do workspace. Nenhuma tentativa de deploy foi feita sem o pacote correto. A versão remota, portanto, **não está confirmada como atualizada**. Smoke remoto e backup/PITR não puderam ser comprovados. Não há usuários Auth ou administradores reais.

## 2. Estado inicial e continuidade

- Repositório local: `gabielrtxofc-coder/Prime-Store`; HEAD inicial `12a427991f94e34c85e967e296fd0a2089cd01fd` (grafted/shallow; histórico anterior não está integralmente disponível no clone).
- A branch fornecida pelo ambiente é `arena/aa4e6a29-prime-store`. A branch informada na missão, `arena/66cda9f6-prime-store`, é o head do PR #2 no GitHub, não a branch ativa deste checkout. Não houve troca de branch.
- `main` local/remota: `8f37527e9fe41997020a8bab86cbb3b9272dcf8d` na verificação inicial. Na verificação final, o remoto avançou para `0edf709f34480e3a1af56e65c190fe38f5f732bb`; não fizemos checkout, commit, push nem alteração direta em `main`.
- PR #2: observado inicialmente aberto e draft; na consulta final, status `MERGED`, merge commit `0edf709f34480e3a1af56e65c190fe38f5f732bb`, às 2026-11-09 20:00:48Z, por `gabielrtxofc-coder`, sem checks reportados. **A fusão ocorreu externamente durante esta sessão; não foi executada por este agente.** A branch do PR era `arena/66cda9f6-prime-store`, diferente da branch ativa fixa do checkout, portanto nosso trabalho não atualizou o PR.
- Tag `safety/m07-start-cd87b3d`: não foi encontrada em refs locais nem na consulta remota de tags; a integridade/existência da tag **não pôde ser confirmada**. Não criada, removida ou alterada.
- Projeto Supabase confirmado por listagem e `get_project`: `eorlmqolbknrplvdbbtl`, `prime-store-sandbox`, região `sa-east-1`, PostgreSQL 17.11. Conector validado. Health geral: serviços principais `ACTIVE_HEALTHY`; Realtime também retorna health saudável nesta consulta atual.

## 3. Incompatibilidade, correção e segurança da admin-api

**Evidência da incompatibilidade remota:** `admin-api` publicada como versão 4 (status `ACTIVE`, `verify_jwt=true`, código retornado pelo conector). A documentação M08 registrou que a v4 enviava somente `p_stock_unit_id` e `p_status`, isto é, a assinatura antiga removida pela 0038.

**Fonte da verdade remota:** consulta somente de leitura ao catálogo do PostgreSQL e ao corpo real da função confirma exclusivamente `admin_set_stock_unit_status(uuid,text,text,text)`, parâmetros `p_stock_unit_id`, `p_status`, `p_reason`, `p_note`; `SECURITY DEFINER`, `search_path=public, pg_temp`, execução negada a `anon` e autorizada a `authenticated`/`service_role`. `admin_list_stock` também contém e retorna os campos de motivo previstos na 0038. Migração 0038 local define os mesmos parâmetros e regras.

**Código local:** em `supabase/functions/_shared/handlers/adminApi.ts`, `stock.setStatus` já valida status, enum de motivo, nota obrigatória quando `other` e chama o RPC com quatro campos. Busca global no código-fonte funcional não encontrou chamada produtiva com a assinatura antiga. Os usos nos testes de banco exercitam deliberadamente a regra de motivo. Não foi necessária nova edição do handler nem migração (evita-se mudança redundante; o código corrigido já estava no commit de referência).

A camada mantém bearer JWT obrigatório, consulta Auth para validar a sessão e deixa `assert_admin()`/MFA no banco como autorização final. Não foi alterado `verify_jwt=true`. Os erros conhecidos são tratados com mensagens genéricas; a análise estática não identificou credenciais hard-coded no bundle.

## 4. Publicação da função e estado remoto

- O catálogo de ferramentas Supabase inclui `update_edge_function`; a consulta de estado remoto continua identificando oito funções ativas. A `admin-api` continua v4 na última leitura e com `verify_jwt=true`.
- Pacote gerado: `npm run bundle:functions` — 8/8; pacote da admin-api acima; versão local sem imports externos (bundle ESM/autocontido), sem credenciais embutidas.
- **Deploy não executado**: a ferramenta de atualização recebe o corpo fonte em texto, mas o conector não fornece upload de arquivo do workspace nem publicação de diretório/pacote; transmitir código parcial ou substituir a função por um stub seria inseguro e removeria recursos. Não houve chamada de update nem alteração remota. O pacote permanece no local ignorado `.local/functions-build/admin-api.ts`, reproduzível pelo comando documentado.
- A lista remota ainda mostra v4. Não declarar publicação concluída. A função precisa ser publicada com o bundle integral em máquina/pipeline autorizado, projeto correto e `verify_jwt=true`, sem tocar nas outras sete funções.

## 5. Testes HTTP e smoke

O script `scripts/smoke-edge-functions.mjs` revisado cobre leitura de catálogo, payload de checkout inválido, UUID inexistente em order-status, token de entrega inexistente, assinatura de webhook inválida, chamada admin sem token e JWT inválido; JWT AAL2 real é um caso opcional após provisionamento. Foi removido o caminho que criava pedido real com `PRODUCT_ID`. Todos os casos definidos são read-only e nenhum pagamento é acionado.

Execução local do comando `npm run smoke:functions`: bloqueada antes de qualquer requisição, exit 2, porque não há `SUPABASE_URL`/chave publicável no ambiente de execução. O conector não oferece ferramenta de invocação de Edge Functions; as restrições de egress da máquina também não permitem acesso direto ao host Supabase. Portanto, para cada função remota: **BLOQUEADO — nenhuma resposta HTTP observada nesta missão**. A listagem como `ACTIVE` não foi tratada como prova de funcionamento. Não foram criados pedidos, reservas, alterações de estoque, entregas ou pagamentos.

## 6. Banco, dados, permissões e configuração

- Migrações remotas `m08_0034_pedidos_multiproduto` até `m08_0038_motivos_ajuste_estoque` conferidas em `list_migrations`. Nenhuma migração reaplicada ou criada.
- Contagem atual somente leitura: products 2; orders 8; order_items 2; deliveries 3; stock_units 27; reservations 7; payments 3; admin_users 0; auth.users 0. Coincide com a referência M08.
- 20/20 tabelas públicas com RLS; 0 políticas públicas no schema. Todas as funções `SECURITY DEFINER` conferidas na consulta de escopo têm `search_path` fixo; o RPC corrigido não concede execução a `anon`. Nenhuma permissão ou política alterada.
- Configurações consultadas: `max_items_per_order=10`; `internal_confirmation_enabled=false`. Auth: `disable_signup=true`, e-mail habilitado, auto-confirmação desabilitada, TOTP habilitado; não houve alteração de configuração.
- O catálogo remoto confirma presença de segredos por metadados; valores não são registrados neste relatório. Não houve criação/alteração de segredos.
- Pagamentos: sem mudança em checkout, provedor, webhook, estado, chaves ou configuração de solicitação. Ativação continua fora de escopo.

## 7. Backup e recuperação

**Classificação: INDISPONÍVEL PARA VERIFICAÇÃO PELO AMBIENTE.** A lista de ferramentas Supabase não inclui consulta de backup, retenção ou PITR; health do banco não comprova backup recuperável. Nenhuma restauração, alteração de plano ou ativação paga foi executada.

Verificar manualmente no painel Supabase do projeto `eorlmqolbknrplvdbbtl`: **Database → Backups** (data/hora da última cópia e retenção) e, se exibido no plano, **Point-in-Time Recovery** (habilitado, janela e ponto recuperável). Registrar evidência sem compartilhar credenciais. Não restaurar produção para testar.

## 8. Administradores

Contagens remotas confirmam Auth users 0 e `admin_users` 0. Nenhuma conta criada. O script `scripts/provision-admin.sql` foi corrigido para substituir o UUID fictício anterior por marcadores UUID inválidos até preenchimento intencional; cobre um administrador por execução, papel owner/admin explicitamente escolhido e conferência. TOTP deve ser cadastrado por cada usuário no primeiro login.

Dados necessários por conta: UUID gerado no Supabase Auth, nome de exibição autorizado, papel autorizado e e-mail real; a senha forte deve ser definida/entregue pelo fluxo seguro de convite/reset, nunca informada aqui. Procedimento: Authentication → Users → criar/convidar usuário; copiar UUID; preencher e executar o insert no SQL Editor com contexto de serviço no projeto correto; acessar `/admin`, cadastrar TOTP no autenticador do próprio usuário; validar sessão e MFA AAL2 e fazer leitura administrativa. Não elevar permissões para contornar erros.

## 9. Testes locais e regressão

- `npm test`: **127/127** (16 arquivos), aprovado.
- `npm run test:db`: primeiro executado sem Postgres, falhou por conexão recusada em `127.0.0.1:55432`; iniciado PostgreSQL embutido local e repetido: **294/294** (24 arquivos), aprovado, incluindo `20_admin_api_http` e `21_stock_adjustment_reason`. Nenhuma operação no banco remoto foi feita pelos testes.
- `npm run typecheck`: aprovado.
- `npm run build`: aprovado.
- `npm run bundle:functions`: 8/8; SHA do bundle admin-api registrado acima.
- A suíte de banco apresentou 294 testes nesta branch, em comparação à referência de 293 da M08; todos os 294 passaram e não foram desativados.

## 10. Pendências reais do operador

1. **Publicar a função** após obter acesso de deploy ao projeto certo: pacote completo `.local/functions-build/admin-api.ts` (regerável com `npm run bundle:functions`), `verify_jwt=true`; publicar somente `admin-api`. Confirmar versão/updated_at com nova leitura remota.
2. **Executar smoke HTTP read-only** a partir de máquina com rede e `SUPABASE_URL` + chave publishable/anon segura, após deploy. Usar `npm run smoke:functions`; não definir `PRODUCT_ID` (o script já não usa), não fornecer JWT administrativo até existir conta real. Corrigir/documentar respostas inesperadas sem escrever dados comerciais.
3. **Verificar backups/PITR** no painel do Supabase conforme seção 7; evidência necessária: horário, retenção e janela de PITR quando disponível.
4. **Provisionar administradores reais** quando houver autorização: e-mail, nome, papel e UUID Auth por pessoa; convidar/criar, associar em `admin_users`, cadastrar TOTP e validar leitura do painel.
5. **Investigar o merge externo do PR #2**: o PR passou de OPEN/DRAFT a MERGED durante a sessão, por ator GitHub `gabielrtxofc-coder`, com merge commit `0edf709f34480e3a1af56e65c190fe38f5f732bb`. O agente não executou merge nem alterou `main`. O operador deve confirmar se essa ação estava autorizada e revisar o merge/checks (não havia checks reportados).
6. A tag `safety/m07-start-cd87b3d` não consta local nem no remote consultado; operador deve localizar a referência correta/confirmar em GitHub antes de alegar integridade histórica.

## 11. Classificação dos grupos

| Grupo | Objetivo | Estado | Evidência |
|---|---|---|---|
| A | Ambiente e continuidade | PARCIAL | Supabase/repo/PR consultados; branch imposta difere da solicitada; tag de segurança não encontrada; PR mudou de estado externamente. |
| B | Correção da admin-api | APROVADO | Código já corrigido em `12a4279`; SQL remoto confirma assinatura, corpo, permissões; testes DB 21 e bundle verificados. |
| C | Publicação | BLOQUEADO | Estado remoto continua v4; sem caminho seguro de upload do arquivo local pelo conector disponível. |
| D | Testes reais | BLOQUEADO | Smoke requer endpoint/chave e ferramenta de invocação indisponível; script agora só executa casos não mutantes. |
| E | Segurança e banco | APROVADO | Migrações, contagens, RLS, políticas, `search_path`, settings e assinatura conferidos; sem mudanças remotas. |
| F | Backup | BLOQUEADO | Ferramenta de backup/PITR não exposta pelo conector. |
| G | Administradores | PENDENTE DO OPERADOR | Script protegido e fluxo documentado; dados humanos e autorização ausentes; nenhuma conta criada. |
| H | Testes gerais | APROVADO | 127/127 unit; 294/294 DB; typecheck/build e 8/8 bundles aprovados. |
| I | Documentação | APROVADO | Este relatório, apêndice M08 e progresso atualizados. |
| J | GitHub e PR | PARCIAL | Repo conferido; branch corrente difere do head do PR; PR #2 foi mesclado externamente durante a sessão, sem checks reportados; este agente não fez merge. |
| K | Pagamentos preservados | APROVADO | Nenhuma configuração, checkout, webhook ou estado de pagamento foi alterado; teste smoke não cria pedido. |

## 12. Resultado final

A missão **permanece PARCIAL**. Banco, integridade, código local e testes estão comprovados. A função remota permanece v4 e o deploy ainda precisa de publicação e confirmação remota; faltam smoke HTTP, evidência de backup e admins reais. Este agente não fez merge; o PR #2 foi mesclado externamente durante a sessão e isso requer revisão humana. A loja não está aprovada para lançamento.
