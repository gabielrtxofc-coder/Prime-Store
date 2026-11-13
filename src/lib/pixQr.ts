/**
 * Imagem do QR Code PIX a partir dos dados da cobrança.
 *
 * Prioridade:
 *   1. `qr_code_base64` — imagem devolvida pela CRIAÇÃO da cobrança.
 *      A WyviPay entrega um data URI completo (`data:image/png;base64,...`);
 *      o Mercado Pago devolve só o corpo base64. Os dois formatos são
 *      aceitos aqui.
 *   2. `qr_code` (PIX copia-e-cola) — em ambiente de teste a WyviPay devolve
 *      `qrcode: null`, então o QR é DESENHADO a partir do BR Code com
 *      `qrcode-generator` (mesma estrutura/CRC que um leitor de QR espera).
 *
 * Sem dados utilizáveis, devolve `null` e a tela mostra o copia-e-cola.
 */
import qrcode from 'qrcode-generator';

export interface PixQrSource {
  qr_code_base64?: string | null;
  qr_code?: string | null;
}

/**
 * BR Code com estrutura inválida nunca derruba a tela: devolve null.
 *
 * O SVG é gerado como STRING pura (sem canvas): funciona em navegador, em
 * jsdom nos testes e em qualquer leitor de QR — o conteúdo do código é o
 * mesmo que o PNG do provedor teria.
 */
export function qrDataUrlFromPixCode(code: string): string | null {
  if (!code || code.length < 12) return null;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(code);
    qr.make();
    const svg = qr.createSvgTag(4, 8);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } catch {
    return null;
  }
}

export function qrImageSource(payment: PixQrSource | null | undefined): string | null {
  if (!payment) return null;
  const { qr_code_base64: base64, qr_code: copiaECola } = payment;
  if (base64) {
    if (base64.startsWith('data:')) return base64;
    return `data:image/png;base64,${base64}`;
  }
  if (copiaECola) return qrDataUrlFromPixCode(copiaECola);
  return null;
}
