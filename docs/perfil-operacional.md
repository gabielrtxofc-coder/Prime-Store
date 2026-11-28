# Perfil operacional — acesso diário com e-mail + senha

> Missão: simplificação definitiva da autenticação operacional (2026-11-28).
> Migração `20261128120000_0048_perfil_operacional.sql`.

## Em uma frase

Para o trabalho do dia a dia (estoque e informações de produto) basta
**e-mail + senha**. Pedidos, pagamentos, reembolsos, credenciais, preços/custos
e auditoria continuam no **acesso administrativo completo**, que segue exigindo
a verificação em duas etapas (TOTP/AAL2).

Sem TOTP, sem passkey, sem PIN próprio do app no perfil operacional.

## Dois perfis, duas allowlists, decididos no banco

| | Perfil operacional | Perfil administrativo |
|---|---|---|
| Entrada | e-mail + senha (AAL1) | e-mail + senha + TOTP (AAL2) |
| Allowlist | `public.operator_users` | `public.admin_users` (inalterada) |
| Guarda no banco | `assert_operator()` | `assert_admin()` (inalterada) |
| Funções | `ops_*` (9) + `is_operator` | `admin_*` (22) + `is_admin` |
| Ações na `admin-api` | `ops.*` | as de sempre |
| Auditoria | `admin_audit_log`, `metadata.profile = 'operational'` | `admin_audit_log` |

As duas guardas são independentes: estar em `operator_users` **não** dá acesso
a nenhuma função `admin_*` (nem em AAL2), e estar em `admin_users` não dispensa
o TOTP do perfil administrativo.

## O que o operador PODE

**Estoque**
- ver o resumo por produto e a lista de unidades (status, observações, motivo);
- cadastrar unidade (a credencial é cifrada no servidor, AES-256-GCM);
- importar CSV (prévia mascarada → gravação; duplicadas são reportadas);
- desativar/reativar unidade disponível, com motivo categorizado.

**Produtos**
- listar (com preço apenas para conferência e unidades disponíveis);
- alterar: nome, resumo, descrição, instruções, condições, imagem, validade
  exibida, limite por pedido, destaque;
- ativar/desativar na loja.

## O que o operador NÃO pode (recusado no banco)

- ler ou editar credenciais de estoque, ou ver a fingerprint;
- ver pedidos, clientes, pagamentos, reembolsos, disputas ou entregas;
- ver indicadores financeiros, custo, margem ou histórico de preços;
- criar produto; alterar preço, custo, slug, categoria, arquivamento;
- ver auditoria, gerenciar usuários ou allowlists, mudar configurações;
- ler qualquer tabela diretamente (RLS ligada, sem políticas, sem grants).

`ops_update_product` **recusa** (erro `operator_field_not_allowed`) qualquer
campo fora da lista — nunca descarta em silêncio. A `admin-api` antecipa a
mesma recusa com `403 field_not_allowed`.

## Como a segurança é garantida

1. `operator_users`: RLS ligada, **nenhuma política**, nenhum grant a
   `anon`/`authenticated`. O cliente não lê, não insere e não se autopromove.
2. Toda função `ops_*` é `SECURITY DEFINER` com `search_path` fixo e começa por
   `assert_operator()` (usuário autenticado + linha ativa em `operator_users`).
3. As projeções de saída são explícitas: nenhuma devolve `account_*_enc`,
   `credential_fingerprint`, `cost_cents`, `sold_order_id`, ids de reserva ou
   autoria.
4. Funções internas (`assert_operator`, `log_operator_action`,
   `ops_product_projection`) não são executáveis pelo cliente.
5. `anon` não executa nenhuma função `ops_*`.
6. A chave de criptografia fica só no servidor (Edge Function); o navegador
   nunca recebe chave privilegiada.
7. Revogar é imediato: `is_active = false` derruba a próxima chamada.

## Fluxo no painel (`/admin`)

```
login (e-mail + senha)
  └─ admin-api "session" → { is_admin, mfa_satisfied, is_operator }
       ├─ is_admin && mfa_satisfied ............ painel completo (inalterado)
       ├─ is_operator .......................... PAINEL OPERACIONAL (Estoque, Produtos)
       │     └─ (se também admin) "Acesso administrativo completo" → portão TOTP
       ├─ is_admin (sem operador) .............. portão TOTP (inalterado)
       └─ nenhum ............................... "Acesso negado"
```

Falha de rede na verificação de permissões continua trancando tudo
(fail-closed): `is_operator` ausente ou erro = sem perfil operacional.

## Recuperação de senha

"Esqueci minha senha" envia o link do Supabase Auth (redirect para `/admin`).
Ao abrir o link, o painel mostra **somente** a tela "Definir nova senha"
(mínimo de 8 caracteres, confirmação). Ela usa `auth.updateUser` com a sessão do
próprio link — nada de chave privilegiada, PIN ou fator extra. Depois, basta
e-mail + senha.

## Provisionamento

A migração **não** cadastra ninguém. Para dar acesso operacional às contas
existentes (sem criar, apagar ou alterar contas e sem tocar em TOTP ou em
`admin_users`):

```
scripts/provision-operator.sql   (idempotente; ON CONFLICT DO NOTHING)
```

Revogar: `update public.operator_users set is_active = false where user_id = '<uuid>';`

## Testes que comprovam

- `tests/db/31_perfil_operacional.test.ts` (33): estrutura/RLS/grants; sessão
  AAL1; operador ≠ admin (admin_* recusam em AAL1 e AAL2); admin em AAL1 segue
  bloqueado (`mfa_required`); listagens sem dados sensíveis; edição autorizada +
  auditoria; 6 campos proibidos recusados; estoque (cadastrar, duplicada,
  fingerprint inválida, desativar/reativar, motivo obrigatório, reservada
  intocável, importação); não-operador recusado; sem autopromoção.
- `tests/db/32_perfil_operacional_http.test.ts` (24): a mesma matriz via HTTP
  (`admin-api` → banco real), incluindo 10 ações administrativas recusadas
  com 403 e o controle positivo do admin em AAL2.
- `src/pages/admin/operatorPanel.test.tsx` (12) e
  `src/services/adminAuth.test.ts` (+7): telas, ausência de chamadas
  administrativas, ausência de credencial/fingerprint/custo, envio só de campos
  operacionais, recuperação de senha.
