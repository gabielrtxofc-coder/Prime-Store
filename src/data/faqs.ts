export type FAQCategory = 'Compras' | 'Catálogo' | 'Pagamentos' | 'Entrega' | 'Atendimento' | 'Cancelamentos';

export interface FAQItem {
  id: string;
  category: FAQCategory;
  question: string;
  answer: string;
}

export const faqCategories: FAQCategory[] = ['Compras', 'Catálogo', 'Pagamentos', 'Entrega', 'Atendimento', 'Cancelamentos'];

export const faqs: FAQItem[] = [
  {
    id: 'como-comprar',
    category: 'Compras',
    question: 'Como funciona um pedido na Prime Store?',
    answer:
      'Você escolhe os produtos no catálogo, confere o carrinho e informa nome e e-mail. Ao enviar, a solicitação é registrada no servidor da loja e você recebe um número de pedido para acompanhar o estado. A solicitação fica aguardando confirmação da loja.',
  },
  {
    id: 'catalogo-real',
    category: 'Catálogo',
    question: 'Os produtos e valores do catálogo são ofertas reais?',
    answer:
      'O catálogo é carregado do banco da loja: nome, descrição, preço e disponibilidade são os dados vigentes no momento da consulta. A disponibilidade pode mudar enquanto você navega; a confirmação final acontece ao enviar a solicitação.',
  },
  {
    id: 'pagamento',
    category: 'Pagamentos',
    question: 'A loja cobra alguma coisa ao enviar o pedido?',
    answer:
      'Não. O envio do pedido não inicia pagamento, não gera cobrança e não pede dados de cartão. A solicitação fica registrada como "aguardando confirmação" e nenhum valor é movimentado pelo site.',
  },
  {
    id: 'prazo-entrega',
    category: 'Entrega',
    question: 'Quando recebo o produto digital?',
    answer:
      'Nesta fase a entrega não acontece automaticamente: o pedido é uma solicitação registrada e aguarda confirmação. Nenhum acesso, arquivo ou credencial é liberado pelo site enquanto o pedido não for confirmado.',
  },
  {
    id: 'contato',
    category: 'Atendimento',
    question: 'Como falo com o atendimento?',
    answer: 'O canal real de atendimento ainda está pendente de configuração. O formulário da página de ajuda apenas demonstra a interface e não envia nem armazena mensagens.',
  },
  {
    id: 'cancelamento',
    category: 'Cancelamentos',
    question: 'Como funcionam cancelamentos e reembolsos?',
    answer: 'As regras ainda precisam ser definidas e revisadas antes da publicação. Esta demonstração não realiza cobranças nem permite solicitar ou concluir um reembolso real; consulte a página de reembolsos para ver o rascunho editável.',
  },
  {
    id: 'dados-cartao',
    category: 'Pagamentos',
    question: 'Preciso informar dados de pagamento?',
    answer:
      'Não. Nenhum dado de cartão é solicitado ou armazenado. A loja guarda apenas nome, e-mail, itens e valor da solicitação, necessários para identificar o pedido e permitir o acompanhamento.',
  },
  {
    id: 'acompanhar-pedido',
    category: 'Compras',
    question: 'Como acompanho a minha solicitação?',
    answer:
      'Guarde o número do pedido (formato PS-XXXXXX) e o código de acompanhamento mostrados na confirmação. Com os dois, a página "Acompanhar pedido" abre o estado atual. Sem o código, ninguém consegue ver o pedido, nem mesmo com o número.',
  },
  {
    id: 'cadastro',
    category: 'Compras',
    question: 'Preciso criar uma conta?',
    answer:
      'Não. O pedido é feito como visitante: nome e e-mail são usados para identificar a solicitação. Não há cadastro, login ou área de cliente.',
  },
];
