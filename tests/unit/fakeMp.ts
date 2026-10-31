/**
 * Servidor Mercado Pago simulado no nível de `fetch`.
 * Exercita o cliente HTTP real (URL, headers, corpo) sem depender da rede,
 * que é bloqueada neste ambiente (api.mercadopago.com).
 */

export interface FakePayment {
  id: string;
  status: string;
  status_detail: string;
  transaction_amount: number;
  external_reference: string;
  date_of_expiration: string | null;
  point_of_interaction: {
    transaction_data: { qr_code: string; qr_code_base64: string; ticket_url: string };
  };
}

export interface FakeMpOptions {
  failCreate?: boolean;
  status?: string;
}

export function createFakeMercadoPago(options: FakeMpOptions = {}) {
  const payments = new Map<string, FakePayment>();
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  let sequence = 0;
  let currentStatus = options.status ?? 'pending';

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, headers, body });

    if (url.endsWith('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: 'user-from-fake-auth' }), { status: 200 });
    }

    if (method === 'POST' && url.endsWith('/v1/payments')) {
      if (options.failCreate) {
        return new Response(JSON.stringify({ message: 'service_unavailable' }), { status: 503 });
      }
      sequence += 1;
      const id = String(100000000 + sequence);
      const payment: FakePayment = {
        id,
        status: 'pending',
        status_detail: 'pending_waiting_transfer',
        transaction_amount: body.transaction_amount,
        external_reference: body.external_reference,
        date_of_expiration: body.date_of_expiration ?? null,
        point_of_interaction: {
          transaction_data: {
            qr_code: `00020126FAKEPIX${id}`,
            qr_code_base64: 'iVBORw0KGgoFAKE',
            ticket_url: `https://sandbox.mercadopago.test/payments/${id}/ticket`,
          },
        },
      };
      payments.set(id, payment);
      return new Response(JSON.stringify(payment), { status: 201 });
    }

    if (method === 'GET' && url.includes('/v1/payments/')) {
      const id = url.split('/').pop() as string;
      const payment = payments.get(id);
      if (!payment) {
        return new Response(JSON.stringify({ message: 'payment_not_found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ ...payment, status: currentStatus }), { status: 200 });
    }

    return new Response(JSON.stringify({ message: 'not_found' }), { status: 404 });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    calls,
    payments,
    setStatus(status: string) {
      currentStatus = status;
      for (const payment of payments.values()) payment.status = status;
    },
    get lastPayment(): FakePayment | undefined {
      return Array.from(payments.values()).at(-1);
    },
  };
}
