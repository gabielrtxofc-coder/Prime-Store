import { credentialFingerprint, encryptText, loadSecretMaterial, toBase64 } from '../crypto.ts';
import { MAX_IMPORT_ROWS, extractStockRows, maskEmail, maskSecret, parseCsv, validateStockRows } from '../csv.ts';
import type { Deps } from '../deps.ts';
import { ApiError, json } from '../http.ts';
import type { RpcFn } from '../rest.ts';
import { boundedInt, optionalString, requireEmail, requireString, requireUuid } from '../validation.ts';

/**
 * Ações do PERFIL OPERACIONAL (`ops.*`) da `admin-api`.
 *
 * Perfil pensado para o dia a dia da loja: entra com e-mail + senha (sem
 * TOTP) e só alcança as funções `ops_*` do banco. Cada uma começa por
 * `assert_operator()`; a lista de ações abaixo é só a porta de entrada — a
 * autorização continua decidida no PostgreSQL, com o JWT do próprio usuário.
 *
 * O que NÃO existe aqui (de propósito): revelar credenciais, pedidos,
 * pagamentos, reembolsos, entregas, indicadores, auditoria, criação de
 * produto, preço/custo/slug/categoria. Essas ações seguem exclusivas do perfil
 * administrativo (`admin_*` + allowlist + AAL2).
 */

/** Campos de produto que o perfil operacional pode alterar (espelho do banco). */
export const OPS_PRODUCT_FIELDS = [
  'name',
  'short_description',
  'description',
  'instructions',
  'conditions',
  'image_url',
  'access_validity_label',
  'max_quantity_per_order',
  'is_featured',
  'is_active',
] as const;

const OPS_PRODUCT_FIELD_SET = new Set<string>(OPS_PRODUCT_FIELDS);

const VALID_REASONS = new Set([
  'inventory_adjustment',
  'invalid_credential',
  'compromised_credential',
  'duplicate_import',
  'data_correction',
  'other',
]);

const STOCK_STATUS_FILTERS = new Set(['available', 'reserved', 'sold', 'disabled']);

async function requireMaterial(deps: Deps) {
  const masterKey = await deps.resolveEncryptionKey();
  if (!masterKey) {
    throw new ApiError(503, 'not_configured', 'Chave de criptografia ausente no ambiente.');
  }
  return loadSecretMaterial(masterKey);
}

export function isOpsAction(action: string): boolean {
  return action.startsWith('ops.');
}

