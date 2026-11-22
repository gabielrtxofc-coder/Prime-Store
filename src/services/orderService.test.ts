import { describe, expect, it } from 'vitest';
import { isPaid } from './orderService';

describe('isPaid — liberação da entrega privada', () => {
  it('só considera pago o pedido ativo com aprovação confirmada', () => {
    expect(isPaid('paid', 'approved')).toBe(true);
  });

  it('não libera credenciais durante um reembolso pendente', () => {
    expect(isPaid('refund_pending', 'approved')).toBe(false);
  });

  it('não libera credenciais depois de um reembolso ou em estados incertos', () => {
    expect(isPaid('refunded', 'refunded')).toBe(false);
    expect(isPaid('pending_payment', 'pending')).toBe(false);
    expect(isPaid('paid', 'amount_mismatch')).toBe(false);
  });
});
