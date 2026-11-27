import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon, type IconName } from '../../components/Icon';
import { getBackendConfig } from '../../services/backend/config';
import {
  canUseAdminDemo,
  getCurrentSession,
  isAdminDemoSession,
  setAdminDemoSession,
  signOutAdmin,
  type AdminSession,
} from '../../services/adminAuth';
import { AdminLogin } from './AdminLogin';
import { AdminMfaGate } from './AdminMfaGate';
import { AdminOverview } from './AdminOverview';
import { AdminProducts } from './AdminProducts';
import { AdminStock } from './AdminStock';
import { AdminOrders } from './AdminOrders';
import { AdminSecurity } from './AdminSecurity';

type Tab = 'overview' | 'products' | 'stock' | 'orders' | 'security';

const BASE_TABS: Array<{ id: Tab; label: string; icon: IconName; description: string }> = [
  {
    id: 'overview',
    label: 'Visão geral',
    icon: 'grid',
    description: 'Situação comercial da loja, pedidos recentes e pendências de atendimento.',
  },
  {
    id: 'products',
    label: 'Produtos',
    icon: 'tag',
    description: 'Cadastre, edite, ative ou desative os produtos vendidos na loja.',
  },
  {
    id: 'stock',
    label: 'Estoque',
    icon: 'box',
    description: 'Cadastre unidades, acompanhe a disponibilidade e importe planilhas.',
  },
  {
    id: 'orders',
    label: 'Pedidos',
    icon: 'receipt',
    description: 'Acompanhe solicitações, pagamentos, entregas e reembolsos.',
  },
];

// A área de Segurança gerencia autenticadores reais e NÃO está disponível no
// modo demonstrativo (dados fictícios, sem Auth).
const SECURITY_TAB: { id: Tab; label: string; icon: IconName; description: string } = {
  id: 'security',
  label: 'Segurança',
  icon: 'shield',
  description: 'Autenticadores de verificação em duas etapas, segundo fator e remoção de fatores.',
};

const TABS = (demo: boolean): Array<{ id: Tab; label: string; icon: IconName; description: string }> =>
  demo ? BASE_TABS : [...BASE_TABS, SECURITY_TAB];

