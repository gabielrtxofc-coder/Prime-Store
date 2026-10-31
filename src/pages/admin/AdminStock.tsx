import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { adminApi, type AdminProduct, type AdminStockList, type AdminStockSummary, type ImportPreview, type ImportReport } from '../../services/adminApi';
import { describeBackendError } from '../../services/backend/http';

const STATUS_FILTERS = ['', 'available', 'reserved', 'sold', 'disabled'] as const;

const STATUS_LABEL: Record<string, string> = {
  available: 'disponível',
  reserved: 'reservada',
  sold: 'vendida',
  disabled: 'desativada',
};

export function AdminStock() {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [productId, setProductId] = useState('');
  const [status, setStatus] = useState<string>('');
  const [stock, setStock] = useState<AdminStockList | null>(null);
  const [summary, setSummary] = useState<AdminStockSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCredentials, setShowCredentials] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notes, setNotes] = useState('');

  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('importacao.csv');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, summaryResult] = await Promise.all([
        adminApi.listStock({
          productId: productId || null,
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
  }, [productId, status, showCredentials]);

  useEffect(() => {
    void adminApi.listProducts('', true).then((result) => setProducts(result.products)).catch(() => setProducts([]));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addUnit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!productId) {
      setError('Selecione o produto antes de cadastrar uma unidade.');
      return;
    }
    try {
      await adminApi.addStock({ productId, email: email.trim(), password, notes: notes.trim() });
      setNotice('Unidade cadastrada. E-mail e senha foram cifrados antes de gravar.');
      setEmail('');
      setPassword('');
      setNotes('');
      await load();
    } catch (addError) {
      setError(describeBackendError(addError));
    }
  };

  const setUnitStatus = async (unitId: string, next: 'available' | 'disabled') => {
    try {
      await adminApi.setStockStatus(unitId, next);
      setNotice(`Unidade ${next === 'available' ? 'reativada' : 'desativada'}.`);
      await load();
    } catch (statusError) {
      setError(describeBackendError(statusError));
    }
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
    setPreview(null);
    setReport(null);
  };

  const runPreview = async () => {
    if (!productId) {
      setError('Selecione o produto da importação.');
      return;
    }
    setImportBusy(true);
    setError(null);
    try {
      setPreview(await adminApi.previewImport(productId, csv));
      setReport(null);
    } catch (previewError) {
      setError(describeBackendError(previewError));
    } finally {
      setImportBusy(false);
    }
  };

  const runImport = async () => {
    if (!productId) return;
    setImportBusy(true);
    setError(null);
    try {
      const result = await adminApi.commitImport(productId, csv, fileName);
      setReport(result.report);
      setPreview(null);
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
          <div className="admin-metric"><span>Total</span><strong>{summary.total}</strong></div>
          <div className="admin-metric"><span>Disponíveis</span><strong>{summary.available}</strong></div>
          <div className="admin-metric"><span>Reservadas</span><strong>{summary.reserved}</strong></div>
          <div className="admin-metric"><span>Vendidas</span><strong>{summary.sold}</strong></div>
          <div className="admin-metric"><span>Desativadas</span><strong>{summary.disabled}</strong></div>
        </div>
      )}

      <div className="admin-toolbar">
        <select
          className="form-control"
          value={productId}
          onChange={(event) => setProductId(event.target.value)}
          aria-label="Filtrar por produto"
        >
          <option value="">Todos os produtos</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>{product.name}</option>
          ))}
        </select>
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
        <label className="admin-inline-check">
          <input type="checkbox" checked={showCredentials} onChange={(event) => setShowCredentials(event.target.checked)} />
          Exibir credenciais (registrado em auditoria)
        </label>
        <button className="button button--secondary button--small" type="button" onClick={() => void load()}>Atualizar</button>
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
                <td><span className={`admin-badge${unit.status === 'available' ? ' is-on' : ' is-off'}`}>{STATUS_LABEL[unit.status] ?? unit.status}</span></td>
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
                      onClick={() => setUnitStatus(unit.id, unit.status === 'available' ? 'disabled' : 'available')}
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

      <div className="admin-columns">
        <form className="admin-panel admin-form" onSubmit={addUnit}>
          <h2>Adicionar unidade</h2>
          <p className="field-hint">A credencial é cifrada (AES-256-GCM) antes de chegar ao banco. Só a entrega privada a decifra.</p>
          <div className="form-grid">
            <div className="form-field form-field--full">
              <label htmlFor="stock-product">Produto</label>
              <select id="stock-product" value={productId} onChange={(event) => setProductId(event.target.value)} required>
                <option value="">Selecione…</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>{product.name}</option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="stock-email">E-mail / login da conta</label>
              <input id="stock-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </div>
            <div className="form-field">
              <label htmlFor="stock-password">Senha da conta</label>
              <input id="stock-password" type="text" value={password} onChange={(event) => setPassword(event.target.value)} required />
            </div>
            <div className="form-field form-field--full">
              <label htmlFor="stock-notes">Observações internas (opcional)</label>
              <input id="stock-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
            </div>
          </div>
          <button className="button button--primary" type="submit">Cadastrar unidade</button>
        </form>

        <section className="admin-panel admin-form">
          <h2>Importar CSV</h2>
          <p className="field-hint">
            Formato: uma credencial por linha, <code>email,senha,observação</code>. Cabeçalho opcional. Nada é gravado antes da prévia.
          </p>
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" onChange={onFile} />
          <textarea
            className="admin-csv"
            rows={6}
            placeholder={'conta1@exemplo.com,senha-forte-1\nconta2@exemplo.com,senha-forte-2'}
            value={csv}
            onChange={(event) => setCsv(event.target.value)}
            aria-label="Conteúdo CSV"
          />
          <div className="admin-row-actions">
            <button className="button button--secondary" type="button" onClick={runPreview} disabled={importBusy || csv.trim().length < 3}>
              Pré-visualizar
            </button>
            <button className="button button--primary" type="button" onClick={runImport} disabled={importBusy || !preview || preview.valid_rows === 0}>
              Importar {preview ? `${preview.valid_rows} válidas` : ''}
            </button>
          </div>

          {preview && (
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
              <p className="field-hint">Prévia com dados mascarados. A importação é parcial: linhas válidas entram, inválidas são reportadas.</p>
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
    </div>
  );
}
