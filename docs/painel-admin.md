# Painel administrativo e provisionamento dos administradores

## Acesso

- Rota: `/admin` (chunk carregado sob demanda; nada da biblioteca de auth entra
  no bundle público).
- Login: e-mail + senha (Supabase Auth). **Cadastro público desativado.**
- Segunda etapa obrigatória: TOTP (AAL2). No primeiro acesso o painel mostra o
  QR code e o segredo para cadastrar no aplicativo autenticador.
- A autorização **não** depende do frontend: toda ação chama `admin-api`, que
  executa funções SQL com `assert_admin()` — allowlist ativa **e** `aal` = `aal2`.

Camadas de verificação em uma chamada administrativa:

1. Gateway do Supabase exige JWT (`admin-api` com `verify_jwt = true`).
2. Handler confirma o usuário com `auth.getUser` (401 se inválido).
3. Banco: `assert_admin()` verifica allowlist, `is_active` e AAL2.
4. Cada mutação grava linha em `admin_audit_log` (ator, ação, entidade, metadados).
5. Depois da resposta: nada é confiado ao cliente — nova leitura é feita do banco.

## Provisionamento (o que falta fazer)

O repositório **não inventa** identidade de administrador. Nenhum e-mail, senha
ou UUID está embutido no código, e nenhum usuário administrador foi criado.
Criar os dois administradores (proprietário e Natanael) é um passo operacional:

1. **Criar os usuários no Supabase Auth** (painel → Authentication → Users →
   *Add user*, com e-mail real e senha forte; ou `supabase auth admin create-user`).
   O cadastro público continua desativado — o usuário é criado manualmente.
2. **Incluir cada UUID na allowlist**:

```sql
insert into public.admin_users (user_id, display_name, role)
values
  ('<uuid-do-proprietario>', 'Proprietário', 'owner'),
  ('<uuid-do-natanael>',     'Natanael',     'admin')
on conflict (user_id) do update set is_active = true;
```

3. **Confirmar e-mail** de cada conta (obrigatório para login).
   Atalho: `scripts/provision-admin.sql` contém o `insert` comentado e a consulta
   de conferência para colar no SQL Editor.
4. **Ativar TOTP**: cada administrador acessa `/admin`, entra com a senha e
   cadastra o autenticador no primeiro acesso (o segredo é exibido uma vez).
5. **Teste de fumaça**: `session` deve retornar `is_admin: true` e
   `mfa_satisfied: true`; uma chamada com AAL1 deve falhar com `mfa_required`.

Papéis `owner` e `admin` têm **as mesmas permissões efetivas** na V1; o campo é
informativo e serve para auditoria.

### Recuperação de senha

- Autoatendimento: "Esqueci minha senha" em `/admin` dispara
  `resetPasswordForEmail` do Supabase Auth (o link volta para `/admin`).
- Sem acesso ao e-mail: redefinir pelo painel do Supabase (service role) e
  revisar `admin_audit_log` para identificar atividades suspeitas.
- Perda do TOTP: remover o fator do usuário no painel do Supabase
  (Authentication → Users → MFA factors) e reenrolar no próximo login.

### Revogar acesso

```sql
update public.admin_users set is_active = false where user_id = '<uuid>';
```

## Operações disponíveis

| Aba | Ações |
| --- | --- |
| Visão geral | Indicadores (receita, pedidos, estoque, reembolsos), estoque baixo, reembolsos pendentes, últimas 15 ações de auditoria, botão para liberar reservas vencidas |
| Produtos | Listar/buscar, criar, editar (preço, custo, validade, instruções, tema), ativar/desativar, ver estoque por produto e margem |
| Estoque | Resumo por status, listar com filtros, cadastrar unidade, editar credencial (somente unidades disponíveis), desativar/reativar, importar CSV com prévia obrigatória, exibir credenciais (com registro em auditoria) |
| Pedidos | Buscar por referência/produto, filtrar por status de pedido e de pagamento, filtro "somente problemas", detalhe com pagamento, unidades entregues, histórico de eventos, revogar/rotacionar link de entrega, decidir reembolsos |

Regras de ouro que o painel respeita:

- **Credenciais nunca aparecem em listagens padrão**; exigem ação explícita e
  ficam registradas em auditoria (`stock_credentials_listed`).
- **Nenhum dado sensível é persistido no navegador** além do token de sessão do
  Supabase Auth.
- **Reembolso só é efetivado no Mercado Pago**; o painel autoriza/marca/recusa e
  revoga a entrega ao marcar como processado.
