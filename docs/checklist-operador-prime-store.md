# Checklist do operador — Prime Store

> **Para quem:** o operador humano (dono do projeto Supabase
> `eorlmqolbknrplvdbbtl`). **O que não está aqui:** tarefas técnicas já
> concluídas e verificadas pelas missões 02–13 (migrações, funções, testes,
> smoke, auditoria, docs) — essas estão nos relatórios; e **backup/PITR,
> que é DISPENSADO por sua decisão** (não é item, não é afirmação, não
> exige ação).
>
> Nada desta lista foi executado por você: cada item exige dado, escolha ou
> credencial humana.

## A. Acesso administrativo

- [ ] Definir as pessoas que terão acesso ao painel (nome + e-mail real).
- [ ] Criar os usuários em Authentication → Users (guia:
      `docs/provisionamento-admin.md`, passo 2).
- [ ] Registrar em `admin_users` com os UUIDs reais (passo 3 do guia).
- [ ] Cada pessoa cadastra o próprio TOTP no primeiro acesso (passo 4).
- [ ] Guardar as senhas em gerenciador de senhas (nunca em repositório).

## B. Domínio e origens

- [ ] Escolher o domínio final da loja.
- [ ] Atualizar `STORE_URL` e `ALLOWED_ORIGINS` (secrets do projeto) para o
      domínio final; conferir que o CORS da loja passa a aceitar só essas
      origens.
- [ ] Apontar o frontend publicado para esse domínio (deploy é decisão
      sua; o build está verde).

## C. Pagamentos (decisão sua — nada foi ativado)

- [ ] Decidir: manter **solicitação sem pagamento** (estado atual, loja
      funcional nesse modo) **ou** integrar um provedor.
- [ ] Se integrar a WyviPay: seguir `docs/wyvipay-integracao.md`
      (dependências D1–D11, etapas 0–11; nenhum código foi implementado —
      é um projeto novo, não uma ativação).
- [ ] Se integrar Mercado Pago: fornecer `MP_ACCESS_TOKEN` e
      `MP_WEBHOOK_SECRET` como secrets e seguir `docs/mercado-pago.md`.
- [ ] Enquanto não decidir: **não** criar credenciais de pagamento.

## D. Conformidade

- [ ] Revisão jurídica de termos de uso, política de privacidade, taxas e
      reembolsos (WyviPay D11) antes de qualquer publicação.

## E. Verificação final a partir da sua máquina

- [ ] `npm ci && npm test && npm run test:all` (ou confiar nos registros
      verdes das missões — 136/136 e 308/308 na M13).
- [ ] `npm run smoke:functions` com `SUPABASE_URL` e `SUPABASE_ANON_KEY`
      definidos (o script só faz requisições inválidas/read-only; saída
      esperada: todas as verificações PASS).
- [ ] Conferir a lista em `admin_users` após provisionar (guia, passo 5).

## F. Estado registrado (para referência)

| Item | Estado |
| --- | --- |
| Migrações, funções, config, smoke, auditoria, testes, docs | **CONCLUÍDO** pelas missões 02–13 (ver relatórios) |
| Backup / PITR | **DISPENSADO** por decisão do operador |
| Admins, TOTP, domínio, pagamentos, jurídico | **PENDENTE DO OPERADOR** (esta lista) |
| Loja pronta para lançamento | **NÃO DECLARADA** — só após os itens acima |

_Data deste checklist: 2026-11-10 (Missão 13)._
