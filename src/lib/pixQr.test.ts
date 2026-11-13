import { describe, expect, it } from 'vitest';
import { qrDataUrlFromPixCode, qrImageSource } from './pixQr';

/**
 * Imagem do QR PIX nos três formatos que o backend pode devolver:
 *   - data URI completo (WyviPay — criação);
 *   - só o base64 (Mercado Pago — formato antigo);
 *   - apenas o copia-e-cola (WyviPay — consulta/ambiente de teste).
 */

const PIX_CODE =
  '00020126580014BR.GOV.BCB.PIX0136123e4567-e12b-12d1-a456-426655440000520400005303986540510.005802BR5913Fulano de Tal6008BRASILIA62070503***63041D3A';

describe('qrImageSource', () => {
  it('usa o data URI do provedor como está', () => {
    const source = qrImageSource({ qr_code_base64: 'data:image/png;base64,AAAA', qr_code: 'x' });
    expect(source).toBe('data:image/png;base64,AAAA');
  });

  it('prefixa base64 puro com data URI', () => {
    const source = qrImageSource({ qr_code_base64: 'iVBORw0KGgo=', qr_code: null });
    expect(source).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('desenha o QR a partir do copia-e-cola quando não há imagem', () => {
    const source = qrImageSource({ qr_code_base64: null, qr_code: PIX_CODE });
    expect(source).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    // O SVG decodificado contém a matriz do QR (módulos escuros).
    const svg = decodeURIComponent((source as string).split(',')[1] ?? '');
    expect(svg).toContain('<svg');
    expect(svg).toContain('rect');
  });

  it('devolve null sem nenhum dado utilizável', () => {
    expect(qrImageSource(null)).toBeNull();
    expect(qrImageSource({ qr_code_base64: null, qr_code: null })).toBeNull();
    expect(qrImageSource({})).toBeNull();
  });

  it('não derruba a tela com BR Code inválido', () => {
    expect(qrImageSource({ qr_code_base64: null, qr_code: 'lixo' })).toBeNull();
    expect(qrDataUrlFromPixCode('')).toBeNull();
  });
});
