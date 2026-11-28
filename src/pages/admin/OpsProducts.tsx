import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ConfirmActionDialog } from '../../components/admin/ConfirmActionDialog';
import { opsApi, type OpsProduct, type OpsProductPatch } from '../../services/adminApi';
import { describeBackendError } from '../../services/backend/http';

/**
 * Produtos — PERFIL OPERACIONAL.
 *
 * Mostra e altera apenas informações operacionais (nome, textos, imagem,
 * validade exibida, limite por pedido, destaque, ativo). Preço aparece só para
 * conferência; custo, margem, slug, categoria, histórico de preços e criação
 * de produtos ficam no perfil administrativo. O banco aplica a mesma regra
 * (ops_update_product recusa qualquer outro campo).
 */

interface FormState {
  name: string;
  short_description: string;
  description: string;
  instructions: string;
  conditions: string;
  image_url: string;
  access_validity_label: string;
  max_quantity_per_order: string;
  is_featured: boolean;
}

function toForm(product: OpsProduct): FormState {
  return {
    name: product.name ?? '',
    short_description: product.short_description ?? '',
    description: product.description ?? '',
    instructions: product.instructions ?? '',
    conditions: (product.conditions ?? []).join('\n'),
    image_url: product.image_url ?? '',
    access_validity_label: product.access_validity_label ?? '',
    max_quantity_per_order: String(product.max_quantity_per_order ?? 1),
    is_featured: Boolean(product.is_featured),
  };
}

