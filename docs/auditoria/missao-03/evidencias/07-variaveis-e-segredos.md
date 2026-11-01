# Evidência 07 — Variáveis de ambiente e segredos (sem valores)

## Edge Functions (Supabase → Project Settings → Edge Functions → Secrets)

| Nome | Obrigatória | Para que serve | Estado |
| --- | --- | --- | --- |
| `SUPABASE_URL` | sim | URL do projeto (injetada automaticamente) | disponível |
| `SUPABASE_SERVICE_ROLE_KEY` | sim | RPC como `service_role` (injetada automaticamente) | disponível |
| `SUPABASE_ANON_KEY` | recomendada | validação de JWT no `admin-api` | disponível |
| `PRIME_ENCRYPTION_KEY` | **opcional** | AES-256-GCM das credenciais e tokens de entrega (base64 de 32 bytes) | **não configurada** — fallback no Vault |
| `MP_ACCESS_TOKEN` | sim (pagamentos) | criar/consultar pagamento PIX | **ausente** (bloqueio da fase H) |
| `MP_WEBHOOK_SECRET` | sim (webhook) | validar `x-signature` | **ausente** (bloqueio da fase H) |
| `MP_NOTIFICATION_URL` | recomendada | `notification_url` enviado ao provedor | ausente |
| `STORE_URL` | recomendada | montar o link privado de entrega | padrão `http://localhost:5173` |

Cadeia de precedência da chave mestra (implementada em `_shared/deps.ts`):

1. `PRIME_ENCRYPTION_KEY` (secret da função), se existir;
2. `select public.get_secret_material('prime_store_encryption_key')` — RPC
   `SECURITY DEFINER` **somente** `service_role`, lendo o Supabase Vault;
3. nada → operações que cifram/decifram falham fechadas (`503 not_configured`).

A migração `0023` cria o segredo no Vault com `encode(extensions.gen_random_bytes(32),'base64')`
gerado **dentro do banco**: o valor não passou por arquivo, relatório, log ou histórico de
conversa. Verificado: `vault.secrets where name='prime_store_encryption_key'` → 1 linha
(o valor não foi lido nem impresso).

## Frontend (`.env.local`, nunca versionado)

| Nome | Uso |
| --- | --- |
| `VITE_SUPABASE_URL` | base das Edge Functions |
| `VITE_SUPABASE_ANON_KEY` | apikey das chamadas públicas |

Modelo pronto e sem valores: `.env.example` (frontend) e `.env.functions.example`
(funções). Nenhum `service_role` no frontend.

## Regras mantidas

- Nenhum segredo em código, migração, documentação ou relatório.
- Nenhum log imprime credencial, token, e-mail do comprador ou ciphertext
  (`maskEmail`/`maskSecret` na prévia de importação; `log()` só com IDs e status).
- Nenhum RPC devolve `token_enc` a usuário; `resolve_delivery` devolve ciphertext
  somente ao backend, que decifra e devolve apenas as credenciais do pedido pago.
