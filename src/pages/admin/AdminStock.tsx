import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { adminApi, STOCK_ADJUSTMENT_REASONS, type AdminProduct, type AdminStockList, type AdminStockSummary, type ImportPreview, type ImportReport, type StockAdjustmentReason, type StockHealth } from '../../services/adminApi';
import { ConfirmActionDialog } from '../../components/admin/ConfirmActionDialog';
import { describeBackendError } from '../../services/backend/http';

const STATUS_FILTERS = ['', 'available', 'reserved', 'sold', 'disabled'] as const;

const STATUS_LABEL: Record<string, string> = {
  available: 'disponível',
  reserved: 'reservada',
  sold: 'vendida',
  disabled: 'desativada',
};

const HEALTH_LABEL: Record<StockHealth, string> = {
  empty: 'sem estoque',
  low: 'estoque baixo',
  ok: 'ok',
};

const HEALTH_BADGE: Record<StockHealth, string> = {
  empty: 'admin-badge is-off',
  low: 'admin-badge is-warn',
  ok: 'admin-badge is-on',
};

export function AdminStock() {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  // Missão 13: três seleções independentes — filtrar a lista, cadastrar
  // unidade e importar CSV não compartilham mais o mesmo estado.
  const [stockFilterProductId, setStockFilterProductId] = useState('');
  const [addProductId, setAddProductId] = useState('');
  const [importProductId, setImportProductId] = useState('');
  // Produto para o qual a prévia de importação foi preparada. Só confirma
  // quando previewProductId === importProductId.
  const [previewProductId, setPreviewProductId] = useState('');
  const [status, setStatus] = useState<string>('');
  const [stock, setStock] = useState<AdminStockList | null>(null);
  const [summary, setSummary] = useState<AdminStockSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCredentials, setShowCredentials] = useState(false);
  const [addBusy, setAddBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notes, setNotes] = useState('');

  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('importacao.csv');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [pendingUnit, setPendingUnit] = useState<{ id: string; next: 'available' | 'disabled'; name: string } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const [disableReason, setDisableReason] = useState<StockAdjustmentReason | ''>('');
  const [disableNote, setDisableNote] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, summaryResult] = await Promise.all([
        adminApi.listStock({
          productId: stockFilterProductId || null,
          status: status || null,
          includeCredentials: showCredentials,
          limit: 100,
        }),
        adminApi.stockSummary(),
      ]);
      setStock(list);
      setSummary(summaryResult);
      setError(null);
    } catch (loadError) {
      setError(describeBackendError(loadError));
    }
  }, [stockFilterProductId, status, showCredentials]);

  useEffect(() => {
    void adminApi.listProducts('', true)
      .then((result) => setProducts(result.products))
      .catch((productsError) => setError(describeBackendError(productsError)));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const addUnit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!addProductId) {
      setError('Selecione o produto antes de cadastrar uma unidade.');
      return;
    }
    const trimmedEmail = email.trim();
    if (!EMAIL_PATTERN.test(trimmedEmail)) {
      setError('Informe um e-mail/login válido (ex.: conta@exemplo.com).');
      return;
    }
    if (password.length < 6) {
      setError('A senha da conta deve ter pelo menos 6 caracteres.');
      return;
    }
    if (notes.trim().length > 500) {
      setError('Observações podem ter no máximo 500 caracteres.');
      return;
    }
    setAddBusy(true);
    try {
      // Sempre envia o produto do formulário de cadastro (addProductId),
      // nunca o filtro da listagem.
      await adminApi.addStock({ productId: addProductId, email: trimmedEmail, password, notes: notes.trim() });
      setNotice('Unidade cadastrada. E-mail e senha foram cifrados antes de gravar.');
      setEmail('');
      setPassword('');
      setNotes('');
      await load();
    } catch (addError) {
      setError(describeBackendError(addError));
    } finally {
      setAddBusy(false);
    }
  };

  const setUnitStatus = (unitId: string, next: 'available' | 'disabled', name: string) => {
    if (next === 'disabled') {
      setDisableReason('');
      setDisableNote('');
    }
    setPendingUnit({ id: unitId, next, name });
  };

  const confirmUnitStatus = async () => {
    if (!pendingUnit) return;
    setActionBusy(true);
    try {
      await adminApi.setStockStatus(
        pendingUnit.id,
        pendingUnit.next,
        pendingUnit.next === 'disabled' ? (disableReason || null) : null,
        pendingUnit.next === 'disabled' ? disableNote.trim() : '',
      );
      setNotice(`Unidade ${pendingUnit.next === 'available' ? 'reativada' : 'desativada'}.`);
      setPendingUnit(null);
      await load();
    } catch (statusError) {
      setError(describeBackendError(statusError));
      setPendingUnit(null);
    } finally {
      setActionBusy(false);
    }
  };

  const disableValid =
    pendingUnit?.next !== 'disabled' ||
    (disableReason !== '' && (disableReason !== 'other' || disableNote.trim().length >= 5));

  // A prévia é sempre descartada quando o arquivo ou o produto da importação
  // mudam — ela nunca pode ser reutilizada para outro produto.
  const invalidatePreview = () => {
    setPreview(null);
    setPreviewProductId('');
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 1_500_000) {
      setError('Arquivo muito grande. Envie um CSV com até 1,5 MB.');
      return;
    }
    setFileName(file.name);
    setCsv(await file.text());
    invalidatePreview();
    setReport(null);
  };

  const onCsvChange = (value: string) => {
    setCsv(value);
    invalidatePreview();
  };

  const onImportProductChange = (value: string) => {
    setImportProductId(value);
    invalidatePreview();
  };

  const runPreview = async () => {
    if (!importProductId) {
      setError('Selecione o produto da importação.');
      return;
    }
    setImportBusy(true);
    setError(null);
    try {
      const result = await adminApi.previewImport(importProductId, csv);
      setPreview(result);
      setPreviewProductId(importProductId);
      setReport(null);
    } catch (previewError) {
      setError(describeBackendError(previewError));
      invalidatePreview();
    } finally {
      setImportBusy(false);
    }
  };

  // A confirmação só é permitida quando a prévia foi preparada exatamente
  // para o produto selecionado para importar.
  const canConfirmImport = Boolean(
    preview && preview.valid_rows > 0 && previewProductId && previewProductId === importProductId,
  );

  const runImport = async () => {
    if (!importProductId) return;
    if (!preview || previewProductId !== importProductId) {
      setError('A prévia de importação não corresponde ao produto selecionado. Gere a prévia novamente.');
      invalidatePreview();
      return;
    }
    setImportBusy(true);
    setError(null);
    try {
      const result = await adminApi.commitImport(importProductId, csv, fileName);
      setReport(result.report);
      invalidatePreview();
      setCsv('');
      if (fileRef.current) fileRef.current.value = '';
      setNotice('Importação concluída. Confira o relatório abaixo.');
      await load();
    } catch (importError) {
      setError(describeBackendError(importError));
    } finally {
      setImportBusy(false);
    }
  };

  return (
    <div className="admin-section">
      {error && <div className="payment-warning" role="alert"><p>{error}</p></div>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}

      {summary && (
        <div className="admin-metrics admin-metrics--compact">
          <div className="admin-metric"><span>Total</span><strong>{summary.totals.total_units}</strong></div>
          <div className="admin-metric"><span>Disponíveis</span><strong>{summary.totals.available_units}</strong></div>
          <div className="admin-metric"><span>Reservadas</span><strong>{summary.totals.reserved_units}</strong></div>
          <div className="admin-metric"><span>Vendidas</span><strong>{summary.totals.sold_units}</strong></div>
          <div className="admin-metric"><span>Desativadas</span><strong>{summary.totals.disabled_units}</strong></div>
        </div>
      )}

      {summary && summary.products.length > 0 && (
        <div className="admin-panel">
          <div className="admin-panel__header">
            <h2>Estoque por produto</h2>
            <span className="field-hint">Resumo individual do banco (admin_stock_summary_by_product): vazio = 0 disponíveis, baixo = ≤ 2</span>
          </div>
          <div className="admin-table-wrapper">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Produto</th>
                  <th>Disponível</th>
                  <th>Reservada</th>
                  <th>Vendida</th>
                  <th>Desativada</th>
                  <th>Última reposição</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {[...summary.products]
                  .sort((a, b) => a.available_units - b.available_units)
                  .map((product) => (
                    <tr key={product.product_id}>
                      <td>{product.product_name}</td>
                      <td>{product.available_units}</td>
                      <td>{product.reserved_units}</td>
                      <td>{product.sold_units}</td>
                      <td>{product.disabled_units}</td>
                      <td className="field-hint">
                        {product.last_restocked_at ? new Date(product.last_restocked_at).toLocaleString('pt-BR') : '—'}
                      </td>
                      <td>
                        <span className={HEALTH_BADGE[product.stock_health]}>{HEALTH_LABEL[product.stock_health]}</span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="admin-filters" role="group" aria-label="Filtros de estoque">
        <div className="admin-filter-field">
          <span className="admin-filter-label" aria-hidden="true">Produto</span>
          <select
            className="form-control"
            value={stockFilterProductId}
            onChange={(event) => setStockFilterProductId(event.target.value)}
            aria-label="Filtrar por produto"
          >
            <option value="">Todos os produtos</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>{product.name}</option>
            ))}
          </select>
        </div>
        <div className="admin-filter-field">
          <span className="admin-filter-label" aria-hidden="true">Situação da unidade</span>
          <select
            className="form-control"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            aria-label="Filtrar por status"
          >
            {STATUS_FILTERS.map((value) => (
              <option key={value || 'all'} value={value}>{value ? STATUS_LABEL[value] : 'Todos os status'}</option>
            ))}
          </select>
        </div>
        <div className="admin-filter-field admin-filter-field--actions">
          <label className="admin-inline-check">
            <input type="checkbox" checked={showCredentials} onChange={(event) => setShowCredentials(event.target.checked)} />
            Exibir credenciais (registrado em auditoria como stock_credentials_listed)
          </label>
          <button className="button button--secondary button--small" type="button" onClick={() => void load()}>Atualizar</button>
        </div>
      </div>

      <div className="admin-table-wrapper">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Produto</th>
              <th>Status</th>
              <th>Credencial</th>
              <th>Fingerprint</th>
              <th>Reserva</th>
              <th>Criada em</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {(stock?.items ?? []).map((unit) => (
              <tr key={unit.id}>
                <td>{unit.product_name}</td>
                <td>
                  <span className={`admin-badge${unit.status === 'available' ? ' is-on' : ' is-off'}`}>{STATUS_LABEL[unit.status] ?? unit.status}</span>
                  {unit.status === 'disabled' && unit.status_reason && (
                    <span className="field-hint" title={unit.status_reason_note || undefined}>
                      {STOCK_ADJUSTMENT_REASONS.find((reason) => reason.value === unit.status_reason)?.label ?? unit.status_reason}
                    </span>
                  )}
                </td>
                <td>
                  {showCredentials
                    ? <><code>{unit.email ?? '—'}</code><br /><code>{unit.password ?? '—'}</code></>
                    : <span className="field-hint">oculta</span>}
                </td>
                <td><code className="admin-fingerprint">{unit.credential_fingerprint.slice(0, 12)}…</code></td>
                <td className="field-hint">
                  {unit.reservation_expires_at
                    ? `expira ${new Date(unit.reservation_expires_at).toLocaleString('pt-BR')}`
                    : '—'}
                </td>
                <td>{new Date(unit.created_at).toLocaleString('pt-BR')}</td>
                <td className="admin-row-actions">
                  {(unit.status === 'available' || unit.status === 'disabled') && (
                    <button
                      className="link-button"
                      type="button"
                      onClick={() => setUnitStatus(unit.id, unit.status === 'available' ? 'disabled' : 'available', unit.product_name)}
                    >
                      {unit.status === 'available' ? 'Desativar' : 'Reativar'}
                    </button>
                  )}
                  {unit.status === 'reserved' && <span className="field-hint">em uso</span>}
                </td>
              </tr>
            ))}
            {(stock?.items ?? []).length === 0 && (
              <tr><td colSpan={7} className="field-hint">Nenhuma unidade encontrada para o filtro atual.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {stock && stock.total > stock.items.length && (
        <p className="field-hint" role="status">
          {stock.total} unidade(s) no total · exibindo {stock.items.length} — refine os filtros para ver as demais.
        </p>
      )}

      <div className="admin-columns">
        <form className="admin-panel admin-form" onSubmit={addUnit}>
          <h2>Adicionar unidade</h2>
          <p className="field-hint">A credencial é cifrada (AES-256-GCM) antes de chegar ao banco. Só a entrega privada a decifra.</p>
          <div className="form-grid">
            <div className="form-field form-field--full">
              <label className="is-required" htmlFor="stock-product">Produto</label>
              <select id="stock-product" className="form-control" value={addProductId} onChange={(event) => setAddProductId(event.target.value)} required aria-describedby="stock-product-hint">
                <option value="">Selecione…</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>{product.name}</option>
                ))}
              </select>
              <p className="field-hint" id="stock-product-hint">Escolha o produto ao qual esta credencial pertence. Independente do filtro e da importação acima.</p>
            </div>
            <div className="form-field">
              <label className="is-required" htmlFor="stock-email">E-mail / login da conta</label>
              <input id="stock-email" className="form-control" type="email" autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} required aria-describedby="stock-email-hint" />
              <p className="field-hint" id="stock-email-hint">Credencial entregue ao cliente após a compra.</p>
            </div>
            <div className="form-field">
              <label className="is-required" htmlFor="stock-password">Senha da conta</label>
              <input id="stock-password" className="form-control" type="text" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} required aria-describedby="stock-password-hint" />
              <p className="field-hint" id="stock-password-hint">Mínimo de 6 caracteres. Fica cifrada no banco.</p>
            </div>
            <div className="form-field form-field--full">
              <label htmlFor="stock-notes">Observações internas (opcional)</label>
              <input id="stock-notes" className="form-control" value={notes} maxLength={500} onChange={(event) => setNotes(event.target.value)} aria-describedby="stock-notes-hint" />
              <p className="field-hint" id="stock-notes-hint">Não aparece para o cliente. Útil para registrar lote ou validade.</p>
            </div>
          </div>
          <button className="button button--primary" type="submit" disabled={addBusy}>
            {addBusy ? 'Cadastrando…' : 'Cadastrar unidade'}
          </button>
        </form>

        <section className="admin-panel admin-form">
          <h2>Importar CSV</h2>
          <p className="field-hint">
            Formato: uma credencial por linha, <code>email,senha,observação</code>. Cabeçalho opcional. Nada é gravado antes da prévia.
          </p>
          <div className="form-field">
            <label className="is-required" htmlFor="stock-import-product">Produto da importação</label>
            <select id="stock-import-product" className="form-control" value={importProductId} onChange={(event) => onImportProductChange(event.target.value)} required aria-describedby="stock-import-product-hint">
              <option value="">Selecione…</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>{product.name}</option>
              ))}
            </select>
            <p className="field-hint" id="stock-import-product-hint">Todas as linhas do arquivo serão vinculadas a este produto. Trocar o produto invalida a prévia.</p>
          </div>
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" onChange={onFile} />
          <textarea
            className="admin-csv"
            rows={6}
            placeholder={'conta1@exemplo.com,senha-forte-1\nconta2@exemplo.com,senha-forte-2'}
            value={csv}
            onChange={(event) => onCsvChange(event.target.value)}
            aria-label="Conteúdo CSV"
          />
          <div className="admin-row-actions">
            <button className="button button--secondary" type="button" onClick={runPreview} disabled={importBusy || !importProductId || csv.trim().length < 3}>
              Pré-visualizar
            </button>
            <button className="button button--primary" type="button" onClick={() => setConfirmImport(true)} disabled={importBusy || !canConfirmImport}>
              Importar {preview ? `${preview.valid_rows} válidas` : ''}
            </button>
          </div>

          {preview && previewProductId === importProductId && (
            <div className="admin-import-preview">
              <p>
                <strong>{preview.total_rows}</strong> linhas · <strong>{preview.valid_rows}</strong> válidas ·{' '}
                <strong>{preview.rejected_rows}</strong> rejeitadas · <strong>{preview.duplicated_in_file}</strong> duplicadas no arquivo
              </p>
              {preview.rejected.length > 0 && (
                <ul className="admin-list">
                  {preview.rejected.slice(0, 20).map((row) => (
                    <li key={row.row_number}><span>Linha {row.row_number}</span><span>{row.reason}</span></li>
                  ))}
                </ul>
              )}
              <p className="field-hint">Prévia com dados mascarados para o produto selecionado. A importação é parcial: linhas válidas entram, inválidas são reportadas.</p>
            </div>
          )}

          {report && (
            <div className="admin-import-report" role="status">
              <p>
                Importadas: <strong>{report.imported}</strong> · duplicadas: <strong>{report.duplicates}</strong> · inválidas:{' '}
                <strong>{report.invalid}</strong>
              </p>
              {report.failures.length > 0 && (
                <ul className="admin-list">
                  {report.failures.map((failure, index) => (
                    <li key={`${failure.row_number}-${index}`}><span>Linha {failure.row_number}</span><span>{failure.reason}</span></li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      </div>
      <ConfirmActionDialog
        open={pendingUnit !== null}
        title={pendingUnit?.next === 'disabled' ? 'Desativar unidade?' : 'Reativar unidade?'}
        description={
          pendingUnit?.next === 'disabled'
            ? `A unidade de ${pendingUnit?.name ?? ''} deixará de aparecer como disponível para venda. Pedidos já feitos não são alterados. Você pode reativá-la depois.`
            : `A unidade de ${pendingUnit?.name ?? ''} voltará a aparecer como disponível para venda.`
        }
        confirmLabel={pendingUnit?.next === 'disabled' ? 'Desativar' : 'Reativar'}
        danger={pendingUnit?.next === 'disabled'}
        busy={actionBusy}
        confirmDisabled={!disableValid}
        onConfirm={() => void confirmUnitStatus()}
        onCancel={() => setPendingUnit(null)}
      >
        {pendingUnit?.next === 'disabled' && (
          <>
            <div>
              <label htmlFor="stock-disable-reason">Motivo do ajuste (obrigatório)</label>
              <select
                id="stock-disable-reason"
                className="form-control"
                value={disableReason}
                onChange={(event) => setDisableReason(event.target.value as StockAdjustmentReason | '')}
              >
                <option value="">Selecione o motivo…</option>
                {STOCK_ADJUSTMENT_REASONS.map((reason) => (
                  <option key={reason.value} value={reason.value}>{reason.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="stock-disable-note">
                {disableReason === 'other' ? 'Nota (obrigatória para "outro motivo")' : 'Nota (opcional)'}
              </label>
              <input
                id="stock-disable-note"
                className="form-control"
                value={disableNote}
                maxLength={300}
                placeholder={disableReason === 'other' ? 'Descreva o motivo em pelo menos 5 caracteres' : 'Detalhe adicional para auditoria'}
                onChange={(event) => setDisableNote(event.target.value)}
              />
              <p className="field-hint">Fica registrado na auditoria (admin_audit_log) com quem, quando e por quê.</p>
            </div>
          </>
        )}
      </ConfirmActionDialog>
      <ConfirmActionDialog
        open={confirmImport}
        title="Importar unidades para o estoque?"
        description={
          canConfirmImport
            ? 'As linhas válidas da prévia serão gravadas como unidades cifradas no produto selecionado. A importação não pode ser desfeita em lote — unidades podem ser desativadas uma a uma depois.'
            : 'A prévia não corresponde ao produto selecionado para importação. Gere a prévia novamente para o produto atual.'
        }
        confirmLabel="Importar"
        danger
        busy={importBusy}
        confirmDisabled={!canConfirmImport}
        onConfirm={() => { setConfirmImport(false); void runImport(); }}
        onCancel={() => setConfirmImport(false)}
      />
    </div>
  );
}
