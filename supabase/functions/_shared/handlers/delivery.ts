import { decryptText, fromBase64, loadSecretMaterial, sha256Hex } from '../crypto.ts';
import type { Deps } from '../deps.ts';
import { ApiError, errorResponse, json, methodGuard, preflight } from '../http.ts';
import { requirePrivateToken } from '../validation.ts';

interface ResolvedDelivery {
  delivery_id: string;
  order_id: string;
  reference: string;
  created_at: string;
  product: {
    id: string;
    name: string;
    slug: string;
    instructions: string;
    access_validity_label: string;
    access_validity_days: number | null;
  };
  units: Array<{ stock_unit_id: string; email_enc: string; password_enc: string; notes: string }>;
}

/**
 * GET/POST /delivery — entrega privada por token.
 * O token nunca é registrado em log. Só pedidos pagos e com entrega ativa
 * devolvem credenciais.
 */
export async function handleDelivery(request: Request, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();

  try {
    methodGuard(request, ['GET', 'POST']);

    if (!deps.config.encryptionKey) {
      throw new ApiError(503, 'not_configured', 'Entrega indisponível: chave de criptografia ausente.');
    }

    let token: string | null = new URL(request.url).searchParams.get('token');
    if (request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { token?: unknown };
      if (typeof body.token === 'string') token = body.token;
    }

    const privateToken = requirePrivateToken(token, 'token');
    const tokenHash = await sha256Hex(privateToken);

    const payload = await deps.rpc<ResolvedDelivery>('resolve_delivery', {
      p_token_hash: tokenHash,
    });

    const material = await loadSecretMaterial(deps.config.encryptionKey);
    const units = [];
    for (const unit of payload.units) {
      units.push({
        email: await decryptText(material.encryptionKey, fromBase64(unit.email_enc)),
        password: await decryptText(material.encryptionKey, fromBase64(unit.password_enc)),
        notes: unit.notes,
      });
    }

    return json({
      reference: payload.reference,
      created_at: payload.created_at,
      product: payload.product,
      units,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
