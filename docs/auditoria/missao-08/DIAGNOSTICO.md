# Missão 08 — diagnóstico inicial

> Reconhecimento feito antes de qualquer alteração, sobre o commit de referência
> `f6f3405` (Missão 07). Branch de trabalho: `arena/08e7eb3e-prime-store`
> (o ambiente fixa esta branch — ver seção 6).
> Data: 2026-11-01.

## 1. Estado do repositório

| Item | Situação |
| --- | --- |
| HEAD | `f6f3405` — *docs(auditoria): corrige rotulo da chamada de catalogo* |
| Árvore de trabalho | limpa, idêntica ao remoto (`git archive` do remoto × checkout → sem diferenças) |
| Suítes na base | `npx tsc -b` limpo · frontend **70/70** (9 arquivos) · banco **198/198** (16 arquivos) |
| Migrações | 32 arquivos (`0001`–`0032`) |
| Edge Functions no repo | `catalog`, `create-order`, `order-status`, `delivery`, `mp-webhook`, `demo-payment`, `admin-api` |
| Publicadas no sandbox | `catalog` v6, `create-order` v7, `order-status` v4, `delivery` v4, `mp-webhook` v5, `demo-payment` v3, `admin-api` v4 |
| Sandbox | `prime-store-sandbox` (`eorlmqolbknrplvdbbtl`), 2 produtos ativos com estoque (11 e 13 unidades), ambos `is_demo` |

## 2. O que já funciona de verdade

| Área | Situação |
| --- | --- |
| Catálogo (backend) | `GET /catalog` lê `public_catalog` via `get_catalog`, devolve preço, disponibilidade real, categoria, instruções, `is_demo`; expira reservas vencidas antes de responder |
| Catálogo (frontend) | `catalogService` + `CatalogContext` consomem a função e mapeiam o contrato com descarte de campos inválidos |
| Carrinho | `CartContext` com `localStorage`, normalização de quantidade por `maxQuantity` e `availableUnits`, subtotal/total, remoção |
| Pedido (backend) | `create_order` valida produto/quantidade/estoque, reserva unidades por 30 min, gera referência `PS-XXXXXX`, idempotência por chave, eventos |
| Acompanhamento (backend) | `get_order_status(order_id, client_token_hash)` exige o token privado, devolve estado, produto, pagamento, entrega e disponibilidade; mensagem uniforme `order_not_found` |
| Segurança | RLS em 19 tabelas, `anon` sem leitura de tabela/função, `authenticated` só funções `admin_*`, limite de requisições persistente, assinatura do webhook |

## 3. O que existe apenas visualmente (ou depende de pagamento)

1. **Catálogo com dados fictícios como substituto.** `src/data/products.ts` tem 12
   produtos inventados e `catalogService` começa com eles (`state: 'demo'`).
   Sem `VITE_BACKEND_ENABLED=true` — e também **depois de uma falha** de rede — a
   loja exibe esses produtos como se fossem o catálogo. As categorias da home e do
   filtro também vêm de lista estática.
2. **Imagens.** `ProductArtwork` desenha um monograma e ignora `product.imageUrl`.
   Nenhum produto do sandbox tem imagem, mas o campo existe no banco e no
   contrato, e não é usado.
3. **Checkout de pagamento.** `CheckoutPage` só conclui pedido com Mercado Pago
   (ou aprovação demonstrativa). Sem `MP_ACCESS_TOKEN`, produto não-demo cai em
   `503 payment_not_configured`; no sandbox, apenas produtos `is_demo` passam, com
   botão de "simular aprovação". Há seleção de método (PIX/cartão) que **não**
   processa nada — é decoração.
4. **Um produto por pedido.** O checkout bloqueia carrinho com mais de um item
   ("Um produto por pedido"), o que contradiz a jornada pedida na missão.
5. **Confirmação fictícia.** `/pedido-confirmado` mostra um `DemoOrder` criado em
   `demoOrderService` e guardado **em memória do React** — nada é persistido, nada
   sobrevive a recarregar a página. É a simulação que a missão manda substituir.
6. **Acompanhamento sem porta de entrada.** `order-status` existe e funciona, mas
   só é chamado pela tela de pagamento (PIX). Não há página pública para o
   visitante consultar a solicitação.
7. **Tela de pagamento e entrega.** `/pagamento` e `/entrega/:token` são públicas
   no roteador. A segunda só faz sentido depois de um pagamento aprovado — hoje,
   um caminho sem saída.

## 4. O que impede a experiência principal

| Impedimento | Consequência |
| --- | --- |
| `orders` modela **um** produto (`product_id`, `quantity`, `unit_price_cents`, `total_cents` + CHECK `total = unit_price × quantity`) | Não há como registrar a solicitação de um carrinho com vários itens |
| `order_status` não tem estado de solicitação sem pagamento (`pending_payment`, `paid`, `expired`…) | Registrar a solicitação exigiria mentir dizendo "aguardando pagamento" |
| `payment_status` não tem valor para "não se aplica" | O pedido pareceria pendente de cobrança |
| `create_order` sempre reserva estoque por 30 min e espera cobrança | Sem pagamento, a reserva expira e o pedido vira `expired` — a solicitação "morre" sozinha |
| `orders.idempotency_key` é única e `create_order` rotaciona o token | Reaproveitável, mas a função é amarrada a um único produto |
| Frontend exige `VITE_BACKEND_ENABLED` e cai para dados locais | A loja nunca é, de fato, uma loja |

## 5. Decisões de projeto tomadas a partir do diagnóstico

1. **Solicitação sem pagamento como novo fluxo**, sem tocar no fluxo de cobrança
   existente (que fica preservado para a fase seguinte):
   - novos valores de enum `order_status.requested` e `payment_status.not_required`;
   - tabela `public.order_items` (uma linha por produto do carrinho);
   - `public.create_purchase_request(...)` — valida tudo no banco, calcula preço a
     partir da tabela, registra o pedido e os itens, é idempotente;
   - nova Edge Function `order-request` (a `create-order` de cobrança continua
     intacta e publicada).
2. **Sem reserva de estoque na solicitação.** A disponibilidade é conferida no
   ato do registro; nada é bloqueado, nada é baixado. Motivo: não existe
   confirmação comercial nesta fase, e uma reserva de 30 min faria a solicitação
   expirar sozinha (`expire_overdue_reservations` só age em `pending_payment`,
   logo não toca em `requested`).
3. **Nada é entregue.** Nenhum `delivery` é criado, `delivery_status` fica
   `not_ready`, e nenhuma função de pagamento é chamada.
4. **Frontend sem catálogo fictício.** O catálogo passa a ser sempre o backend;
   falha de rede vira estado de erro com ação de recarregar, e ausência de
   configuração vira aviso claro — nunca produtos inventados.
5. **Pagamento e administração saem da experiência pública** (rotas removidas do
   roteador), mas **os arquivos e serviços continuam no repositório** para a fase
   seguinte.
6. **Carrinho com vários produtos** e confirmação persistida no banco, com link de
   acompanhamento baseado no token privado que já existe.

## 6. Limitação de ambiente registrada

O Arena fixa a branch `arena/08e7eb3e-prime-store`; não é possível criar
`arena/missao-08-...`. Todo o trabalho segue nessa branch, a partir de `f6f3405`.
