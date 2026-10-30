import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import * as demoOrderService from './services/demoOrderService';
import { CartProvider } from './context/CartContext';
import { OrderProvider } from './context/OrderContext';
import { ToastProvider } from './context/ToastContext';

function renderShopAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CartProvider>
        <OrderProvider>
          <ToastProvider><App /></ToastProvider>
        </OrderProvider>
      </CartProvider>
    </MemoryRouter>,
  );
}

describe('Prime Store demo frontend', () => {
  it('renders the home page and navigates to the local catalog', async () => {
    const user = userEvent.setup();
    renderShopAt('/');

    expect(screen.getByRole('heading', { name: /Seu próximo favorito está a um clique/i })).toBeInTheDocument();
    expect(screen.getByText(/sem pagamento real/i)).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /Explorar catálogo/i }));
    expect(await screen.findByRole('heading', { name: 'Produtos digitais' })).toBeInTheDocument();
  });

  it('filters the catalog by search and category and clears filters', async () => {
    const user = userEvent.setup();
    renderShopAt('/produtos');

    const search = screen.getByPlaceholderText('Buscar por nome ou descrição');
    await user.type(search, 'templates');
    expect(screen.getAllByRole('link', { name: /Kit de templates digitais/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: /Spotify/i })).not.toBeInTheDocument();

    await user.clear(search);
    await user.click(screen.getByRole('button', { name: 'Música' }));
    expect(screen.getAllByRole('link', { name: /Spotify/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: /Kit de templates digitais/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(screen.getAllByRole('link', { name: /Kit de templates digitais/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: /Spotify/i }).length).toBeGreaterThan(0);

    await user.type(search, 'produto-que-nao-existe');
    expect(screen.getByRole('heading', { name: 'Nenhum produto encontrado' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Limpar pesquisa e filtros' }));
    expect(screen.getAllByRole('link', { name: /Spotify/i }).length).toBeGreaterThan(0);
  });

  it('sorts the catalog by price and name', async () => {
    const user = userEvent.setup();
    renderShopAt('/produtos');
    const sort = screen.getByLabelText('Ordenar por');

    await user.selectOptions(sort, 'price-low');
    expect(screen.getAllByRole('heading', { level: 3 })[0]).toHaveTextContent('Pacote de ícones para interface');
    await user.selectOptions(sort, 'price-high');
    expect(screen.getAllByRole('heading', { level: 3 })[0]).toHaveTextContent('Netflix — plano de referência');
    await user.selectOptions(sort, 'name');
    expect(screen.getAllByRole('heading', { level: 3 })[0]).toHaveTextContent('Canva Pro — referência mensal');
  });

  it('adds a quantity-enabled product, updates totals, removes it, and shows an empty cart', async () => {
    const user = userEvent.setup();
    renderShopAt('/produto/kit-de-templates');

    const increaseQuantity = screen.getByRole('button', { name: 'Aumentar quantidade do produto' });
    for (let index = 0; index < 4; index += 1) await user.click(increaseQuantity);
    expect(increaseQuantity).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Adicionar ao carrinho/i }));
    expect(await screen.findByText(/Kit de templates digitais foi adicionado ao carrinho/i)).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Carrinho, 5 itens' }));
    expect(await screen.findByRole('heading', { name: 'Carrinho', level: 1 })).toBeInTheDocument();
    expect(screen.getByLabelText('5 unidades')).toBeInTheDocument();
    expect(screen.getAllByText(/74,50/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Aumentar quantidade de kit de templates digitais' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Remover Kit de templates digitais do carrinho' }));
    expect(await screen.findByRole('heading', { name: 'Seu carrinho está vazio' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/foi removido do carrinho/i);
  });

  it('requires valid checkout fields and creates only a clearly labeled demo order', async () => {
    const user = userEvent.setup();
    const checkoutSession = renderShopAt('/produto/musica-individual');

    await user.click(screen.getByRole('button', { name: /Adicionar ao carrinho/i }));
    await user.click(screen.getByRole('link', { name: 'Carrinho, 1 item' }));
    await user.click(screen.getByRole('link', { name: /Ir para o checkout/i }));

    const submit = screen.getByRole('button', { name: /Criar pedido demonstrativo/i });
    expect(submit).toBeDisabled();

    const fullName = screen.getByLabelText('Nome completo');
    await user.type(fullName, 'A');
    await user.tab();
    expect(screen.getByText('Informe seu nome completo.')).toBeInTheDocument();
    await user.clear(fullName);
    await user.type(fullName, 'Ana da Silva');

    const email = screen.getByLabelText('E-mail');
    await user.type(email, 'ana@invalid');
    await user.tab();
    expect(screen.getByText('Informe um e-mail válido.')).toBeInTheDocument();
    await user.clear(email);
    await user.type(email, 'ana@example.com');
    const confirmEmail = screen.getByLabelText('Confirme seu e-mail');
    await user.type(confirmEmail, 'outra@example.com');
    await user.tab();
    expect(screen.getByText('Os e-mails informados não são iguais.')).toBeInTheDocument();
    await user.clear(confirmEmail);
    await user.type(confirmEmail, 'ana@example.com');
    await user.click(screen.getByRole('radio', { name: /Cartão de crédito/i }));
    const termsCheckbox = screen.getByRole('checkbox');
    termsCheckbox.focus();
    await user.tab();
    expect(termsCheckbox).toHaveAttribute('aria-invalid', 'true');
    expect(termsCheckbox).toHaveAttribute('aria-describedby', 'terms-acceptance-error');
    await user.click(termsCheckbox);

    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(await screen.findByRole('heading', { name: 'Pedido demonstrativo criado' }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/Nenhum pagamento real foi efetuado/i)).toBeInTheDocument();
    expect(screen.getByText('Ana da Silva')).toBeInTheDocument();
    expect(screen.getByText('ana@example.com')).toBeInTheDocument();
    expect(screen.getByText(/DEMO-/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Carrinho, 0 itens' })).toBeInTheDocument();
    expect(window.localStorage.getItem('prime-store-demo-cart-v1')).toBe('[]');

    checkoutSession.unmount();
    renderShopAt('/pedido-confirmado');
    expect(screen.getByRole('heading', { name: 'Nenhum pedido nesta sessão' })).toBeInTheDocument();
    expect(screen.getByText(/Nenhuma compra foi feita/i)).toBeInTheDocument();
  });

  it('keeps the cart and allows a local retry when demo order creation fails', async () => {
    const user = userEvent.setup();
    const createOrderSpy = vi.spyOn(demoOrderService, 'createDemoOrder').mockRejectedValueOnce(new Error('falha local simulada'));
    renderShopAt('/produto/musica-individual');

    await user.click(screen.getByRole('button', { name: /Adicionar ao carrinho/i }));
    await user.click(screen.getByRole('link', { name: 'Carrinho, 1 item' }));
    await user.click(screen.getByRole('link', { name: /Ir para o checkout/i }));
    await user.type(screen.getByLabelText('Nome completo'), 'Ana da Silva');
    await user.type(screen.getByLabelText('E-mail'), 'ana@example.com');
    await user.type(screen.getByLabelText('Confirme seu e-mail'), 'ana@example.com');
    await user.click(screen.getByRole('checkbox'));

    await user.click(screen.getByRole('button', { name: /Criar pedido demonstrativo/i }));
    const errorToast = await screen.findByRole('alert');
    expect(errorToast).toHaveTextContent(/Não foi possível criar a demonstração/i);
    expect(errorToast).toHaveAttribute('aria-live', 'assertive');
    expect(screen.getByRole('link', { name: 'Carrinho, 1 item' })).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /Criar pedido demonstrativo/i });
    expect(retry).toBeEnabled();

    await user.click(retry);
    expect(await screen.findByRole('heading', { name: 'Pedido demonstrativo criado' }, { timeout: 3000 })).toBeInTheDocument();
    expect(createOrderSpy).toHaveBeenCalledTimes(2);
  });

  it('completes the full demonstrative purchase flow, including empty/re-add, reload, and safe confirmation fallback', async () => {
    const user = userEvent.setup();
    const createOrderSpy = vi.spyOn(demoOrderService, 'createDemoOrder');
    const shopSession = renderShopAt('/');

    await user.click(screen.getByRole('link', { name: /Explorar catálogo/i }));
    await user.type(screen.getByPlaceholderText('Buscar por nome ou descrição'), 'kit');
    await user.click(screen.getByRole('button', { name: 'Design e criatividade' }));
    await user.selectOptions(screen.getByLabelText('Ordenar por'), 'price-low');
    await user.click(screen.getByRole('link', { name: /^Kit de templates digitais$/ }));
    await user.click(screen.getByRole('button', { name: 'Aumentar quantidade do produto' }));
    await user.click(screen.getByRole('button', { name: /Adicionar ao carrinho/i }));
    await user.click(screen.getByRole('link', { name: 'Carrinho, 2 itens' }));
    expect(screen.getAllByText(/29,80/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Remover Kit de templates digitais do carrinho' }));
    expect(await screen.findByRole('heading', { name: 'Seu carrinho está vazio' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Explorar catálogo' }));
    await user.type(screen.getByPlaceholderText('Buscar por nome ou descrição'), 'kit');
    await user.click(screen.getByRole('button', { name: 'Adicionar' }));
    await user.click(screen.getByRole('link', { name: 'Carrinho, 1 item' }));
    expect(screen.getAllByText(/14,90/).length).toBeGreaterThan(0);

    shopSession.unmount();
    const reloadedCart = renderShopAt('/carrinho');
    expect(screen.getByRole('link', { name: 'Carrinho, 1 item' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /Ir para o checkout/i }));
    await user.type(screen.getByLabelText('Nome completo'), 'Ana da Silva');
    await user.type(screen.getByLabelText('E-mail'), 'ana@example.com');
    await user.type(screen.getByLabelText('Confirme seu e-mail'), 'ana@example.com');

    const pixOption = screen.getByRole('radio', { name: /PIX/i });
    const cardOption = screen.getByRole('radio', { name: /Cartão de crédito/i });
    await user.click(pixOption);
    expect(pixOption).toBeChecked();
    await user.click(cardOption);
    expect(cardOption).toBeChecked();
    await user.click(screen.getByRole('checkbox'));

    const submit = screen.getByRole('button', { name: /Criar pedido demonstrativo/i });
    expect(submit).toBeEnabled();
    await user.dblClick(submit);
    expect(await screen.findByRole('button', { name: /Criando pedido demonstrativo/i })).toBeDisabled();
    expect(createOrderSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('heading', { name: 'Pedido demonstrativo criado' }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/Nenhum pagamento real foi efetuado/i)).toBeInTheDocument();
    expect(screen.getByText(/Cartão de crédito \(somente visual\)/i)).toBeInTheDocument();
    expect(window.localStorage.getItem('prime-store-demo-cart-v1')).toBe('[]');

    reloadedCart.unmount();
    renderShopAt('/pedido-confirmado');
    expect(screen.getByRole('heading', { name: 'Nenhum pedido nesta sessão' })).toBeInTheDocument();
    expect(screen.getByText(/Nenhuma compra foi feita/i)).toBeInTheDocument();
  });

  it.each([
    ['/', /Seu próximo favorito está a um clique/i, 'Prime Store — Início'],
    ['/produtos', 'Produtos digitais', 'Prime Store — Catálogo'],
    ['/produto/musica-individual', 'Spotify — plano individual', 'Prime Store — Detalhes do produto'],
    ['/produto/slug-inexistente', 'Produto não encontrado', 'Prime Store — Detalhes do produto'],
    ['/carrinho', 'Seu carrinho está vazio', 'Prime Store — Carrinho'],
    ['/checkout', 'Seu carrinho está vazio', 'Prime Store — Checkout demonstrativo'],
    ['/pedido-confirmado', 'Pedido demonstrativo', 'Prime Store — Pedido demonstrativo'],
    ['/faq', 'Perguntas frequentes', 'Prime Store — Perguntas frequentes'],
    ['/ajuda', 'Como podemos ajudar?', 'Prime Store — Atendimento'],
    ['/sobre', 'Uma ideia em construção.', 'Prime Store — Sobre a loja'],
    ['/termos', 'Termos comerciais', 'Prime Store — Termos comerciais provisórios'],
    ['/privacidade', 'Política de privacidade', 'Prime Store — Privacidade'],
    ['/reembolsos', 'Reembolsos e cancelamentos', 'Prime Store — Reembolsos e cancelamentos'],
    ['/nao-existe', 'Não encontramos esta página', 'Prime Store — Página não encontrada'],
  ])('renders the expected page and title at %s', (path, heading, title) => {
    renderShopAt(path);
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(document.title).toBe(title);
  });

  it('persists only cart product IDs and quantities between page sessions', async () => {
    const user = userEvent.setup();
    const firstRender = renderShopAt('/produto/kit-de-templates');
    await user.click(screen.getByRole('button', { name: /Adicionar ao carrinho/i }));
    expect(await screen.findByText(/Kit de templates digitais foi adicionado ao carrinho/i)).toBeInTheDocument();

    const stored = JSON.parse(window.localStorage.getItem('prime-store-demo-cart-v1') ?? '[]') as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0]).sort()).toEqual(['productId', 'quantity']);
    firstRender.unmount();

    renderShopAt('/carrinho');
    expect(screen.getByRole('heading', { name: 'Carrinho', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Carrinho, 1 item' })).toBeInTheDocument();
  });

  it('deduplicates stale cart entries, drops removed products, and persists normalized quantities', () => {
    window.localStorage.setItem('prime-store-demo-cart-v1', JSON.stringify([
      { productId: 'demo-template-kit', quantity: 3 },
      { productId: 'demo-template-kit', quantity: 4 },
      { productId: 'demo-music-individual', quantity: 4 },
      { productId: 'demo-music-individual', quantity: 2 },
      { productId: 'removed-product', quantity: 5 },
    ]));

    const { container } = renderShopAt('/carrinho');
    expect(container.querySelectorAll('.cart-item')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Carrinho, 6 itens' })).toBeInTheDocument();
    expect(screen.getAllByText(/94,40/).length).toBeGreaterThan(0);
    expect(JSON.parse(window.localStorage.getItem('prime-store-demo-cart-v1') ?? '[]')).toEqual([
      { productId: 'demo-template-kit', quantity: 5 },
      { productId: 'demo-music-individual', quantity: 1 },
    ]);
  });

  it('falls back to an empty cart and repairs malformed persisted storage', () => {
    window.localStorage.setItem('prime-store-demo-cart-v1', '{not valid JSON');
    renderShopAt('/carrinho');

    expect(screen.getByRole('heading', { name: 'Seu carrinho está vazio' })).toBeInTheDocument();
    expect(window.localStorage.getItem('prime-store-demo-cart-v1')).toBe('[]');
  });

  it('supports keyboard activation of FAQ accordion items', async () => {
    const user = userEvent.setup();
    renderShopAt('/faq');
    const question = screen.getByRole('button', { name: 'Como funciona uma compra neste protótipo?' });
    question.focus();
    expect(question).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Enter}');
    expect(question).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/criado somente um pedido demonstrativo/i)).toBeInTheDocument();
  });

  it('filters FAQ by search and category and recovers from an empty result', async () => {
    const user = userEvent.setup();
    renderShopAt('/faq');

    const search = screen.getByPlaceholderText('Buscar uma pergunta');
    await user.type(search, 'cartão');
    expect(screen.getByRole('button', { name: 'O PIX ou o cartão é cobrado?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preciso informar dados de pagamento para testar?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pagamentos' }));
    expect(screen.getByRole('button', { name: 'O PIX ou o cartão é cobrado?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preciso informar dados de pagamento para testar?' })).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'nenhuma resposta para este termo');
    expect(screen.getByRole('heading', { name: 'Nenhuma pergunta encontrada' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(screen.getByText('8 perguntas')).toBeInTheDocument();
  });

  it('shows the safe fallback when confirmation is opened directly and renders a route 404', () => {
    const { unmount } = renderShopAt('/pedido-confirmado');
    expect(screen.getByRole('heading', { name: 'Nenhum pedido nesta sessão' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Voltar ao catálogo' })).toHaveAttribute('href', '/produtos');
    unmount();

    renderShopAt('/nao-existe');
    expect(screen.getByRole('heading', { name: 'Não encontramos esta página' })).toBeInTheDocument();
  });

  it('opens the mobile menu and navigates through its links', async () => {
    const user = userEvent.setup();
    renderShopAt('/');

    const menuButton = screen.getByRole('button', { name: 'Abrir menu' });
    await user.click(menuButton);
    expect(screen.getByRole('navigation', { name: 'Navegação mobile' })).toBeInTheDocument();
    expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await user.click(within(screen.getByRole('navigation', { name: 'Navegação mobile' })).getByRole('link', { name: 'Catálogo' }));
    expect(await screen.findByRole('heading', { name: 'Produtos digitais' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Navegação mobile' })).not.toBeInTheDocument();
  });

  it('opens the header search and carries its query into the catalog', async () => {
    const user = userEvent.setup();
    renderShopAt('/');
    await user.click(screen.getByRole('button', { name: 'Abrir busca' }));
    const search = document.getElementById('mobile-product-search');
    expect(search).toBeInstanceOf(HTMLInputElement);
    await user.type(search as HTMLInputElement, 'Notion{Enter}');
    expect(await screen.findByRole('heading', { name: 'Produtos digitais' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Buscar por nome ou descrição')).toHaveValue('Notion');
    expect(screen.getAllByRole('link', { name: /Notion Plus/i }).length).toBeGreaterThan(0);
  });

  it('validates the help form and presents a local-only success message', async () => {
    const user = userEvent.setup();
    renderShopAt('/ajuda');
    const submit = screen.getByRole('button', { name: /Validar formulário/i });

    await user.click(submit);
    expect(screen.getByText('Informe seu nome.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Nome'), 'Joana Lima');
    await user.type(screen.getByLabelText('E-mail'), 'joana@example.com');
    await user.type(screen.getByLabelText('Assunto'), 'Dúvida sobre o protótipo');
    await user.type(screen.getByLabelText('Mensagem'), 'Esta mensagem serve para testar o formulário demonstrativo.');
    await user.click(submit);
    expect(await screen.findByRole('status')).toHaveTextContent(/não foi enviada nem armazenada/i);
  });
});
