import { EmptyState } from '../components/EmptyState';

export function NotFoundPage() {
  return (
    <section className="container page-section not-found-page">
      <span className="eyebrow-label">ERRO 404 · ROTA NÃO ENCONTRADA</span>
      <EmptyState title="Não encontramos esta página" description="O endereço pode ter mudado ou não existir nesta versão da loja." actionLabel="Voltar ao catálogo" to="/produtos" icon="alert" secondaryAction={{ label: 'Ir para o início', to: '/' }} />
    </section>
  );
}
