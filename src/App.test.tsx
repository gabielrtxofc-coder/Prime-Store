import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { CartProvider } from './context/CartContext';
import { CatalogProvider } from './context/CatalogContext';
import { ToastProvider } from './context/ToastContext';
import { catalogService } from './services/catalogService';
import { clearRequestReceipts } from './services/requestService';

/**
 * Missão 08 — jornada pública da loja SEM pagamento e SEM administração.
 *
 * O backend (Edge Functions `catalog`, `order-request` e `order-status`) é
 * simulado no nível do `fetch`: o teste exercita os componentes reais, o
 * carrinho real e os contratos HTTP esperados.
 */

const AVULSO = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  slug: 'acesso-avulso',
  name: 'Acesso avulso',
  shortDescription: 'Um acesso liberado por pedido',
  description: 'Acesso avulso para uso imediato após a confirmação.',
  imageUrl: null,
  categoryId: 'productivity',
  categoryLabel: 'Produtividade',
  modality: 'Acesso avulso',
  period: '30 dias',
  priceCents: 4990,
  monogram: 'A',
  theme: 'green',
  maxQuantity: 5,
  allowQuantity: true,
  featured: true,
  availableUnits: 3,
  available: true,
  instructions: 'Instruções enviadas após a confirmação.',
  conditions: [],
};

const MENSAL = {
  ...AVULSO,
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  slug: 'acesso-mensal',
  name: 'Acesso mensal',
  shortDescription: 'Assinatura mensal',
  description: 'Acesso mensal renovado a cada 30 dias.',
  categoryId: 'creative',
  categoryLabel: 'Design e criatividade',
  priceCents: 2990,
  monogram: 'M',
  theme: 'violet',
  maxQuantity: 2,
  availableUnits: 2,
  featured: false,
};

const ESGOTADO = {
  ...AVULSO,
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  slug: 'acesso-esgotado',
  name: 'Acesso esgotado',
  shortDescription: 'Sem unidades',
  description: 'Produto sem unidades disponíveis no momento.',
  priceCents: 1990,
  monogram: 'E',
  theme: 'gray',
  availableUnits: 0,
  available: false,
  featured: false,
};

interface BackendOptions {
  products?: unknown[];
  catalogError?: boolean;
  failFirstRequest?: boolean;
  insufficientStock?: boolean;
  refuseStatus?: boolean;
}

interface OrderRecord {
  order_id: string;
  reference: string;
  token: string;
  status: string;
  payment_status: string;
  delivery_status: string;
  items: Array<{
    product_id: string;
    product_name: string;
    product_slug: string;
    quantity: number;
    unit_price_cents: number;
    subtotal_cents: number;
  }>;
  total_cents: number;
  quantity: number;
  unit_price_cents: number;
  created_at: string;
  buyer_name: string | null;
}

/**
 * Backend simulado: responde `catalog`, `order-request` e `order-status` com os
 * mesmos formatos das Edge Functions reais.
 */
