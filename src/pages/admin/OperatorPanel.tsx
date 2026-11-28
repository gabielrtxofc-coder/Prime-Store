import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon, type IconName } from '../../components/Icon';
import type { AdminSession } from '../../services/adminAuth';
import { AdminStock } from './AdminStock';
import { OpsProducts } from './OpsProducts';

type OpsTab = 'stock' | 'products';

const OPS_TABS: Array<{ id: OpsTab; label: string; icon: IconName; description: string }> = [
  {
    id: 'stock',
    label: 'Estoque',
    icon: 'box',
    description: 'Cadastre unidades, importe planilhas e ative ou desative unidades.',
  },
  {
    id: 'products',
    label: 'Produtos',
    icon: 'tag',
    description: 'Atualize nome, textos, imagem, limite por pedido e disponibilidade na loja.',
  },
];

interface OperatorPanelProps {
  session: AdminSession;
  onSignOut: () => void | Promise<void>;
  /**
   * Presente só para contas que TAMBÉM são administradoras: leva à
   * verificação em duas etapas para liberar o painel completo.
   */
  onRequestFullAccess?: () => void;
}

/**
 * Painel OPERACIONAL — acesso diário com e-mail + senha.
 *
 * Sem verificação em duas etapas, passkey ou PIN. Só estoque e informações
 * operacionais de produto. Pedidos, pagamentos, reembolsos, credenciais,
 * preços/custos e auditoria ficam no painel administrativo completo. Quem
 * decide é o banco (assert_operator/assert_admin) — esta tela só organiza.
 */
export function OperatorPanel({ session, onSignOut, onRequestFullAccess }: OperatorPanelProps) {
  const [tab, setTab] = useState<OpsTab>('stock');
  const [navOpen, setNavOpen] = useState(false);
  const current = OPS_TABS.find((item) => item.id === tab) ?? OPS_TABS[0];

  return (
    <div className={`admin-shell${navOpen ? ' admin-shell--nav-open' : ''}`}>
      <aside className="admin-sidebar" id="admin-navigation">
        <div className="admin-brand">
          <span className="admin-brand__mark" aria-hidden="true">PS</span>
          <span className="admin-brand__text">
            <h1>Painel Prime Store</h1>
            <small>Operação diária</small>
          </span>
        </div>

        <nav className="admin-nav" aria-label="Seções do painel">
          {OPS_TABS.map((item) => (
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
            <span className="admin-session__dot" aria-hidden="true" />
            <span className="admin-session__text">
              <strong>Operador</strong>
              <small>{session.email ?? 'Sessão ativa'}</small>
            </span>
          </div>
          {onRequestFullAccess && (
            <button className="link-button" type="button" onClick={onRequestFullAccess}>
              Acesso administrativo completo
            </button>
          )}
          <div className="admin-sidebar__actions">
            <Link className="button button--secondary button--small" to="/">Ver loja</Link>
            <button className="button button--ghost button--small" type="button" onClick={onSignOut}>Sair</button>
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
            <span className="eyebrow-label">OPERAÇÃO</span>
            <h2>{current.label}</h2>
            <p>{current.description}</p>
          </div>
          <div className="admin-topbar__aside">
            <span className="admin-pill">Acesso operacional</span>
          </div>
        </header>

        <div className="admin-content">
          {tab === 'stock' && <AdminStock mode="operational" />}
          {tab === 'products' && <OpsProducts />}
        </div>

        <p className="admin-footnote">
          <Icon name="alert" size={15} /> Cada alteração fica registrada em auditoria com a sua conta.
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
