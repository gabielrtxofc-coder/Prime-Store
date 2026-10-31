import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { categories } from '../../data/products';
import { centsToInput, formatCurrency, parseBrlToCents } from '../../lib/format';
import { adminApi, type AdminProduct, type ProductInput } from '../../services/adminApi';
import { describeBackendError } from '../../services/backend/http';

interface FormState {
  id: string | null;
  name: string;
  slug: string;
  categoryId: string;
  price: string;
  cost: string;
  maxQuantity: string;
  validityDays: string;
  validityLabel: string;
  shortDescription: string;
  description: string;
  instructions: string;
  conditions: string;
  modality: string;
  period: string;
  monogram: string;
  theme: string;
  imageUrl: string;
  featured: boolean;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  slug: '',
  categoryId: 'other',
  price: '',
  cost: '',
  maxQuantity: '1',
  validityDays: '30',
  validityLabel: '30 dias',
  shortDescription: '',
  description: '',
  instructions: '',
  conditions: '',
  modality: 'Produto digital',
  period: 'Acesso conforme validade',
  monogram: 'P',
  theme: 'blue',
  imageUrl: '',
  featured: false,
};

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

export function AdminProducts() {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await adminApi.listProducts(search, true);
      setProducts(result.products);
      setError(null);
    } catch (loadError) {
      setError(describeBackendError(loadError));
    }
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (field: keyof FormState, value: string | boolean) =>
    setForm((previous) => ({ ...previous, [field]: value }));

  const edit = (product: AdminProduct) => {
    setForm({
      id: product.id,
      name: product.name,
      slug: product.slug,
      categoryId: product.category_id,
      price: centsToInput(product.price_cents),
      cost: centsToInput(product.cost_cents),
      maxQuantity: String(product.max_quantity_per_order),
      validityDays: product.access_validity_days ? String(product.access_validity_days) : '',
      validityLabel: product.access_validity_label ?? '',
      shortDescription: product.short_description,
      description: product.description,
      instructions: product.instructions,
      conditions: (product.conditions ?? []).join('\n'),
      modality: product.modality,
      period: product.period,
      monogram: product.monogram,
      theme: product.theme,
      imageUrl: product.image_url ?? '',
      featured: product.is_featured,
    });
    setNotice(`Editando "${product.name}".`);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const priceCents = parseBrlToCents(form.price);
    if (priceCents === null) {
      setError('Informe o preço de venda em reais (ex.: 49,90).');
      return;
    }
    const costCents = form.cost.trim() ? parseBrlToCents(form.cost) : 0;
    if (costCents === null) {
      setError('Custo de aquisição inválido. Use apenas números (ex.: 12,50).');
      return;
    }
    const payload: ProductInput = {
      name: form.name.trim(),
      slug: form.id ? undefined : slugify(form.slug || form.name),
      category_id: form.categoryId,
      price_cents: priceCents,
      cost_cents: costCents,
      max_quantity_per_order: Number(form.maxQuantity) || 1,
      access_validity_days: form.validityDays.trim() ? Number(form.validityDays) : null,
      access_validity_label: form.validityLabel.trim() || null,
      short_description: form.shortDescription.trim(),
      description: form.description.trim(),
      instructions: form.instructions.trim(),
      conditions: form.conditions.split('\n').map((line) => line.trim()).filter(Boolean),
      modality: form.modality.trim(),
      period: form.period.trim(),
      monogram: form.monogram.trim().slice(0, 2) || 'P',
      theme: form.theme,
      image_url: form.imageUrl.trim() || null,
      is_featured: form.featured,
    };

    setBusy(true);
    try {
      if (form.id) {
        const patch = { ...payload };
        delete patch.slug;
        await adminApi.updateProduct(form.id, patch);
        setNotice('Produto atualizado. Alterações de preço ficam registradas no histórico.');
      } else {
        await adminApi.createProduct(payload);
        setNotice('Produto criado. Adicione unidades de estoque para liberá-lo no catálogo.');
      }
      setForm(EMPTY_FORM);
      await load();
    } catch (submitError) {
      setError(describeBackendError(submitError));
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (product: AdminProduct) => {
    try {
      await adminApi.setProductActive(product.id, !product.is_active);
      setNotice(`${product.name}: ${product.is_active ? 'desativado' : 'ativado'}.`);
      await load();
    } catch (toggleError) {
      setError(describeBackendError(toggleError));
    }
  };

  return (
    <div className="admin-section">
      {error && <div className="payment-warning" role="alert"><p>{error}</p></div>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}

      <div className="admin-toolbar">
        <input
          className="form-control admin-search"
          type="search"
          placeholder="Buscar por nome ou slug"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Buscar produtos"
        />
        <button className="button button--secondary button--small" type="button" onClick={() => { setForm(EMPTY_FORM); setNotice(null); }}>
          Novo produto
        </button>
      </div>

      <div className="admin-table-wrapper">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Produto</th>
              <th>Categoria</th>
              <th>Preço</th>
              <th>Custo</th>
              <th>Margem</th>
              <th>Estoque</th>
              <th>Status</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id}>
                <td>
                  <strong>{product.name}</strong>
                  <small>/{product.slug}</small>
                </td>
                <td>{product.category_label}</td>
                <td>{formatCurrency(product.price_cents)}</td>
                <td>{formatCurrency(product.cost_cents)}</td>
                <td>{formatCurrency(product.margin_cents)}</td>
                <td>
                  {product.available_units} disp · {product.reserved_units} res · {product.sold_units} vendidas
                </td>
                <td>
                  <span className={`admin-badge${product.is_active ? ' is-on' : ' is-off'}`}>
                    {product.is_active ? 'ativo' : 'inativo'}
                  </span>
                </td>
                <td className="admin-row-actions">
                  <button className="link-button" type="button" onClick={() => edit(product)}>Editar</button>
                  <button className="link-button" type="button" onClick={() => toggleActive(product)}>
                    {product.is_active ? 'Desativar' : 'Ativar'}
                  </button>
                </td>
              </tr>
            ))}
            {products.length === 0 && (
              <tr>
                <td colSpan={8} className="field-hint">Nenhum produto cadastrado. Use o formulário abaixo para criar o primeiro.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <form className="admin-panel admin-form" onSubmit={submit}>
        <h2>{form.id ? 'Editar produto' : 'Novo produto'}</h2>
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor="product-name">Nome</label>
            <input id="product-name" value={form.name} onChange={(event) => update('name', event.target.value)} required />
          </div>
          <div className="form-field">
            <label htmlFor="product-slug">Slug (URL)</label>
            <input
              id="product-slug"
              value={form.slug}
              onChange={(event) => update('slug', event.target.value)}
              placeholder={slugify(form.name) || 'produto-exemplo'}
              disabled={Boolean(form.id)}
            />
          </div>
          <div className="form-field">
            <label htmlFor="product-category">Categoria</label>
            <select id="product-category" value={form.categoryId} onChange={(event) => update('categoryId', event.target.value)}>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.label}</option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="product-price">Preço de venda (R$)</label>
            <input id="product-price" inputMode="decimal" value={form.price} onChange={(event) => update('price', event.target.value)} required />
          </div>
          <div className="form-field">
            <label htmlFor="product-cost">Custo de aquisição (R$)</label>
            <input id="product-cost" inputMode="decimal" value={form.cost} onChange={(event) => update('cost', event.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="product-max">Qtd. máxima por pedido</label>
            <input id="product-max" inputMode="numeric" value={form.maxQuantity} onChange={(event) => update('maxQuantity', event.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="product-validity-days">Validade do acesso (dias)</label>
            <input id="product-validity-days" inputMode="numeric" value={form.validityDays} onChange={(event) => update('validityDays', event.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="product-validity-label">Rótulo da validade</label>
            <input id="product-validity-label" value={form.validityLabel} onChange={(event) => update('validityLabel', event.target.value)} />
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="product-short">Descrição curta</label>
            <input id="product-short" value={form.shortDescription} onChange={(event) => update('shortDescription', event.target.value)} />
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="product-description">Descrição completa</label>
            <textarea id="product-description" rows={3} value={form.description} onChange={(event) => update('description', event.target.value)} />
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="product-instructions">Instruções de acesso (públicas)</label>
            <textarea id="product-instructions" rows={3} value={form.instructions} onChange={(event) => update('instructions', event.target.value)} />
            <p className="field-hint">Aparece na página de entrega. Nunca inclua senhas ou dados internos.</p>
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="product-conditions">Condições (uma por linha)</label>
            <textarea id="product-conditions" rows={2} value={form.conditions} onChange={(event) => update('conditions', event.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="product-modality">Modalidade</label>
            <input id="product-modality" value={form.modality} onChange={(event) => update('modality', event.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="product-period">Período</label>
            <input id="product-period" value={form.period} onChange={(event) => update('period', event.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="product-monogram">Monograma</label>
            <input id="product-monogram" maxLength={2} value={form.monogram} onChange={(event) => update('monogram', event.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="product-theme">Tema visual</label>
            <select id="product-theme" value={form.theme} onChange={(event) => update('theme', event.target.value)}>
              {['blue', 'green', 'violet', 'red', 'rose', 'gray', 'orange'].map((theme) => (
                <option key={theme} value={theme}>{theme}</option>
              ))}
            </select>
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="product-image">URL da imagem (opcional)</label>
            <input id="product-image" value={form.imageUrl} onChange={(event) => update('imageUrl', event.target.value)} />
          </div>
          <label className="terms-checkbox form-field--full">
            <input type="checkbox" checked={form.featured} onChange={(event) => update('featured', event.target.checked)} />
            <span>Destacar na página inicial</span>
          </label>
        </div>
        <div className="admin-row-actions">
          <button className="button button--primary" type="submit" disabled={busy}>
            {busy ? 'Salvando…' : form.id ? 'Salvar alterações' : 'Criar produto'}
          </button>
          {form.id && (
            <button className="button button--secondary" type="button" onClick={() => setForm(EMPTY_FORM)}>Cancelar edição</button>
          )}
        </div>
      </form>
    </div>
  );
}
