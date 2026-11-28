# Relatório — Simplificação da autenticação operacional (Prime Store)

Data: 2026-11-28 · Branch: `arena/90b4d5fc-prime-store` (a partir de `main` 252473a)

## 1. Resumo

O acesso do dia a dia agora é feito só com **e-mail e senha**. Ele cobre o
estoque e as informações dos produtos.
Não há TOTP, passkey nem PIN nesse fluxo.
O **acesso administrativo completo** continua igual, com allowlist e
verificação em duas etapas. Ele cobre pedidos, pagamentos, reembolsos,
credenciais, preços/custos e auditoria.
Nenhuma conta foi criada, apagada ou alterada.

## 2. Situação encontrada (produção, somente leitura)

- As duas contas administrativas (Proprietário e Administrador) estavam
  **travadas no portão TOTP**. Cada uma tem 1 fator *não verificado* e 0
  verificados, com `mfa_required = true`, ou seja, nenhuma entrava no painel.
- O banco nega tudo por padrão: RLS sem políticas e sem grants de tabela. Todo
  acesso passava por 22 funções `admin_*`, cada uma exigindo allowlist + AAL2.
- Recuperação de senha: o e-mail era enviado, mas **não existia tela de nova
  senha** ao voltar pelo link.

## 3. Classificação das operações

| Operação | Perfil |
|---|---|
| Ver estoque, cadastrar unidade, importar CSV, desativar/reativar unidade | **Operacional** |
| Editar nome/textos/imagem/validade/limite/destaque, ativar/desativar produto | **Operacional** |
| Revelar ou editar credenciais, fingerprints | Administrativo |
| Criar produto, preço, custo, slug, categoria, histórico de preço | Administrativo |
| Pedidos, clientes, pagamentos, reembolsos, disputas, entregas | Administrativo |
| Indicadores financeiros, auditoria, expirar reservas | Administrativo |
| Usuários, allowlists, configurações | Administrativo (fora do painel) |

## 4. O que foi implementado

**Banco** (`supabase/migrations/20261128120000_0048_perfil_operacional.sql`):
- tabela `operator_users`, com RLS ligada, sem políticas e sem grants ao
  cliente;
- `assert_operator()`, `is_operator()` e `log_operator_action()`. A auditoria
  vai para `admin_audit_log` com `profile = operational`;
- 9 funções `ops_*`, todas com `SECURITY DEFINER`, `search_path` fixo e
  `assert_operator()` na 1ª linha;
- projeções sem credencial, fingerprint, custo, pedidos ou autoria;
- `ops_update_product` **recusa** campos fora da lista permitida;
- `admin_*`, `assert_admin` e `admin_users` **não foram tocados**.

**Edge Function** (`admin-api`):
- ações `ops.*` em um módulo separado (`_shared/handlers/opsActions.ts`);
- `session` passa a informar `is_operator`;
- novos erros mapeados para 403/409/422 claros;
- a cifragem continua só no servidor.

**Painel** (`/admin`):
- painel **"Operação diária"** com as abas Estoque e Produtos;
- o operador entra direto após o login;
- não há opção de exibir credenciais nem coluna de fingerprint;
- não há custo, margem nem criação de produto;
- conta que é também admin tem o atalho "Acesso administrativo completo", que
  leva ao TOTP;
- nova tela **"Definir nova senha"** para o link de recuperação;
- texto do login atualizado.

**Provisionamento** (`scripts/provision-operator.sql`):
- inclui as 2 contas existentes em `operator_users`;
- é idempotente e não toca em `admin_users`, TOTP ou `auth.users`.

## 5. Provas (testes automatizados)

| Comprovação | Onde |
|---|---|
| Login e-mail+senha (AAL1) abre a sessão operacional | db/31, db/32, operatorPanel |
| Alteração de estoque (cadastrar, importar, desativar/reativar) | db/31, db/32, operatorPanel |
| Atualização autorizada de produto + auditoria | db/31, db/32, operatorPanel |
| Preço/custo/slug/categoria recusados, nada gravado | db/31 (6 casos), db/32 |
| 10 ações administrativas recusadas ao operador (403) | db/32 |
| Operador não passa em `admin_*`, nem em AAL2 | db/31 |
| Admin em AAL1 segue bloqueado (`mfa_required`) | db/31, db/32 |
| Nenhuma saída com credencial/fingerprint/custo/pedido | db/31, db/32 |
| Sem autopromoção; sem leitura direta de tabelas; anon sem acesso | db/31 |
| Conta fora da allowlist recebe 403 / "Acesso negado" | db/31, db/32, operatorPanel |
| Recuperação de senha (tela, validação, `updateUser`) | operatorPanel, adminAuth |

Resultados locais:
- `npx tsc -b`: 0 erros;
- `npm test`: **237/237**;
- `npm run test:db`: **553/553** (42 arquivos, PostgreSQL 18);
- `npm run bundle:functions`: 10/10;
- `npm run build`: ok.

O e2e (Chromium) roda no CI.

## 6. Publicação (somente após aprovação)

1. Merge do PR em `main`.
2. Aplicar a migração em produção (`audsosvbdybifvxsmqpi`).
3. Rodar `scripts/provision-operator.sql`.
4. Republicar a Edge Function `admin-api` (bundle `.local/functions-build/admin-api.ts`).
5. Deploy de produção na Vercel.
6. Verificar em produção:
   - login com e-mail+senha;
   - uma operação de estoque;
   - recusas (ação admin → 403).

## 7. Observações

- Os fatores TOTP pendentes das duas contas continuam lá e não atrapalham o
  perfil operacional. Para usar o acesso completo, basta concluir o cadastro no
  portão TOTP (ou descartar e recadastrar).
- O e-mail de recuperação usa o mailer padrão do Supabase, limitado a 2 por
  hora. Para uso frequente, configure um SMTP próprio.