/** Só envia o que mudou — e só campos operacionais. */
function diff(product: OpsProduct, form: FormState): OpsProductPatch {
  const patch: OpsProductPatch = {};
  const base = toForm(product);
  if (form.name.trim() !== base.name) patch.name = form.name.trim();
  if (form.short_description.trim() !== base.short_description) patch.short_description = form.short_description.trim();
  if (form.description.trim() !== base.description) patch.description = form.description.trim();
  if (form.instructions.trim() !== base.instructions) patch.instructions = form.instructions.trim();
  if (form.conditions !== base.conditions) {
    patch.conditions = form.conditions
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }
  if (form.image_url.trim() !== base.image_url) patch.image_url = form.image_url.trim() || null;
  if (form.access_validity_label.trim() !== base.access_validity_label) {
    patch.access_validity_label = form.access_validity_label.trim() || null;
  }
  if (form.max_quantity_per_order !== base.max_quantity_per_order) {
    patch.max_quantity_per_order = Number(form.max_quantity_per_order);
  }
  if (form.is_featured !== base.is_featured) patch.is_featured = form.is_featured;
  return patch;
}

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function OpsProducts() {
  const [products, setProducts] = useState<OpsProduct[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingToggle, setPendingToggle] = useState<OpsProduct | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await opsApi.listProducts(search.trim(), true);
      setProducts(result.products ?? []);
      setError(null);
    } catch (loadError) {
      setError(describeBackendError(loadError));
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void load();
    // Busca é disparada pelo formulário; só carregamos na montagem.
  }, []);

  const selected = useMemo(() => products.find((item) => item.id === selectedId) ?? null, [products, selectedId]);
  const patch = selected && form ? diff(selected, form) : {};
  const dirty = Object.keys(patch).length > 0;

  const openEditor = (product: OpsProduct) => {
    setSelectedId(product.id);
    setForm(toForm(product));
    setNotice(null);
    setError(null);
  };

  const closeEditor = () => {
    setSelectedId(null);
    setForm(null);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !form || !dirty) return;
    const max = Number(form.max_quantity_per_order);
    if (!Number.isInteger(max) || max < 1 || max > 20) {
      setError('Limite por pedido deve ser um número inteiro entre 1 e 20.');
      return;
    }
    if (form.name.trim().length < 2) {
      setError('Informe o nome do produto.');
      return;
    }
    setSaving(true);
    try {
      const result = await opsApi.updateProduct(selected.id, patch);
      setProducts((current) => current.map((item) => (item.id === selected.id ? { ...item, ...result.product } : item)));
      setForm(toForm({ ...selected, ...result.product }));
      setNotice(`Produto "${result.product.name}" atualizado.`);
      setError(null);
    } catch (saveError) {
      setError(describeBackendError(saveError));
    } finally {
      setSaving(false);
    }
  };

  const confirmToggle = async () => {
    if (!pendingToggle) return;
    setToggleBusy(true);
    try {
      const result = await opsApi.setProductActive(pendingToggle.id, !pendingToggle.is_active);
      setProducts((current) =>
        current.map((item) => (item.id === pendingToggle.id ? { ...item, is_active: result.product.is_active } : item)),
      );
      setNotice(result.product.is_active ? 'Produto ativado na loja.' : 'Produto desativado na loja.');
      setError(null);
    } catch (toggleError) {
      setError(describeBackendError(toggleError));
    } finally {
      setToggleBusy(false);
      setPendingToggle(null);
    }
  };

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  return (
    <div className="admin-section">
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      {error && (
        <div className="payment-warning" role="alert">
          <p>{error}</p>
        </div>
      )}

      <form
        className="admin-filters"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <div className="admin-filter-field">
          <span className="admin-filter-label" aria-hidden="true">Buscar</span>
          <input
            className="form-control"
            type="search"
            value={search}
            placeholder="Nome do produto"
            aria-label="Buscar produto"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="admin-filter-field admin-filter-field--actions">
          <button className="button button--secondary button--small" type="submit">Buscar</button>
        </div>
      </form>

      <div className="admin-table-wrapper">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Produto</th>
              <th>Preço</th>
              <th>Disponíveis</th>
              <th>Situação</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id}>
                <td>{product.name}</td>
                <td>{currency.format((product.price_cents ?? 0) / 100)}</td>
                <td>{product.available_units ?? 0}</td>
                <td>
                  <span className={`admin-badge${product.is_active ? ' is-on' : ' is-off'}`}>
                    {product.is_active ? 'ativo' : 'inativo'}
                  </span>
                  {product.is_featured && <span className="admin-badge is-warn">destaque</span>}
                </td>
                <td className="admin-row-actions">
                  <button className="link-button" type="button" onClick={() => openEditor(product)}>Editar</button>
                  <button className="link-button" type="button" onClick={() => setPendingToggle(product)}>
                    {product.is_active ? 'Desativar' : 'Ativar'}
                  </button>
                </td>
              </tr>
            ))}
            {!loading && products.length === 0 && (
              <tr><td colSpan={5} className="field-hint">Nenhum produto encontrado.</td></tr>
            )}
            {loading && (
              <tr><td colSpan={5} className="field-hint">Carregando produtos…</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && form && (
        <form className="admin-panel admin-form" onSubmit={save} aria-label="Editar informações do produto">
          <div className="admin-panel__header">
            <h2>Editar: {selected.name}</h2>
            <button className="link-button" type="button" onClick={closeEditor}>Fechar</button>
          </div>
          <p className="field-hint">
            Preço, custo, categoria e endereço do produto são alterados apenas no acesso administrativo completo.
          </p>
          <div className="form-grid">
            <div className="form-field form-field--full">
              <label className="is-required" htmlFor="ops-name">Nome</label>
              <input id="ops-name" className="form-control" value={form.name} maxLength={120} onChange={(e) => update('name', e.target.value)} required />
            </div>
            <div className="form-field form-field--full">
              <label htmlFor="ops-short">Resumo</label>
              <input id="ops-short" className="form-control" value={form.short_description} maxLength={280} onChange={(e) => update('short_description', e.target.value)} />
            </div>
            <div className="form-field form-field--full">
              <label htmlFor="ops-description">Descrição</label>
              <textarea id="ops-description" className="form-control" rows={4} maxLength={8000} value={form.description} onChange={(e) => update('description', e.target.value)} />
            </div>
            <div className="form-field form-field--full">
              <label htmlFor="ops-instructions">Instruções de uso</label>
              <textarea id="ops-instructions" className="form-control" rows={3} maxLength={4000} value={form.instructions} onChange={(e) => update('instructions', e.target.value)} />
            </div>
            <div className="form-field form-field--full">
              <label htmlFor="ops-conditions">Condições (uma por linha)</label>
              <textarea id="ops-conditions" className="form-control" rows={3} value={form.conditions} onChange={(e) => update('conditions', e.target.value)} />
            </div>
            <div className="form-field form-field--full">
              <label htmlFor="ops-image">Imagem (URL)</label>
              <input id="ops-image" className="form-control" type="url" placeholder="https://…" value={form.image_url} onChange={(e) => update('image_url', e.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="ops-validity">Validade exibida</label>
              <input id="ops-validity" className="form-control" value={form.access_validity_label} maxLength={120} onChange={(e) => update('access_validity_label', e.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="ops-max">Limite por pedido</label>
              <input id="ops-max" className="form-control" type="number" min={1} max={20} value={form.max_quantity_per_order} onChange={(e) => update('max_quantity_per_order', e.target.value)} />
            </div>
            <div className="form-field form-field--full">
              <label className="admin-inline-check">
                <input type="checkbox" checked={form.is_featured} onChange={(e) => update('is_featured', e.target.checked)} />
                Destacar na vitrine
              </label>
            </div>
          </div>
          <button className="button button--primary" type="submit" disabled={saving || !dirty}>
            {saving ? 'Salvando…' : 'Salvar alterações'}
          </button>
        </form>
      )}

      <ConfirmActionDialog
        open={pendingToggle !== null}
        title={pendingToggle?.is_active ? 'Desativar produto?' : 'Ativar produto?'}
        description={
          pendingToggle?.is_active
            ? `"${pendingToggle?.name ?? ''}" deixará de aparecer na loja. Pedidos já feitos não mudam.`
            : `"${pendingToggle?.name ?? ''}" voltará a aparecer na loja.`
        }
        confirmLabel={pendingToggle?.is_active ? 'Desativar' : 'Ativar'}
        danger={Boolean(pendingToggle?.is_active)}
        busy={toggleBusy}
        onConfirm={() => void confirmToggle()}
        onCancel={() => setPendingToggle(null)}
      />
    </div>
  );
}
