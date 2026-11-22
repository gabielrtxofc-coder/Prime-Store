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
- [ ] **P5 — Decidir o destino de `bootstrap_admin_register` /
      `bootstrap_admin_status`.** As duas existem em **produção** e em
      **nenhuma migração** (deriva de schema). São `SECURITY DEFINER`
      executáveis só por `postgres`/`service_role`, limitadas a 2 admins e
      fechadas por padrão (`admin_bootstrap_enabled` ausente = `false`), então
      **não** são caminho de escalada para usuário final. Escolha uma:
      (a) versionar o DDL das duas numa migração nova, revisado por você;
      (b) remover as duas de produção e provisionar por `scripts/provision-admin.sql`;
      (c) manter como estão, aceitando que recriar o banco pelas migrações não
      as reproduz. Detalhes em `RELATORIO.md` §7-ter.
- [ ] **P6 — Aplicar a migração `0046`.** Ela está versionada e provada
      localmente (475/475) mas **não** foi aplicada em produção, porque esta
      missão é somente leitura. Ela revoga `EXECUTE` da órfã
      `admin_stock_summary()` e fecha `net.http_*` para
      `PUBLIC`/`anon`/`authenticated`. Só vale depois de `supabase db push`.
      Ver `ADVISORS.md` §Grupo 2 e §Limitações.

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
