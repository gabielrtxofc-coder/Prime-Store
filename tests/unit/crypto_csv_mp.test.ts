import { describe, expect, it } from 'vitest';
import {
  credentialFingerprint,
  decryptText,
  deriveKey,
  encryptText,
  fromBase64,
  loadSecretMaterial,
  randomToken,
  safeEqual,
  sha256Hex,
  toBase64,
} from '../../supabase/functions/_shared/crypto';
import { extractStockRows, maskEmail, maskSecret, parseCsv, validateStockRows } from '../../supabase/functions/_shared/csv';
import {
  buildSignatureManifest,
  createPixPayment,
  getPayment,
  MIN_PIX_EXPIRATION_MINUTES,
  parseSignatureHeader,
  sanitizePayment,
  verifyWebhookSignature,
} from '../../supabase/functions/_shared/mercadopago';

const MASTER_KEY_B64 = toBase64(crypto.getRandomValues(new Uint8Array(32)));

describe('criptografia', () => {
  it('cifra e decifra credenciais com AES-256-GCM', async () => {
    const material = await loadSecretMaterial(MASTER_KEY_B64);
    const encrypted = await encryptText(material.encryptionKey, 'senha-super-secreta');
    expect(encrypted.length).toBeGreaterThan(28);

    const decrypted = await decryptText(material.encryptionKey, encrypted);
    expect(decrypted).toBe('senha-super-secreta');
  });

  it('não decifra com chave diferente e rejeita payload adulterado', async () => {
    const material = await loadSecretMaterial(MASTER_KEY_B64);
    const otherKey = await deriveKey(crypto.getRandomValues(new Uint8Array(32)), 'prime-store/credentials/v1');
    const encrypted = await encryptText(material.encryptionKey, 'segredo');

    await expect(decryptText(otherKey, encrypted)).rejects.toBeTruthy();

    const tampered = new Uint8Array(encrypted);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(decryptText(material.encryptionKey, tampered)).rejects.toBeTruthy();
  });

  it('gera ciphertext diferente a cada cifragem (IV aleatório)', async () => {
    const material = await loadSecretMaterial(MASTER_KEY_B64);
    const first = await encryptText(material.encryptionKey, 'mesmo-valor');
    const second = await encryptText(material.encryptionKey, 'mesmo-valor');
    expect(toBase64(first)).not.toBe(toBase64(second));
  });

  it('fingerprint é estável, ignora caixa do e-mail e não revela a senha', async () => {
    const material = await loadSecretMaterial(MASTER_KEY_B64);
    const first = await credentialFingerprint(material, 'Conta@Exemplo.com ', 'senha123');
    const second = await credentialFingerprint(material, 'conta@exemplo.com', 'senha123');
    const other = await credentialFingerprint(material, 'conta@exemplo.com', 'outra');

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain('senha123');
  });

  it('tokens aleatórios têm entropia e formato seguros para URL', () => {
    const first = randomToken();
    const second = randomToken();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(40);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64(toBase64(new Uint8Array([0, 1, 2, 250])))).toEqual(new Uint8Array([0, 1, 2, 250]));
  });

  it('sha256 e comparação em tempo constante funcionam', async () => {
    expect(await sha256Hex('abc')).toHaveLength(64);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });

  it('rejeita chave mestra curta', async () => {
    await expect(loadSecretMaterial(toBase64(new Uint8Array(8)))).rejects.toThrow('invalid_master_key');
  });
});

describe('CSV de importação de estoque', () => {
  it('lê CSV com cabeçalho e vírgulas', () => {
    const parsed = parseCsv('email,senha,observacao\nconta@exemplo.com,senha1,primeira\noutra@exemplo.com,senha2,\n');
    expect(parsed.hasHeader).toBe(true);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0].values).toEqual(['conta@exemplo.com', 'senha1', 'primeira']);
  });

  it('detecta ponto e vírgula e BOM', () => {
    const parsed = parseCsv('\uFEFFemail;senha\nconta@exemplo.com;senha1;');
    expect(parsed.delimiter).toBe(';');
    expect(parsed.records[0].values[1]).toBe('senha1');
  });

  it('suporta campos entre aspas com vírgula e acentos', () => {
    const parsed = parseCsv('email,senha,observacao\n"conta@exemplo.com","se,nha","plano, anual"');
    expect(parsed.hasHeader).toBe(true);
    expect(parsed.records[0].values).toEqual(['conta@exemplo.com', 'se,nha', 'plano, anual']);
  });

  it('valida linhas individualmente e sinaliza motivos', () => {
    const parsed = parseCsv(
      [
        'email,senha',
        'ok1@exemplo.com,senha1',
        'sem-arroba,senha2',
        'ok2@exemplo.com,',
        'ok1@exemplo.com,senha1',
        'ok3@exemplo.com,senha3',
      ].join('\n'),
    );
    const validated = validateStockRows(extractStockRows(parsed));

    expect(validated.valid.map((row) => row.email)).toEqual(['ok1@exemplo.com', 'ok3@exemplo.com']);
    expect(validated.duplicatedInFile).toBe(1);
    expect(validated.rejected).toEqual([
      { rowNumber: 3, reason: 'email_invalido' },
      { rowNumber: 4, reason: 'senha_ausente' },
      { rowNumber: 5, reason: 'duplicado_no_arquivo' },
    ]);
  });

  it('detecta credenciais já existentes no estoque', () => {
    const parsed = parseCsv('a@b.com,senha1\na@b.com,senha2');
    const validated = validateStockRows(extractStockRows(parsed), new Set(['a@b.com\u0000senha2']));
    expect(validated.valid).toHaveLength(1);
    expect(validated.rejected).toEqual([{ rowNumber: 2, reason: 'duplicado_no_estoque' }]);
  });

  it('mascara credenciais em prévias', () => {
    expect(maskEmail('contato@exemplo.com')).toBe('co*****@exemplo.com');
    expect(maskSecret('senha12345')).toBe('•••••••• (10 caracteres)');
    expect(maskSecret('abc')).toBe('••• (3 caracteres)');
  });
});

