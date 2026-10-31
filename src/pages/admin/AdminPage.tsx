import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
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

type Tab = 'overview' | 'products' | 'stock' | 'orders';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'products', label: 'Produtos' },
  { id: 'stock', label: 'Estoque' },
  { id: 'orders', label: 'Pedidos' },
];

export function AdminPage() {
  const configured = getBackendConfig().enabled;
  const [demoMode, setDemoMode] = useState(() => isAdminDemoSession());
  const [session, setSession] = useState<AdminSession | null>(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

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

  const demoBanner = demoMode ? (
    <div className="admin-demo-banner" role="note">
      <Icon name="alert" size={18} />
      <p>
        <strong>Modo de demonstração do painel.</strong> Os dados exibidos são fictícios e nenhuma alteração é gravada no Supabase.
        As ações são simuladas nesta aba. O acesso real continua exigindo conta autorizada e verificação em duas etapas.
      </p>
    </div>
  ) : null;

  if (!configured && !demoMode) {
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
        demoAvailable={canUseAdminDemo()}
        onStartDemo={enableDemo}
      />
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
    return <AdminMfaGate session={session} onVerified={refresh} onSignOut={logout} />;
  }

  return (
    <section className="container page-section admin-page">
      {demoBanner}
      <header className="admin-header">
        <div>
          <span className="eyebrow-label">ADMINISTRAÇÃO</span>
          <h1>Painel Prime Store</h1>
          <p className="field-hint">
            {demoMode
              ? 'sessão de demonstração (sem dados reais)'
              : `${session.email} · sessão com verificação em duas etapas (AAL2)`}
          </p>
        </div>
        <div className="admin-header__actions">
          <Link className="button button--secondary button--small" to="/">Ver loja</Link>
          <button className="button button--secondary button--small" type="button" onClick={logout}>Sair</button>
        </div>
      </header>

      <nav className="admin-tabs" aria-label="Seções do painel">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`admin-tab${tab === item.id ? ' is-active' : ''}`}
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="admin-content">
        {tab === 'overview' && <AdminOverview />}
        {tab === 'products' && <AdminProducts />}
        {tab === 'stock' && <AdminStock />}
        {tab === 'orders' && <AdminOrders />}
      </div>

      <p className="admin-footnote">
        <Icon name="alert" size={15} /> Toda operação administrativa é registrada em auditoria com o identificador do administrador.
      </p>
    </section>
  );
}
