import {
  decryptText,
  encryptText,
  fromBase64,
  loadSecretMaterial,
  randomToken,
  sha256Hex,
} from '../crypto.ts';
import type { Deps } from '../deps.ts';
import { errorResponse, json, methodGuard, preflight, readJson } from '../http.ts';
import { enforceRateLimit } from '../rateLimit.ts';
import { getPayment } from '../mercadopago.ts';
import { classifyWyviFailure, getCharge, mapChargeSituacao, WyviPayError } from '../wyvipay.ts';
import { processWyviQueueForOrder, recoverWyviCharge } from '../wyviEvents.ts';
import { requireOrderReference, requirePrivateToken, requireUuid } from '../validation.ts';

interface OrderStatusBody {
  order_id?: unknown;
  /** Alternativa ao id: número público do pedido (`PS-XXXXXX`). */
  reference?: unknown;
  client_token?: unknown;
}

export interface OrderStatusPayload {
  order_id: string;
  reference: string;
  status: string;
  payment_status: string;
  delivery_status: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  created_at: string;
  paid_at: string | null;
  reservation_expires_at: string;
  product: {
    id: string;
    slug: string;
    name: string;
    instructions: string;
    access_validity_label: string;
  };
  payment: {
    status: string;
    /** Provedor da cobrança: `wyvipay`, `mercado_pago`, `demo` ou `internal`. */
    provider?: string | null;
    provider_payment_id?: string | null;
    status_detail?: string | null;
    amount_cents?: number;
    qr_code: string | null;
    qr_code_base64: string | null;
    ticket_url: string | null;
    expires_at: string | null;
  } | null;
  delivery: { id: string; status: string; link_ready?: boolean; created_at: string } | null;
  availability: { available_units: number };
}

async function newDeliveryToken(deps: Deps): Promise<{ hash: string; enc: string } | null> {
  const masterKey = await deps.resolveEncryptionKey();
  if (!masterKey) return null;
  const material = await loadSecretMaterial(masterKey);
  const token = randomToken(32);
  const encrypted = await encryptText(material.encryptionKey, token);
  let binary = '';
  for (const byte of encrypted) binary += String.fromCharCode(byte);
  return { hash: await sha256Hex(token), enc: btoa(binary) };
}

/**
 * POST /order-status
 * Consulta o pedido pelo token privado e, se necessário, reconcilia o
 * pagamento diretamente com o Mercado Pago (fonte de verdade).
 */