describe('cliente Mercado Pago (HTTP simulado local)', () => {
  interface Captured {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown> | null;
  }

  function fakeFetch(response: unknown, status = 201): { fetchImpl: typeof fetch; calls: Captured[] } {
    const calls: Captured[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify(response), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  const providerResponse = {
    id: 123456789,
    status: 'pending',
    status_detail: 'pending_waiting_transfer',
    transaction_amount: 49.9,
    external_reference: 'order-uuid',
    date_of_expiration: '2026-10-31T12:30:00.000Z',
    payer: { email: 'comprador@teste.com', first_name: 'Comprador' },
    point_of_interaction: {
      transaction_data: {
        qr_code: '00020126580014br.gov.bcb.pix',
        qr_code_base64: 'iVBORw0KGgo=',
        ticket_url: 'https://www.mercadopago.com.br/payments/123456789/ticket',
      },
    },
  };

  it('cria cobrança PIX com validade de 30 minutos e idempotência', async () => {
    const { fetchImpl, calls } = fakeFetch(providerResponse);
    const now = new Date('2026-10-31T12:00:00.000Z');

    const snapshot = await createPixPayment(
      { accessToken: 'TEST-token', fetchImpl },
      {
        amountCents: 4990,
        description: 'Produto de teste',
        externalReference: 'order-uuid',
        payerEmail: 'comprador@teste.com',
        payerFirstName: 'Comprador',
        notificationUrl: 'https://example.supabase.co/functions/v1/mp-webhook',
        expirationMinutes: 5,
        idempotencyKey: 'idem-123',
        now,
      },
    );

    expect(calls[0].url).toBe('https://api.mercadopago.com/v1/payments');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['X-Idempotency-Key']).toBe('idem-123');
    expect(calls[0].headers.Authorization).toBe('Bearer TEST-token');

    const body = calls[0].body as Record<string, unknown>;
    expect(body.payment_method_id).toBe('pix');
    expect(body.transaction_amount).toBe(49.9);
    expect(body.external_reference).toBe('order-uuid');
    expect((body.payer as Record<string, unknown>).email).toBe('comprador@teste.com');

    // A validade nunca fica abaixo do mínimo aceito (30 min).
    expect(body.date_of_expiration).toBe(
      new Date(now.getTime() + MIN_PIX_EXPIRATION_MINUTES * 60_000).toISOString(),
    );

    expect(snapshot.providerPaymentId).toBe('123456789');
    expect(snapshot.qrCode).toBe('00020126580014br.gov.bcb.pix');
    expect(snapshot.qrCodeBase64).toBe('iVBORw0KGgo=');
    expect(snapshot.amountCents).toBe(4990);
  });

  it('normaliza o pagamento sem reter dados pessoais', () => {
    const snapshot = sanitizePayment(providerResponse);
    expect(JSON.stringify(snapshot)).not.toContain('comprador@teste.com');
    expect(Object.keys(snapshot)).not.toContain('payer');
  });

  it('consulta pagamento por id', async () => {
    const { fetchImpl, calls } = fakeFetch({ ...providerResponse, status: 'approved' }, 200);
    const snapshot = await getPayment({ accessToken: 'TEST-token', fetchImpl }, '123456789');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('https://api.mercadopago.com/v1/payments/123456789');
    expect(snapshot.status).toBe('approved');
  });

  it('propaga erro do provedor sem expor corpo completo', async () => {
    const { fetchImpl } = fakeFetch({ message: 'invalid access token' }, 401);
    await expect(
      createPixPayment(
        { accessToken: 'bad', fetchImpl },
        {
          amountCents: 1000,
          description: 'x',
          externalReference: 'o',
          payerEmail: 'a@b.com',
          expirationMinutes: 30,
          idempotencyKey: 'k',
        },
      ),
    ).rejects.toMatchObject({ httpStatus: 401, providerMessage: 'invalid access token' });
  });

  it('trata indisponibilidade/timeout como erro 503', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    await expect(
      getPayment({ accessToken: 'token', fetchImpl }, '1'),
    ).rejects.toMatchObject({ httpStatus: 503 });
  });

  it('valida a assinatura do webhook conforme o manifesto oficial', async () => {
    const secret = 'webhook-secret';
    const dataId = '123456789';
    const requestId = 'req-abc';
    const ts = '1704908010';
    const manifest = buildSignatureManifest({ dataId, requestId, ts });
    expect(manifest).toBe('id:123456789;request-id:req-abc;ts:1704908010;');

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest)),
    );
    const v1 = Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');

    await expect(
      verifyWebhookSignature({
        signatureHeader: `ts=${ts},v1=${v1}`,
        requestId,
        dataId,
        secret,
      }),
    ).resolves.toBe(true);

    await expect(
      verifyWebhookSignature({
        signatureHeader: `ts=${ts},v1=${'0'.repeat(64)}`,
        requestId,
        dataId,
        secret,
      }),
    ).resolves.toBe(false);

    await expect(
      verifyWebhookSignature({ signatureHeader: null, requestId, dataId, secret }),
    ).resolves.toBe(false);

    expect(parseSignatureHeader('ts=1,v1=abc')).toEqual({ ts: '1', v1: 'abc' });
  });
});
