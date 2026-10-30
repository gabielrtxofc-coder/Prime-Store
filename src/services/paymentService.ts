import type { PaymentMethod } from '../types';

export interface PaymentRequest {
  orderId: string;
  method: PaymentMethod;
}

export interface PaymentNotConfigured {
  status: 'not-configured';
  message: string;
}

/**
 * Integration boundary for a future payment provider. Intentionally returns a
 * clear not-configured state and performs no network request. The demo checkout
 * does not call this function and must never be presented as paid.
 */
export async function initiatePayment(_request: PaymentRequest): Promise<PaymentNotConfigured> {
  return {
    status: 'not-configured',
    message: 'Pagamentos ainda não estão conectados neste protótipo.',
  };
}
