# Guia de provisionamento de administradores (placeholders)

> **Uso:** este guia contém **somente placeholders** — nenhum dado real de
> pessoa foi inventado, nenhum UUID foi criado, nenhum usuário existe hoje no
> projeto (`auth.users = 0`, `admin_users = 0`, conferido na Missão 13).
> Execute os passos na ordem; cada passo que depende de dado humano fica
> marcado **[OPERADOR]**.

**Pré-condições (já verificadas na M13):** `disable_signup = true`
(criação de conta é feita pelo painel Supabase, não pelo signup público);
TOTP habilitado (`mfa_totp_enroll/verify = true`);
`mfa_allow_low_aal = false` (AAL2 obrigatório para ações administrativas);
allowlist de administradores decidida no banco via `assert_admin()`.

## Passo 1 — Dados reais **[OPERADOR]**

Colete, com autorização, para cada pessoa que terá acesso:

| Campo | Placeholder | Observação |
| --- | --- | --- |
| Nome de exibição | `<NOME_REAL_ADMIN_1>` (2–80 chars) | `admin_users.display_name` |
| E-mail real | `<EMAIL_REAL_ADMIN_1@dominio.com>` | caixa real, acessível pela pessoa |
| Papel | `owner` (primeiro) / `admin` (demais) | constraint `role ∈ {owner, admin}` |
| Segunda pessoa | `<NOME_REAL_ADMIN_2>` / `<EMAIL_REAL_ADMIN_2@dominio.com>` | opcional |

## Passo 2 — Criar os usuários no Auth **[OPERADOR]**

No painel Supabase → **Authentication → Users → Add user**:

1. Informe `<EMAIL_REAL_ADMIN_1@dominio.com>` e senha forte (gerada por
   gerenciador de senhas). Repita para `<EMAIL_REAL_ADMIN_2@dominio.com>`.
2. Confirme o e-mail conforme a política do projeto
   (`mailer_autoconfirm = false` — o link de confirmação precisa ser
   concluído pela pessoa).
3. Copie o **UUID** de cada usuário criado →
   `<UUID_REAL_ADMIN_1>` e `<UUID_REAL_ADMIN_2>`.

## Passo 3 — Registrar em `admin_users` **[OPERADOR]**

No **SQL Editor** do projeto `eorlmqolbknrplvdbbtl`, descomente e preencha o
bloco de `scripts/provision-admin.sql`:

```sql
insert into public.admin_users (user_id, display_name, role, is_active)
values
  ('<UUID_REAL_ADMIN_1>', '<NOME_REAL_ADMIN_1>', 'owner', true),
  ('<UUID_REAL_ADMIN_2>', '<NOME_REAL_ADMIN_2>', 'admin', true)
on conflict (user_id) do update
  set display_name = excluded.display_name,
      role = excluded.role,
      is_active = true;
```

- Nunca use UUID fictício; nunca versione UUIDs reais.
- Confira com o `select` de conferência do próprio script (esperam-se **apenas**
  os administradores autorizados; hoje a tabela está vazia).

## Passo 4 — TOTP de cada pessoa **[OPERADOR]**

1. A pessoa acessa `/admin`, entra com o e-mail e a senha.
2. Ao primeiro acesso, cadastra o **TOTP** (app autenticador) conforme o fluxo
   do painel; o login conclui em **AAL2**.
3. Confirme que `mfa_allow_low_aal = false` continua ativo (falha fechada:
   sem AAL2 nada é autorizado — `tests/db/22` cobre essa guarda).

## Passo 5 — Verificação final **[OPERADOR]**

- [ ] `select count(*) from auth.users;` = número de pessoas criadas.
- [ ] `select user_id, display_name, role, is_active from public.admin_users;`
      = mesmos UUIDs, `is_active = true`.
- [ ] Login em `/admin` + TOTP → painel abre (ações de escrita auditadas).
- [ ] Nenhum e-mail/UUID real foi commitado no repositório.

## Revogação (a qualquer momento) **[OPERADOR]**

```sql
update public.admin_users set is_active = false where user_id = '<uuid>';
```

(Isso remove o acesso sem apagar histórico de auditoria; para reverter,
`set is_active = true`.)
