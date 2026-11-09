import { lazy, Suspense, useEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { AboutPage } from './pages/AboutPage';
import { CartPage } from './pages/CartPage';
import { CatalogPage } from './pages/CatalogPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { DeliveryPage } from './pages/DeliveryPage';
import { FAQPage } from './pages/FAQPage';
import { HelpPage } from './pages/HelpPage';
import { HomePage } from './pages/HomePage';
import { LegalPage } from './pages/LegalPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OrderConfirmedPage } from './pages/OrderConfirmedPage';
import { OrderStatusPage } from './pages/OrderStatusPage';
import { ProductPage } from './pages/ProductPage';
import { TrackingPage } from './pages/TrackingPage';
import { SiteLayout } from './components/SiteLayout';
import { privacySections, refundSections, termsSections } from './data/legalContent';

/**
 * Missão 03.2A — painel administrativo restaurado sob demanda.
 *
 * O painel continua fora do bundle público: o `import()` dinâmico faz o Vite
 * emitir um chunk separado (`AdminPage-*.js`), carregado apenas quando alguém
 * abre `/admin`. A proteção real não depende desta rota — ela acontece no
 * backend (`admin-api` com JWT) e no banco (`assert_admin()`: allowlist +
 * AAL2/TOTP) — a rota só devolve a interface já desenvolvida.
 *
 * `/pagamento` permanece FORA do roteador de propósito: a cobrança depende da
 * integração de pagamento (não autorizada).
 *
 * `/entrega/:token` é público de propósito: é a entrega digital do pedido. A
 * rota não libera nada por si — a credencial só é devolvida pela Edge Function
 * `delivery` quando o token privado existe, a entrega está ativa e o pedido
 * está pago e pronto. Sem isso a página mostra "Entrega indisponível".
 */
const AdminPage = lazy(() =>
  import('./pages/admin/AdminPage').then((module) => ({ default: module.AdminPage })),
);

/** Apresentação de carregamento enquanto o chunk do painel é baixado. */
function AdminLoadingFallback() {
  return (
    <section className="container page-section" aria-busy="true">
      <p className="loading-line">
        <span className="loading-spinner" aria-hidden="true" />
        Carregando o painel administrativo…
      </p>
    </section>
  );
}

function RouteEffects() {
  const location = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    const titleByPath: Record<string, string> = {
      '/': 'Início',
      '/produtos': 'Catálogo',
      '/carrinho': 'Carrinho',
      '/checkout': 'Finalizar pedido',
      '/acompanhar': 'Acompanhar pedido',
      '/faq': 'Perguntas frequentes',
      '/ajuda': 'Atendimento',
      '/sobre': 'Sobre a loja',
      '/termos': 'Termos comerciais provisórios',
      '/privacidade': 'Privacidade',
      '/reembolsos': 'Reembolsos e cancelamentos',
    };

    const routeTitle = location.pathname.startsWith('/produto/')
      ? 'Detalhes do produto'
      : location.pathname.startsWith('/pedido')
        ? 'Pedido'
        : location.pathname.startsWith('/admin')
          ? 'Administração'
          : (titleByPath[location.pathname] ?? 'Página não encontrada');
    document.title = `Prime Store — ${routeTitle}`;
  }, [location.pathname]);

  return null;
}

export function App() {
  return (
    <>
      <RouteEffects />
      <Routes>
        {/* Administração: chunk carregado sob demanda; autenticação e MFA no
            backend/banco continuam sendo a proteção real. Caminhos internos
            (`/admin/*`) renderizam o mesmo AdminPage, cuja navegação é por
            abas — não existem sub-rotas administrativas nesta fase. */}
        <Route
          path="admin"
          element={
            <Suspense fallback={<AdminLoadingFallback />}>
              <AdminPage />
            </Suspense>
          }
        />
        <Route
          path="admin/*"
          element={
            <Suspense fallback={<AdminLoadingFallback />}>
              <AdminPage />
            </Suspense>
          }
        />
        <Route element={<SiteLayout />}>
          <Route index element={<HomePage />} />
          <Route path="produtos" element={<CatalogPage />} />
          <Route path="produto/:slug" element={<ProductPage />} />
          <Route path="carrinho" element={<CartPage />} />
          <Route path="checkout" element={<CheckoutPage />} />
          <Route path="pedido/:identifier" element={<OrderStatusPage />} />
          {/* Entrega privada: o token da URL é a única credencial de acesso. */}
          <Route path="entrega/:token" element={<DeliveryPage />} />
          <Route path="acompanhar" element={<TrackingPage />} />
          {/* Endereço antigo: leva ao pedido registrado neste navegador. */}
          <Route path="pedido-confirmado" element={<OrderConfirmedPage />} />
          <Route path="faq" element={<FAQPage />} />
          <Route path="ajuda" element={<HelpPage />} />
          <Route path="sobre" element={<AboutPage />} />
          <Route path="termos" element={<LegalPage eyebrow="INFORMAÇÕES COMERCIAIS" title="Termos comerciais" description="Rascunho editável sobre o funcionamento de uma futura operação." sections={termsSections} />} />
          <Route path="privacidade" element={<LegalPage eyebrow="DADOS E PRIVACIDADE" title="Política de privacidade" description="Como os dados do pedido são usados nesta versão da loja." sections={privacySections} />} />
          <Route path="reembolsos" element={<LegalPage eyebrow="SUPORTE AO CLIENTE" title="Reembolsos e cancelamentos" description="Procedimento provisório para revisão antes da publicação. Nenhum pedido é confirmado automaticamente por esta página." sections={refundSections} />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </>
  );
}
