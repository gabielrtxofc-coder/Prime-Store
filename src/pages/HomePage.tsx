import { Link } from 'react-router-dom';
import { FAQAccordion } from '../components/FAQAccordion';
import { Icon } from '../components/Icon';
import { ProductGrid } from '../components/ProductGrid';
import { faqs } from '../data/faqs';
import { useCatalog } from '../context/CatalogContext';

const steps = [
  { number: '01', title: 'Explore o catálogo', text: 'Veja produtos ativos, com descrição, preço e unidades disponíveis agora.' },
  { number: '02', title: 'Monte seu carrinho', text: 'Adicione, aumente, diminua ou remova itens. O carrinho fica salvo no navegador.' },
  { number: '03', title: 'Envie a solicitação', text: 'Informe nome e e-mail, confira o total e receba o número do pedido para acompanhar.' },
];

export function HomePage() {
  const { products, categories, status, error, reload, lastSyncedAt } = useCatalog();
  const featuredProducts = products.filter((product) => product.featured).slice(0, 4);
  const highlights = featuredProducts.length > 0 ? featuredProducts : products.slice(0, 4);

  return (
    <>
      <section className="home-hero">
        <div className="container home-hero__layout">
          <div className="home-hero__copy">
            <span className="eyebrow"><span className="eyebrow__dot" /> LOJA DIGITAL · CATÁLOGO ONLINE</span>
            <h1>Seu próximo favorito está a <span>um clique.</span></h1>
            <p>
              Produtos digitais com preço e disponibilidade consultados direto do catálogo da loja. Monte o carrinho,
              envie a solicitação e acompanhe cada pedido pelo número gerado.
            </p>
            <div className="home-hero__actions">
              <Link className="button button--primary button--large" to="/produtos">Explorar catálogo <Icon name="arrow-right" size={18} /></Link>
              <Link className="text-link" to="/acompanhar">Acompanhar um pedido</Link>
            </div>
            <div className="hero-reassurance">
              <Icon name="alert" size={16} />
              <span>Pedido registrado no servidor · nenhum pagamento é feito pelo site</span>
            </div>
          </div>
          <div className="home-hero__visual" role="img" aria-label="Representação abstrata de produtos digitais">
            <div className="hero-visual__ring hero-visual__ring--outer" />
            <div className="hero-visual__ring hero-visual__ring--inner" />
            <div className="hero-visual__card hero-visual__card--back">
              <span className="hero-visual__mini-icon hero-visual__mini-icon--violet">C</span>
              <span><small>DESIGN &amp; CRIATIVIDADE</small><strong>Novas ideias</strong></span>
            </div>
            <div className="hero-visual__card hero-visual__card--front">
              <div className="hero-visual__card-top"><span className="hero-visual__label">CATÁLOGO ATIVO</span><span className="hero-visual__spark" aria-hidden="true">✳</span></div>
              <div className="hero-visual__tiles" aria-hidden="true"><span className="hero-visual__tile hero-visual__tile--green">S</span><span className="hero-visual__tile hero-visual__tile--blue">T</span><span className="hero-visual__tile hero-visual__tile--rose">Y</span></div>
              <strong>Um espaço para descobrir.</strong>
              <span className="hero-visual__caption">Produtos digitais · pedido online</span>
            </div>
            <span className="hero-visual__orbit-dot hero-visual__orbit-dot--one" />
            <span className="hero-visual__orbit-dot hero-visual__orbit-dot--two" />
          </div>
        </div>
      </section>

      {status === 'error' || status === 'not_configured' ? (
        <section className="section-block" aria-label="Aviso do catálogo">
          <div className="container">
            <div className="catalog-status catalog-status--error" role="alert">
              <span>{error}</span>
              {status === 'error' && (
                <button className="button button--secondary button--small" type="button" onClick={reload}>
                  Tentar novamente
                </button>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {categories.length > 0 && (
        <section className="section-block category-section" aria-labelledby="categories-heading">
          <div className="container">
            <div className="section-heading section-heading--row">
              <div><span className="eyebrow-label">ENCONTRE POR TEMA</span><h2 id="categories-heading">Explore categorias</h2></div>
              <Link className="text-link text-link--arrow" to="/produtos">Ver todo o catálogo <Icon name="arrow-right" size={17} /></Link>
            </div>
            <div className="category-grid">
              {categories.map((category, index) => (
                <Link className="category-tile" to={`/produtos?categoria=${encodeURIComponent(category.id)}`} key={category.id}>
                  <span className={`category-tile__symbol category-tile__symbol--${(index % 5) + 1}`} aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                  <span className="category-tile__copy">
                    <strong>{category.label}</strong>
                    <small>{category.count === 1 ? '1 produto' : `${category.count} produtos`}</small>
                  </span>
                  <Icon className="category-tile__arrow" name="arrow-right" size={17} />
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="section-block featured-section" aria-labelledby="featured-heading">
        <div className="container">
          <div className="section-heading section-heading--row">
            <div>
              <span className="eyebrow-label">DESTAQUES</span>
              <h2 id="featured-heading">Selecionados da loja</h2>
              <p>
                {status === 'live'
                  ? 'Produtos ativos com disponibilidade consultada agora no servidor.'
                  : 'Carregando os produtos do catálogo…'}
              </p>
            </div>
            <Link className="text-link text-link--arrow" to="/produtos">Ver todos os produtos <Icon name="arrow-right" size={17} /></Link>
          </div>

          {status === 'loading' && (
            <p className="loading-line" role="status"><span className="loading-spinner" aria-hidden="true" />Carregando produtos…</p>
          )}

          {status === 'live' && highlights.length === 0 && (
            <div className="catalog-status">
              <span>O catálogo está vazio neste momento.</span>
              <button className="button button--secondary button--small" type="button" onClick={reload}>Atualizar</button>
            </div>
          )}

          {highlights.length > 0 && <ProductGrid products={highlights} />}

          <div className="section-bottom-link">
            <Link className="button button--secondary" to="/produtos">Abrir catálogo completo <Icon name="arrow-right" size={17} /></Link>
          </div>
          {lastSyncedAt && status === 'live' && (
            <p className="catalog-status__meta">
              Catálogo consultado em {new Date(lastSyncedAt).toLocaleString('pt-BR')}.
            </p>
          )}
        </div>
      </section>

      <section className="section-block how-section" id="como-funciona" aria-labelledby="how-heading">
        <div className="container how-section__layout">
          <div className="how-section__intro">
            <span className="eyebrow-label">SIMPLES DE ACOMPANHAR</span>
            <h2 id="how-heading">Da vitrine ao número do pedido.</h2>
            <p>
              A solicitação é gravada no servidor da loja com os itens, as quantidades e o valor conferido no banco.
              Nenhum pagamento é solicitado nesta etapa.
            </p>
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
            <div className="demo-inline-note">
              <Icon name="alert" size={17} />
              <p>O pedido fica como "aguardando confirmação" e guardamos o código de acompanhamento para consultar depois.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section-block home-faq-section" aria-labelledby="home-faq-heading">
        <div className="container home-faq__layout">
          <div className="home-faq__intro">
            <span className="eyebrow-label">TEM DÚVIDAS?</span>
            <h2 id="home-faq-heading">Tudo claro antes de continuar.</h2>
            <p>Veja como o pedido é registrado, como acompanhar e o que ainda depende da loja.</p>
            <Link className="button button--secondary" to="/faq">Todas as perguntas <Icon name="arrow-right" size={17} /></Link>
          </div>
          <FAQAccordion items={faqs.slice(0, 4)} idPrefix="home-faq" />
        </div>
      </section>

      <section className="container home-final-cta" aria-label="Explore o catálogo">
        <div><span className="eyebrow-label">PRIME STORE</span><h2>Pronto para escolher?</h2><p>Monte seu carrinho e envie a solicitação em poucos passos.</p></div>
        <Link className="button button--primary button--large" to="/produtos">Ir para o catálogo <Icon name="arrow-right" size={18} /></Link>
      </section>
    </>
  );
}
