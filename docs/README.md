# Prime Store — documentação técnica (V1, backend integrado)

Esta pasta concentra a documentação da implementação do backend da Prime Store.
Todo o conteúdo é verificável a partir do repositório: nada aqui depende de
configuração fora dele, exceto os segredos (que nunca são versionados).

## Mapa da documentação

| Documento | Conteúdo |
| --- | --- |
| [`setup-local.md`](./setup-local.md) | Como rodar frontend, banco e testes na máquina local |
| [`backend.md`](./backend.md) | Modelo de dados, migrações, funções SQL e endpoints das Edge Functions |
| [`mercado-pago.md`](./mercado-pago.md) | Checkout Transparente PIX, webhook, idempotência e o que falta configurar |
| [`painel-admin.md`](./painel-admin.md) | Login, MFA/TOTP, provimento dos dois administradores, operações |
| [`seguranca.md`](./seguranca.md) | RLS, criptografia de credenciais, tokens, auditoria, limites |
| [`testes.md`](./testes.md) | Suítes automatizadas, resultados reais e matriz de cenários críticos |
| [`limitacoes-e-pendencias.md`](./limitacoes-e-pendencias.md) | Bloqueios externos, decisões pendentes, próximos passos |
| [`PROGRESSO.md`](./PROGRESSO.md) | Registro de progresso para retomar o trabalho em outra sessão |

## Arquitetura em uma tela

```
Navegador (Vite + React, hospedagem própria)
   │  catálogo, checkout, pagamento, entrega, painel
   │  usa apenas VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
   ▼
Edge Functions (Deno, Supabase)
   │  catalog · create-order · order-status · delivery · mp-webhook · admin-api
   │  validam entrada, cifram credenciais, falam com o Mercado Pago
   │  usam SERVICE ROLE apenas no servidor
   ▼
PostgreSQL (Supabase)
   │  RLS em todas as tabelas, sem GRANT para anon/authenticated
   │  regras de reserva, pagamento e entrega em funções SECURITY DEFINER
   ▼
Mercado Pago (Checkout Transparente, PIX)
```

Decisões estruturais relevantes:

- **O Supabase não hospeda o frontend.** O build do Vite é estático e pode ir
  para qualquer hospedagem (Vercel, Netlify, S3, nginx).
- **Nenhuma escrita direta do cliente no banco.** Toda mutação passa por uma
  função SQL com validação e autorização no servidor.
- **Preço, disponibilidade e quantidade são decididos no banco.** O cliente
  escolhe produto e quantidade; valores nunca vêm do navegador.
- **Um produto por pedido**, com uma ou várias unidades (regra da V1).
- **Reserva e PIX de 30 minutos**, sempre revalidados em cada nova tentativa.
- **Credenciais de estoque cifradas (AES-256-GCM)**; a chave existe apenas nas
  Edge Functions. O banco guarda apenas texto cifrado e um fingerprint HMAC.
- **Link de entrega com token de alta entropia**, guardado como hash (SHA-256);
  o token em claro só é recuperado pela Edge Function para exibição ao comprador.
- **Dois administradores com permissões iguais**, allowlist no banco e MFA TOTP
  obrigatório; toda ação administrativa é auditada.

## Estado atual (outubro/2026)

- Modelo de dados completo, 16 migrações versionadas e reaplicáveis do zero.
- 6 Edge Functions implementadas (código + testes), prontas para deploy.
- 70 testes de banco/back-end e 57 testes de frontend passando (127 no total),
  além de `tsc -b` e `vite build` verdes.
- Frontend integrado: catálogo real, checkout de produto único, página de PIX,
  entrega privada e painel administrativo.
- **Pendências externas**: credenciais sandbox do Mercado Pago, deploy das Edge
  Functions e criação dos dois usuários administradores (ver
  [`limitacoes-e-pendencias.md`](./limitacoes-e-pendencias.md)).
