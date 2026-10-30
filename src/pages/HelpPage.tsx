import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { siteConfig } from '../data/siteConfig';
import { validateContact, type ContactErrors, type ContactValues } from '../lib/validation';

const initialValues: ContactValues = { name: '', email: '', subject: '', message: '' };

export function HelpPage() {
  const [values, setValues] = useState<ContactValues>(initialValues);
  const [errors, setErrors] = useState<ContactErrors>({});
  const [touched, setTouched] = useState<Partial<Record<keyof ContactValues, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [success, setSuccess] = useState(false);

  const update = (field: keyof ContactValues, value: string) => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setSuccess(false);
    if (touched[field]) {
      setErrors(validateContact({ ...values, [field]: value }));
    }
  };

  const markTouched = (field: keyof ContactValues) => {
    setTouched((previous) => ({ ...previous, [field]: true }));
    setErrors(validateContact(values));
  };

  const visibleError = (field: keyof ContactValues) => (submitted || touched[field] ? errors[field] : undefined);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateContact(values);
    setErrors(validation);
    setSubmitted(true);
    setTouched({ name: true, email: true, subject: true, message: true });
    if (Object.keys(validation).length > 0) return;

    // Intentionally local-only: the contact channel/backend is not configured.
    setSuccess(true);
  };

  return (
    <section className="container page-section help-page">
      <div className="page-heading"><span className="eyebrow-label">ATENDIMENTO</span><h1>Como podemos ajudar?</h1><p>As informações e o formulário abaixo fazem parte do protótipo e não iniciam um contato real.</p></div>
      <div className="help-layout">
        <aside className="help-info-card">
          <span className="help-info-card__icon"><Icon name="mail" size={23} /></span>
          <span className="eyebrow-label">CANAL DE CONTATO</span>
          <h2>{siteConfig.supportContactLabel}</h2>
          <p>O endereço ou canal oficial deve ser configurado quando a operação de atendimento estiver definida.</p>
          {siteConfig.supportContact ? <a className="text-link" href={`mailto:${siteConfig.supportContact}`}>{siteConfig.supportContact}</a> : <span className="pending-contact">Nenhum contato real cadastrado</span>}
          <div className="help-info-card__divider" />
          <h3>Enquanto isso</h3>
          <p>Consulte as <Link to="/faq">perguntas frequentes</Link> ou veja os rascunhos de <Link to="/reembolsos">reembolsos e cancelamentos</Link>.</p>
          <p className="help-info-card__note"><Icon name="alert" size={16} />O formulário não envia nem armazena mensagens.</p>
        </aside>

        <div className="help-form-card">
          <div className="help-form-card__heading"><h2>Formulário de contato demonstrativo</h2><p>Preencha para testar a validação e o estado visual de sucesso.</p></div>
          {success && <div className="form-success" role="status"><Icon name="check" size={18} /><p>Validação concluída. Sua mensagem não foi enviada nem armazenada.</p></div>}
          <form onSubmit={handleSubmit} noValidate>
            <div className="form-grid">
              <div className="form-field"><label htmlFor="contact-name">Nome</label><input className={`form-control${visibleError('name') ? ' has-error' : ''}`} id="contact-name" autoComplete="name" value={values.name} onChange={(event) => update('name', event.target.value)} onBlur={() => markTouched('name')} aria-invalid={Boolean(visibleError('name'))} aria-describedby={visibleError('name') ? 'contact-name-error' : undefined} required />{visibleError('name') && <p className="field-error" id="contact-name-error">{visibleError('name')}</p>}</div>
              <div className="form-field"><label htmlFor="contact-email">E-mail</label><input className={`form-control${visibleError('email') ? ' has-error' : ''}`} id="contact-email" type="email" inputMode="email" autoComplete="email" value={values.email} onChange={(event) => update('email', event.target.value)} onBlur={() => markTouched('email')} aria-invalid={Boolean(visibleError('email'))} aria-describedby={visibleError('email') ? 'contact-email-error' : undefined} required />{visibleError('email') && <p className="field-error" id="contact-email-error">{visibleError('email')}</p>}</div>
              <div className="form-field form-field--full"><label htmlFor="contact-subject">Assunto</label><input className={`form-control${visibleError('subject') ? ' has-error' : ''}`} id="contact-subject" value={values.subject} onChange={(event) => update('subject', event.target.value)} onBlur={() => markTouched('subject')} aria-invalid={Boolean(visibleError('subject'))} aria-describedby={visibleError('subject') ? 'contact-subject-error' : undefined} required />{visibleError('subject') && <p className="field-error" id="contact-subject-error">{visibleError('subject')}</p>}</div>
              <div className="form-field form-field--full"><label htmlFor="contact-message">Mensagem</label><textarea className={`form-control form-control--textarea${visibleError('message') ? ' has-error' : ''}`} id="contact-message" rows={5} value={values.message} onChange={(event) => update('message', event.target.value)} onBlur={() => markTouched('message')} aria-invalid={Boolean(visibleError('message'))} aria-describedby={visibleError('message') ? 'contact-message-error' : undefined} required />{visibleError('message') && <p className="field-error" id="contact-message-error">{visibleError('message')}</p>}</div>
            </div>
            <button className="button button--primary button--large" type="submit">Validar formulário <Icon name="arrow-right" size={18} /></button>
            <p className="form-submit-note">Nenhum dado será enviado para lugar algum.</p>
          </form>
        </div>
      </div>
    </section>
  );
}