export async function handleOrderStatus(request: Request, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();

  try {
    methodGuard(request, ['POST']);

    // Defesa em profundidade (missão 07): limite por origem e rota, antes de
    // qualquer trabalho. Containers persistentes: ver `_shared/rateLimit.ts`.
    const limited = await enforceRateLimit(request, deps, 'order-status');
    if (limited) return limited;

    const body = await readJson<OrderStatusBody>(request);
    const clientToken = requirePrivateToken(body.client_token, 'client_token');
    const clientTokenHash = await sha256Hex(clientToken);

    // Duas formas de identificar o pedido: o id (link privado) ou o número
    // público + código de acompanhamento. Nos dois casos a prova de posse é o
    // token privado, e o erro é o mesmo quando algo não confere.
    let orderId: string;
    let status: OrderStatusPayload;
    if (body.order_id === undefined && body.reference !== undefined) {
      const reference = requireOrderReference(body.reference);
      status = await deps.rpc<OrderStatusPayload>('get_order_status_by_reference', {
        p_reference: reference,
        p_client_token_hash: clientTokenHash,
      });
      orderId = status.order_id;
    } else {
      orderId = requireUuid(body.order_id, 'order_id');
      status = await deps.rpc<OrderStatusPayload>('get_order_status', {
        p_order_id: orderId,
        p_client_token_hash: clientTokenHash,
      });
    }

    const providerPaymentId = status.payment?.provider_payment_id ?? null;
    const paymentProvider = status.payment?.provider ?? null;

    // Solicitação sem pagamento (migração 0033): `requested` / `not_required`
    // não têm cobrança a reconciliar. Não consultamos o provedor nem tentamos
    // confirmar nada — a consulta é somente leitura. O banco reforça a mesma
    // regra em `apply_payment_status` (`ignored_no_payment_required`), portanto
    // o handler não é a única barreira.
    const isPaymentFreeRequest =
      status.status === 'requested' || status.payment_status === 'not_required';

    // ---------------------------------------------------------------------
    // WyviPay (fluxo ativo) — três passos, sempre com a API como FONTE DE
    // VERDADE e throttle GLOBAL por pedido (banco: `provider_api_gates`,
    // vale para qualquer instância da função — o Map em memória foi
    // removido na fase de automação).
    // ---------------------------------------------------------------------
    const wyviConfig = deps.config.wyviApiKey
      ? {
          apiKey: deps.config.wyviApiKey,
          baseUrl: deps.config.wyviApiBase,
          fetchImpl: deps.fetchImpl,
        }
      : null;

    // (1) FILA de eventos do webhook: processa entregas registradas fora da
    //     requisição (o webhook só grava e responde rápido). Pode mudar o
    //     estado do pedido — nesse caso relê antes de continuar.
    if (wyviConfig && !isPaymentFreeRequest) {
      const touched = await processWyviQueueForOrder(deps, wyviConfig, orderId);
      if (touched) {
        status = await deps.rpc<OrderStatusPayload>('get_order_status', {
          p_order_id: orderId,
          p_client_token_hash: clientTokenHash,
        });
      }
    }

    // (2) RECUPERAÇÃO de tentativa INCERTA: linha `wyvipay` aberta SEM txid
    //     = a criação não teve resultado confirmado. Replay com a MESMA
    //     Idempotency-Key recupera a cobrança original (nunca cria outra)
    //     e completa o vínculo. O gate de 15 s evita martelar a API a cada
    //     poll; `Retry-After` de 429/503 é gravado no gate.
    let justRecovered = false;
    if (
      wyviConfig &&
      !isPaymentFreeRequest &&
      status.status === 'pending_payment' &&
      status.payment?.provider === 'wyvipay' &&
      !status.payment.provider_payment_id
    ) {
      const recoveryKey = `wyvi:${orderId}:recovery`;
      const slot = await deps.rpc<boolean>('try_acquire_provider_slot', {
        p_key: recoveryKey,
        p_interval_seconds: 15,
      });
      if (slot) {
        try {
          const recovered = await recoverWyviCharge(deps, wyviConfig, status);
          if (recovered) {
            status = await deps.rpc<OrderStatusPayload>('get_order_status', {
              p_order_id: orderId,
              p_client_token_hash: clientTokenHash,
            });
            justRecovered = true;
          }
        } catch (error) {
          const verdict = classifyWyviFailure(error);
          deps.log('order_status.wyvi_recovery_failed', {
            order_id: orderId,
            http_status: verdict.httpStatus,
            provider_code: verdict.providerCode,
            config_error: verdict.configError,
          });
          if (verdict.retryAfterSeconds !== null) {
            try {
              await deps.rpc('record_provider_rate_limit', {
                p_key: recoveryKey,
                p_retry_after_seconds: verdict.retryAfterSeconds,
              });
            } catch {
              // O próprio claim expira; sem o registro o próximo poll tenta
              // de novo — nunca derrubar a consulta por causa do gate.
            }
          }
        }
      }
    }

    // (3) RECONCILIAÇÃO: a consulta à API cobre webhook atrasado/desligado.
    //     Uma consulta por pedido a cada 15 s, gate global no banco.
    const shouldReconcileWyvi =
      !isPaymentFreeRequest &&
      paymentProvider === 'wyvipay' &&
      Boolean(wyviConfig) &&
      Boolean(providerPaymentId) &&
      status.status === 'pending_payment' &&
      !justRecovered;

    if (shouldReconcileWyvi && providerPaymentId && wyviConfig) {
      const reconcileKey = `wyvi:${orderId}:reconcile`;
      const slot = await deps.rpc<boolean>('try_acquire_provider_slot', {
        p_key: reconcileKey,
        p_interval_seconds: 15,
      });
      if (slot) {
        try {
          const charge = await getCharge(wyviConfig, providerPaymentId, orderId);
          const mapped = mapChargeSituacao(charge.situacao);

          if (
            mapped.providerStatus !== status.payment?.status ||
            mapped.providerStatus === 'approved'
          ) {
            let token: { hash: string; enc: string } | null = null;
            if (mapped.providerStatus === 'approved') token = await newDeliveryToken(deps);

            await deps.rpc('apply_payment_status', {
              p_order_id: orderId,
              p_provider_payment_id: charge.txid,
              p_provider_status: mapped.providerStatus,
              p_status_detail: mapped.statusDetail,
              p_amount_cents: charge.valorCentavos,
              p_delivery_token_hash: token?.hash ?? null,
              p_delivery_token_enc_b64: token?.enc ?? null,
              p_provider: 'wyvipay',
            });
            status = await deps.rpc<OrderStatusPayload>('get_order_status', {
              p_order_id: orderId,
              p_client_token_hash: clientTokenHash,
            });
          }
        } catch (error) {
          // Indisponibilidade do provedor não deve quebrar a consulta do pedido.
          deps.log('order_status.wyvi_reconcile_failed', {
            order_id: orderId,
            reason: error instanceof Error ? error.name : 'unknown',
          });
          if (error instanceof WyviPayError && error.retryAfterSeconds !== null) {
            try {
              await deps.rpc('record_provider_rate_limit', {
                p_key: reconcileKey,
                p_retry_after_seconds: error.retryAfterSeconds,
              });
            } catch {
              // gate é melhor esforço; a consulta do pedido segue intacta
            }
          }
        }
      }
    }

    // Caminho legado (Mercado Pago): só para cobranças DE FATO do MP — uma
    // cobrança WyviPay nunca deve ser consultada na API do Mercado Pago.
    const shouldReconcile =
      !isPaymentFreeRequest &&
      paymentProvider !== 'wyvipay' &&
      paymentProvider !== 'demo' &&
      Boolean(deps.config.mercadoPagoAccessToken) &&
      Boolean(providerPaymentId) &&
      (status.status === 'pending_payment' || status.payment?.status === 'in_process');

    if (shouldReconcile && providerPaymentId) {
      try {
        const snapshot = await getPayment(
          {
            accessToken: deps.config.mercadoPagoAccessToken as string,
            baseUrl: deps.config.mercadoPagoApiBase,
            fetchImpl: deps.fetchImpl,
          },
          providerPaymentId,
        );

        if (snapshot.status !== status.payment?.status || snapshot.status === 'approved') {
          const token = snapshot.status === 'approved' ? await newDeliveryToken(deps) : null;
          await deps.rpc('apply_payment_status', {
            p_order_id: orderId,
            p_provider_payment_id: snapshot.providerPaymentId,
            p_provider_status: snapshot.status,
            p_status_detail: snapshot.statusDetail,
            p_amount_cents: snapshot.amountCents,
            p_delivery_token_hash: token?.hash ?? null,
            p_delivery_token_enc_b64: token?.enc ?? null,
          });
          status = await deps.rpc<OrderStatusPayload>('get_order_status', {
            p_order_id: orderId,
            p_client_token_hash: clientTokenHash,
          });
        }
      } catch (error) {
        // Indisponibilidade do provedor não deve quebrar a consulta do pedido.
        deps.log('order_status.reconcile_failed', { order_id: orderId });
      }
    }

    let deliveryUrl: string | null = null;
    if (status.delivery && status.delivery.status === 'active' && status.delivery_status === 'ready') {
      const masterKey = await deps.resolveEncryptionKey();
      if (masterKey) {
        try {
          // O ciphertext vem por RPC dedicado (prova de posse + link ativo) e é
          // decifrado aqui, no servidor. O navegador só recebe a URL pronta.
          const tokenEnc = await deps.rpc<string | null>('get_delivery_token_enc', {
            p_order_id: orderId,
            p_client_token_hash: clientTokenHash,
          });
          if (tokenEnc) {
            const material = await loadSecretMaterial(masterKey);
            const token = await decryptText(material.encryptionKey, fromBase64(tokenEnc));
            deliveryUrl = `${deps.config.storeUrl.replace(/\/+$/, '')}/entrega/${encodeURIComponent(token)}`;
          }
        } catch {
          deps.log('order_status.delivery_token_unreadable', { order_id: orderId });
        }
      }
    }

    const { delivery, ...rest } = status;

    return json({
      ...rest,
      payment: status.payment
        ? {
            status: status.payment.status,
            status_detail: status.payment.status_detail ?? null,
            qr_code: status.payment.qr_code,
            qr_code_base64: status.payment.qr_code_base64,
            ticket_url: status.payment.ticket_url,
            expires_at: status.payment.expires_at,
          }
        : null,
      delivery: delivery
        ? { id: delivery.id, status: delivery.status, created_at: delivery.created_at, url: deliveryUrl }
        : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
