# Configuração inicial temporária das duas contas administrativas

> **Status:** procedimento temporário, com auto-encerramento. Desligado por
> padrão; a migração `0042` apenas cria a estrutura. Ativado para a janela de
> configuração inicial e encerrado automaticamente quando a segunda conta é
> criada (ou manualmente, a qualquer momento).
>
> Para o procedimento manual clássico (SQL editor + `admin_users`), ver
> [`provisionamento-admin.md`](./provisionamento-admin.md).

## O que é

Uma porta única e estreita pela qual o **proprietário** cria as duas contas
administrativas previstas, pelo próprio navegador, sem qualquer cadastro
público aberto:

- **URL:** `https://<dominio-da-loja>/admin/setup`
- **Exige:** o código temporário de configuração (existe apenas no servidor,
  em `SETUP_ADMIN_CODE`, nunca no repositório, no frontend ou em logs);
- **Teto:** exatamente duas contas (`admin_bootstrap_created_count`, máximo 2,
  monotônico — nunca diminui);
- **Encerramento automático:** a criação da segunda conta apaga
  `admin_bootstrap_enabled` na MESMA transação; a partir daí a porta responde
  "encerrada" (HTTP 410) para qualquer tentativa;
- **Credenciais individuais:** e-mail e senha são cadastrados pelo proprietário
  e gravados diretamente na Supabase Auth (cada um com a sua senha);
- **Allowlist atômica:** `bootstrap_admin_register()` insere em `admin_users`
  e incrementa o contador sob trava de linha — duas criações simultâneas não
  ultrapassam o teto;
- **MFA preservado:** nada aqui autentica ninguém. Cada conta entra pelo login
  normal (`/admin`) e cadastra o TOTP no primeiro acesso; ações
  administrativas continuam exigindo AAL2 + allowlist + `is_active` no banco;
- **Denial por padrão:** sem `SETUP_ADMIN_CODE` no servidor, a função
  `admin-bootstrap` responde como inexistente (404) para POSTs e
  `{ configured: false, available: false }` para GETs;
- **Anti-força-bruta:** 5 tentativas a cada 5 minutos por origem, com IP
  pseudonimizado (HMAC) no banco;
- **Não-consumidor:** requisições com código inválido, senha fraca, payload
  fora do formato ou configuração encerrada **não criam usuário nem ocupam
  vaga**;
- **Auditoria:** cada criação grava `admin_bootstrap.created` em
  `admin_audit_log` (ator, papel, vagas restantes — nunca senha nem e-mail).

## O que o proprietário precisa fazer

1. Receber do operador de deploy o **código temporário** (uma única string,
   entregue fora do repositório) e guardá-lo até terminar.
2. Abrir `https://<dominio-da-loja>/admin/setup`.
3. Para a **primeira conta**: informar código, nome de exibição, e-mail, senha
   (mín. 12 caracteres, maiúsculas + minúsculas + números) e o papel
   (`owner` para o proprietário). Enviar.
4. Repetir para a **segunda conta** (`admin` para a pessoa indicada).
   Depois do segundo envio, a página confirma o encerramento automático.
5. Entrar em `/admin` com **cada** conta e cadastrar o autenticador (TOTP)
   quando o painel pedir. A partir daí, o procedimento está concluído e a
   porta não existe mais.

## Encerramento

Automático, em camadas (bastando uma):

1. **Segunda conta criada** → `admin_bootstrap_enabled = false` na mesma
   transação do insert. `remaining` chega a 0.
2. **Teto atingido** → mesmo com a chave religada por engano,
   `bootstrap_admin_register()` devolve `ok: false, reason: 'bootstrap_closed'`
   e **apaga a chave de novo** antes de retornar (nada é inserido).
3. **Manual** (a qualquer momento, inclusive antes das duas contas):
   ver [`scripts/close-admin-bootstrap.sql`](../scripts/close-admin-bootstrap.sql).
4. **Definitivo:** apagar o segredo `SETUP_ADMIN_CODE` no painel do Supabase
   (Edge Functions → Secrets) ou via `supabase secrets unset SETUP_ADMIN_CODE`.
   Sem o segredo, nem código válido abre a porta.

O encerramento **não** desativa a loja, o painel, o login, a allowlist, o TOTP
ou qualquer permissão administrativa legítima — desliga apenas a porta de
criação inicial.

## Verificação pós-encerramento (SQL, somente leitura)

```sql
select public.bootstrap_admin_status();
-- esperado depois da segunda conta: {"created": 2, "enabled": false, "remaining": 0}

select user_id, display_name, role, is_active from public.admin_users;
-- esperado: exatamente as duas contas criadas, is_active = true

select action, actor_label, metadata, created_at
  from public.admin_audit_log
 where action = 'admin_bootstrap.created'
 order by id;
-- esperado: duas linhas, uma por conta, sem senha nem e-mail
```

## Playbook de falhas

| Situação | O que aconteceu | O que fazer |
| --- | --- | --- |
| Erro após enviar o formulário, antes do toast | Rede caiu entre Auth e allowlist | Recarregue `/admin/setup`: se `remaining` caiu, a conta foi criada — entre em `/admin`. Se não caiu, tente de novo. |
| `Já existe uma conta com este e-mail` (409) | E-mail já tem usuário no Auth | Se a conta é a administrativa recém-criada, faça login em `/admin`. Se é uma conta antiga, use "Esqueci minha senha". |
| Erro no meio e usuário órfão ficou no Auth | Falha rara entre criar no Auth e registrar na allowlist (o rollback tentou removê-lo) | Supabase → Authentication → Users: apagar o usuário órfão e repetir. |
| `bootstrap_closed` (410) com menos de duas contas | Alguém atingiu o teto ou a chave foi desligada | Verificar `select public.bootstrap_admin_status();` e a auditoria; se a configuração foi usada por engano, falar com o operador (reativar exige religar a chave manualmente e o teto continua valendo). |
| Ninguém sabe o código | `SETUP_ADMIN_CODE` só existe no servidor | O operador gera um novo código (`create_secrets`) — o procedimento manual via SQL continua disponível como alternativa. |

## O que este procedimento NÃO faz

- Não cria contas com permissões além de `owner`/`admin` da allowlist do painel;
- Não confere papel pelo navegador: qualquer `role` fora de `owner`/`admin` é
  recusado no handler e de novo no banco;
- Não abre caminho para um terceiro criar a terceira conta — mesmo sabendo o
  código, depois da segunda criação a porta responde 410;
- Não substitui o login, o TOTP, o `assert_admin()` nem o `is_active`;
- Não é um backdoor: sem `SETUP_ADMIN_CODE` e com `admin_bootstrap_enabled =
  false` (padrão), a função e o banco não concedem coisa alguma.
