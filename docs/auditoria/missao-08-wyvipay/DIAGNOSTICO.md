# Missão 08 (b) — Diagnóstico de reconhecimento

> Registro feito **antes** de qualquer alteração, para que a auditoria seja
> rastreável. Commit de referência: `2a456ee` — *feat(loja): catálogo, carrinho e
> solicitação sem pagamento integrados ao backend*. Branch
> `arena/e7e73e28-prime-store`. Data: 2026-11-08.

## 1. Estado do repositório

| Item | Situação |
| --- | --- |
| `git status` | árvore limpa, nada pendente |
| HEAD | `2a456ee` |
| `main` | outro `HEAD` (`0b50248`), **sem base comum** com esta branch — `git diff main...HEAD` responde `no merge base` |
| Migrações | **33** arquivos (`0001`–`0033`) |
| Edge Functions no repositório | 8: `catalog`, `create-order`, `order-status`, `delivery`, `mp-webhook`, `demo-payment`, `admin-api`, `order-request` |
| Edge Functions no sandbox | as 8, `ACTIVE` — `catalog` v6, `create-order` v7, `order-status` v5, `delivery` v4, `mp-webhook` v5, `admin-api` v4 (JWT), `demo-payment` v3, `order-request` v1 |
| `tsc -b` | limpo |
| Frontend (`npx vitest run`) | **75/75**, 9 arquivos |
| Banco (`npm run test:db`) | **não executado**: este container não tem PostgreSQL (`which postgres/initdb` vazio, `/usr/lib/postgresql` inexistente) |
| Documentos da missão 08 anterior | `docs/auditoria/missao-08/{DIAGNOSTICO,RELATORIO}.md` — tratam da **funcionalidade da loja**, não de gateway |

## 2. Leitura do relatório da Missão 07

`docs/auditoria/missao-07/RELATORIO.md` (316 linhas). O que importa para esta
missão:

1. **Webhook passou a exigir assinatura** e a falhar fechado (`503` sem segredo,
   `401` sem HMAC válido, `401` com `ts` velho). A ordem "validar tudo antes de
   gravar" é o padrão que a versão WyviPay herda.
2. **Expiração de reservas é automática** (`pg_cron`, 1/min) — a WyviPay só troca
   quem emite o evento.
3. **Limite de requisições persistente** no banco, por rota e por origem. Ficou
   registrado que o webhook **não** usa esse módulo (provedor envia de vários IPs).
4. **Pendências operacionais herdadas**: cinco funções não republicadas, segredo
   do webhook não configurado, linhagem de migrações divergente, `pg_cron` só no sandbox.

Consequência: qualquer plano que repita "basta trocar o cliente HTTP" ignora que
o webhook, o cron e a base de migrações são o alicerce já testado — e devem ser
**reusados**, não reescritos.

## 3. O que a auditoria encontrou de imediato

1. O Mercado Pago está confinado: **1 módulo de cliente**, **2 handlers** que o
   consomem (`createOrder`, `orderStatus`), **1 handler de webhook**, `config.ts`,
   `supabase/config.toml`, 3 migrações com `CHECK (provider …)` e **2 dublês de teste**.
2. Não há SDK do provedor em `package.json` nem chamada de pagamento no frontend
   público (`paymentService.ts` é stub; as telas de pagamento estão fora do roteador).
3. **A máquina de estados do dinheiro é agnóstica**: `apply_payment_status`,
   `attach_payment`, reservas, entrega, disputa e reembolso não mencionam provedor
   em regra de negócio — só a coluna `provider` e o filtro de dedup em
   `record_payment_event`.
4. **O ponto cego**: `apply_payment_status`, `consume_reservation`,
   `allocate_late_units` e `resolve_delivery` são **mono-produto**, enquanto a
   loja passou a registrar carrinho com vários itens (`order_items`, migração
   `0033`). Nenhum teste cobre pagamento de carrinho multi-item porque esse
   caminho nunca existiu.
5. **Nenhuma credencial** WyviPay ou Mercado Pago existe no ambiente (secrets do
   projeto, `env`, arquivos `.env*`, busca textual: zero ocorrências).
6. O sandbox **tem** saída HTTPS para `api.wyvipay.com.br`; o shell deste
   container **não**. Sondagens sem credencial feitas de dentro do sandbox:
   `GET /cobrancas` → `401 sem_credencial`; `GET /webhooks/certificado` → `200`;
   `GET /transparency` → `200`. Nenhuma operação financeira.

## 4. Divergência documental registrada no reconhecimento

Três páginas da documentação oficial da WyviPay descrevem a chave `wy_test_` de
duas maneiras incompatíveis:

- `/api-reference` (tabela *Ambientes*): **"Ainda não emite cobrança. Responde `501` com `ambiente_indisponivel`."**
- `/guides/ambiente-de-teste`: **"a chave `wy_test_` cria cobranças, aceita pagamentos simulados e dispara webhooks reais."**
- `/endpoint/payment-pix/create` (tabela de erros): `501 ambiente_indisponivel` — **"Não é mais devolvido: a chave `wy_test_` emite no ambiente de teste."**

As duas últimas concordam entre si e a terceira é uma nota de correção explícita;
a primeira parece texto anterior à mudança. **Ainda assim não foi medido**, porque
não há credencial de teste. O plano trata o comportamento como desconhecido e
começa por esse teste (etapa 2 do relatório).

## 5. Decisões de escopo desta missão

1. **Nada de código de integração.** O produto desta missão é o relatório
   [`RELATORIO.md`](./RELATORIO.md) e o checklist
   [`DEPENDENCIAS-HUMANAS.md`](./DEPENDENCIAS-HUMANAS.md).
2. **Nada de migração aplicada, nada publicado, nenhuma credencial tocada,
   nenhuma cobrança emitida** (nem de teste).
3. **Preservar o Mercado Pago no repositório** durante toda a transição: o
   desligamento só acontece depois que a WyviPay estiver verde (etapa 8).
4. **A etapa 1 do plano não é sobre WyviPay**: é sobre fazer a máquina de estados
   existente entender carrinho multi-item. Cobrar antes disso entrega o pedido
   errado.
