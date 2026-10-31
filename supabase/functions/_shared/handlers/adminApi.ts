import {
  credentialFingerprint,
  decryptText,
  encryptText,
  fromBase64,
  loadSecretMaterial,
  randomToken,
  sha256Hex,
  toBase64,
} from '../crypto.ts';
import { extractStockRows, maskEmail, maskSecret, parseCsv, validateStockRows } from '../csv.ts';
import type { Deps } from '../deps.ts';
import { ApiError, errorResponse, json, methodGuard, preflight, readJson } from '../http.ts';
import type { RpcFn } from '../rest.ts';
import {
  isUuid,
  optionalString,
  pickKnownFields,
  requireEmail,
  requireString,
  requireUuid,
} from '../validation.ts';

const PRODUCT_FIELDS = [
  'slug',
  'name',
  'short_description',
  'description',
  'image_url',
  'category_id',
  'price_cents',
  'cost_cents',
  'access_validity_days',
  'access_validity_label',
  'instructions',
  'conditions',
  'modality',
  'period',
  'monogram',
  'theme',
  'max_quantity_per_order',
  'is_featured',
  'is_active',
];

interface AdminBody {
  action?: unknown;
  payload?: Record<string, unknown>;
}

interface AuthUser {
  id: string;
  email?: string;
}

async function verifyUser(
  request: Request,
  deps: Deps,
  authorization: string,
): Promise<AuthUser> {
  const url = `${deps.config.supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`;
  const response = await deps.fetchImpl(url, {
    headers: {
      Authorization: authorization,
      apikey: deps.config.anonKey || deps.config.serviceRoleKey,
    },
  });

  if (!response.ok) {
    throw new ApiError(401, 'unauthorized', 'Sessão inválida ou expirada.');
  }

  const payload = (await response.json()) as Partial<AuthUser>;
  if (!payload.id) {
    throw new ApiError(401, 'unauthorized', 'Sessão inválida ou expirada.');
  }
  return { id: payload.id, email: payload.email };
}

async function requireMaterial(deps: Deps) {
  const masterKey = await deps.resolveEncryptionKey();
  if (!masterKey) {
    throw new ApiError(503, 'not_configured', 'Chave de criptografia ausente no ambiente.');
  }
  return loadSecretMaterial(masterKey);
}

async function encryptSecret(deps: Deps, value: string): Promise<string> {
  const material = await requireMaterial(deps);
  return toBase64(await encryptText(material.encryptionKey, value));
}

async function decryptSecret(deps: Deps, value: string): Promise<string> {
  const material = await requireMaterial(deps);
  return decryptText(material.encryptionKey, fromBase64(value));
}

/**
 * POST /admin-api — porta única do painel administrativo.
 *
 * A autorização é sempre decidida no banco (assert_admin), usando o JWT do
 * usuário: sem allowlist ativa e sem AAL2 (TOTP), toda ação falha.
 */
