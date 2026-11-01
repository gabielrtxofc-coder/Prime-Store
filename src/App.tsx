import { Suspense, lazy, useEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { AboutPage } from './pages/AboutPage';
import { CartPage } from './pages/CartPage';
import { CatalogPage } from './pages/CatalogPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { FAQPage } from './pages/FAQPage';
import { HelpPage } from './pages/HelpPage';
import { HomePage } from './pages/HomePage';
import { LegalPage } from './pages/LegalPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OrderConfirmedPage } from './pages/OrderConfirmedPage';
import { ProductPage } from './pages/ProductPage';
import { PaymentPage } from './pages/PaymentPage';
import { DeliveryPage } from './pages/DeliveryPage';

// O painel (e a biblioteca de autenticação) só carrega quando acessado.
const AdminPage = lazy(() =>
  import('./pages/admin/AdminPage').then((module) => ({ default: module.AdminPage })),
);
import { SiteLayout } from './components/SiteLayout';
import { privacySections, refundSections, termsSections } from './data/legalContent';

function RouteEffects() {
  const location = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    const titleByPath: Record<string, string> = {
      '/': 'Início',
      '/produtos': 'Catálogo',
      '/carrinho': 'Carrinho',
      '/checkout': 'Checkout demonstrativo',
      '/pedido-confirmado': 'Pedido demonstrativo',
      '/pagamento': 'Pagamento PIX',
      '/admin': 'Painel administrativo',
      '/faq': 'Perguntas frequentes',
      '/ajuda': 'Atendimento',
      '/sobre': 'Sobre a loja',
      '/termos': 'Termos comerciais provisórios',
      '/privacidade': 'Privacidade',
      '/reembolsos': 'Reembolsos e cancelamentos',
    };
    const routeTitle = location.pathname.startsWith('/produto/') ? 'Detalhes do produto' : (titleByPath[location.pathname] ?? 'Página não encontrada');
    document.title = `Prime Store — ${routeTitle}`;
  }, [location.pathname]);

  return null;
}

export function App() {
  return (
    <>
      <RouteEffects />
      <Routes>
        <Route element={<SiteLayout />}>
          <Route index element={<HomePage />} />
          <Route path="produtos" element={<CatalogPage />} />
          <Route path="produto/:slug" element={<ProductPage />} />
          <Route path="carrinho" element={<CartPage />} />
          <Route path="checkout" element={<CheckoutPage />} />
          <Route path="pedido-confirmado" element={<OrderConfirmedPage />} />
          <Route path="pagamento" element={<PaymentPage />} />
          <Route path="entrega/:token" element={<DeliveryPage />} />
          <Route
            path="admin"
            element={
              <Suspense fallback={<section className="container page-section"><p className="loading-line"><span className="loading-spinner" aria-hidden="true" />Carregando painel…</p></section>}>
                <AdminPage />
              </Suspense>
            }
          />
          <Route path="faq" element={<FAQPage />} />
          <Route path="ajuda" element={<HelpPage />} />
          <Route path="sobre" element={<AboutPage />} />
          <Route path="termos" element={<LegalPage eyebrow="INFORMAÇÕES COMERCIAIS" title="Termos comerciais" description="Rascunho editável sobre o funcionamento de uma futura operação." sections={termsSections} />} />
          <Route path="privacidade" element={<LegalPage eyebrow="DADOS E PRIVACIDADE" title="Política de privacidade" description="Informações sobre esta versão de protótipo e tópicos que dependem de decisões futuras." sections={privacySections} />} />
          <Route path="reembolsos" element={<LegalPage eyebrow="SUPORTE AO CLIENTE" title="Reembolsos e cancelamentos" description="Procedimento provisório para revisão antes da publicação. Nenhuma solicitação real pode ser concluída nesta versão." sections={refundSections} />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </>
  );
}
