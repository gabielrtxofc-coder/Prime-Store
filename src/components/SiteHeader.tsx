import { useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { siteConfig } from '../data/siteConfig';
import { useCart } from '../context/CartContext';
import { Icon } from './Icon';

function SearchForm({
  mobile = false,
  onDone,
}: {
  mobile?: boolean;
  onDone?: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const search = query.trim();
    navigate(search ? `/produtos?q=${encodeURIComponent(search)}` : '/produtos');
    setQuery('');
    onDone?.();
  };

  return (
    <form className={`site-search${mobile ? ' site-search--mobile' : ''}`} role="search" onSubmit={handleSubmit}>
      <label className="sr-only" htmlFor={mobile ? 'mobile-product-search' : 'header-product-search'}>Buscar produtos</label>
      <Icon name="search" size={18} />
      <input
        id={mobile ? 'mobile-product-search' : 'header-product-search'}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Buscar produtos"
      />
      <button type="submit" aria-label="Pesquisar"><Icon name="arrow-right" size={17} /></button>
    </form>
  );
}

export function SiteHeader() {
  const { count } = useCart();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
    setSearchOpen(false);
  }, [location.pathname, location.search]);

  return (
    <>
      <a className="skip-link" href="#main-content">Pular para o conteúdo</a>
      <div className="demo-banner" role="note">
        <div className="container demo-banner__inner">
          <span className="demo-banner__dot" aria-hidden="true" />
          <span>Protótipo demonstrativo — sem pagamentos reais, acesso ou entrega de produtos.</span>
          <Link to="/sobre">Saiba mais</Link>
        </div>
      </div>
      <header className="site-header">
        <div className="container site-header__main">
          <Link className="brand" to="/" aria-label={`${siteConfig.name} — início`}>
            <span className="brand__mark" aria-hidden="true">P</span>
            <span className="brand__name"><strong>PRIME</strong><small>STORE</small></span>
          </Link>

          <nav className="desktop-nav" aria-label="Navegação principal">
            <NavLink to="/" end className={({ isActive }) => isActive ? 'is-active' : undefined}>Início</NavLink>
            <NavLink to="/produtos" className={({ isActive }) => isActive ? 'is-active' : undefined}>Catálogo</NavLink>
            <NavLink to="/ajuda" className={({ isActive }) => isActive ? 'is-active' : undefined}>Ajuda</NavLink>
          </nav>

          <div className="site-header__actions">
            <div className="desktop-search"><SearchForm /></div>
            <button
              className="icon-button header-search-toggle"
              type="button"
              aria-label={searchOpen ? 'Fechar busca' : 'Abrir busca'}
              aria-expanded={searchOpen}
              aria-controls="mobile-search-panel"
              onClick={() => { setSearchOpen((open) => !open); setMenuOpen(false); }}
            >
              <Icon name={searchOpen ? 'close' : 'search'} />
            </button>
            <Link className="cart-link" to="/carrinho" aria-label={`Carrinho, ${count} ${count === 1 ? 'item' : 'itens'}`}>
              <Icon name="cart" size={21} />
              <span className="cart-link__label">Carrinho</span>
              <span className="cart-link__count" aria-hidden="true">{count > 99 ? '99+' : count}</span>
            </Link>
            <button
              className="icon-button mobile-menu-toggle"
              type="button"
              aria-label={menuOpen ? 'Fechar menu' : 'Abrir menu'}
              aria-expanded={menuOpen}
              aria-controls="mobile-navigation"
              onClick={() => { setMenuOpen((open) => !open); setSearchOpen(false); }}
            >
              <Icon name={menuOpen ? 'close' : 'menu'} />
            </button>
          </div>
        </div>

        <div className="container mobile-search-panel" id="mobile-search-panel" hidden={!searchOpen}>
          <SearchForm mobile onDone={() => setSearchOpen(false)} />
        </div>

        <nav className="mobile-navigation" id="mobile-navigation" aria-label="Navegação mobile" hidden={!menuOpen}>
          <div className="container mobile-navigation__inner">
            <NavLink to="/" end className={({ isActive }) => isActive ? 'active' : undefined}>Início</NavLink>
            <NavLink to="/produtos" className={({ isActive }) => isActive ? 'active' : undefined}>Catálogo</NavLink>
            <NavLink to="/faq" className={({ isActive }) => isActive ? 'active' : undefined}>Perguntas frequentes</NavLink>
            <NavLink to="/ajuda" className={({ isActive }) => isActive ? 'active' : undefined}>Atendimento</NavLink>
            <NavLink to="/sobre" className={({ isActive }) => isActive ? 'active' : undefined}>Sobre a loja</NavLink>
          </div>
        </nav>
      </header>
    </>
  );
}
