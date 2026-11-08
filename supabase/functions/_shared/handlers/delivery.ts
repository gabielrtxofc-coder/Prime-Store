import { decryptText, fromBase64, loadSecretMaterial, sha256Hex } from '../crypto.ts';
import type { Deps } from '../deps.ts';
import { ApiError, errorResponse, json, methodGuard, preflight } from '../http.ts';
import { enforceRateLimit } from '../rateLimit.ts';
import { requirePrivateToken } from '../validation.ts';

/**
 * Grupos devolvidos por `resolve_delivery` (migração 0036).
 *
 * A credencial chega cifrada do banco e é decifrada aqui, no servidor. O
 * navegador nunca recebe ciphertext nem a chave: recebe só o texto final da
 * unidade vendida, com o produto a que ela pertence.
 */
interface ResolvedItemGroup {
  product_id: string;
  product_name: string;
  product_slug: string;
  instructions: string;
  access_validity_label: string;
  access_validity_days: number | null;
  quantity: number;
  units: Array<{ stock_unit_id: string; email_enc: string; password_enc: string; notes: string }>;
}

interface ResolvedDelivery {
  delivery_id: string;
  order_id: string;
  reference: string;
  created_at: string;
  items_count: number;
  items: ResolvedItemGroup[];
  /** Compatibilidade com o formato mono-produto anterior. */
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

interface DecryptedUnit {
  email: string;
  password: string;
  notes: string;
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

    // Defesa em profundidade (missão 07): limite por origem e rota, antes de
    // qualquer trabalho. Containers persistentes: ver `_shared/rateLimit.ts`.
    const limited = await enforceRateLimit(request, deps, 'delivery');
    if (limited) return limited;

    const masterKey = await deps.resolveEncryptionKey();
    if (!masterKey) {
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

    const material = await loadSecretMaterial(masterKey);
    const decrypt = async (unit: ResolvedDelivery['units'][number]): Promise<DecryptedUnit> => ({
      email: await decryptText(material.encryptionKey, fromBase64(unit.email_enc)),
      password: await decryptText(material.encryptionKey, fromBase64(unit.password_enc)),
      notes: unit.notes,
    });

    // Grupos por produto. Quando o banco é anterior a 0036 (`items` ausente) o
    // payload plano é convertido em um único grupo: mesma resposta para o
    // cliente, sem depender de a migração ter sido aplicada.
    const groups: ResolvedItemGroup[] =
      Array.isArray(payload.items) && payload.items.length > 0
        ? payload.items
        : [
            {
              product_id: payload.product.id,
              product_name: payload.product.name,
              product_slug: payload.product.slug,
              instructions: payload.product.instructions,
              access_validity_label: payload.product.access_validity_label,
              access_validity_days: payload.product.access_validity_days,
              quantity: payload.units.length,
              units: payload.units,
            },
          ];

    const items = [];
    const flatUnits: DecryptedUnit[] = [];

    for (const group of groups) {
      const units = [];
      for (const unit of group.units) {
        const decrypted = await decrypt(unit);
        units.push(decrypted);
        flatUnits.push(decrypted);
      }

      items.push({
        product_id: group.product_id,
        product_name: group.product_name,
        product_slug: group.product_slug,
        instructions: group.instructions,
        access_validity_label: group.access_validity_label,
        access_validity_days: group.access_validity_days,
        quantity: group.quantity,
        units,
      });
    }

    return json({
      reference: payload.reference,
      created_at: payload.created_at,
      items_count: items.length,
      items,
      // Formato anterior preservado para clientes já publicados.
      product: {
        id: payload.product.id,
        name: payload.product.name,
        slug: payload.product.slug,
        instructions: payload.product.instructions,
        access_validity_label: payload.product.access_validity_label,
        access_validity_days: payload.product.access_validity_days,
      },
      units: flatUnits,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
