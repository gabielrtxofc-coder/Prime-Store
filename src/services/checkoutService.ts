import { BackendError } from './backend/http';
import { createOrder, type CreateOrderResult } from './orderService';
import { createPurchaseRequest, type PurchaseRequestResult } from './requestService';

/**
 * Submissão do checkout final.
 *
 * Estratégia (decisão registrada em `docs/wyvipay.md`):
 *   1. Tenta o fluxo de COBRANÇA (`create-order`): pedido multi-item com
 *      reserva + cobrança PIX na WyviPay. Com chave configurada, é o caminho
 *      real de pagamento.
 *   2. Se o servidor responder `503 payment_not_configured` (nenhuma chave —
 *      e o flag `fallback_to_request` não foi honrado, ex.: sandbox de
 *      demonstração), cai para a solicitação SEM pagamento (`order-request`),
 *      preservando o comportamento atual da loja.
 *   3. Qualquer outro erro é repassado à tela (estoque, conflito de
 *      idempotência, rede): nada é mascarado.
 *
 * A cobrança NUNCA é contornada: o fallback só existe quando não há
 * provedor configurado, e o servidor decide isso do lado dele também.
 */

export interface CheckoutItemInput {
  productId: string;
  quantity: number;
}

export interface SubmitCheckoutInput {
  items: CheckoutItemInput[];
  buyerName: string;
  buyerEmail: string;
  /** Identidade da tentativa: reenvios idênticos não duplicam pedido nem cobrança. */
  idempotencyKey: string;
  clientToken: string;
}

export type CheckoutOutcome =
  | { kind: 'payment'; result: CreateOrderResult }
  | { kind: 'request'; result: PurchaseRequestResult };

function toPurchaseOutcome(result: CreateOrderResult): CheckoutOutcome {
  return {
    kind: 'request',
    result: {
      order: result.order as unknown as PurchaseRequestResult['order'],
      client_token: result.client_token,
      idempotent_replay: result.idempotent_replay === true,
    },
  };
}

export async function submitCheckout(input: SubmitCheckoutInput): Promise<CheckoutOutcome> {
  try {
    const result = await createOrder({
      items: input.items,
      buyerName: input.buyerName,
      payerEmail: input.buyerEmail,
      idempotencyKey: input.idempotencyKey,
      clientToken: input.clientToken,
      fallbackToRequest: true,
    });

    if (result.payment_mode === 'request') {
      return toPurchaseOutcome(result);
    }
    return { kind: 'payment', result };
  } catch (error) {
    if (error instanceof BackendError && error.code === 'payment_not_configured') {
      // Caminho legado: função antiga sem flag, ou sandbox sem chave.
      const request = await createPurchaseRequest({
        items: input.items,
        buyerName: input.buyerName,
        buyerEmail: input.buyerEmail,
        idempotencyKey: input.idempotencyKey,
        clientToken: input.clientToken,
      });
      return { kind: 'request', result: request };
    }
    throw error;
  }
}
