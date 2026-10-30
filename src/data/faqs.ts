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
    question: 'Como funciona uma compra neste protótipo?',
    answer: 'Você pode explorar o catálogo, adicionar itens e preencher o checkout. Ao concluir, é criado somente um pedido demonstrativo no estado da página. Não existe venda, cobrança ou entrega real.',
  },
  {
    id: 'catalogo-real',
    category: 'Catálogo',
    question: 'Os produtos e valores do catálogo são ofertas reais?',
    answer: 'Não. Os nomes, modalidades, disponibilidades e preços são dados ilustrativos para testes de interface. Eles não confirmam estoque, autorização comercial, parceria ou preço de qualquer serviço.',
  },
  {
    id: 'pagamento',
    category: 'Pagamentos',
    question: 'O PIX ou o cartão é cobrado?',
    answer: 'Não. PIX e cartão aparecem apenas como opções visuais. Este frontend não está integrado a um processador e não coleta dados de cartão, não gera QR code e não processa pagamentos.',
  },
  {
    id: 'prazo-entrega',
    category: 'Entrega',
    question: 'Quando recebo o produto digital?',
    answer: 'A entrega automatizada ainda não foi implementada. Nenhum acesso, arquivo, credencial ou benefício será liberado pelo protótipo. O processo e os prazos precisam ser definidos antes de uma operação real.',
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
    question: 'Preciso informar dados de pagamento para testar?',
    answer: 'Não. Não informe dados financeiros. O protótipo não possui campos de cartão, integração com SyncPay ou outro gateway, nem qualquer serviço externo de pagamento.',
  },
  {
    id: 'cadastro',
    category: 'Compras',
    question: 'Preciso criar uma conta?',
    answer: 'Não. O fluxo foi pensado como checkout demonstrativo de convidado e não há cadastro, login ou área de cliente nesta versão.',
  },
];
