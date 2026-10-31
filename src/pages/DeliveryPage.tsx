import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { describeBackendError } from '../services/backend/http';
import { fetchDelivery, type DeliveredUnit, type DeliveryPayload } from '../services/orderService';

/**
 * Página privada de entrega.
 *
 * O token vem da URL, tem alta entropia e é a única credencial de acesso.
 * Nada é persistido no navegador; ao recarregar, a consulta é refeita.
 */
export function DeliveryPage() {
  const { token } = useParams<{ token: string }>();
  const [payload, setPayload] = useState<DeliveryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      setError('Link incompleto.');
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setPayload(await fetchDelivery(token));
      setError(null);
    } catch (loadError) {
      setPayload(null);
      setError(describeBackendError(loadError));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  };

  if (loading) {
    return (
      <section className="container page-section">
        <p className="loading-line"><span className="loading-spinner" aria-hidden="true" />Abrindo sua entrega…</p>
      </section>
    );
  }

  if (error || !payload) {
    return (
      <section className="container page-section">
        <EmptyState
          title="Entrega indisponível"
          description={error ?? 'Este link não está disponível.'}
          actionLabel="Ir para o catálogo"
          to="/produtos"
          icon="alert"
          secondaryAction={{ label: 'Falar com o atendimento', to: '/ajuda' }}
        />
      </section>
    );
  }

  return (
    <section className="container page-section delivery-page">
      <div className="page-heading">
        <span className="eyebrow-label">ENTREGA PRIVADA</span>
        <h1>{payload.product.name}</h1>
        <p>
          Pedido <strong>{payload.reference}</strong> · {payload.units.length} {payload.units.length === 1 ? 'unidade' : 'unidades'} ·{' '}
          {payload.product.access_validity_label}
        </p>
      </div>

      <div className="delivery-notice" role="note">
        <Icon name="alert" size={19} />
        <p>
          Este link é pessoal e permanente. Não compartilhe: qualquer pessoa com a URL vê estas credenciais. Se precisar revogar o acesso,
          fale com o atendimento informando a referência do pedido.
        </p>
      </div>

      <div className="delivery-units">
        {payload.units.map((unit, index) => (
          <DeliveryUnitCard
            key={`${index}-${unit.email.slice(0, 3)}`}
            index={index}
            unit={unit}
            revealed={Boolean(revealed[index])}
            onToggle={() => setRevealed((previous) => ({ ...previous, [index]: !previous[index] }))}
            onCopy={copy}
            copiedLabel={copied}
          />
        ))}
      </div>

      {payload.product.instructions && (
        <div className="delivery-instructions">
          <h2>Instruções de acesso</h2>
          <p>{payload.product.instructions}</p>
        </div>
      )}

      <div className="delivery-footer">
        <p className="field-hint">Criada em {new Date(payload.created_at).toLocaleString('pt-BR')}.</p>
        <Link className="confirmation-catalog-link" to="/ajuda">Preciso de ajuda com este acesso</Link>
      </div>
    </section>
  );
}

interface DeliveryUnitCardProps {
  index: number;
  unit: DeliveredUnit;
  revealed: boolean;
  onToggle: () => void;
  onCopy: (value: string, label: string) => void;
  copiedLabel: string | null;
}

function DeliveryUnitCard({ index, unit, revealed, onToggle, onCopy, copiedLabel }: DeliveryUnitCardProps) {
  const mask = (value: string) => '•'.repeat(Math.min(16, Math.max(6, value.length)));
  return (
    <article className="delivery-unit">
      <header>
        <h2>Unidade {index + 1}</h2>
        <button className="button button--secondary button--small" type="button" onClick={onToggle} aria-pressed={revealed}>
          {revealed ? 'Ocultar dados' : 'Mostrar dados'}
        </button>
      </header>
      <dl>
        <div>
          <dt>E-mail / login</dt>
          <dd>
            <code>{revealed ? unit.email : mask(unit.email)}</code>
            <button className="link-button" type="button" onClick={() => onCopy(unit.email, `email-${index}`)}>
              {copiedLabel === `email-${index}` ? 'Copiado' : 'Copiar'}
            </button>
          </dd>
        </div>
        <div>
          <dt>Senha</dt>
          <dd>
            <code>{revealed ? unit.password : mask(unit.password)}</code>
            <button className="link-button" type="button" onClick={() => onCopy(unit.password, `senha-${index}`)}>
              {copiedLabel === `senha-${index}` ? 'Copiado' : 'Copiar'}
            </button>
          </dd>
        </div>
        {unit.notes && (
          <div>
            <dt>Observações</dt>
            <dd>{unit.notes}</dd>
          </div>
        )}
      </dl>
    </article>
  );
}