function stubBackend(options: BackendOptions = {}) {
  const products = options.products ?? [AVULSO, MENSAL, ESGOTADO];
  const orders = new Map<string, OrderRecord>();
  const idempotency = new Map<string, string>();
  let requestCount = 0;
  let sequence = 0;
  let catalogRequests = 0;

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (url.endsWith('/catalog')) {
      catalogRequests += 1;
      if (options.catalogError) return jsonResponse({ error: 'internal_error' }, 500);
      return jsonResponse({ products, generated_at: new Date().toISOString() });
    }

    if (url.endsWith('/create-order')) {
      // Ambiente SEM chave de pagamento (cenário real desta suíte): o servidor
      // responde 503 e o checkout cai para a solicitação sem pagamento.
      return jsonResponse(
        { error: 'payment_not_configured', message: 'Pagamento indisponível neste ambiente.' },
        503,
      );
    }

    if (url.endsWith('/order-request')) {
      requestCount += 1;
      if (options.failFirstRequest && requestCount === 1) {
        return jsonResponse({ error: 'internal_error', message: 'Não foi possível concluir a operação.' }, 500);
      }
      if (options.insufficientStock) {
        return jsonResponse({ error: 'insufficient_stock', message: 'Estoque insuficiente.', available_units: 0 }, 409);
      }

      const items = body.items as Array<{ product_id: string; quantity: number }>;
      const key = String(body.idempotency_key ?? '');
      const existing = idempotency.get(key);
      if (existing) {
        const order = orders.get(existing)!;
        return jsonResponse({ order, client_token: order.token, idempotent_replay: true });
      }

      sequence += 1;
      const resolved = items.map((item) => {
        const product = [AVULSO, MENSAL, ESGOTADO].find((candidate) => candidate.id === item.product_id)!;
        return {
          product_id: product.id,
          product_name: product.name,
          product_slug: product.slug,
          quantity: item.quantity,
          unit_price_cents: product.priceCents,
          subtotal_cents: product.priceCents * item.quantity,
        };
      });
      const total = resolved.reduce((sum, item) => sum + item.subtotal_cents, 0);
      const quantity = resolved.reduce((sum, item) => sum + item.quantity, 0);
      const order: OrderRecord = {
        order_id: `0f0e0d0c-0000-4000-8000-00000000000${sequence}`,
        reference: `PS-ABC12${sequence}`,
        token: String(body.client_token),
        status: 'requested',
        payment_status: 'not_required',
        delivery_status: 'not_ready',
        items: resolved,
        total_cents: total,
        quantity,
        unit_price_cents: resolved[0].unit_price_cents,
        created_at: '2026-11-01T12:00:00.000Z',
        buyer_name: String(body.buyer_name),
      };
      orders.set(order.order_id, order);
      idempotency.set(key, order.order_id);
      return jsonResponse({ order, client_token: order.token, idempotent_replay: false }, 201);
    }

    if (url.endsWith('/order-status')) {
      if (options.refuseStatus) return jsonResponse({ error: 'not_found', message: 'Registro não encontrado.' }, 404);
      const found = Array.from(orders.values()).find(
        (order) =>
          order.order_id === body.order_id ||
          order.reference === String(body.reference ?? '').toUpperCase(),
      );
      if (!found || found.token !== body.client_token) {
        return jsonResponse({ error: 'not_found', message: 'Registro não encontrado.' }, 404);
      }
      return jsonResponse({
        ...found,
        paid_at: null,
        reservation_expires_at: found.created_at,
        items_count: found.items.length,
        product: {
          id: found.items[0].product_id,
          slug: found.items[0].product_slug,
          name: found.items[0].product_name,
          instructions: '',
          access_validity_label: '30 dias',
          is_demo: false,
        },
        payment: null,
        delivery: null,
        availability: { available_units: 3 },
      });
    }

    return jsonResponse({ error: 'not_found' }, 404);
  });

  vi.stubGlobal('fetch', fetchMock);

  return {
    fetchMock,
    orders,
    get requestCount() {
      return requestCount;
    },
    get catalogRequests() {
      return catalogRequests;
    },
  };
}

function enableBackend() {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://exemplo.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'chave-anon');
  vi.stubEnv('VITE_BACKEND_ENABLED', 'true');
}

function renderShopAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CatalogProvider>
        <CartProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </CartProvider>
      </CatalogProvider>
    </MemoryRouter>,
  );
}

async function fillCheckout(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Nome completo'), 'Ana da Silva');
  await user.type(screen.getByLabelText('E-mail'), 'ana@example.com');
  await user.type(screen.getByLabelText('Confirme seu e-mail'), 'ana@example.com');
  await user.click(screen.getByRole('checkbox'));
}

beforeEach(() => {
  enableBackend();
  catalogService.reset();
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearRequestReceipts();
});

