export interface LegalSection {
  heading: string;
  body: string;
}

export const termsSections: LegalSection[] = [
  {
    heading: 'Identificação do vendedor',
    body: 'PENDENTE DE DEFINIÇÃO: incluir a identificação e os dados comerciais do responsável pela operação antes de publicar estes termos. Este protótipo não identifica um vendedor nem realiza vendas.',
  },
  {
    heading: 'Funcionamento da compra',
    body: 'RASCUNHO: definir como pedidos, confirmação, cobrança e suporte funcionarão em uma operação real. Na versão atual, o checkout cria apenas um registro demonstrativo em memória e não envia dados a um servidor.',
  },
  {
    heading: 'Produtos digitais',
    body: 'RASCUNHO: descrever cada produto efetivamente oferecido, sua modalidade, vigência, requisitos e eventuais limitações. O catálogo presente nesta demonstração contém apenas dados fictícios e não concede acesso a serviços de terceiros.',
  },
  {
    heading: 'Condições de utilização e limitações',
    body: 'PENDENTE DE REVISÃO: detalhar as condições de uso e as limitações de cada produto real. Não são declaradas parcerias, autorizações, garantias ou benefícios nesta versão de protótipo.',
  },
  {
    heading: 'Entrega',
    body: 'PENDENTE DE DEFINIÇÃO: estabelecer o processo e eventuais prazos de entrega antes de iniciar a operação. Não há entrega automatizada, liberação de credenciais ou download implementado.',
  },
  {
    heading: 'Atendimento',
    body: 'PENDENTE DE CONFIGURAÇÃO: informar canais, horários e procedimentos reais de atendimento. O formulário disponível na demonstração não transmite mensagens.',
  },
  {
    heading: 'Cancelamentos e reembolsos',
    body: 'PENDENTE DE DEFINIÇÃO E REVISÃO: estabelecer regras aplicáveis e procedimento de solicitação antes da publicação. Não é possível concluir pedidos de cancelamento ou reembolso por este protótipo.',
  },
  {
    heading: 'Responsabilidades das partes',
    body: 'PENDENTE DE REVISÃO: revisar e completar esta seção com as responsabilidades da operação e do comprador, considerando os produtos e processos que vierem a ser implementados.',
  },
];

export const privacySections: LegalSection[] = [
  {
    heading: 'Dados tratados nesta versão',
    body: 'O carrinho pode guardar no armazenamento local do navegador apenas identificadores de produtos e quantidades. O formulário de contato não envia nem persiste dados. Os dados de nome e e-mail do checkout ficam no estado em memória para a tela de confirmação demonstrativa e não são enviados a um servidor.',
  },
  {
    heading: 'Finalidades',
    body: 'Os dados locais são utilizados somente para demonstrar a navegação do carrinho e a confirmação de um pedido fictício. Nenhum processamento comercial ou pagamento acontece nesta versão.',
  },
  {
    heading: 'Compartilhamento',
    body: 'O frontend atual não implementa integração com serviços externos nem compartilha dados com processadores de pagamento. Qualquer compartilhamento futuro depende de decisões e implementação do backend.',
  },
  {
    heading: 'Armazenamento e retenção',
    body: 'Os itens do carrinho permanecem no armazenamento local até serem removidos ou apagados pelo usuário. Os dados do checkout existem apenas enquanto o estado da aplicação estiver ativo; não são gravados junto ao carrinho. A política de retenção de uma operação real ainda precisa ser definida.',
  },
  {
    heading: 'Direitos do titular',
    body: 'PENDENTE DE DEFINIÇÃO: documentar os procedimentos e o canal para solicitações relacionadas a dados pessoais antes da publicação e de qualquer coleta real.',
  },
  {
    heading: 'Contato sobre privacidade',
    body: 'O canal responsável por questões de privacidade ainda não foi configurado. Definir esse contato e os procedimentos de atendimento antes de disponibilizar a loja publicamente.',
  },
];

export const refundSections: LegalSection[] = [
  {
    heading: 'Solicitação de suporte',
    body: 'O canal real de atendimento ainda está pendente de configuração. Antes da publicação, informe um canal funcional para dúvidas e solicitações relacionadas a pedidos.',
  },
  {
    heading: 'Análise e acompanhamento',
    body: 'O procedimento de análise, as informações necessárias e a forma de acompanhamento devem ser definidos pela operação. Esta demonstração não cria solicitações reais nem processa cobranças.',
  },
  {
    heading: 'Regras aplicáveis',
    body: 'RASCUNHO PARA REVISÃO: documentar critérios, prazos e condições de cancelamento ou reembolso após a definição dos produtos e da operação. Nenhuma solicitação será aceita ou recusada automaticamente por este protótipo.',
  },
];
