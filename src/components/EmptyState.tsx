import { Link } from 'react-router-dom';
import { Icon, type IconName } from './Icon';

interface EmptyStateProps {
  title: string;
  description: string;
  actionLabel: string;
  to: string;
  icon?: IconName;
  secondaryAction?: { label: string; to: string };
}

export function EmptyState({ title, description, actionLabel, to, icon = 'cart', secondaryAction }: EmptyStateProps) {
  return (
    <section className="empty-state" aria-labelledby="empty-state-title">
      <span className="empty-state__icon"><Icon name={icon} size={25} /></span>
      <h2 id="empty-state-title">{title}</h2>
      <p>{description}</p>
      <div className="empty-state__actions">
        <Link className="button button--primary" to={to}>{actionLabel}<Icon name="arrow-right" size={17} /></Link>
        {secondaryAction && <Link className="button button--secondary" to={secondaryAction.to}>{secondaryAction.label}</Link>}
      </div>
    </section>
  );
}