export async function handleAdminApi(request: Request, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();

  try {
    methodGuard(request, ['POST']);

    const authorization = request.headers.get('authorization') ?? '';
    if (!authorization.toLowerCase().startsWith('bearer ')) {
      throw new ApiError(401, 'unauthorized', 'Autenticação obrigatória.');
    }

    const user = await verifyUser(request, deps, authorization);

    // IMPORTANTE: o cliente RPC usa o JWT do usuário, nunca a service role.
    // Assim as funções administrativas enxergam auth.uid()/aal do chamador e
    // aplicam assert_admin() no banco.
    const rpc: RpcFn = deps.rpcForUser(authorization);

    const body = await readJson<AdminBody>(request);
    const action = requireString(body.action, 'action', { max: 60 });
    const payload = body.payload ?? {};

    switch (action) {
      // ---------------------------------------------------------------------
      // Sessão
      // ---------------------------------------------------------------------
      case 'session': {
        const isAdmin = await rpc<boolean>('is_admin', { p_require_mfa: false }).catch(() => false);
        const mfaSatisfied = await rpc<boolean>('is_admin', { p_require_mfa: true }).catch(() => false);
        return json({
          user: { id: user.id },
          is_admin: Boolean(isAdmin),
          mfa_satisfied: Boolean(mfaSatisfied),
        });
      }

      // ---------------------------------------------------------------------
      // Produtos
      // ---------------------------------------------------------------------
      case 'products.list': {
        const products = await rpc('admin_list_products', {
          p_search: optionalString(payload.search, 'search', { max: 120 }) ?? null,
          p_include_inactive: payload.includeInactive === undefined ? true : Boolean(payload.includeInactive),
        });
        return json({ products });
      }

      case 'products.get': {
        const productId = requireUuid(payload.productId, 'productId');
        return json(await rpc('admin_get_product', { p_product_id: productId }));
      }

      case 'products.create': {
        const fields = pickKnownFields(
          (payload.product ?? payload) as Record<string, unknown>,
          PRODUCT_FIELDS,
        );
        requireString(fields.name, 'name', { max: 120 });
        requireString(fields.slug, 'slug', { max: 120 });
        if (fields.price_cents === undefined) {
          throw new ApiError(422, 'invalid_payload', 'Informe o preço de venda.');
        }
        const product = await rpc('admin_create_product', { p_payload: fields });
        return json({ product }, { status: 201 });
      }

      case 'products.update': {
        const productId = requireUuid(payload.productId, 'productId');
        const fields = pickKnownFields(
          (payload.patch ?? {}) as Record<string, unknown>,
          PRODUCT_FIELDS,
        );
        const product = await rpc('admin_update_product', { p_product_id: productId, p_payload: fields });
        return json({ product });
      }

      case 'products.setActive': {
        const productId = requireUuid(payload.productId, 'productId');
        if (typeof payload.active !== 'boolean') {
          throw new ApiError(422, 'invalid_payload', 'Campo active inválido.');
        }
        const product = await rpc('admin_set_product_active', {
          p_product_id: productId,
          p_active: payload.active,
        });
        return json({ product });
      }

      // ---------------------------------------------------------------------
      // Estoque
      // ---------------------------------------------------------------------
      case 'stock.summary':
        return json(await rpc('admin_stock_summary'));

      case 'stock.list': {
        const includeCredentials = Boolean(payload.includeCredentials);
        const result = await rpc<{ items: Array<Record<string, unknown>>; total: number }>(
          'admin_list_stock',
          {
            p_product_id: payload.productId ? requireUuid(payload.productId, 'productId') : null,
            p_status: optionalString(payload.status, 'status', { max: 20 }) ?? null,
            p_search: optionalString(payload.search, 'search', { max: 120 }) ?? null,
            p_limit: Number(payload.limit ?? 100),
            p_offset: Number(payload.offset ?? 0),
            p_include_credentials: includeCredentials,
          },
        );

        if (includeCredentials) {
          const items = [];
          for (const item of result.items) {
            items.push({
              ...item,
              email: typeof item.email_enc === 'string' ? await decryptSecret(deps, item.email_enc) : null,
              password: typeof item.password_enc === 'string' ? await decryptSecret(deps, item.password_enc) : null,
              email_enc: undefined,
              password_enc: undefined,
            });
          }
          return json({ ...result, items });
        }

        return json(result);
      }

      case 'stock.add': {
        const productId = requireUuid(payload.productId, 'productId');
        const email = requireEmail(payload.email, 'email');
        const password = requireString(payload.password, 'password', { max: 200 });
        const notes = optionalString(payload.notes, 'notes', { max: 500 }) ?? '';
        const material = await requireMaterial(deps);

        const unit = await rpc('admin_add_stock_unit', {
          p_product_id: productId,
          p_email_enc_b64: await encryptSecret(deps, email),
          p_password_enc_b64: await encryptSecret(deps, password),
          p_fingerprint: await credentialFingerprint(material, email, password),
          p_notes: notes,
        });
        return json({ unit }, { status: 201 });
      }

      case 'stock.update': {
        const stockUnitId = requireUuid(payload.stockUnitId, 'stockUnitId');
        const notes = optionalString(payload.notes, 'notes', { max: 500 });
        const hasEmail = payload.email !== undefined;
        const hasPassword = payload.password !== undefined;

        if (hasEmail !== hasPassword) {
          throw new ApiError(422, 'invalid_payload', 'Informe e-mail e senha juntos para alterar a credencial.');
        }

        const params: Record<string, unknown> = {
          p_stock_unit_id: stockUnitId,
          p_email_enc_b64: null,
          p_password_enc_b64: null,
          p_fingerprint: null,
          p_notes: notes ?? null,
        };

        if (hasEmail && hasPassword) {
          const email = requireEmail(payload.email, 'email');
          const password = requireString(payload.password, 'password', { max: 200 });
          const material = await requireMaterial(deps);
          params.p_email_enc_b64 = await encryptSecret(deps, email);
          params.p_password_enc_b64 = await encryptSecret(deps, password);
          params.p_fingerprint = await credentialFingerprint(material, email, password);
        }

        return json(await rpc('admin_update_stock_unit', params));
      }

      case 'stock.setStatus': {
        const stockUnitId = requireUuid(payload.stockUnitId, 'stockUnitId');
        const status = requireString(payload.status, 'status', { max: 20 });
        return json(await rpc('admin_set_stock_unit_status', {
          p_stock_unit_id: stockUnitId,
          p_status: status,
        }));
      }

      case 'stock.import.preview':
      case 'stock.import.commit': {
        const productId = requireUuid(payload.productId, 'productId');
        const csvText = requireString(payload.csv, 'csv', { min: 3, max: 2_000_000 });
        const material = await requireMaterial(deps);

        const parsed = parseCsv(csvText);
        const rows = extractStockRows(parsed);

        const fingerprints = await rpc<string[]>('admin_stock_fingerprints', {
          p_product_id: productId,
        });
        const existing = new Set(fingerprints ?? []);

        const validated = validateStockRows(rows, existing, (email, password) =>
          `${email.trim().toLowerCase()}\u0000${password}`,
        );

        if (action === 'stock.import.preview') {
          return json({
            total_rows: rows.length,
            valid_rows: validated.valid.length,
            rejected_rows: validated.rejected.length,
            duplicated_in_file: validated.duplicatedInFile,
            preview: validated.valid.slice(0, 50).map((row) => ({
              row_number: row.rowNumber,
              email: maskEmail(row.email),
              password: maskSecret(row.password),
              notes: row.notes,
            })),
            rejected: validated.rejected,
          });
        }

        if (rows.length === 0) {
          throw new ApiError(422, 'empty_file', 'O arquivo não possui linhas.');
        }

        // Recalcula o fingerprint real (HMAC) no momento de gravar.
        const rowsToImport = [];
        for (const row of validated.valid) {
          rowsToImport.push({
            row_number: row.rowNumber,
            email_enc: await encryptSecret(deps, row.email),
            password_enc: await encryptSecret(deps, row.password),
            fingerprint: await credentialFingerprint(material, row.email, row.password),
            notes: row.notes,
          });
        }

        const rejectedWithNumbers = validated.rejected.map((row) => ({
          row_number: row.rowNumber,
          reason: row.reason,
        }));

        const report = await rpc('admin_import_stock_units', {
          p_product_id: productId,
          p_rows: rowsToImport,
          p_rejected: rejectedWithNumbers,
          p_file_name: optionalString(payload.fileName, 'fileName', { max: 200 }) ?? 'importacao.csv',
        });

        return json({ report }, { status: 201 });
      }

      // ---------------------------------------------------------------------
      // Pedidos, indicadores e reembolsos
      // ---------------------------------------------------------------------
      case 'orders.list': {
        const result = await rpc('admin_list_orders', {
          p_search: optionalString(payload.search, 'search', { max: 120 }) ?? null,
          p_status: optionalString(payload.status, 'status', { max: 30 }) ?? null,
          p_payment_status: optionalString(payload.paymentStatus, 'paymentStatus', { max: 30 }) ?? null,
          p_from: payload.from ?? null,
          p_to: payload.to ?? null,
          p_problem_only: Boolean(payload.problemOnly),
          p_limit: Number(payload.limit ?? 50),
          p_offset: Number(payload.offset ?? 0),
        });
        return json(result);
      }

      case 'orders.get': {
        const orderId = requireUuid(payload.orderId, 'orderId');
        return json(await rpc('admin_get_order', { p_order_id: orderId }));
      }

      case 'indicators':
        return json(await rpc('admin_indicators'));

      case 'refunds.list':
        return json({
          refunds: await rpc('admin_list_refund_requests', {
            p_status: optionalString(payload.status, 'status', { max: 20 }) ?? null,
          }),
        });

      case 'refunds.resolve': {
        const refundId = requireUuid(payload.refundId, 'refundId');
        const status = requireString(payload.status, 'status', { max: 20 });
        if (!['authorized', 'processed', 'rejected'].includes(status)) {
          throw new ApiError(422, 'invalid_payload', 'Status de reembolso inválido.');
        }
        return json(await rpc('admin_resolve_refund', {
          p_refund_id: refundId,
          p_status: status,
          p_notes: optionalString(payload.notes, 'notes', { max: 1000 }) ?? '',
        }));
      }

      // ---------------------------------------------------------------------
      // Entregas
      // ---------------------------------------------------------------------
      case 'orders.resolveDispute': {
        const orderId = requireUuid(payload.orderId, 'orderId');
        const outcome = requireString(payload.outcome, 'outcome', { max: 30 });
        if (!['refund', 'reinstated', 'refund_pending'].includes(outcome)) {
          throw new ApiError(422, 'invalid_payload', 'Decisão de disputa inválida.');
        }
        return json(await rpc('admin_resolve_dispute', {
          p_order_id: orderId,
          p_outcome: outcome,
          p_notes: optionalString(payload.notes, 'notes', { max: 500 }) ?? '',
        }));
      }

      case 'deliveries.revoke': {
        const deliveryId = requireUuid(payload.deliveryId, 'deliveryId');
        return json(await rpc('admin_revoke_delivery', {
          p_delivery_id: deliveryId,
          p_reason: optionalString(payload.reason, 'reason', { max: 500 }) ?? 'Revogada por administrador',
        }));
      }

      case 'deliveries.rotate': {
        const deliveryId = requireUuid(payload.deliveryId, 'deliveryId');
        const token = randomToken(32);
        const encrypted = await encryptSecret(deps, token);
        const result = await rpc('admin_rotate_delivery_token', {
          p_delivery_id: deliveryId,
          p_token_hash: await sha256Hex(token),
          p_token_enc_b64: encrypted,
        });
        return json({
          ...((result as Record<string, unknown>) ?? {}),
          delivery_url: `${deps.config.storeUrl.replace(/\/+$/, '')}/entrega/${encodeURIComponent(token)}`,
        });
      }

      case 'audit.list':
        return json({
          entries: await rpc('admin_audit_log', { p_limit: Number(payload.limit ?? 50) }),
        });

      case 'reservations.expire':
        return json(await rpc('admin_expire_reservations'));

      default:
        throw new ApiError(400, 'unknown_action', `Ação desconhecida: ${action}`);
    }
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error);
    // Erros do PostgREST preservam a mensagem para tratamento no cliente.
    if (error && typeof error === 'object' && 'code' in error) {
      const dbError = error as { code: string; message?: string; detail?: string };
      if (dbError.code === '42501' || (dbError.message ?? '').includes('not_admin')) {
        const isMfa = (dbError.message ?? '').includes('mfa_required');
        return json(
          {
            error: isMfa ? 'mfa_required' : 'forbidden',
            message: isMfa
              ? 'Ative a verificação em duas etapas (TOTP) para continuar.'
              : 'Acesso administrativo negado.',
          },
          { status: 403 },
        );
      }
      if (dbError.code === '28000') {
        return json({ error: 'unauthorized', message: 'Sessão necessária.' }, { status: 401 });
      }
    }
    return errorResponse(error);
  }
}

export const __adminInternals = { isUuid, verifyUser };
