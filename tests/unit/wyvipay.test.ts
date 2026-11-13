import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createCharge,
  cancelCharge,
  createRefund,
  getCharge,
  mapChargeSituacao,
  verifyWebhookSignature,
  WEBHOOK_MAX_AGE_SECONDS,
  WyviPayError,
} from '../../supabase/functions/_shared/wyvipay';
import { createFakeWyvi, signWyviEvent } from './fakeWyvi';

/**
 * Cliente WyviPay (API v2) — contrato HTTP exercitado sem rede real.
 *
 * Cobre: criação de cobrança em centavos, idempotência por pedido (repetição
 * não duplica cobrança), conflito de chave, recusa de valores incorretos,
 * falha de comunicação, consulta, cancelamento, reembolso e a VALIDAÇÃO DA
 * ASSINATURA de webhook (formato `{carimbo}.{corpo}`, janela ±300 s).
 */

const API_KEY = 'wy_test_unidade-de-teste-sem-valor-real';
const BASE = 'https://api.wyvipay.test';

function config(fetchImpl: typeof fetch) {
  return { apiKey: API_KEY, baseUrl: BASE, fetchImpl };
}

function validInput(overrides: Partial<Parameters<typeof createCharge>[1]> = {}) {
  return {
    amountCents: 4990,
    description: 'Prime Store PS-TEST01',
    reference: '0f0e0d0c-0000-4000-8000-000000000001',
    expirationSeconds: 1800,
    idempotencyKey: 'order-0f0e0d0c-0000-4000-8000-000000000001',
    ...overrides,
  };
}

