# Missão 08 (b) — Checklist para as dependências humanas

> Companheiro do [`RELATORIO.md`](./RELATORIO.md). Só o que **exige uma pessoa**:
> credencial, decisão comercial ou confirmação do fornecedor. Nada aqui foi
> executado. Nenhum segredo deve ser colado em conversa, relatório ou arquivo
> versionado.

## 1. Bloqueios imediatos (antes de qualquer código novo)

- [ ] **D5 — Decisões de produto.** Quatro respostas por escrito:
  - [ ] V1 aceita **só PIX**? (o `CHECK (method = 'pix')` fica ou sai)
  - [ ] Rota de processamento: **`white`** (1% sem fixa, mínimo R$ 0,02) ou **`black`** (R$ 0,50 + 6%, exige `pagador.cpf`)?
  - [ ] Reembolso devolve **valor bruto** (`total_cents`) ou **líquido** (padrão da WyviPay, desconta a taxa)?
  - [ ] Rotação de chave pelo **Caminho A** (assistida, uma chave) ou **Caminho B** (duas chaves de escopo mínimo)?
- [ ] **D1 — Chave `wy_test_`.** Obter em *Painel WyviPay → Desenvolvedor → Chaves de API* e gravar **direto** como secret da Edge Function. Não enviar por chat.
- [ ] **D6 — Responsável nomeado** pela rotação semanal (toda segunda-feira), com alarme de calendário.

## 2. Confirmações junto ao fornecedor (D3)

Contato publicado: `contato@wyvipay.com.br` · WhatsApp `(84) 9707-1022`.

- [ ] A chave `wy_test_` **emite** cobrança de teste (`201`) ou **recusa** com `501 ambiente_indisponivel`?
      *A documentação se contradiz: `/api-reference` (Ambientes) diz `501`; `/guides/ambiente-de-teste`
      e a tabela de erros de `POST /cobrancas` dizem que "não é mais devolvido".*
- [ ] Existe provisionamento de chave por API (para automatizar a rotação semanal)?
      *A doc afirma que a chave é guardada apenas como hash e não pode ser relida, e que
      `chave.rotacionada` entrega **somente o prefixo**.*
- [ ] Qual o comportamento esperado de `Idempotency-Key` depois de 24 h/7 dias? Há expiração?
- [ ] Limite de `200 req/min` é **por chave** — duas chaves contam orçamentos separados?

## 3. Provisionamento (D2, D4, D8, D10)

- [ ] **D2** Conta WyviPay ativa e com **plano de taxas vigente** (sem plano, toda cobrança é `409 sem_plano`).
- [ ] **D4** Cadastrar o destino de webhook (`POST /api/v1/webhooks`) apontando para
      `https://<REF>.supabase.co/functions/v1/wyvi-webhook`, eventos mínimos:
      `cobranca.paga`, `cobranca.expirada`, `cobranca.cancelada`, `cobranca.estornada`,
      `reembolso.solicitado`, `reembolso.falhou`, `med.encerrado`, `chave.rotacionada`.
      **Guardar o `whsec_` na primeira e única exibição.**
- [ ] **D8** Credencial de deploy das Edge Functions (`supabase` CLI ou token) — herdado da missão 07.
- [ ] **D10** Decidir o destino do histórico de migrações (27 registros × 36 arquivos) antes de aplicar `0034`+.

## 4. Ambiente de desenvolvimento (D7, D9)

- [ ] **D7** Servidor PostgreSQL local para `npm run test:db` (ausente neste container).
- [ ] **D9** Saída de rede do shell/CI para `*.supabase.co` e `api.wyvipay.com.br`
      (hoje bloqueada aqui; contornada chamando a API **de dentro** do projeto Supabase via `verif.http_*`).

## 5. Antes de publicar (D11 e afins)

- [ ] **D11** Revisão jurídica de termos, política de reembolso e repasse de taxas com o novo provedor.
- [ ] Desligar o modo demonstrativo (`app_settings.demo_payments_enabled = false`, remover
      `DEMO_PAYMENT_ENABLED`) — hoje está **ligado** no sandbox.
- [ ] Confirmar que `WYVI_ENVIRONMENT=production` no projeto de produção (é o que recusa
      eventos com `teste: true`).
- [ ] Meta de sucesso, medida depois do piloto: nenhum pedido `paid` sem `delivery_status='ready'`
      e nenhum `refund_pending` com mais de 48 h sem decisão.
