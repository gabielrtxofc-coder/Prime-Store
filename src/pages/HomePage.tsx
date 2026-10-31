import { Link } from 'react-router-dom';
import { FAQAccordion } from '../components/FAQAccordion';
import { Icon } from '../components/Icon';
import { ProductGrid } from '../components/ProductGrid';
import { categories } from '../data/products';
import { faqs } from '../data/faqs';
import { useCatalog } from '../context/CatalogContext';
import { getBackendConfig } from '../services/backend/config';

const steps = [
  { number: '01', title: 'Explore', text: 'Navegue pelas categorias e veja os detalhes de cada item demonstrativo.' },
  { number: '02', title: 'Monte seu carrinho', text: 'Adicione produtos e confira quantidades e valores ilustrativos.' },
  { number: '03', title: 'Teste o checkout', text: 'Preencha os dados de exemplo e crie um pedido somente no protótipo.' },
];

export function HomePage() {
  const { products } = useCatalog();
  const backendEnabled = getBackendConfig().enabled;
  const featuredProducts = products.filter((product) => product.featured).slice(0, 4);

  return (
    <>
      <section className="home-hero">
        <div className="container home-hero__layout">
          <div className="home-hero__copy">
            <span className="eyebrow"><span className="eyebrow__dot" /> LOJA DIGITAL · {backendEnabled ? 'CATÁLOGO ATIVO' : 'PROTÓTIPO'}</span>
            <h1>Seu próximo favorito está a <span>um clique.</span></h1>
            <p>{backendEnabled
              ? 'Assinaturas e produtos digitais com pagamento por PIX e entrega privada imediata após a confirmação.'
              : 'Explore uma experiência de catálogo e checkout para assinaturas e produtos digitais. Tudo aqui é demonstrativo — sem cobranças ou entrega real.'}</p>
            <div className="home-hero__actions">
              <Link className="button button--primary button--large" to="/produtos">Explorar catálogo <Icon name="arrow-right" size={18} /></Link>
              <Link className="text-link" to="/sobre">Conhecer a proposta</Link>
            </div>
            <div className="hero-reassurance"><Icon name="alert" size={16} /><span>{backendEnabled ? 'Pagamento por PIX · entrega privada · ambiente de testes' : 'Preços ilustrativos · sem pagamento real'}</span></div>
          </div>
          <div className="home-hero__visual" role="img" aria-label="Representação abstrata de produtos digitais demonstrativos">
            <div className="hero-visual__ring hero-visual__ring--outer" />
            <div className="hero-visual__ring hero-visual__ring--inner" />
            <div className="hero-visual__card hero-visual__card--back">
              <span className="hero-visual__mini-icon hero-visual__mini-icon--violet">C</span>
              <span><small>DESIGN & CRIATIVIDADE</small><strong>Novas ideias</strong></span>
            </div>
            <div className="hero-visual__card hero-visual__card--front">
              <div className="hero-visual__card-top"><span className="hero-visual__label">SELEÇÃO DEMO</span><span className="hero-visual__spark" aria-hidden="true">✳</span></div>
              <div className="hero-visual__tiles" aria-hidden="true"><span className="hero-visual__tile hero-visual__tile--green">S</span><span className="hero-visual__tile hero-visual__tile--blue">T</span><span className="hero-visual__tile hero-visual__tile--rose">Y</span></div>
              <strong>Um espaço para descobrir.</strong>
              <span className="hero-visual__caption">Produtos digitais · versão de teste</span>
            </div>
            <span className="hero-visual__orbit-dot hero-visual__orbit-dot--one" />
            <span className="hero-visual__orbit-dot hero-visual__orbit-dot--two" />
          </div>
        </div>
      </section>

      <section className="section-block category-section" aria-labelledby="categories-heading">
        <div className="container">
          <div className="section-heading section-heading--row">
            <div><span className="eyebrow-label">ENCONTRE POR TEMA</span><h2 id="categories-heading">Explore categorias</h2></div>
            <Link className="text-link text-link--arrow" to="/produtos">Ver todo o catálogo <Icon name="arrow-right" size={17} /></Link>
          </div>
          <div className="category-grid">
            {categories.map((category, index) => (
              <Link className="category-tile" to={`/produtos?categoria=${encodeURIComponent(category.id)}`} key={category.id}>
                <span className={`category-tile__symbol category-tile__symbol--${index + 1}`} aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <span className="category-tile__copy"><strong>{category.label}</strong><small>{category.description}</small></span>
                <Icon className="category-tile__arrow" name="arrow-right" size={17} />
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="section-block featured-section" aria-labelledby="featured-heading">
        <div className="container">
          <div className="section-heading section-heading--row">
            <div><span className="eyebrow-label">DESTAQUES</span><h2 id="featured-heading">{backendEnabled ? 'Selecionados da loja' : 'Destaques demonstrativos'}</h2><p>{backendEnabled ? 'Produtos ativos com estoque disponível neste momento.' : 'Exemplos fictícios para navegar e testar a experiência.'}</p></div>
            <Link className="text-link text-link--arrow" to="/produtos">Ver todos os produtos <Icon name="arrow-right" size={17} /></Link>
          </div>
          <ProductGrid products={featuredProducts} />
          <div className="section-bottom-link"><Link className="button button--secondary" to="/produtos">Abrir catálogo completo <Icon name="arrow-right" size={17} /></Link></div>
        </div>
      </section>

      <section className="section-block how-section" id="como-funciona" aria-labelledby="how-heading">
        <div className="container how-section__layout">
          <div className="how-section__intro">
            <span className="eyebrow-label">SIMPLES DE TESTAR</span>
            <h2 id="how-heading">Uma jornada de compra, em modo demonstração.</h2>
            <p>O fluxo abaixo existe para validar a navegação do frontend. Ele não inicia uma operação real.</p>
            <Link className="text-link text-link--arrow" to="/faq">Leia as perguntas frequentes <Icon name="arrow-right" size={17} /></Link>
          </div>
          <div className="steps-list">
            {steps.map((step) => (
              <article className="step-card" key={step.number}>
                <span className="step-card__number">{step.number}</span>
                <div><h3>{step.title}</h3><p>{step.text}</p></div>
                <Icon name="arrow-right" size={18} className="step-card__arrow" />
              </article>
            ))}
            <div className="demo-inline-note"><Icon name="alert" size={17} /><p>O pedido criado ao final é fictício. Pagamento e entrega ainda não estão conectados.</p></div>
          </div>
        </div>
      </section>

      <section className="section-block home-faq-section" aria-labelledby="home-faq-heading">
        <div className="container home-faq__layout">
          <div className="home-faq__intro">
            <span className="eyebrow-label">TEM DÚVIDAS?</span>
            <h2 id="home-faq-heading">Tudo claro antes de continuar.</h2>
            <p>Veja como o protótipo funciona, o que é apenas ilustrativo e o que ainda será conectado.</p>
            <Link className="button button--secondary" to="/faq">Todas as perguntas <Icon name="arrow-right" size={17} /></Link>
          </div>
          <FAQAccordion items={faqs.slice(0, 4)} idPrefix="home-faq" />
        </div>
      </section>

      <section className="container home-final-cta" aria-label="Explore o catálogo">
        <div><span className="eyebrow-label">PRIME STORE · DEMO</span><h2>Pronto para explorar?</h2><p>Monte um carrinho de teste e percorra todas as telas da loja.</p></div>
        <Link className="button button--primary button--large" to="/produtos">Ir para o catálogo <Icon name="arrow-right" size={18} /></Link>
      </section>
    </>
  );
}
