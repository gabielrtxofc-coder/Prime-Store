import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { describeBackendError } from '../services/backend/http';
import {
  fetchDelivery,
  type DeliveredUnit,
  type DeliveryItemGroup,
  type DeliveryPayload,
} from '../services/orderService';

/**
 * Normaliza o payload da entrega.
 *
 * O backend devolve um grupo por produto (`items`). Navegadores antigos, que
 * podem estar com um bundle anterior em memória, recebem também `product` +
 * `units`; aqui o formato plano é convertido em um único grupo.
 */
function deliveryGroups(payload: DeliveryPayload): DeliveryItemGroup[] {
  if (payload.items && payload.items.length > 0) return payload.items;
  return [
    {
      product_id: payload.product.id,
      product_name: payload.product.name,
      product_slug: payload.product.slug,
      instructions: payload.product.instructions,
      access_validity_label: payload.product.access_validity_label,
      access_validity_days: payload.product.access_validity_days,
      quantity: payload.units.length,
      units: payload.units,
    },
  ];
}

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
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
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

  const groups = deliveryGroups(payload);
  const totalUnits = groups.reduce((total, group) => total + group.units.length, 0);

  return (
    <section className="container page-section delivery-page">
      <div className="page-heading">
        <span className="eyebrow-label">ENTREGA PRIVADA</span>
        <h1>{groups.length > 1 ? 'Seus acessos' : groups[0].product_name}</h1>
        <p>
          Pedido <strong>{payload.reference}</strong> · {groups.length}{' '}
          {groups.length === 1 ? 'produto' : 'produtos'} ·{' '}
          {totalUnits} {totalUnits === 1 ? 'unidade' : 'unidades'}
        </p>
      </div>

      <div className="delivery-notice" role="note">
        <Icon name="alert" size={19} />
        <p>
          Este link é pessoal e permanente. Não compartilhe: qualquer pessoa com a URL vê estas credenciais. Se precisar revogar o acesso,
          fale com o atendimento informando a referência do pedido.
        </p>
      </div>

      {groups.map((group, groupIndex) => (
        <section className="delivery-group" key={group.product_id} aria-labelledby={`grupo-${groupIndex}`}>
          {/* Com um produto só, o título já está no topo da página. */}
          {groups.length > 1 ? (
            <div className="delivery-group__heading">
              <h2 id={`grupo-${groupIndex}`}>{group.product_name}</h2>
              <p className="field-hint">
                {group.quantity} {group.quantity === 1 ? 'acesso' : 'acessos'}
                {group.access_validity_label ? ` · ${group.access_validity_label}` : ''}
              </p>
            </div>
          ) : (
            group.access_validity_label && (
              <p className="field-hint delivery-group__meta">{group.access_validity_label}</p>
            )
          )}

          {group.instructions && (
            <div className="delivery-instructions">
              <h3>Instruções de acesso</h3>
              <p>{group.instructions}</p>
            </div>
          )}

          <div className="delivery-units">
            {group.units.map((unit, index) => {
              // A chave combina produto e posição: revelar uma unidade não
              // revela as demais, nem em outro produto.
              const key = `${groupIndex}:${index}`;
              return (
                <DeliveryUnitCard
                  key={key}
                  index={index}
                  unit={unit}
                  revealed={Boolean(revealed[key])}
                  onToggle={() => setRevealed((previous) => ({ ...previous, [key]: !previous[key] }))}
                  onCopy={copy}
                  copiedLabel={copied}
                  stateKey={key}
                />
              );
            })}
          </div>
        </section>
      ))}

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
  /** Identidade do card (produto + posição) usada nos rótulos de cópia. */
  stateKey: string;
}

function DeliveryUnitCard({
  index,
  unit,
  revealed,
  onToggle,
  onCopy,
  copiedLabel,
  stateKey,
}: DeliveryUnitCardProps) {
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
            <button className="link-button" type="button" onClick={() => onCopy(unit.email, `email-${stateKey}`)}>
              {copiedLabel === `email-${stateKey}` ? 'Copiado' : 'Copiar'}
            </button>
          </dd>
        </div>
        <div>
          <dt>Senha</dt>
          <dd>
            <code>{revealed ? unit.password : mask(unit.password)}</code>
            <button className="link-button" type="button" onClick={() => onCopy(unit.password, `senha-${stateKey}`)}>
              {copiedLabel === `senha-${stateKey}` ? 'Copiado' : 'Copiar'}
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