afterEach(() => {
  catalogService.reset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('catálogo servido pelo backend', () => {
  it('lista os produtos reais, com preço, disponibilidade e categoria vindos do servidor', async () => {
    stubBackend();
    renderShopAt('/produtos');

    expect(await screen.findByRole('link', { name: 'Acesso avulso' })).toBeInTheDocument();
    expect(screen.getAllByText(/R\$\s*49,90/).length).toBeGreaterThan(0);
    expect(screen.getByText('3 unidade(s) disponível(is)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Produtividade' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Design e criatividade' })).toBeInTheDocument();
  });

  it('marca o produto sem unidades e não permite adicioná-lo', async () => {
    stubBackend();
    renderShopAt('/produtos');

    const soldOutCard = (await screen.findByRole('link', { name: 'Acesso esgotado' })).closest('article')!;
    expect(within(soldOutCard).getByText('INDISPONÍVEL')).toBeInTheDocument();
    expect(within(soldOutCard).getByRole('button', { name: /Acesso esgotado indisponível/i })).toBeDisabled();
  });

  it('mostra erro com ação de recarregar em vez de produtos fictícios quando o backend falha', async () => {
    const backend = stubBackend({ catalogError: true });
    renderShopAt('/produtos');

    expect(await screen.findByText(/Não foi possível carregar o catálogo/i)).toBeInTheDocument();
    expect(screen.queryByText(/Acesso avulso/i)).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(backend.catalogRequests).toBeGreaterThan(1));
  });

  it('não exibe catálogo quando o backend não está configurado', async () => {
    vi.unstubAllEnvs();
    const backend = stubBackend();
    renderShopAt('/produtos');

    expect(await screen.findByText(/não está conectada ao catálogo/i)).toBeInTheDocument();
    expect(screen.queryByText(/Acesso avulso/i)).not.toBeInTheDocument();
    expect(backend.fetchMock).not.toHaveBeenCalled();
  });

  it('atualiza preço e disponibilidade ao reabrir o catálogo', async () => {
    const backend = stubBackend();
    const first = renderShopAt('/produtos');
    await screen.findByRole('link', { name: 'Acesso avulso' });
    first.unmount();

    // O produto some do estoque entre as duas visitas.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ products: [{ ...AVULSO, availableUnits: 0, available: false }], generated_at: new Date().toISOString() }), {
          status: 200,
        }),
      ),
    );

    renderShopAt('/produtos');
    expect(await screen.findByText('INDISPONÍVEL')).toBeInTheDocument();
    expect(backend.catalogRequests).toBeGreaterThan(0);
  });
});

