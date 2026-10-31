import { encryptText, hmacHex, loadSecretMaterial, randomToken, sha256Hex, toBase64 } from '../crypto.ts';
import { isDemoSandboxAllowed } from '../config.ts';
import type { Deps } from '../deps.ts';
import { ApiError, errorResponse, json, methodGuard, preflight, readJson } from '../http.ts';
import { requireUuid } from '../validation.ts';

/**
 * POST /demo-payment — pagamento SIMULADO, exclusivo do sandbox.
 *
 * Ações:
 *   - `capabilities` : informa se o modo está ativo neste ambiente (sem segredo).
 *   - `approve`      : simula a aprovação de um pedido pendente, com prova de
 *                      posse (order_id + client_token). A transição é decidida
 *                      pelo banco (`demo_approve_payment`), que reaproveita o
 *                      fluxo normal de `apply_payment_status`.
 *   - `seed`         : cria unidades de estoque FICTÍCIAS para um produto de
 *                      demonstração. Exige o token de preparação guardado no
 *                      Vault (`demo_setup_token`) no header
 *                      `x-demo-setup-token` — nenhum segredo fica no código.
 *
 * Garantias:
 *   - Desligado por padrão (`DEMO_PAYMENT_ENABLED` + ref do projeto).
 *   - Nunca altera estado fora do backend: o navegador não escreve nada.
 *   - Só aprova produtos marcados `is_demo` e unidades `is_demo`, portanto
 *     nunca distribui credencial real importada no ambiente.
 *   - O token de entrega é gerado e cifrado aqui, como no fluxo do Mercado Pago.
 */

interface DemoBody {
  action?: unknown;
  order_id?: unknown;
  client_token?: unknown;
  product_id?: unknown;
  units?: unknown;
  notes?: unknown;
}

const ACTIONS = ['capabilities', 'approve', 'seed'];

function assertSandbox(deps: Deps): void {
  if (!isDemoSandboxAllowed(deps.config)) {
    // 404: em ambiente não autorizado a rota não existe.
    throw new ApiError(404, 'demo_unavailable', 'Recurso indisponível neste ambiente.');
  }
}

async function newDeliveryToken(deps: Deps): Promise<{ hash: string; enc: string }> {
  const masterKey = await deps.resolveEncryptionKey();
  if (!masterKey) {
    throw new ApiError(503, 'encryption_not_configured', 'Criptografia não configurada neste ambiente.');
  }
  const material = await loadSecretMaterial(masterKey);
  const token = randomToken(32);
  const encrypted = await encryptText(material.encryptionKey, token);
  return { hash: await sha256Hex(token), enc: toBase64(encrypted) };
}

/** Comparação em tempo constante (evita vazar o token por timing). */
function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function approve(request: Request, deps: Deps, body: DemoBody): Promise<Response> {
  const orderId = requireUuid(body.order_id, 'order_id');
  if (typeof body.client_token !== 'string' || body.client_token.length < 32) {
    throw new ApiError(404, 'not_found', 'Registro não encontrado.');
  }

  const clientTokenHash = await sha256Hex(body.client_token);
  const delivery = await newDeliveryToken(deps);

  const result = await deps.rpc<Record<string, unknown>>('demo_approve_payment', {
    p_order_id: orderId,
    p_client_token_hash: clientTokenHash,
    p_delivery_token_hash: delivery.hash,
    p_delivery_token_enc_b64: delivery.enc,
  });

  deps.log('demo_payment.approved', { order_id: orderId, result: String(result?.result ?? '') });

  return json({
    demo: true,
    result: result?.result ?? 'approved',
    order_status: result?.order_status ?? null,
    payment_status: result?.payment_status ?? null,
    delivery_status: result?.delivery_status ?? null,
  });
}

async function seed(request: Request, deps: Deps, body: DemoBody): Promise<Response> {
  const productId = requireUuid(body.product_id, 'product_id');
  const requested = Number(body.units ?? 3);
  const units = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 10) : 3;

  // O token de preparação existe apenas no Vault: nada é versionado.
  const serviceRpc = deps.serviceRpc ?? deps.rpc;
  const expected = await serviceRpc<string | null>('get_secret_material', {
    p_name: 'demo_setup_token',
  });
  const provided = request.headers.get('x-demo-setup-token') ?? '';
  if (!expected || !provided || !safeEqual(provided, expected)) {
    throw new ApiError(403, 'forbidden', 'Preparação de estoque não autorizada.');
  }

  const masterKey = await deps.resolveEncryptionKey();
  if (!masterKey) {
    throw new ApiError(503, 'encryption_not_configured', 'Criptografia não configurada neste ambiente.');
  }
  const material = await loadSecretMaterial(masterKey);

  const payload: Array<Record<string, string>> = [];
  for (let index = 0; index < units; index += 1) {
    // Credenciais fictícias, geradas no servidor, nunca reais.
    const email = `demo.${productId.slice(0, 8)}.${randomToken(6).toLowerCase()}@prime-store.test`;
    const password = `Demo-${randomToken(9)}`;
    payload.push({
      email_enc_b64: toBase64(await encryptText(material.encryptionKey, email)),
      password_enc_b64: toBase64(await encryptText(material.encryptionKey, password)),
      fingerprint: await hmacHex(material.fingerprintSecret, `${email}\u0000${password}`),
      notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim().slice(0, 200) : 'Credencial fictícia de demonstração',
    });
  }

  const result = await deps.rpc<{ created: number }>('demo_seed_stock', {
    p_product_id: productId,
    p_units: payload,
  });

  deps.log('demo_payment.seeded', { product_id: productId, created: result?.created ?? 0 });
  return json({ demo: true, product_id: productId, created: result?.created ?? 0 });
}

export async function handleDemoPayment(request: Request, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();

  try {
    const enabled = isDemoSandboxAllowed(deps.config);

    if (request.method === 'GET') {
      return json({ demo_enabled: enabled, mode: enabled ? 'demo' : 'disabled' });
    }

    methodGuard(request, ['POST']);

    const body = await readJson<DemoBody>(request);
    const action = typeof body.action === 'string' ? body.action : body.order_id ? 'approve' : 'capabilities';

    if (!ACTIONS.includes(action)) {
      throw new ApiError(422, 'invalid_payload', 'Ação inválida.');
    }

    if (action === 'capabilities') {
      return json({ demo_enabled: enabled, mode: enabled ? 'demo' : 'disabled' });
    }

    assertSandbox(deps);

    if (action === 'seed') return await seed(request, deps, body);
    return await approve(request, deps, body);
  } catch (error) {
    return errorResponse(error);
  }
}
