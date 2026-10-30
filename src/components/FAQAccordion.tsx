import { useState } from 'react';
import type { FAQItem } from '../data/faqs';
import { Icon } from './Icon';

export function FAQAccordion({ items, idPrefix = 'faq' }: { items: FAQItem[]; idPrefix?: string }) {
  const [openItems, setOpenItems] = useState<Set<string>>(() => new Set());

  const toggle = (id: string) => {
    setOpenItems((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="faq-list">
      {items.map((item) => {
        const isOpen = openItems.has(item.id);
        const buttonId = `${idPrefix}-${item.id}-button`;
        const panelId = `${idPrefix}-${item.id}-panel`;
        return (
          <article className={`faq-item${isOpen ? ' is-open' : ''}`} key={item.id}>
            <h3 className="faq-item__heading">
              <button
                id={buttonId}
                className="faq-item__trigger"
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => toggle(item.id)}
              >
                <span>{item.question}</span>
                <Icon name="chevron-down" size={19} className="faq-item__chevron" />
              </button>
            </h3>
            <div id={panelId} className="faq-item__panel" role="region" aria-labelledby={buttonId} hidden={!isOpen}>
              <p>{item.answer}</p>
            </div>
          </article>
        );
      })}
    </div>
  );
}
