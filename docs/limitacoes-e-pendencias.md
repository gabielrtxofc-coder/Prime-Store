# Limitações conhecidas e pendências

## Bloqueios de ambiente (não resolvíveis pelo código)

1. **Sem saída de rede para o Supabase e para o Mercado Pago** neste ambiente de
   desenvolvimento (`*.supabase.co` e `api.mercadopago.com` recusam TLS). Isso
   impede, aqui: `supabase db push`, `supabase functions deploy` e qualquer
   chamada real ao sandbox do Mercado Pago.
   - O schema do banco foi aplicado no projeto sandbox via conector (equivalente
     ao `db push`): **22 migrações registradas**, incluindo as 8 da missão 03.
   - As **6 Edge Functions foram implantadas** via conector e estão `ACTIVE`
     (`catalog`, `create-order`, `order-status`, `delivery`, `mp-webhook`,
     `admin-api`). O que **não** foi feito é chamá-las por HTTP — sem rede aqui.
     Ver `docs/auditoria/missao-03/evidencias/06-edge-functions-deploy.md`.
2. **Sem credenciais sandbox do Mercado Pago** (`MP_ACCESS_TOKEN`,
   `MP_WEBHOOK_SECRET`). Sem elas o checkout responde
   `503 payment_not_configured` — comportamento intencional e testado.
3. **Sem identidades dos administradores.** O repositório não inventa e-mails nem
   UUIDs. O procedimento está em `docs/painel-admin.md`; falta criar os dois
   usuários no Supabase Auth e inserir os UUIDs em `admin_users`.

## Pendências funcionais (decisões ou trabalho futuro)

| Item | Situação |
| --- | --- |
| Deploy das 6 Edge Functions no projeto sandbox | **Feito** (implantadas e ativas) |
| Chamar as funções por HTTP / validar CORS no domínio real | Pendente: requer ambiente com rede |
| Validar integração Mercado Pago sandbox (roteiro de 10 passos) | Pendente: exige `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET` de teste |
| Provisionar 2 administradores + TOTP | Depende de e-mails reais (passo documentado) |
| Validar PIX no sandbox real | Depende de credenciais MP |
| E-mail de confirmação do pedido | Fora do escopo da V1 (sem provedor de e-mail) |
| "Tenho interesse" | Continua provisório: sem coleta de dados nem notificações |
| Migrar para a API de Orders do Mercado Pago | Recomendação do provedor para integrações novas; V1 usa Payments API |
| Rotação da chave `PRIME_ENCRYPTION_KEY` | Não implementada: exigiria re-cifragem das credenciais |
| Reembolso automático | Fora de escopo por decisão: sempre manual e autorizado |
| Rate limiting / CAPTCHA no checkout | Recomendado se houver abuso; hoje há validação de payload e estoque |
| Notificação de reembolso pendente para o administrador | Hoje aparece no painel (indicadores + lista), sem e-mail |
| `pg_cron` para expirar reservas | Não necessário: toda criação de pedido e toda consulta de status expiram reservas vencidas |

## Limitações de produto (V1, intencionais)

- Um produto por pedido; sem carrinho misto.
- PIX apenas; cartão e boleto não implementados.
- Link de entrega permanente, sem expiração, revogável pelo administrador.
- Sem área de cliente: o comprador acompanha o pedido pela própria sessão e pelo
  link de entrega.
- Preços, prazos e textos comerciais (FAQ, termos, reembolsos) continuam sendo
  rascunhos editáveis — a loja não declara oferta comercial ativa.
- O catálogo em modo demonstração (sem `VITE_BACKEND_ENABLED=true`) usa dados
  locais de exemplo; nesse modo nada é cobrado, reservado ou entregue.

## Riscos monitorados

- **Abuso do `create-order`** (criação massiva de pedidos): mitigado por reserva
  real de estoque (produto precisa ter unidades) e por `max_quantity_per_order`;
  rate limiting fica como próximo endurecimento.
- **Custo de instância do Supabase**: o projeto sandbox é gratuito e pode
  pausar por inatividade; reativar antes de testar o checkout.
- **Divergência entre sandbox e produção**: nenhuma migração é aplicada em
  produção; não há projeto de produção configurado.