export function AdminPage() {
  const configured = getBackendConfig().enabled;
  // Build com o modo demonstrativo disponível. Sem ele, um ambiente sem backend
  // configurado continua mostrando apenas o aviso de indisponibilidade.
  const demoAvailable = canUseAdminDemo();
  const [demoMode, setDemoMode] = useState(() => isAdminDemoSession());
  const [session, setSession] = useState<AdminSession | null>(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [navOpen, setNavOpen] = useState(false);

  const refresh = useCallback(async () => {
    const result = await getCurrentSession();
    if (!result.ok) {
      setError(result.message);
      setSession(null);
    } else {
      setSession(result.value);
      setError(null);
    }
    setBooting(false);
  }, []);

  useEffect(() => {
    if (!configured && !demoMode) {
      setBooting(false);
      return;
    }
    void refresh();
  }, [configured, demoMode, refresh]);

  const enableDemo = () => {
    setAdminDemoSession(true);
    setDemoMode(true);
    setBooting(true);
    void refresh();
  };

  const logout = async () => {
    await signOutAdmin();
    setAdminDemoSession(false);
    setDemoMode(false);
    setSession(null);
    setTab('overview');
  };

  const current = TABS(demoMode).find((item) => item.id === tab) ?? TABS(demoMode)[0];
  const sessionLabel = demoMode ? 'Sessão de demonstração (sem dados reais)' : (session?.email ?? 'Sessão ativa');

  const demoBanner = demoMode ? (
    <div className="admin-demo-banner" role="note">
      <Icon name="alert" size={18} />
      <p>
        <strong>Modo de demonstração do painel.</strong> Os dados exibidos são fictícios e nenhuma alteração é gravada no Supabase.
        As ações são simuladas nesta aba. O acesso real continua exigindo conta autorizada e verificação em duas etapas.
      </p>
    </div>
  ) : null;

  // Sem backend E sem modo demonstrativo disponível não há nada a exibir.
  // Com o build demo ligado, o visitante segue para o login, que oferece a
  // entrada em modo demonstrativo.
  if (!configured && !demoMode && !demoAvailable) {
    return (
      <section className="container page-section">
        <div className="page-heading">
          <span className="eyebrow-label">ADMINISTRAÇÃO</span>
          <h1>Painel indisponível neste ambiente</h1>
          <p>
            Defina <code>VITE_SUPABASE_URL</code>, <code>VITE_SUPABASE_ANON_KEY</code> e <code>VITE_BACKEND_ENABLED=true</code> para
            habilitar o painel. Nenhuma chave privilegiada é usada no navegador.
          </p>
        </div>
        <Link className="button button--secondary" to="/">Voltar à loja</Link>
      </section>
    );
  }

  if (booting) {
    return (
      <section className="container page-section">
        <p className="loading-line"><span className="loading-spinner" aria-hidden="true" />Verificando sessão…</p>
      </section>
    );
  }

  if (!session) {
    return (
      <AdminLogin
        onSignedIn={refresh}
        initialError={error}
        demoAvailable={demoAvailable}
        onStartDemo={enableDemo}
        backendConfigured={configured}
      />
    );
  }

  // Falha na verificação de permissões NÃO é a mesma coisa que "fora da
  // allowlist". Em caso de erro (ex.: Auth indisponível), mantemos o painel
  // trancado e oferecemos retry — não liberamos nem exibimos "acesso negado".
  if (session.adminCheckError) {
    return (
      <section className="container page-section admin-page">
        <div className="admin-denied">
          <h1>Não foi possível verificar o acesso</h1>
          <p>{session.adminCheckError}</p>
          <button className="button button--secondary" type="button" onClick={refresh}>Tentar novamente</button>
          <button className="button button--ghost button--small" type="button" onClick={logout}>Sair</button>
        </div>
      </section>
    );
  }

  if (!session.isAdmin) {
    return (
      <section className="container page-section admin-page">
        <div className="admin-denied">
          <h1>Acesso negado</h1>
          <p>
            A conta <strong>{session.email}</strong> está autenticada, mas não está na allowlist de administradores.
            Solicite a inclusão ao responsável pela loja.
          </p>
          <button className="button button--secondary" type="button" onClick={logout}>Sair</button>
        </div>
      </section>
    );
  }

  if (!session.mfaSatisfied) {
    return <AdminMfaGate session={session} onVerified={refresh} onSignOut={logout} onRetry={refresh} />;
  }

  return (
    <div className={`admin-shell${navOpen ? ' admin-shell--nav-open' : ''}`}>
      <aside className="admin-sidebar" id="admin-navigation">
        <div className="admin-brand">
          <span className="admin-brand__mark" aria-hidden="true">PS</span>
          <span className="admin-brand__text">
            <h1>Painel Prime Store</h1>
            <small>Gestão comercial</small>
          </span>
        </div>

        <nav className="admin-nav" aria-label="Seções do painel">
          {TABS(demoMode).map((item) => (
            <button
              key={item.id}
              type="button"
              className={`admin-nav__item${tab === item.id ? ' is-active' : ''}`}
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => {
                setTab(item.id);
                setNavOpen(false);
              }}
            >
              <span className="admin-nav__icon" aria-hidden="true"><Icon name={item.icon} size={17} /></span>
              <span className="admin-nav__label">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="admin-sidebar__footer">
          <div className="admin-session">
            <span className={`admin-session__dot${demoMode ? ' is-demo' : ''}`} aria-hidden="true" />
            <span className="admin-session__text">
              <strong>{demoMode ? 'Demonstração' : 'Administrador'}</strong>
              <small>{sessionLabel}</small>
            </span>
          </div>
          <div className="admin-sidebar__actions">
            <Link className="button button--secondary button--small" to="/">Ver loja</Link>
            <button className="button button--ghost button--small" type="button" onClick={logout}>Sair</button>
          </div>
        </div>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar">
          <button
            className="admin-topbar__menu"
            type="button"
            onClick={() => setNavOpen((open) => !open)}
            aria-expanded={navOpen}
            aria-controls="admin-navigation"
          >
            <Icon name={navOpen ? 'close' : 'menu'} size={18} />
            <span>Menu</span>
          </button>
          <div className="admin-topbar__head">
            <span className="eyebrow-label">ADMINISTRAÇÃO</span>
            <h2>{current.label}</h2>
            <p>{current.description}</p>
          </div>
          <div className="admin-topbar__aside">
            {demoMode && <span className="admin-pill admin-pill--demo">Modo demonstração</span>}
            <span className="admin-pill">{session.mfaSatisfied ? 'Verificação em duas etapas ativa' : 'Sessão ativa'}</span>
          </div>
        </header>

        <div className="admin-content">
          {demoBanner}
          {tab === 'overview' && <AdminOverview onNavigate={setTab} />}
          {tab === 'products' && <AdminProducts />}
          {tab === 'stock' && <AdminStock />}
          {tab === 'orders' && <AdminOrders />}
          {tab === 'security' && !demoMode && <AdminSecurity initialSession={session} onSessionUpdated={refresh} />}
        </div>

        <p className="admin-footnote">
          <Icon name="alert" size={15} /> Toda operação administrativa é registrada em auditoria com o identificador do administrador.
        </p>
      </div>

      {navOpen && (
        <button
          className="admin-nav-backdrop"
          type="button"
          aria-label="Fechar menu de navegação"
          onClick={() => setNavOpen(false)}
        />
      )}
    </div>
  );
}
