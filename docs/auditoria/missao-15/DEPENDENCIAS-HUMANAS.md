# Missão 15 — Dependências humanas

> Só o que **exige uma pessoa**: credencial, decisão de produto ou conferência
> em ambiente que este sandbox não tem. Nada aqui foi executado. Nenhum segredo
> deve ser colado em conversa, relatório ou arquivo versionado.

## Bloqueiam o lançamento

- [ ] **P1 — Administradores reais + TOTP.** `admin_users` está vazio e o signup
      público foi **desligado** nesta missão. Crie cada usuário pelo painel do
      Supabase Auth (o convite usa a SMTP configurada) e insira o UUID em
      `admin_users` com `scripts/provision-admin.sql`. Sem isso o painel não abre
      para ninguém — o que é o estado seguro, mas não é operável.
- [ ] **P2 — E-mail de autenticação.** Não há SMTP configurado no projeto.
      Recuperação de senha e convite de administrador não saem. Configure SMTP
      (Supabase → Authentication → SMTP) antes de criar os admins de P1.
- [ ] **P3 — Chave de pagamento.** `WYVI_API_KEY` existe como secret; falta
      confirmar que é a chave **definitiva** do responsável (`wy_live_…`) e que o
      destino de webhook aponta para
      `https://audsosvbdybifvxsmqpi.supabase.co/functions/v1/wyvi-webhook`.
      Roteiro em `docs/wyvipay.md` §7 (checklist D1–D11).
- [ ] **P4 — Política de senha.** Produção está em `password_min_length = 6`,
      sem CAPTCHA e sem verificação HIBP. A API do conector não expõe esses
      campos. Recomendado: mínimo 12, HIBP ligado, CAPTCHA só se houver sinal de
      abuso. Não alterei por não ter caminho suportado — não inventei valor.
- [ ] **P5 — RESOLVIDA no repositório; falta só aplicar.** As duas funções de
      bootstrap existiam em produção e em nenhuma migração. A origem foi
      investigada: são **bootstrap de operação manual** (os dados em produção
      têm timestamp único de 2026-11-20 14:44:33 UTC; o repositório disponível
      só começa em 2026-11-21, então não há como provar autoria pelo git; o
      `scripts/provision-admin.sql` documenta o fluxo manual no SQL Editor).
      A **migração 0047** recria as duas a partir do catálogo de produção, com
      `EXECUTE` só para `service_role` e a janela **fechada por padrão**.
      11 testes travam o comportamento. O que resta é aplicar a 0047 em
      produção (junto com a P6). Detalhes em `RELATORIO.md` §7-ter.
- [ ] **P6 — Aplicar as migrações `0046` e `0047`.** Versionadas e provadas
      localmente (**496/496**), mas **não** aplicadas em produção: esta missão é
      somente leitura. A 0046 revoga `EXECUTE` da órfã `admin_stock_summary()`;
      a 0047 versiona o bootstrap. Ver `ADVISORS.md` §Grupo 2.
- [ ] **P7 — Fechar `net.http_*` exige `supabase_admin`.** Descoberto e
      **comprovado** na 15.2: as funções de `pg_net` e o schema `net` pertencem
      a `supabase_admin`, e o `postgres` **não é superusuário** (`rolsuper =
      false`) nem membro desse papel. Nessa condição, `REVOKE ... FROM PUBLIC`
      **não levanta exceção e não altera a ACL** (no-op silencioso, reproduzido
      no cenário B de `tests/db/29_pg_net_permissoes.test.ts`).
      Consequência: **aplicar a 0046 não fecha `net.*` em produção.** Para
      fechar, alguém com `supabase_admin` precisa executar:
      ```sql
      revoke execute on function net.http_post(text,jsonb,jsonb,jsonb,integer)
        from public, anon, authenticated;
      revoke execute on function net.http_get(text,jsonb,jsonb,integer)
        from public, anon, authenticated;
      revoke execute on function net.http_delete(text,jsonb,jsonb,integer,jsonb)
        from public, anon, authenticated;
      revoke usage on schema net from public, anon, authenticated;
      -- ATENÇÃO: sem isto o cron do worker perde a capacidade de enfileirar,
      -- porque o `postgres` só executa via PUBLIC.
      grant execute on function net.http_post(text,jsonb,jsonb,jsonb,integer)
        to postgres;
      ```
      O risco hoje é **residual**, não ativo: `db-schemas = public`, então o
      PostgREST não expõe `net`. Ver `ADVISORS.md` §Grupo 2.

## Conferências de uma vez só (primeiro deploy com as mudanças)

- [ ] **D1 — CORS em produção.** Já validado por chamada real (`pg_net`) com e
      sem a origem correta. Se o domínio mudar, `STORE_URL` e `ALLOWED_ORIGINS`
      mudam junto — os dois, não um.
- [ ] **D2 — `wyvi-worker`.** A URL do worker é derivada do JWT no Vault; ela
      usa `SUPABASE_URL` do runtime e não depende de `STORE_URL`. Confirme no
      painel que o job `wyvi-worker` continua com sucesso após o deploy (o cron
      roda a cada minuto).
- [ ] **D3 — CSP no console do navegador.** A política nova é estrita
      (`script-src 'self'`). Abra catálogo, produto, checkout, entrega e painel
      com o DevTools aberto e confirme **zero** violações de CSP. Se aparecer
      alguma, ela diz exatamente qual diretiva afrouxar — não desligue a CSP
      inteira.
- [ ] **D4 — `mp-webhook` continua fora.** Não está implantada, e é coerente: a
      loja usa WyviPay. Se o Mercado Pago legado voltar, além de
      `MERCADO_PAGO_LEGACY_ENABLED=true` a função precisa ser implantada **e**
      `MP_WEBHOOK_SECRET` configurado — sem o segredo ela responde 503.
- [ ] **D5 — Preview da Vercel.** O preview aponta para o projeto QA isolado
      (`sxsjfhtjtubuslmkeiiu`). Se ele precisar chamar a **produção**, a origem
      do preview entra em `ALLOWED_ORIGINS` de produção. Não fiz isso: preview
      não deve falar com dados reais por padrão.

## Decisões de produto (não são falhas)

- [ ] **N1 — Link de entrega sem expiração.** Decisão da V1: permanente até ser
      revogado. Está documentado em `docs/seguranca.md`. Se quiser prazo, é
      mudança de produto, com migração e aviso na página.
- [ ] **N2 — Imagem de produto por URL externa.** `AdminProducts` aceita
      `https://…` e a CSP libera `img-src https:` por causa disso. Se quiser
      fechar, o caminho é upload para o Storage e `img-src 'self'` — decisão de
      produto, não de segurança isolada.
