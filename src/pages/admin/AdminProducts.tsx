import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { categoryOptions as categories } from '../../data/categories';
import { centsToInput, formatCurrency, parseBrlToCents } from '../../lib/format';
import { adminApi, type AdminProduct, type ProductInput } from '../../services/adminApi';
import { ConfirmActionDialog } from '../../components/admin/ConfirmActionDialog';
import { Icon } from '../../components/Icon';
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

/** Custo pode ser zero (produto sem custo informado); negativo nunca. */
function parseCostToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return 0;
  const normalized = trimmed.includes(',')
    ? trimmed.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')
    : trimmed.replace(/[^\d.-]/g, '');
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** Inteiro em uma faixa, ou null se inválido/vazio. */
function parseBoundedInt(input: string, min: number, max: number): number | null {
  if (!input.trim()) return null;
  const value = Number(input);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

type FieldErrors = Partial<Record<keyof FormState, string>>;

type PendingDiscard =
  | { kind: 'new' }
  | { kind: 'cancel' }
  | { kind: 'edit'; product: AdminProduct }
  | null;

export function AdminProducts() {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<'' | 'active' | 'inactive'>('');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editSnapshot, setEditSnapshot] = useState<FormState>(EMPTY_FORM);
  const [editingActive, setEditingActive] = useState<boolean | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [imageError, setImageError] = useState(false);
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard>(null);
  const [detail, setDetail] = useState<{ product: AdminProduct; price_history: Array<Record<string, unknown>> } | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pendingToggle, setPendingToggle] = useState<AdminProduct | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const noticeRef = useRef<HTMLParagraphElement | null>(null);

  // Busca com pequeno atraso: evita uma requisição a cada tecla digitada.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await adminApi.listProducts(debouncedSearch, true);
      setProducts(result.products);
      setError(null);
    } catch (loadError) {
      setError(describeBackendError(loadError));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleProducts = products.filter((product) => {
    if (activeFilter === 'active') return product.is_active;
    if (activeFilter === 'inactive') return !product.is_active;
    return true;
  });

  const openDetail = async (productId: string) => {
    setDetailBusy(true);
    try {
      setDetail(await adminApi.getProduct(productId));
      setError(null);
    } catch (detailError) {
      setError(describeBackendError(detailError));
    } finally {
      setDetailBusy(false);
    }
  };

  const update = (field: keyof FormState, value: string | boolean) => {
    setForm((previous) => ({ ...previous, [field]: value }));
    if (field === 'imageUrl') setImageError(false);
    setFieldErrors((previous) => {
      if (!previous[field]) return previous;
      const next = { ...previous };
      delete next[field];
      return next;
    });
  };

  const isDirty = JSON.stringify(form) !== JSON.stringify(editSnapshot);

  const scrollToForm = (focusName = false) => {
    try {
      formRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    } catch {
      // Ambientes sem scrollIntoView (ex.: jsdom) apenas ignoram a rolagem.
    }
    if (focusName) {
      // Espera a rolagem começar para não perder o foco em telas pequenas.
      setTimeout(() => document.getElementById('product-name')?.focus(), 350);
    }
  };

  const doNew = () => {
    setForm(EMPTY_FORM);
    setEditSnapshot(EMPTY_FORM);
    setEditingActive(null);
    setFieldErrors({});
    setImageError(false);
    setNotice(null);
    setError(null);
    scrollToForm(true);
  };

  const doCancelEdit = () => {
    setForm(EMPTY_FORM);
    setEditSnapshot(EMPTY_FORM);
    setEditingActive(null);
    setFieldErrors({});
    setImageError(false);
    setNotice(null);
    scrollToForm();
  };

  const doEdit = (product: AdminProduct) => {
    const next: FormState = {
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
    };
    setForm(next);
    setEditSnapshot(next);
    setEditingActive(product.is_active);
    setFieldErrors({});
    setImageError(false);
    setNotice(`Editando "${product.name}".`);
    scrollToForm(true);
  };

  const requestNew = () => {
    if (isDirty) {
      setPendingDiscard({ kind: 'new' });
      return;
    }
    doNew();
  };

  const requestCancelEdit = () => {
    if (isDirty) {
      setPendingDiscard({ kind: 'cancel' });
      return;
    }
    doCancelEdit();
  };

  const requestEdit = (product: AdminProduct) => {
    if (isDirty && product.id !== form.id) {
      setPendingDiscard({ kind: 'edit', product });
      return;
    }
    doEdit(product);
  };

  const confirmDiscard = () => {
    if (!pendingDiscard) return;
    if (pendingDiscard.kind === 'new') doNew();
    else if (pendingDiscard.kind === 'cancel') doCancelEdit();
    else doEdit(pendingDiscard.product);
    setPendingDiscard(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const errors: FieldErrors = {};
    const name = form.name.trim();
    if (name.length < 3) {
      errors.name = 'Informe o nome do produto (mínimo de 3 caracteres).';
    }
    const priceCents = parseBrlToCents(form.price);
    if (priceCents === null) {
      errors.price = 'Informe o preço de venda em reais, maior que zero (ex.: 49,90).';
    }
    const costCents = parseCostToCents(form.cost);
    if (costCents === null) {
      errors.cost = 'Custo de aquisição inválido. Use zero ou um valor positivo (ex.: 12,50).';
    }
    const maxQuantity = parseBoundedInt(form.maxQuantity, 1, 20);
    if (maxQuantity === null) {
      errors.maxQuantity = 'Quantidade máxima por pedido deve ser um inteiro entre 1 e 20.';
    }
    const validityRaw = form.validityDays.trim();
    const validityDays = validityRaw ? parseBoundedInt(validityRaw, 1, 3650) : null;
    if (validityRaw && validityDays === null) {
      errors.validityDays = 'Validade do acesso deve ser um inteiro de dias entre 1 e 3650 (ou vazio para sem validade).';
    }
    const slug = form.id ? undefined : slugify(form.slug || form.name);
    if (!form.id && !slug) {
      errors.slug = 'Informe um slug válido: letras minúsculas, números e hífens.';
    }
    const imageUrl = form.imageUrl.trim();
    if (imageUrl && !isHttpUrl(imageUrl)) {
      errors.imageUrl = 'Informe uma URL de imagem válida começando com http:// ou https:// (ou deixe o campo vazio para usar o monograma).';
    }

    const firstInvalid = (Object.keys(errors) as Array<keyof FormState>)[0];
    if (firstInvalid) {
      setFieldErrors(errors);
      setError(errors[firstInvalid] ?? 'Verifique os campos destacados no formulário.');
      const inputId: Partial<Record<keyof FormState, string>> = {
        name: 'product-name',
        slug: 'product-slug',
        price: 'product-price',
        cost: 'product-cost',
        maxQuantity: 'product-max',
        validityDays: 'product-validity-days',
        imageUrl: 'product-image',
      };
      const target = inputId[firstInvalid];
      if (target) document.getElementById(target)?.focus();
      return;
    }
    setFieldErrors({});

    const payload: ProductInput = {
      name,
      slug,
      category_id: form.categoryId,
      price_cents: priceCents as number,
      cost_cents: costCents as number,
      max_quantity_per_order: maxQuantity as number,
      access_validity_days: validityDays,
      access_validity_label: form.validityLabel.trim() || null,
      short_description: form.shortDescription.trim(),
      description: form.description.trim(),
      instructions: form.instructions.trim(),
      conditions: form.conditions.split('\n').map((line) => line.trim()).filter(Boolean),
      modality: form.modality.trim(),
      period: form.period.trim(),
      monogram: form.monogram.trim().slice(0, 2) || 'P',
      theme: form.theme,
      image_url: imageUrl || null,
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
      setEditSnapshot(EMPTY_FORM);
      setEditingActive(null);
      setImageError(false);
      await load();
      noticeRef.current?.focus();
    } catch (submitError) {
      setError(describeBackendError(submitError));
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = (product: AdminProduct) => {
    setPendingToggle(product);
  };

  const confirmToggleActive = async () => {
    if (!pendingToggle) return;
    setActionBusy(true);
    try {
      await adminApi.setProductActive(pendingToggle.id, !pendingToggle.is_active);
      setNotice(`${pendingToggle.name}: ${pendingToggle.is_active ? 'desativado' : 'ativado'}.`);
      setPendingToggle(null);
      await load();
    } catch (toggleError) {
      setError(describeBackendError(toggleError));
      setPendingToggle(null);
    } finally {
      setActionBusy(false);
    }
  };

  // Pré-visualizações ao vivo (somente leitura — não alteram o payload).
  const pricePreview = parseBrlToCents(form.price);
  const costPreview = parseCostToCents(form.cost);
  const marginPreview =
    pricePreview !== null && costPreview !== null ? pricePreview - costPreview : null;
  const marginPercent =
    marginPreview !== null && pricePreview ? Math.round((marginPreview / pricePreview) * 100) : null;
  const slugPreview = form.id ? form.slug : slugify(form.slug || form.name);
  const categoryPreview = categories.find((category) => category.id === form.categoryId)?.label ?? form.categoryId;
  const trimmedImageUrl = form.imageUrl.trim();

  const describedBy = (hintId: string, field: keyof FormState) =>
    fieldErrors[field] ? `${hintId} product-${field}-error` : hintId;

  const fieldError = (field: keyof FormState) =>
    fieldErrors[field] ? (
      <p className="field-error" id={`product-${field}-error`}>{fieldErrors[field]}</p>
    ) : null;

  const stockTotal = products.length;
  const activeCount = products.filter((product) => product.is_active).length;
  const noStockCount = products.filter((product) => product.available_units === 0).length;
  const previewName = form.name.trim() || 'Nome do produto';
  const previewPrice = pricePreview !== null ? formatCurrency(pricePreview) : 'R$ 0,00';

  return (
    <div className="admin-section prod-page">
      {error && <div className="payment-warning" role="alert"><p>{error}</p></div>}
      {notice && <p className="admin-notice" role="status" ref={noticeRef} tabIndex={-1}>{notice}</p>}

      <section className="prod-list" aria-label="Catálogo de produtos">
        <div className="prod-toolbar">
          <label className="prod-search">
            <Icon name="search" size={17} />
            <input
              type="search"
              placeholder="Buscar por nome ou slug"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Buscar produtos"
            />
          </label>
          <select
            className="form-control prod-filter"
            value={activeFilter}
            onChange={(event) => setActiveFilter(event.target.value as '' | 'active' | 'inactive')}
            aria-label="Filtrar por situação"
          >
            <option value="">Todas as situações</option>
            <option value="active">Somente ativos</option>
            <option value="inactive">Somente inativos</option>
          </select>
          <button className="button button--primary prod-new" type="button" onClick={requestNew}>
            <Icon name="plus" size={16} /> Novo produto
          </button>
        </div>

        <ul className="prod-summary" aria-label="Resumo do catálogo">
          <li><strong>{stockTotal}</strong> produtos cadastrados</li>
          <li><strong>{activeCount}</strong> ativos na loja</li>
          <li className={noStockCount > 0 ? 'is-alert' : undefined}><strong>{noStockCount}</strong> sem estoque</li>
        </ul>

        <div className="prod-table" aria-busy={loading}>
          <table className="admin-table prod-table__grid">
            <thead>
              <tr>
                <th>Produto</th>
                <th>Categoria</th>
                <th>Preço</th>
                <th>Estoque</th>
                <th>Situação</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {visibleProducts.map((product) => (
                <tr key={product.id}>
                  <td data-label="Produto">
                    <div className="prod-row">
                      <span className="product-thumb" aria-hidden="true">
                        {product.image_url ? (
                          <img src={product.image_url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                        ) : (
                          <span>{product.monogram}</span>
                        )}
                      </span>
                      <span className="product-cell">
                        <strong>{product.name}</strong>
                        <small>/{product.slug}</small>
                      </span>
                    </div>
                  </td>
                  <td data-label="Categoria">{product.category_label}</td>
                  <td data-label="Preço">
                    <strong className="prod-price">{formatCurrency(product.price_cents)}</strong>
                    <small className="prod-price__meta">
                      custo {formatCurrency(product.cost_cents)} · margem {formatCurrency(product.margin_cents)}
                    </small>
                  </td>
                  <td data-label="Estoque">
                    <span className={`prod-stock${product.available_units === 0 ? ' is-empty' : product.available_units <= 2 ? ' is-low' : ''}`}>
                      <strong>{product.available_units}</strong> disponíveis
                    </span>
                    <small className="prod-stock__meta">
                      {product.reserved_units} reservada(s) · {product.sold_units} vendida(s)
                    </small>
                  </td>
                  <td data-label="Situação">
                    <span className={`admin-badge${product.is_active ? ' is-on' : ' is-off'}`}>
                      {product.is_active ? 'ativo' : 'inativo'}
                    </span>
                    {product.is_featured && <span className="admin-badge is-warn">destaque</span>}
                  </td>
                  <td data-label="Ações">
                    <div className="prod-actions">
                      <button className="button button--ghost button--small" type="button" onClick={() => openDetail(product.id)} disabled={detailBusy}>
                        Detalhes
                      </button>
                      <button className="button button--secondary button--small" type="button" onClick={() => requestEdit(product)}>
                        Editar
                      </button>
                      <button className="button button--ghost button--small" type="button" onClick={() => toggleActive(product)}>
                        {product.is_active ? 'Desativar' : 'Ativar'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {visibleProducts.length === 0 && (
                <tr>
                  <td colSpan={6} className="field-hint">
                    {products.length === 0
                      ? 'Nenhum produto cadastrado ainda. Use “Novo produto” para criar o primeiro.'
                      : 'Nenhum produto neste filtro. Ajuste a busca ou a situação.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="prod-table__foot">
            {loading ? 'Carregando produtos…' : `${visibleProducts.length} produto(s) exibido(s) de ${products.length}`}
            <span>Produtos não são excluídos do banco: desativar retira do catálogo sem apagar o histórico.</span>
          </p>
        </div>
      </section>

      {detail && (
        <section className="admin-panel prod-detail" aria-label="Detalhes do produto">
          <div className="admin-panel__header">
            <div>
              <span className="eyebrow-label">DETALHES DO PRODUTO</span>
              <h2>Detalhes — {detail.product.name}</h2>
            </div>
            <button className="button button--secondary button--small" type="button" onClick={() => setDetail(null)}>Fechar</button>
          </div>
          <div className="prod-detail__body">
            <div className="prod-detail__media">
              {detail.product.image_url ? (
                <img src={detail.product.image_url} alt={`Imagem de ${detail.product.name}`} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
              ) : (
                <span className={`product-art product-art--card product-art--${detail.product.theme}`} aria-hidden="true">
                  <span className="product-art__monogram">{detail.product.monogram}</span>
                </span>
              )}
            </div>
            <dl className="admin-detail-grid">
              <div><dt>Slug</dt><dd>/{detail.product.slug}</dd></div>
              <div><dt>Categoria</dt><dd>{detail.product.category_label}</dd></div>
              <div><dt>Situação</dt><dd>{detail.product.is_active ? 'ativo' : 'inativo'}{detail.product.is_featured ? ' · destacado' : ''}</dd></div>
              <div><dt>Preço</dt><dd>{formatCurrency(detail.product.price_cents)}</dd></div>
              <div><dt>Custo</dt><dd>{formatCurrency(detail.product.cost_cents)}</dd></div>
              <div><dt>Margem</dt><dd>{formatCurrency(detail.product.margin_cents)}</dd></div>
              <div><dt>Estoque</dt><dd>{detail.product.available_units} disponíveis · {detail.product.reserved_units} reservadas · {detail.product.sold_units} vendidas</dd></div>
              <div><dt>Qtd. máx. por pedido</dt><dd>{detail.product.max_quantity_per_order}</dd></div>
              <div><dt>Validade</dt><dd>{detail.product.access_validity_days ? `${detail.product.access_validity_days} dias` : 'sem validade'}{detail.product.access_validity_label ? ` · ${detail.product.access_validity_label}` : ''}</dd></div>
              <div><dt>Modalidade</dt><dd>{detail.product.modality}</dd></div>
              <div><dt>Período</dt><dd>{detail.product.period}</dd></div>
              <div><dt>Atualizado em</dt><dd>{new Date(detail.product.updated_at).toLocaleString('pt-BR')}</dd></div>
            </dl>
          </div>
          {detail.product.description && <p className="prod-detail__description">{detail.product.description}</p>}
          {detail.price_history.length > 0 && (
            <>
              <h3 className="admin-subheading">Histórico de preço</h3>
              <div className="admin-table-wrapper admin-table-wrapper--flat">
                <table className="admin-table">
                  <thead>
                    <tr><th>Data</th><th>Preço anterior</th><th>Preço novo</th><th>Custo anterior</th><th>Custo novo</th></tr>
                  </thead>
                  <tbody>
                    {detail.price_history.map((entry, index) => (
                      <tr key={index}>
                        <td>{entry.changed_at ? new Date(String(entry.changed_at)).toLocaleString('pt-BR') : '—'}</td>
                        <td>{typeof entry.old_price_cents === 'number' ? formatCurrency(entry.old_price_cents) : '—'}</td>
                        <td>{typeof entry.new_price_cents === 'number' ? formatCurrency(entry.new_price_cents) : '—'}</td>
                        <td>{typeof entry.old_cost_cents === 'number' ? formatCurrency(entry.old_cost_cents) : '—'}</td>
                        <td>{typeof entry.new_cost_cents === 'number' ? formatCurrency(entry.new_cost_cents) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      <form ref={formRef} id="produto-form" className="prod-form" onSubmit={submit} noValidate>
        <header className="prod-form__head">
          <div className="prod-form__head-copy">
            <span className="prod-form__eyebrow">CATÁLOGO · {form.id ? 'EDIÇÃO' : 'NOVO CADASTRO'}</span>
            <h2>{form.id ? 'Editar produto' : 'Novo produto'}</h2>
            <p>
              {form.id
                ? 'Atualize os dados do produto. As alterações de preço ficam registradas no histórico.'
                : 'Preencha as informações abaixo para colocar um produto à venda. Campos com * são obrigatórios.'}
            </p>
          </div>
          <div className="prod-form__pills">
            <span className={`admin-pill${form.id ? (editingActive ? ' admin-pill--ok' : '') : ''}`}>
              {form.id ? (editingActive ? 'Publicado na loja' : 'Não publicado') : 'Rascunho não salvo'}
            </span>
            {isDirty && <span className="admin-pill admin-pill--warn">Alterações não salvas</span>}
          </div>
        </header>

        <div className="prod-form__body">
          <div className="prod-form__main">
            <section className="prod-card prod-card--info" aria-labelledby="product-form-info">
              <div className="prod-card__head">
                <span className="prod-card__step" aria-hidden="true">1</span>
                <div>
                  <h3 id="product-form-info">Informações principais</h3>
                  <p>O que o cliente vê no catálogo: nome, categoria e descrições.</p>
                </div>
              </div>
              <div className="prod-card__body form-grid">
                <div className="form-field form-field--full">
                  <label className="is-required" htmlFor="product-name">Nome</label>
                  <input
                    id="product-name"
                    className="form-control form-control--lg"
                    value={form.name}
                    onChange={(event) => update('name', event.target.value)}
                    required
                    aria-invalid={Boolean(fieldErrors.name)}
                    aria-describedby={describedBy('product-name-hint', 'name')}
                    placeholder="Ex.: Streaming Premium — 30 dias"
                  />
                  <p className="field-hint" id="product-name-hint">Nome do produto exibido no catálogo, no carrinho e no pedido do cliente.</p>
                  {fieldError('name')}
                </div>
                <div className="form-field">
                  <label htmlFor="product-category">Categoria</label>
                  <select id="product-category" className="form-control" value={form.categoryId} onChange={(event) => update('categoryId', event.target.value)} aria-describedby="product-category-hint">
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>{category.label}</option>
                    ))}
                  </select>
                  <p className="field-hint" id="product-category-hint">Agrupa o produto nas vitrines e filtros da loja.</p>
                </div>
                <div className="form-field">
                  <label htmlFor="product-slug">Slug (URL)</label>
                  <input
                    id="product-slug"
                    className="form-control"
                    value={form.slug}
                    onChange={(event) => update('slug', event.target.value)}
                    placeholder={slugify(form.name) || 'produto-exemplo'}
                    disabled={Boolean(form.id)}
                    aria-invalid={Boolean(fieldErrors.slug)}
                    aria-describedby={describedBy('product-slug-hint', 'slug')}
                  />
                  <p className="field-hint" id="product-slug-hint">
                    {form.id
                      ? 'O endereço (slug) não pode ser alterado depois que o produto é criado.'
                      : 'Gerado a partir do nome. Só altere se precisar de um endereço específico.'}
                  </p>
                  {!form.id && slugPreview && <p className="product-form__preview">Endereço final: /{slugPreview}</p>}
                  {fieldError('slug')}
                </div>
                <div className="form-field">
                  <label htmlFor="product-short">Descrição curta</label>
                  <input id="product-short" className="form-control" value={form.shortDescription} onChange={(event) => update('shortDescription', event.target.value)} placeholder="Uma frase que resume o produto" aria-describedby="product-short-hint" />
                  <p className="field-hint" id="product-short-hint">Frase exibida no cartão do produto.</p>
                </div>
                <div className="form-field">
                  <label htmlFor="product-modality">Modalidade</label>
                  <input id="product-modality" className="form-control" value={form.modality} onChange={(event) => update('modality', event.target.value)} aria-describedby="product-modality-hint" />
                  <p className="field-hint" id="product-modality-hint">Ex.: conta compartilhada, licença.</p>
                </div>
                <div className="form-field">
                  <label htmlFor="product-period">Período</label>
                  <input id="product-period" className="form-control" value={form.period} onChange={(event) => update('period', event.target.value)} aria-describedby="product-period-hint" />
                  <p className="field-hint" id="product-period-hint">Ex.: 30 dias, mensal, vitalício.</p>
                </div>
                <div className="form-field form-field--full">
                  <label htmlFor="product-description">Descrição completa</label>
                  <textarea id="product-description" className="form-control" rows={4} value={form.description} onChange={(event) => update('description', event.target.value)} placeholder="Detalhe o que está incluído, limites de uso e o que o cliente recebe." aria-describedby="product-description-hint" />
                  <p className="field-hint" id="product-description-hint">Texto principal da página do produto.</p>
                </div>
              </div>
            </section>

            <section className="prod-card prod-card--image" aria-labelledby="product-form-image">
              <div className="prod-card__head">
                <span className="prod-card__step" aria-hidden="true">2</span>
                <div>
                  <h3 id="product-form-image">Imagens</h3>
                  <p>Imagem de capa do produto no catálogo. Sem imagem, a loja usa o monograma.</p>
                </div>
              </div>
              <div className="prod-card__body">
                <div className="product-form__image">
                  <div className="form-field product-form__image-field">
                    <label htmlFor="product-image">URL da imagem (opcional)</label>
                    <input
                      id="product-image"
                      className="form-control"
                      value={form.imageUrl}
                      onChange={(event) => update('imageUrl', event.target.value)}
                      placeholder="https://exemplo.com/imagem.jpg"
                      aria-invalid={Boolean(fieldErrors.imageUrl)}
                      aria-describedby={describedBy('product-image-hint', 'imageUrl')}
                    />
                    <p className="field-hint" id="product-image-hint">Cole a URL completa da imagem (começando com https://). A pré-visualização aparece ao lado.</p>
                    {fieldError('imageUrl')}
                  </div>
                  <div className="product-form__image-side">
                    <div className="product-form__image-preview">
                      {trimmedImageUrl ? (
                        imageError ? (
                          <span className="product-form__image-fallback">Não foi possível carregar esta imagem. Verifique a URL.</span>
                        ) : (
                          <img
                            src={trimmedImageUrl}
                            alt="Pré-visualização da imagem do produto"
                            onError={() => setImageError(true)}
                            onLoad={() => setImageError(false)}
                          />
                        )
                      ) : (
                        <span className="product-form__image-fallback">
                          Sem imagem — a loja exibirá o monograma “{form.monogram.trim().slice(0, 2) || 'P'}”.
                        </span>
                      )}
                    </div>
                    <div className="product-form__image-actions">
                      <span className="admin-pill">Imagem principal</span>
                      {trimmedImageUrl && (
                        <button className="button button--ghost button--small" type="button" onClick={() => update('imageUrl', '')}>
                          Limpar imagem
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="prod-card prod-card--content" aria-labelledby="product-form-content">
              <div className="prod-card__head">
                <span className="prod-card__step" aria-hidden="true">3</span>
                <div>
                  <h3 id="product-form-content">Entrega e condições</h3>
                  <p>Orientações enviadas ao cliente e regras de uso do produto.</p>
                </div>
              </div>
              <div className="prod-card__body form-grid">
                <div className="form-field form-field--full">
                  <label htmlFor="product-instructions">Instruções de acesso (públicas)</label>
                  <textarea id="product-instructions" className="form-control" rows={3} value={form.instructions} onChange={(event) => update('instructions', event.target.value)} placeholder="Ex.: acesse com o e-mail e a senha enviados após a confirmação do pedido." aria-describedby="product-instructions-hint" />
                  <p className="field-hint" id="product-instructions-hint">Aparece na página de entrega. Nunca inclua senhas ou dados internos.</p>
                </div>
                <div className="form-field form-field--full">
                  <label htmlFor="product-conditions">Condições (uma por linha)</label>
                  <textarea id="product-conditions" className="form-control" rows={3} value={form.conditions} onChange={(event) => update('conditions', event.target.value)} placeholder={'Uso individual\nNão altere a senha da conta'} aria-describedby="product-conditions-hint" />
                  <p className="field-hint" id="product-conditions-hint">Cada linha vira um item da lista “Condições e limitações”.</p>
                </div>
              </div>
            </section>
          </div>

          <aside className="prod-form__aside">
            <section className="prod-card prod-card--price" aria-labelledby="product-form-price">
              <div className="prod-card__head">
                <span className="prod-card__step" aria-hidden="true">4</span>
                <div>
                  <h3 id="product-form-price">Preços</h3>
                  <p>Quanto o cliente paga e quanto a loja gasta.</p>
                </div>
              </div>
              <div className="prod-card__body">
                <div className="form-field">
                  <label className="is-required" htmlFor="product-price">Preço de venda (R$)</label>
                  <div className="prod-money">
                    <span aria-hidden="true">R$</span>
                    <input
                      id="product-price"
                      className="form-control"
                      inputMode="decimal"
                      value={form.price}
                      onChange={(event) => update('price', event.target.value)}
                      placeholder="0,00"
                      required
                      aria-invalid={Boolean(fieldErrors.price)}
                      aria-describedby={describedBy('product-price-hint', 'price')}
                    />
                  </div>
                  <p className="field-hint" id="product-price-hint">Valor que o cliente paga, em reais. Ex.: 49,90.</p>
                  {fieldError('price')}
                </div>
                <div className="form-field">
                  <label htmlFor="product-cost">Custo de aquisição (R$)</label>
                  <div className="prod-money">
                    <span aria-hidden="true">R$</span>
                    <input
                      id="product-cost"
                      className="form-control"
                      inputMode="decimal"
                      value={form.cost}
                      onChange={(event) => update('cost', event.target.value)}
                      placeholder="0,00"
                      aria-invalid={Boolean(fieldErrors.cost)}
                      aria-describedby={describedBy('product-cost-hint', 'cost')}
                    />
                  </div>
                  <p className="field-hint" id="product-cost-hint">Opcional — deixe vazio ou zero se não souber.</p>
                  {fieldError('cost')}
                </div>
                <p className="product-form__margin">
                  {marginPreview !== null && marginPercent !== null ? (
                    <>Margem estimada: <strong>{formatCurrency(marginPreview)}</strong> ({marginPercent}% do preço)</>
                  ) : (
                    'Informe o preço de venda para ver a margem estimada.'
                  )}
                </p>
              </div>
            </section>

            <section className="prod-card prod-card--stock" aria-labelledby="product-form-stock">
              <div className="prod-card__head">
                <span className="prod-card__step" aria-hidden="true">5</span>
                <div>
                  <h3 id="product-form-stock">Estoque e validade</h3>
                  <p>Limites de compra e duração do acesso.</p>
                </div>
              </div>
              <div className="prod-card__body">
                <div className="form-field">
                  <label htmlFor="product-max">Qtd. máxima por pedido</label>
                  <input
                    id="product-max"
                    className="form-control"
                    inputMode="numeric"
                    value={form.maxQuantity}
                    onChange={(event) => update('maxQuantity', event.target.value)}
                    aria-invalid={Boolean(fieldErrors.maxQuantity)}
                    aria-describedby={describedBy('product-max-hint', 'maxQuantity')}
                  />
                  <p className="field-hint" id="product-max-hint">Limite de unidades que um único pedido pode levar deste produto (1 a 20).</p>
                  {fieldError('maxQuantity')}
                </div>
                <div className="form-field">
                  <label htmlFor="product-validity-days">Validade do acesso (dias)</label>
                  <input
                    id="product-validity-days"
                    className="form-control"
                    inputMode="numeric"
                    value={form.validityDays}
                    onChange={(event) => update('validityDays', event.target.value)}
                    aria-invalid={Boolean(fieldErrors.validityDays)}
                    aria-describedby={describedBy('product-validity-days-hint', 'validityDays')}
                  />
                  <p className="field-hint" id="product-validity-days-hint">Por quantos dias o acesso vale após a entrega. Deixe vazio se não tiver validade.</p>
                  {fieldError('validityDays')}
                </div>
                <div className="form-field">
                  <label htmlFor="product-validity-label">Rótulo da validade</label>
                  <input id="product-validity-label" className="form-control" value={form.validityLabel} onChange={(event) => update('validityLabel', event.target.value)} aria-describedby="product-validity-label-hint" />
                  <p className="field-hint" id="product-validity-label-hint">Texto exibido na loja, ex.: “30 dias”.</p>
                </div>
                <p className="prod-note">
                  <Icon name="box" size={15} />
                  As unidades são cadastradas na aba <strong>Estoque</strong>. Sem unidade disponível o produto aparece como indisponível.
                </p>
              </div>
            </section>

            <section className="prod-card prod-card--publish" aria-labelledby="product-form-publish">
              <div className="prod-card__head">
                <span className="prod-card__step" aria-hidden="true">6</span>
                <div>
                  <h3 id="product-form-publish">Publicação e aparência</h3>
                  <p>Como o produto aparece na loja.</p>
                </div>
              </div>
              <div className="prod-card__body">
                <label className="terms-checkbox">
                  <input type="checkbox" checked={form.featured} onChange={(event) => update('featured', event.target.checked)} />
                  <span>Destacar na página inicial<small className="prod-check-hint">Aparece em “Selecionados da loja”.</small></span>
                </label>
                <div className="form-grid">
                  <div className="form-field">
                    <label htmlFor="product-monogram">Monograma</label>
                    <input id="product-monogram" className="form-control" maxLength={2} value={form.monogram} onChange={(event) => update('monogram', event.target.value)} aria-describedby="product-monogram-hint" />
                    <p className="field-hint" id="product-monogram-hint">1 ou 2 letras usadas sem foto.</p>
                  </div>
                  <div className="form-field">
                    <label htmlFor="product-theme">Tema da arte</label>
                    <select id="product-theme" className="form-control" value={form.theme} onChange={(event) => update('theme', event.target.value)} aria-describedby="product-theme-hint">
                      {['blue', 'green', 'violet', 'red', 'rose', 'gray', 'orange'].map((theme) => (
                        <option key={theme} value={theme}>{theme}</option>
                      ))}
                    </select>
                    <p className="field-hint" id="product-theme-hint">Cor exibida sem foto.</p>
                  </div>
                </div>
                <p className="prod-note">
                  <Icon name="alert" size={15} />
                  {form.id
                    ? (editingActive ? 'Este produto está publicado e visível no catálogo.' : 'Este produto está desativado: não aparece no catálogo da loja.')
                    : 'Depois de criar, cadastre unidades na aba Estoque e ative o produto na lista para publicá-lo.'}
                </p>
              </div>
            </section>

            <section className="prod-card prod-card--preview" aria-label="Prévia do produto na loja">
              <div className="prod-card__head">
                <span className="prod-card__step" aria-hidden="true">👁</span>
                <div>
                  <h3>Prévia na loja</h3>
                  <p>Como o cartão do produto deve aparecer.</p>
                </div>
              </div>
              <div className="prod-preview">
                <span className={`product-art product-art--card product-art--${form.theme}`} aria-hidden="true">
                  {trimmedImageUrl && !imageError ? (
                    <img className="product-art__image" src={trimmedImageUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="product-art__monogram">{form.monogram.trim().slice(0, 2) || 'P'}</span>
                  )}
                </span>
                <div className="prod-preview__copy">
                  <span className="eyebrow-label">{categoryPreview}</span>
                  <strong>{previewName}</strong>
                  <small>{form.shortDescription.trim() || 'Descrição curta do produto'}</small>
                  <span className="prod-preview__price">{previewPrice}</span>
                </div>
              </div>
            </section>
          </aside>
        </div>

        <div className="prod-form__bar">
          <p className="prod-form__summary">
            <strong>Resumo:</strong> {form.name.trim() || 'Sem nome'} · {categoryPreview} ·{' '}
            {pricePreview !== null ? formatCurrency(pricePreview) : 'sem preço'} ·{' '}
            {form.id
              ? (editingActive ? 'Publicado' : 'Não publicado')
              : 'Novo produto — depois de criar, adicione estoque na aba Estoque e ative na lista para publicar.'}
          </p>
          <div className="prod-form__actions">
            {form.id ? (
              <button className="button button--ghost" type="button" onClick={requestCancelEdit} disabled={busy}>Cancelar edição</button>
            ) : (
              <button className="button button--ghost" type="button" onClick={requestNew} disabled={busy}>Limpar</button>
            )}
            <button className="button button--primary button--lg" type="submit" disabled={busy}>
              {busy ? 'Salvando…' : form.id ? 'Salvar alterações' : 'Criar produto'}
            </button>
          </div>
        </div>
      </form>

      <ConfirmActionDialog
        open={pendingToggle !== null}
        title={pendingToggle?.is_active ? 'Desativar produto?' : 'Reativar produto?'}
        description={
          pendingToggle?.is_active
            ? `${pendingToggle?.name} sairá do catálogo da loja imediatamente (pedidos antigos mantêm o histórico). Você pode reativá-lo depois.`
            : `${pendingToggle?.name ?? ''} voltará a aparecer no catálogo da loja para novos pedidos.`
        }
        confirmLabel={pendingToggle?.is_active ? 'Desativar' : 'Reativar'}
        danger={pendingToggle?.is_active ?? false}
        busy={actionBusy}
        onConfirm={() => void confirmToggleActive()}
        onCancel={() => setPendingToggle(null)}
      />
      <ConfirmActionDialog
        open={pendingDiscard !== null}
        title="Descartar alterações?"
        description="Você tem alterações não salvas neste formulário. Se sair agora, elas serão perdidas."
        confirmLabel="Descartar alterações"
        danger
        onConfirm={confirmDiscard}
        onCancel={() => setPendingDiscard(null)}
      />
    </div>
  );
}
