import { Link } from 'react-router-dom';
import { siteConfig } from '../data/siteConfig';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="site-footer__main">
          <div className="site-footer__brand-block">
            <Link className="brand brand--footer" to="/" aria-label={`${siteConfig.name} — início`}>
              <span className="brand__mark" aria-hidden="true">P</span>
              <span className="brand__name"><strong>PRIME</strong><small>STORE</small></span>
            </Link>
            <p>Uma experiência de loja digital em versão de protótipo.</p>
            <span className="footer-demo-label">Catálogo e checkout demonstrativos</span>
          </div>
          <div className="site-footer__column">
            <h2>Explorar</h2>
            <Link to="/produtos">Catálogo</Link>
            <Link to="/faq">Perguntas frequentes</Link>
            <Link to="/sobre">Sobre a loja</Link>
          </div>
          <div className="site-footer__column">
            <h2>Suporte</h2>
            <Link to="/ajuda">Atendimento</Link>
            <Link to="/reembolsos">Reembolsos e cancelamentos</Link>
            <span className="footer-contact-pending">{siteConfig.supportContactLabel}</span>
          </div>
          <div className="site-footer__column">
            <h2>Informações</h2>
            <Link to="/termos">Termos comerciais</Link>
            <Link to="/privacidade">Privacidade</Link>
          </div>
        </div>
        <div className="site-footer__bottom">
          <span>© {new Date().getFullYear()} Prime Store · versão demonstrativa</span>
          <span>Nenhum pagamento real é processado nesta aplicação.</span>
        </div>
      </div>
    </footer>
  );
}