describe('createCharge — cobrança PIX em centavos', () => {
  it('envia POST /api/v2/cobrancas com valor inteiro, Idempotency-Key e Bearer', async () => {
    const fake = createFakeWyvi();
    const charge = await createCharge(config(fake.fetchImpl), validInput());

    expect(charge.situacao).toBe('pendente');
    expect(charge.valorCentavos).toBe(4990);
    expect(charge.copiaECola).toContain('FAKEWYVI');
    expect(charge.replayed).toBe(false);

    const call = fake.createCalls[0];
    expect(call.url).toBe('https://api.wyvipay.test/api/v2/cobrancas');
    expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(call.headers['idempotency-key']).toBe('order-0f0e0d0c-0000-4000-8000-000000000001');
    expect(call.body).toMatchObject({
      valor_centavos: 4990,
      meio: 'pix',
      referencia: '0f0e0d0c-0000-4000-8000-000000000001',
      expira_em_segundos: 1800,
    });
    // Nunca decimal, nunca string: dinheiro é inteiro em centavos.
    expect(Number.isInteger((call.body as { valor_centavos: number }).valor_centavos)).toBe(true);
  });

  it('repetição com a MESMA chave devolve a MESMA cobrança (sem duplicar)', async () => {
    const fake = createFakeWyvi();
    const input = validInput();

    const first = await createCharge(config(fake.fetchImpl), input);
    const second = await createCharge(config(fake.fetchImpl), input);

    expect(second.txid).toBe(first.txid);
    expect(second.replayed).toBe(true);
    expect(fake.chargeCount).toBe(1);
    // A prova documental da repetição: status 200 + Idempotent-Replayed.
    expect(fake.createCalls).toHaveLength(2);
  });

  it('mesma chave com valor diferente → 409 idempotencia_conflitante', async () => {
    const fake = createFakeWyvi();
    await createCharge(config(fake.fetchImpl), validInput());

    await expect(
      createCharge(config(fake.fetchImpl), validInput({ amountCents: 9999 })),
    ).rejects.toMatchObject({ httpStatus: 409, providerCode: 'idempotencia_conflitante' });
    expect(fake.chargeCount).toBe(1);
  });

  it('valor incorreto (não inteiro / zero) é recusado ANTES de qualquer chamada', async () => {
    const fake = createFakeWyvi();

    await expect(
      createCharge(config(fake.fetchImpl), validInput({ amountCents: 49.9 })),
    ).rejects.toMatchObject({ httpStatus: 422, providerCode: 'campo_invalido' });
    await expect(
      createCharge(config(fake.fetchImpl), validInput({ amountCents: 0 })),
    ).rejects.toMatchObject({ httpStatus: 422 });

    expect(fake.calls).toHaveLength(0);
  });

  it('Idempotency-Key fora do formato é recusada antes da rede', async () => {
    const fake = createFakeWyvi();
    await expect(
      createCharge(config(fake.fetchImpl), validInput({ idempotencyKey: 'curta' })),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(fake.calls).toHaveLength(0);
  });

  it('falha de comunicação vira WyviPayError estável (sem vazar segredo)', async () => {
    const fake = createFakeWyvi({ failCreate: true });
    const error = await createCharge(config(fake.fetchImpl), validInput()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WyviPayError);
    expect((error as WyviPayError).httpStatus).toBe(503);
    expect((error as WyviPayError).providerCode).toBe('indisponivel');
    expect(String(error)).not.toContain(API_KEY);
  });

  it('queda total de rede (fetch lança) também vira erro estável', async () => {
    const exploding = (async () => {
      throw new TypeError('connect ECONNREFUSED 127.0.0.1:443');
    }) as unknown as typeof fetch;

    const error = await createCharge(config(exploding), validInput()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WyviPayError);
    expect((error as WyviPayError).httpStatus).toBe(503);
    expect((error as WyviPayError).providerCode).toBe('indisponivel');
  });

});

describe('getCharge / cancelCharge / createRefund', () => {
  it('consulta devolve a situação sem a imagem do QR (só copia-e-cola)', async () => {
    const fake = createFakeWyvi();
    const created = await createCharge(config(fake.fetchImpl), validInput());
    const found = await getCharge(config(fake.fetchImpl), created.txid);

    expect(found.situacao).toBe('pendente');
    expect(found.copiaECola).toContain('FAKEWYVI');
    expect(found.qrcodeDataUri).toBeNull();
  });

  it('consulta de txid inexistente → 404 nao_encontrada', async () => {
    const fake = createFakeWyvi();
    await expect(getCharge(config(fake.fetchImpl), 'a'.repeat(32))).rejects.toMatchObject({
      httpStatus: 404,
      providerCode: 'nao_encontrada',
    });
  });

  it('txid fora do formato nunca chega à rede', async () => {
    const fake = createFakeWyvi();
    await expect(getCharge(config(fake.fetchImpl), '../etc/passwd')).rejects.toMatchObject({
      httpStatus: 404,
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('cancelar é idempotente; cobrança paga não cancela (409)', async () => {
    const fake = createFakeWyvi();
    const created = await createCharge(config(fake.fetchImpl), validInput());

    const first = await cancelCharge(config(fake.fetchImpl), created.txid);
    expect(first.situacao).toBe('cancelada');
    expect(first.jaEstavaCancelada).toBe(false);

    const second = await cancelCharge(config(fake.fetchImpl), created.txid);
    expect(second.jaEstavaCancelada).toBe(true);

    fake.setSituacao(created.txid, 'concluida');
    await expect(cancelCharge(config(fake.fetchImpl), created.txid)).rejects.toMatchObject({
      httpStatus: 409,
      providerCode: 'nao_cancelavel',
    });
  });

  it('reembolso exige valor inteiro e chave de idempotência', async () => {
    const fake = createFakeWyvi();
    const created = await createCharge(config(fake.fetchImpl), validInput());

    await expect(
      createRefund(config(fake.fetchImpl), {
        txid: created.txid,
        amountCents: 10.5,
        reason: 'teste',
        idempotencyKey: 'devolve-0f0e0d0c-0000-0000',
      }),
    ).rejects.toMatchObject({ httpStatus: 422 });

    await expect(
      createRefund(config(fake.fetchImpl), {
        txid: created.txid,
        amountCents: 4990,
        reason: 'Pedido cancelado',
        idempotencyKey: 'devolve-0f0e0d0c-0000-0000',
      }),
    ).rejects.toMatchObject({ httpStatus: 422, providerCode: 'cobranca_nao_paga' });

    fake.setSituacao(created.txid, 'concluida');
    const refund = await createRefund(config(fake.fetchImpl), {
      txid: created.txid,
      amountCents: 4990,
      reason: 'Pedido cancelado pelo cliente',
      idempotencyKey: 'devolve-0f0e0d0c-0000-0000',
    });
    expect(refund.situacao).toBe('em_processamento');
    expect(refund.valorCentavos).toBe(4990);
  });
});

describe('mapChargeSituacao — estados da v2 para a máquina existente', () => {
  it.each([
    ['pendente', 'pending'],
    ['concluida', 'approved'],
    ['cancelada', 'cancelled'],
    ['falhou', 'cancelled'], // venceu sem pagamento → libera reserva
    ['estornada', 'refunded'],
  ])('%s → %s', (situacao, expected) => {
    expect(mapChargeSituacao(situacao).providerStatus).toBe(expected);
  });

  it('situação desconhecida nunca vira aprovação', () => {
    expect(mapChargeSituacao('qualquer_coisa').providerStatus).toBe('pending');
  });
});

describe('verifyWebhookSignature — HMAC sobre {carimbo}.{corpo}', () => {
  const SECRET = 'whsec_test_nenhum_segredo_real_aqui';
  const now = new Date('2026-11-13T12:00:00.000Z');
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const body = JSON.stringify({
    id: '8f0c2c1e-3a4b-4c9d-9e21-77b0f5a1c3de',
    evento: 'cobranca.paga',
    dados: { txid: 'test4f21a9c07e3b48d5916a2f8c31ab', valor_centavos: 4990 },
  });

  function sign(ts: number, secret = SECRET, rawBody = body): string {
    // Mesmo cálculo do provedor, refeito aqui com node:crypto.
    return `v1=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`;
  }

  async function verify(overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) {
    return verifyWebhookSignature({
      rawBody: body,
      signatureHeader: sign(nowSeconds),
      carimboHeader: String(nowSeconds),
      secret: SECRET,
      now,
      ...overrides,
    });
  }

  it('assinatura válida é aceita', async () => {
    expect(await verify()).toBe(true);
  });

  it('assinatura de outro segredo é recusada', async () => {
    expect(await verify({ signatureHeader: sign(nowSeconds, 'whsec_outro') })).toBe(false);
  });

  it('corpo adulterado é recusado', async () => {
    const tampered = body.replace('4990', '999900');
    expect(await verify({ rawBody: tampered })).toBe(false);
  });

  it('carimbo velho (replay) é recusado — janela de ±300 s', async () => {
    const old = nowSeconds - (WEBHOOK_MAX_AGE_SECONDS + 1);
    expect(await verify({ signatureHeader: sign(old), carimboHeader: String(old) })).toBe(false);
    // Dentro da janela continua valendo.
    const fresh = nowSeconds - WEBHOOK_MAX_AGE_SECONDS + 1;
    expect(await verify({ signatureHeader: sign(fresh), carimboHeader: String(fresh) })).toBe(true);
  });

  it('carimbo no futuro além da tolerância é recusado', async () => {
    const future = nowSeconds + WEBHOOK_MAX_AGE_SECONDS + 1;
    expect(await verify({ signatureHeader: sign(future), carimboHeader: String(future) })).toBe(false);
  });

  it('cabeçalhos ausentes ou malformados são recusados', async () => {
    expect(await verify({ signatureHeader: null })).toBe(false);
    expect(await verify({ signatureHeader: 'v1=abc' })).toBe(false);
    expect(await verify({ signatureHeader: 'ts=1,v1=abc' })).toBe(false);
    expect(await verify({ carimboHeader: null })).toBe(false);
    expect(await verify({ carimboHeader: 'nao-e-numero' })).toBe(false);
  });

  it('assimila o formato exato da entrega real (via helper de teste)', async () => {
    const signed = signWyviEvent({
      secret: SECRET,
      evento: 'cobranca.paga',
      deliveryId: '8f0c2c1e-3a4b-4c9d-9e21-77b0f5a1c3de',
      dados: { txid: 'testabc' },
      ts: nowSeconds,
    });
    const ok = await verifyWebhookSignature({
      rawBody: signed.body,
      signatureHeader: signed.headers['X-Wyvi-Assinatura'],
      carimboHeader: signed.headers['X-Wyvi-Carimbo'],
      secret: SECRET,
      now,
    });
    expect(ok).toBe(true);
  });
});
