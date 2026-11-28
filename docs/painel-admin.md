# Painel administrativo e provisionamento dos administradores

## Disputas (chargeback)

O painel lista pedidos `disputed` (filtro de status e "somente problemas") e, no detalhe,
oferece três desfechos auditados: **reembolsar e encerrar**, **contestação revertida
(valor recuperado)** e **manter em análise**. A ação chama
`admin_resolve_dispute` via `admin-api` (`orders.resolveDispute`).

## Perfil operacional (e-mail + senha)

O trabalho diário (estoque e informações de produto) usa o **perfil
operacional**: só e-mail + senha, sem TOTP, passkey ou PIN. Ele tem allowlist
própria (`operator_users`) e funções próprias (`ops_*`, `assert_operator()`);
não alcança pedidos, pagamentos, credenciais, preços/custos nem auditoria.
Detalhes: [`perfil-operacional.md`](./perfil-operacional.md).

As regras abaixo continuam valendo integralmente para o **acesso
administrativo completo**.

## Acesso

- Rota: `/admin` (chunk carregado sob demanda; nada da biblioteca de auth entra
  no bundle público).
- Login: e-mail + senha (Supabase Auth). **Cadastro público desativado.**
- Segunda etapa obrigatória: TOTP (AAL2). No primeiro acesso o painel mostra o
  QR code e o segredo para cadastrar no aplicativo autenticador.
- Cada administrador pode ter **até dois autenticadores TOTP** (principal e
  reserva), gerenciados na aba **Segurança** do painel.
- A autorização **não** depende do frontend: toda ação chama `admin-api`, que
  executa funções SQL com `assert_admin()` — allowlist ativa **e** `aal` = `aal2`.

Comportamentos de confiabilidade (endurecimento do MFA):

- **Falha de rede nunca é interpretada como "não há autenticadores"** ou como
  "conta fora da allowlist": falha ao listar fatores ou ao verificar permissões
  mantém o acesso trancado, com mensagem clara e botão "Tentar novamente".
- **Cadastro único**: o primeiro acesso identifica fatores já existentes antes
  de criar novos; repetição do efeito no React StrictMode (ou duplo clique) não
  gera fatores duplicados.
- **Fator pendente**: um cadastro incompleto é concluído com o código do app;
  se o segredo foi perdido, o próprio portão oferece "Descartar cadastro
  incompleto" (seguro: fator pendente nunca autorizou nada).
- **Relógio**: os códigos TOTP dependem da hora do dispositivo — mantenha data e
  hora em sincronização automática para evitar códigos recusados.
- O painel só abre com sessão AAL2 confirmada por `admin-api`
  (`mfa_satisfied`); nenhuma tela libera o painel após erro de rede.

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
6. **(Recomendado) Autenticador reserva**: com a sessão aberta, cada
   administrador cadastra um segundo autenticador na aba **Segurança**
   (confirmando o código antes de considerar o cadastro concluído).

Papéis `owner` e `admin` têm **as mesmas permissões efetivas** na V1; o campo é
informativo e serve para auditoria.

### Recuperação de senha

- Autoatendimento: "Esqueci minha senha" em `/admin` dispara
  `resetPasswordForEmail` do Supabase Auth (o link volta para `/admin`).
- Sem acesso ao e-mail: redefinir pelo painel do Supabase (service role) e
  revisar `admin_audit_log` para identificar atividades suspeitas.
- Perda do TOTP principal: se houver **autenticador reserva** cadastrado, entre
  com ele (seletor no portão de verificação) e gerencie os fatores na aba
  Segurança. Sem nenhum fator funcional, remover o fator do usuário no painel do
  Supabase (Authentication → Users → MFA factors) e reenrolar no próximo login.
- Cadastro incompleto travando o primeiro acesso: use "Descartar cadastro
  incompleto e começar novamente" no próprio portão, ou descarte o fator
  pendente na aba Segurança.

### Revogar acesso

```sql
update public.admin_users set is_active = false where user_id = '<uuid>';
```

## Aba Segurança (autenticadores TOTP)

Disponível **apenas fora do modo demonstrativo**. Permite ao administrador, sem
conhecimento técnico:

- **Visualizar** os autenticadores cadastrados, com situação explícita:
  "Ativo (verificado)" ou "Pendente (incompleto)".
- **Cadastrar um segundo autenticador** (limite de dois): o painel mostra o QR
  code/segredo e o cadastro só é concluído após a **confirmação do código** no
  aplicativo — fator pendente nunca conta como proteção ativa.
- **Descartar cadastros incompletos** (fatores pendentes), do portão de login ou
  da aba Segurança, sempre com confirmação explícita.
- **Remover um fator antigo** somente quando existir **outro fator verificado**;
  o último autenticador verificado não pode ser removido, e a remoção exige a
  sessão já elevada a AAL2. Toda alteração reconsulta a sessão em seguida.

Segurança dessa área: as operações usam apenas o JWT do próprio usuário
(`auth.mfa.*` do Supabase); segredos TOTP são exibidos **uma única vez** no
cadastro e não são armazenados nem registrados em log; nenhuma chave
privilegiada é usada.

## Operações disponíveis

| Aba | Ações |
| --- | --- |
| Visão geral | Indicadores (receita, pedidos, estoque, reembolsos), estoque baixo, reembolsos pendentes, últimas 15 ações de auditoria, botão para liberar reservas vencidas |
| Produtos | Listar/buscar, criar, editar (preço, custo, validade, instruções, tema), ativar/desativar, ver estoque por produto e margem |
| Estoque | Resumo por status, listar com filtros, cadastrar unidade, editar credencial (somente unidades disponíveis), desativar/reativar, importar CSV com prévia obrigatória, exibir credenciais (com registro em auditoria) |
| Pedidos | Buscar por referência/produto, filtrar por status de pedido e de pagamento, filtro "somente problemas", detalhe com pagamento, unidades entregues, histórico de eventos, revogar/rotacionar link de entrega, decidir reembolsos |
| Segurança | Ver autenticadores (verificados/pendentes), cadastrar segundo autenticador com confirmação, descartar cadastro incompleto, remover fator antigo (nunca o único verificado) — indisponível no modo demonstrativo |

Regras de ouro que o painel respeita:

- **Credenciais nunca aparecem em listagens padrão**; exigem ação explícita e
  ficam registradas em auditoria (`stock_credentials_listed`).
- **Nenhum dado sensível é persistido no navegador** além do token de sessão do
  Supabase Auth.
- **Reembolso só é efetivado no Mercado Pago**; o painel autoriza/marca/recusa e
  revoga a entrega ao marcar como processado.
