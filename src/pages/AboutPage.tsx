import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';

export function AboutPage() {
  return (
    <section className="container page-section about-page">
      <div className="page-heading"><span className="eyebrow-label">SOBRE A LOJA</span><h1>Uma ideia em construção.</h1><p>Esta é a primeira versão de uma experiência para explorar produtos e assinaturas digitais.</p></div>
      <div className="about-intro-card">
        <span className="about-intro-card__mark" aria-hidden="true">P</span>
        <div><span className="eyebrow-label">PROTÓTIPO FRONTEND</span><h2>Testar a experiência antes de conectar a operação.</h2><p>A Prime Store é, nesta etapa, uma interface demonstrativa. O objetivo é validar páginas, navegação, catálogo, carrinho e um fluxo de checkout fictício antes de decisões sobre backend, produtos, atendimento e pagamentos.</p></div>
      </div>
      <div className="about-points">
        <article><span className="about-point-number">01</span><h2>Catálogo editável</h2><p>Os exemplos de produtos e categorias ficam centralizados em dados locais para facilitar substituições futuras.</p></article>
        <article><span className="about-point-number">02</span><h2>Compra apenas demonstrativa</h2><p>O carrinho e o pedido são simulados no navegador. Não há cobrança, entrega, conta de usuário ou serviço externo conectado.</p></article>
        <article><span className="about-point-number">03</span><h2>Próximas decisões</h2><p>Produtos reais, políticas, canal de suporte, operação de pagamento e entrega ainda precisam ser definidos antes de qualquer publicação comercial.</p></article>
      </div>
      <div className="about-bottom-cta"><div><h2>Explore a versão de teste</h2><p>Navegue pelo catálogo e veja as telas que já fazem parte do protótipo.</p></div><Link className="button button--primary" to="/produtos">Ver catálogo <Icon name="arrow-right" size={17} /></Link></div>
    </section>
  );
}