describe('jornada principal sem pagamento', () => {
  it('catálogo → produto → carrinho → finalização → confirmação → acompanhamento', async () => {
    stubBackend();
    const user = userEvent.setup();
    const shop = renderShopAt('/');

    // 1. Catálogo
    await user.click(screen.getByRole('link', { name: /Explorar catálogo/i }));
    expect(await screen.findByRole('heading', { name: 'Produtos digitais' })).toBeInTheDocument();

    // 2. Produto: duas unidades do primeiro item
    await user.click(await screen.findByRole('link', { name: 'Acesso avulso' }));
    expect(await screen.findByRole('heading', { name: 'Acesso avulso' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Aumentar quantidade do produto' }));
    await user.click(screen.getByRole('button', { name: /Adicionar ao carrinho/i }));

    // 3. Segundo produto, voltando ao catálogo pelo link da própria página
    await user.click(screen.getByRole('link', { name: 'Continuar comprando' }));
    await user.click(await screen.findByRole('button', { name: /Adicionar Acesso mensal ao carrinho/i }));

    // 4. Carrinho com dois produtos
    await user.click(screen.getByRole('link', { name: 'Carrinho, 3 itens' }));
    expect(await screen.findByRole('heading', { name: 'Carrinho', level: 1 })).toBeInTheDocument();
    expect(screen.getAllByText(/R\$\s*129,70/).length).toBeGreaterThan(0);

    // 5. Finalização: sem qualquer método de pagamento
    await user.click(screen.getByRole('link', { name: /Continuar para finalizar/i }));
    expect(await screen.findByRole('heading', { name: 'Finalizar pedido' })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByText(/PIX|Cartão de crédito|Mercado Pago/i)).not.toBeInTheDocument();

    // Dados inválidos primeiro
    const submit = screen.getByRole('button', { name: /Finalizar pedido/i });
    expect(submit).toBeDisabled();
    const nameField = screen.getByLabelText('Nome completo');
    await user.type(nameField, 'A');
    await user.tab();
    expect(screen.getByText('Informe seu nome completo.')).toBeInTheDocument();

    // 6. Envio
    await user.clear(nameField);
    await fillCheckout(user);
    expect(submit).toBeEnabled();
    await user.click(submit);

    // 7. Confirmação persistida
    expect(await screen.findByRole('heading', { name: 'Seu pedido foi registrado' })).toBeInTheDocument();
    expect(screen.getByText('PS-ABC121')).toBeInTheDocument();
    expect(screen.getByText(/aguarda confirmação/i)).toBeInTheDocument();
    expect(screen.getByText(/Nenhum pagamento foi realizado/i)).toBeInTheDocument();
    expect(screen.queryByText(/aprovado|compra concluída|pedido pago|liberado/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/R\$\s*129,70/).length).toBeGreaterThan(0);

    const code = screen.getByTestId('tracking-code-value').textContent ?? '';
    expect(code.length).toBeGreaterThanOrEqual(32);
    expect(screen.getByRole('link', { name: 'Carrinho, 0 itens' })).toBeInTheDocument();

    // 8. Recarregar a confirmação (novo "carregamento" da página)
    shop.unmount();
    const path = '/pedido/0f0e0d0c-0000-4000-8000-000000000001';
    const reloaded = renderShopAt(path);
    expect(await screen.findAllByText('PS-ABC121')).not.toHaveLength(0);
    expect(screen.getByText('Aguardando confirmação')).toBeInTheDocument();
    reloaded.unmount();

    // 9. Consultar de novo pelo número + código
    renderShopAt('/acompanhar');
    await user.type(await screen.findByLabelText('Número do pedido'), 'PS-ABC121');
    await user.type(screen.getByLabelText('Código de acompanhamento'), code);
    await user.click(screen.getByRole('button', { name: /Ver estado do pedido/i }));

    expect(await screen.findByRole('heading', { name: 'Seu pedido foi registrado' })).toBeInTheDocument();
    expect(screen.getByText('Aguardando confirmação')).toBeInTheDocument();
    expect(screen.getByText(/Nenhum pagamento foi realizado/i)).toBeInTheDocument();
  }, 30000);

  it('envio duplicado (duplo clique) registra uma única solicitação', async () => {
    const backend = stubBackend();
    const user = userEvent.setup();
    renderShopAt('/produto/acesso-avulso');

    await user.click(await screen.findByRole('button', { name: /Adicionar ao carrinho/i }));
    await user.click(screen.getByRole('link', { name: 'Carrinho, 1 item' }));
    await user.click(await screen.findByRole('link', { name: /Continuar para finalizar/i }));
    await fillCheckout(user);

    const submit = screen.getByRole('button', { name: /Finalizar pedido/i });
    await user.dblClick(submit);

    expect(await screen.findByRole('heading', { name: 'Seu pedido foi registrado' })).toBeInTheDocument();
    expect(backend.requestCount).toBe(1);
  });

  it('falha de conexão mantém o carrinho e permite reenviar com a mesma tentativa', async () => {
    const backend = stubBackend({ failFirstRequest: true });
    const user = userEvent.setup();
    renderShopAt('/produto/acesso-avulso');

    await user.click(await screen.findByRole('button', { name: /Adicionar ao carrinho/i }));
    await user.click(screen.getByRole('link', { name: 'Carrinho, 1 item' }));
    await user.click(await screen.findByRole('link', { name: /Continuar para finalizar/i }));
    await fillCheckout(user);

    await user.click(screen.getByRole('button', { name: /Finalizar pedido/i }));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((alert) => /Não foi possível concluir a operação/i.test(alert.textContent ?? ''))).toBe(true);
    expect(screen.getByRole('link', { name: 'Carrinho, 1 item' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Finalizar pedido/i }));
    expect(await screen.findByRole('heading', { name: 'Seu pedido foi registrado' })).toBeInTheDocument();
    expect(backend.requestCount).toBe(2);
  }, 20000);

  it('estoque acabou durante a navegação: mensagem clara e nenhum pedido criado', async () => {
    stubBackend({ insufficientStock: true });
    const user = userEvent.setup();
    renderShopAt('/produto/acesso-avulso');

    await user.click(await screen.findByRole('button', { name: /Adicionar ao carrinho/i }));
    await user.click(screen.getByRole('link', { name: 'Carrinho, 1 item' }));
    await user.click(await screen.findByRole('link', { name: /Continuar para finalizar/i }));
    await fillCheckout(user);
    await user.click(screen.getByRole('button', { name: /Finalizar pedido/i }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((alert) => /Outro cliente finalizou a compra/i.test(alert.textContent ?? ''))).toBe(true);
    expect(screen.queryByText('PS-ABC121')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Carrinho, 1 item' })).toBeInTheDocument();
  }, 20000);
});

describe('carrinho', () => {
  it('sobrevive a recarregar a página e mantém quantidades normalizadas', async () => {
    stubBackend();
    const user = userEvent.setup();
    const first = renderShopAt('/produto/acesso-avulso');

    await user.click(await screen.findByRole('button', { name: /Adicionar ao carrinho/i }));
    await user.click(screen.getByRole('button', { name: 'Aumentar quantidade do produto' }));
    await user.click(screen.getByRole('button', { name: /Adicionar ao carrinho/i }));
    // 1 unidade + 2 unidades = 3 no carrinho.
    first.unmount();

    renderShopAt('/carrinho');
    expect(await screen.findByRole('heading', { name: 'Carrinho', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Carrinho, 3 itens' })).toBeInTheDocument();
    expect(screen.getAllByText(/R\$\s*149,70/).length).toBeGreaterThan(0);
  });

  it('mostra e permite remover item que ficou indisponível depois de adicionado', async () => {
    stubBackend();
    const user = userEvent.setup();
    renderShopAt('/produto/acesso-avulso');
    await user.click(await screen.findByRole('button', { name: /Adicionar ao carrinho/i }));

    // A segunda visita encontra o produto sem unidades.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ products: [{ ...AVULSO, availableUnits: 0, available: false }] }), { status: 200 }),
      ),
    );

    renderShopAt('/carrinho');
    expect(await screen.findByText(/Itens indisponíveis não entram no pedido/i)).toBeInTheDocument();
    expect(screen.getByText(/Acesso avulso — sem unidades no momento/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Continuar para finalizar/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'remover' }));
    expect(await screen.findByRole('heading', { name: 'Seu carrinho está vazio' })).toBeInTheDocument();
  });

  it('não deixa finalizar com carrinho vazio e recupera armazenamento corrompido', async () => {
    stubBackend();
    window.localStorage.setItem('prime-store-cart-v2', '{nao-e-json');
    renderShopAt('/carrinho');

    expect(await screen.findByRole('heading', { name: 'Seu carrinho está vazio' })).toBeInTheDocument();
    expect(window.localStorage.getItem('prime-store-cart-v2')).toBe('[]');
  });

  it('impede quantidade acima da disponibilidade', async () => {
    stubBackend();
    const user = userEvent.setup();
    renderShopAt('/produto/acesso-avulso');

    await screen.findByRole('heading', { name: 'Acesso avulso' });
    const increase = screen.getByRole('button', { name: 'Aumentar quantidade do produto' });
    await user.click(increase);
    await user.click(increase);
    // 3 unidades disponíveis: o botão desabilita no limite.
    expect(increase).toBeDisabled();
    expect(screen.getByLabelText('3 unidades')).toBeInTheDocument();
  });
});

describe('acompanhamento e privacidade', () => {
  it('pedido inexistente não revela dados', async () => {
    stubBackend();
    const user = userEvent.setup();
    renderShopAt('/acompanhar');

    await user.type(await screen.findByLabelText('Número do pedido'), 'PS-ZZZZZZ');
    await user.type(screen.getByLabelText('Código de acompanhamento'), 'x'.repeat(40));
    await user.click(screen.getByRole('button', { name: /Ver estado do pedido/i }));

    expect(await screen.findByRole('heading', { name: 'Pedido não encontrado' })).toBeInTheDocument();
    expect(screen.queryByText(/Acesso avulso/i)).not.toBeInTheDocument();
  });

  it('código de outra pessoa não abre o pedido', async () => {
    const backend = stubBackend();
    const user = userEvent.setup();
    const shop = renderShopAt('/produto/acesso-avulso');
    await user.click(await screen.findByRole('button', { name: /Adicionar ao carrinho/i }));
    await user.click(screen.getByRole('link', { name: 'Carrinho, 1 item' }));
    await user.click(await screen.findByRole('link', { name: /Continuar para finalizar/i }));
    await fillCheckout(user);
    await user.click(screen.getByRole('button', { name: /Finalizar pedido/i }));
    await screen.findByRole('heading', { name: 'Seu pedido foi registrado' });
    shop.unmount();

    // Outro visitante tem o número, mas não o código.
    renderShopAt('/acompanhar');
    await user.type(await screen.findByLabelText('Número do pedido'), 'PS-ABC121');
    await user.type(screen.getByLabelText('Código de acompanhamento'), 'z'.repeat(48));
    await user.click(screen.getByRole('button', { name: /Ver estado do pedido/i }));

    expect(await screen.findByRole('heading', { name: 'Pedido não encontrado' })).toBeInTheDocument();
    expect(screen.queryByText(/Ana da Silva/i)).not.toBeInTheDocument();
    expect(backend.requestCount).toBe(1);
  }, 20000);

  it('abrir o pedido sem código pede o código em vez de mostrar dados', async () => {
    stubBackend();
    renderShopAt('/pedido/0f0e0d0c-0000-4000-8000-00000000000a');

    expect(await screen.findByRole('heading', { name: 'Abrir pedido' })).toBeInTheDocument();
    expect(screen.getByLabelText('Código de acompanhamento')).toBeInTheDocument();
    expect(screen.queryByText(/Acesso avulso/i)).not.toBeInTheDocument();
  });

  it('a rota de pagamento existe e exige um pedido pendente; a rota administrativa foi restaurada (missão 03.2A)', async () => {
    stubBackend();
    // Sem pedido pendente nesta sessão, a tela de pagamento não mostra nada —
    // apenas convida a iniciar um checkout. Nenhum dado de pedido vaza.
    const payment = renderShopAt('/pagamento');
    expect(await screen.findByRole('heading', { name: 'Nenhum pedido em andamento' })).toBeInTheDocument();
    payment.unmount();

    // Acesso direto a /admin (missão 03.2A): abre o painel, mas sem sessão
    // administrativa renderiza o login — nunca a 404 pública, nunca dados do painel.
    renderShopAt('/admin');
    expect(await screen.findByRole('heading', { name: 'Painel administrativo' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Não encontramos esta página' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Seções do painel' })).not.toBeInTheDocument();
    expect(document.title).toBe('Prime Store — Administração');
  });
});

describe('estrutura da loja', () => {
  it.each([
    ['/', /Seu próximo favorito está a um clique/i, 'Prime Store — Início'],
    ['/produtos', 'Produtos digitais', 'Prime Store — Catálogo'],
    ['/carrinho', 'Seu carrinho está vazio', 'Prime Store — Carrinho'],
    ['/acompanhar', 'Acompanhar pedido', 'Prime Store — Acompanhar pedido'],
    ['/faq', 'Perguntas frequentes', 'Prime Store — Perguntas frequentes'],
    ['/ajuda', 'Como podemos ajudar?', 'Prime Store — Atendimento'],
    ['/sobre', 'Uma ideia em construção.', 'Prime Store — Sobre a loja'],
    ['/termos', 'Termos comerciais', 'Prime Store — Termos comerciais provisórios'],
    ['/privacidade', 'Política de privacidade', 'Prime Store — Privacidade'],
    ['/nao-existe', 'Não encontramos esta página', 'Prime Store — Página não encontrada'],
  ])('renderiza a página e o título em %s', async (path, heading, title) => {
    stubBackend();
    renderShopAt(path);
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(document.title).toBe(title);
  });

  it('abre o menu mobile e navega pelos links', async () => {
    stubBackend();
    const user = userEvent.setup();
    renderShopAt('/');
    await screen.findByRole('heading', { name: /Seu próximo favorito/i });

    const menuButton = screen.getByRole('button', { name: 'Abrir menu' });
    await user.click(menuButton);
    expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await user.click(within(screen.getByRole('navigation', { name: 'Navegação mobile' })).getByRole('link', { name: 'Catálogo' }));
    expect(await screen.findByRole('heading', { name: 'Produtos digitais' })).toBeInTheDocument();
  });

  it('leva a busca do cabeçalho para o catálogo', async () => {
    stubBackend();
    const user = userEvent.setup();
    renderShopAt('/');
    await screen.findByRole('heading', { name: /Seu próximo favorito/i });

    await user.click(screen.getByRole('button', { name: 'Abrir busca' }));
    const search = document.getElementById('mobile-product-search') as HTMLInputElement;
    await user.type(search, 'mensal{Enter}');

    expect(await screen.findByRole('heading', { name: 'Produtos digitais' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Buscar por nome ou descrição')).toHaveValue('mensal');
    expect(screen.getAllByRole('link', { name: /Acesso mensal/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: /Acesso esgotado/i })).not.toBeInTheDocument();
  });

  it('responde perguntas frequentes por teclado e por busca', async () => {
    stubBackend();
    const user = userEvent.setup();
    renderShopAt('/faq');

    const question = screen.getByRole('button', { name: /Como funciona um pedido na Prime Store/i });
    question.focus();
    expect(question).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Enter}');
    expect(question).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/solicitação é registrada no servidor/i)).toBeInTheDocument();

    const search = screen.getByPlaceholderText('Buscar uma pergunta');
    await user.type(search, 'código de acompanhamento');
    expect(screen.getByRole('button', { name: /Como acompanho a minha solicitação/i })).toBeInTheDocument();
  });
});
