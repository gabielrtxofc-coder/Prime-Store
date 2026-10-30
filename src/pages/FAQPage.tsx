import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FAQAccordion } from '../components/FAQAccordion';
import { Icon } from '../components/Icon';
import { faqCategories, faqs } from '../data/faqs';

export function FAQPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const matchingFaqs = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('pt-BR');
    return faqs.filter((item) => {
      const matchesCategory = category === 'all' || item.category === category;
      const searchable = `${item.question} ${item.answer} ${item.category}`.toLocaleLowerCase('pt-BR');
      return matchesCategory && (!normalized || searchable.includes(normalized));
    });
  }, [category, query]);

  return (
    <section className="container page-section faq-page">
      <div className="page-heading"><span className="eyebrow-label">AJUDA RÁPIDA</span><h1>Perguntas frequentes</h1><p>Informações sobre a experiência demonstrativa, os produtos e o que ainda não está conectado.</p></div>
      <label className="faq-search"><Icon name="search" size={19} /><span className="sr-only">Buscar perguntas frequentes</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar uma pergunta" />{query && <button type="button" aria-label="Limpar busca" onClick={() => setQuery('')}><Icon name="close" size={17} /></button>}</label>
      <div className="faq-category-filters" role="group" aria-label="Filtrar perguntas por categoria">
        <button className={`filter-chip${category === 'all' ? ' is-selected' : ''}`} type="button" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>Todas</button>
        {faqCategories.map((item) => <button className={`filter-chip${category === item ? ' is-selected' : ''}`} type="button" key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>)}
      </div>
      <p className="faq-result-count" aria-live="polite">{matchingFaqs.length} {matchingFaqs.length === 1 ? 'pergunta' : 'perguntas'}</p>
      {matchingFaqs.length ? <FAQAccordion items={matchingFaqs} idPrefix="faq-page" /> : <div className="faq-no-results"><h2>Nenhuma pergunta encontrada</h2><p>Experimente buscar outro termo ou selecionar outra categoria.</p><button className="button button--secondary" type="button" onClick={() => { setQuery(''); setCategory('all'); }}>Limpar filtros</button></div>}
      <div className="faq-contact-cta"><div><span className="eyebrow-label">AINDA PRECISA DE AJUDA?</span><h2>Veja as opções de atendimento</h2><p>O canal real ainda não foi configurado, mas você pode visualizar o formulário demonstrativo.</p></div><Link className="button button--secondary" to="/ajuda">Ir para atendimento <Icon name="arrow-right" size={17} /></Link></div>
    </section>
  );
}
