import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import type { LegalSection } from '../data/legalContent';

interface LegalPageProps {
  title: string;
  eyebrow: string;
  description: string;
  sections: LegalSection[];
  lastUpdated?: string;
}

export function LegalPage({ title, eyebrow, description, sections, lastUpdated = 'Rascunho de protótipo · revisar antes de publicar' }: LegalPageProps) {
  return (
    <section className="container page-section legal-page">
      <div className="page-heading"><span className="eyebrow-label">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      <div className="legal-review-alert" role="note"><Icon name="alert" size={19} /><div><strong>Conteúdo provisório — não é documento revisado.</strong><p>As seções abaixo são rascunhos editáveis. Devem ser revisadas e completadas pela operação antes de qualquer publicação ou uso comercial.</p></div></div>
      <p className="legal-updated">{lastUpdated}</p>
      <div className="legal-sections">
        {sections.map((section, index) => (
          <article className="legal-section" key={section.heading}>
            <span className="legal-section__number">{String(index + 1).padStart(2, '0')}</span>
            <div><h2>{section.heading}</h2><p>{section.body}</p></div>
          </article>
        ))}
      </div>
      <div className="legal-help-link"><span>Ficou com alguma dúvida?</span><Link className="text-link text-link--arrow" to="/ajuda">Ver atendimento <Icon name="arrow-right" size={16} /></Link></div>
    </section>
  );
}