export async function handleOpsAction(
  action: string,
  payload: Record<string, unknown>,
  rpc: RpcFn,
  deps: Deps,
): Promise<Response> {
  // Barreira de entrada: só segue quem é operador ativo (o banco decide).
  // Também evita que um JWT qualquer faça o servidor cifrar/processar CSV.
  const session = await rpc<{ user_id: string; display_name: string; profile: string }>('ops_session');

  switch (action) {
    case 'ops.session':
      return json(session);

    // -------------------------------------------------------------------
    // Produtos
    // -------------------------------------------------------------------
    case 'ops.products.list': {
      const products = await rpc('ops_list_products', {
        p_search: optionalString(payload.search, 'search', { max: 120 }) ?? null,
        p_include_inactive: payload.includeInactive === undefined ? true : Boolean(payload.includeInactive),
      });
      return json({ products });
    }

    case 'ops.products.update': {
      const productId = requireUuid(payload.productId, 'productId');
      const patch = payload.patch;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new ApiError(422, 'invalid_payload', 'Informe os campos a alterar.');
      }
      const keys = Object.keys(patch as Record<string, unknown>);
      if (keys.length === 0) {
        throw new ApiError(422, 'invalid_payload', 'Informe os campos a alterar.');
      }
      // Recusa explícita (nunca descarte silencioso). O banco aplica a mesma
      // lista — esta checagem só antecipa a resposta.
      const forbidden = keys.filter((key) => !OPS_PRODUCT_FIELD_SET.has(key)).sort();
      if (forbidden.length > 0) {
        throw new ApiError(
          403,
          'field_not_allowed',
          `O perfil operacional não pode alterar: ${forbidden.join(', ')}.`,
        );
      }
      const product = await rpc('ops_update_product', { p_product_id: productId, p_payload: patch });
      return json({ product });
    }

    case 'ops.products.setActive': {
      const productId = requireUuid(payload.productId, 'productId');
      if (typeof payload.active !== 'boolean') {
        throw new ApiError(422, 'invalid_payload', 'Campo active inválido.');
      }
      const product = await rpc('ops_set_product_active', { p_product_id: productId, p_active: payload.active });
      return json({ product });
    }

    // -------------------------------------------------------------------
    // Estoque
    // -------------------------------------------------------------------
    case 'ops.stock.summary':
      return json(await rpc('ops_stock_summary'));

    case 'ops.stock.list': {
      if (payload.includeCredentials) {
        // Revelar credencial é privilégio administrativo (AAL2 + auditoria).
        throw new ApiError(403, 'forbidden', 'O perfil operacional não exibe credenciais do estoque.');
      }
      const status = optionalString(payload.status, 'status', { max: 20 }) ?? null;
      if (status && !STOCK_STATUS_FILTERS.has(status)) {
        throw new ApiError(422, 'invalid_payload', 'Filtro de status inválido.');
      }
      return json(
        await rpc('ops_list_stock', {
          p_product_id: payload.productId ? requireUuid(payload.productId, 'productId') : null,
          p_status: status,
          p_search: optionalString(payload.search, 'search', { max: 120 }) ?? null,
          p_limit: boundedInt(payload.limit, { min: 1, max: 200, fallback: 100 }),
          p_offset: boundedInt(payload.offset, { min: 0, max: 1_000_000, fallback: 0 }),
        }),
      );
    }

    case 'ops.stock.add': {
      const productId = requireUuid(payload.productId, 'productId');
      const email = requireEmail(payload.email, 'email');
      const password = requireString(payload.password, 'password', { max: 200 });
      const notes = optionalString(payload.notes, 'notes', { max: 500 }) ?? '';
      const material = await requireMaterial(deps);

      const unit = await rpc('ops_add_stock_unit', {
        p_product_id: productId,
        p_email_enc_b64: toBase64(await encryptText(material.encryptionKey, email)),
        p_password_enc_b64: toBase64(await encryptText(material.encryptionKey, password)),
        p_fingerprint: await credentialFingerprint(material, email, password),
        p_notes: notes,
      });
      return json({ unit }, { status: 201 });
    }

    case 'ops.stock.setStatus': {
      const stockUnitId = requireUuid(payload.stockUnitId, 'stockUnitId');
      const status = requireString(payload.status, 'status', { max: 20 });
      if (status !== 'available' && status !== 'disabled') {
        throw new ApiError(422, 'invalid_status_change', 'Status deve ser available ou disabled.');
      }
      const reason = optionalString(payload.reason, 'reason', { max: 40 }) ?? null;
      const note = optionalString(payload.note, 'note', { max: 300 }) ?? '';
      if (status === 'disabled') {
        if (!reason) {
          throw new ApiError(422, 'adjustment_reason_required', 'Desativar uma unidade exige um motivo categorizado.');
        }
        if (!VALID_REASONS.has(reason)) {
          throw new ApiError(422, 'invalid_adjustment_reason', 'Motivo de ajuste desconhecido.');
        }
        if (reason === 'other' && note.trim().length < 5) {
          throw new ApiError(422, 'adjustment_reason_note_required', "Motivo 'outro' exige uma nota com pelo menos 5 caracteres.");
        }
      }
      return json(
        await rpc('ops_set_stock_unit_status', {
          p_stock_unit_id: stockUnitId,
          p_status: status,
          p_reason: status === 'disabled' ? reason : null,
          p_note: status === 'disabled' ? note : '',
        }),
      );
    }

    case 'ops.stock.import.preview':
    case 'ops.stock.import.commit': {
      const productId = requireUuid(payload.productId, 'productId');
      const csvText = requireString(payload.csv, 'csv', { min: 3, max: 2_000_000 });
      const material = await requireMaterial(deps);

      const rows = extractStockRows(parseCsv(csvText));
      // Sem leitura de fingerprints existentes (dado administrativo): a
      // duplicidade contra o banco é detectada na gravação (índice único) e
      // aparece no relatório como `duplicate_credential`.
      const validated = validateStockRows(rows, new Set<string>(), (email, password) =>
        `${email.trim().toLowerCase()}\u0000${password}`,
      );

      if (validated.truncated && action === 'ops.stock.import.commit') {
        throw new ApiError(
          413,
          'import_too_large',
          `O arquivo passou de ${MAX_IMPORT_ROWS} linhas. Divida em arquivos menores e importe de novo.`,
        );
      }

      if (action === 'ops.stock.import.preview') {
        return json({
          total_rows: rows.length,
          valid_rows: validated.valid.length,
          rejected_rows: validated.rejected.length,
          duplicated_in_file: validated.duplicatedInFile,
          truncated: validated.truncated,
          max_rows: MAX_IMPORT_ROWS,
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

      const rowsToImport = [];
      for (const row of validated.valid) {
        rowsToImport.push({
          row_number: row.rowNumber,
          email_enc: toBase64(await encryptText(material.encryptionKey, row.email)),
          password_enc: toBase64(await encryptText(material.encryptionKey, row.password)),
          fingerprint: await credentialFingerprint(material, row.email, row.password),
          notes: row.notes,
        });
      }

      const report = await rpc('ops_import_stock_units', {
        p_product_id: productId,
        p_rows: rowsToImport,
        p_rejected: validated.rejected.map((row) => ({ row_number: row.rowNumber, reason: row.reason })),
        p_file_name: optionalString(payload.fileName, 'fileName', { max: 200 }) ?? 'importacao.csv',
      });
      return json({ report }, { status: 201 });
    }

    default:
      throw new ApiError(400, 'unknown_action', `Ação desconhecida: ${action}`);
  }
}
