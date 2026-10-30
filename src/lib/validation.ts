export interface CheckoutValues {
  fullName: string;
  email: string;
  confirmEmail: string;
  acceptedTerms: boolean;
}

export type CheckoutField = keyof CheckoutValues;
export type CheckoutErrors = Partial<Record<CheckoutField, string>>;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCheckout(values: CheckoutValues, cartIsEmpty = false): CheckoutErrors {
  const errors: CheckoutErrors = {};
  const fullName = values.fullName.trim();
  const email = values.email.trim();
  const confirmEmail = values.confirmEmail.trim();

  if (fullName.length < 2) errors.fullName = 'Informe seu nome completo.';
  if (!emailPattern.test(email)) errors.email = 'Informe um e-mail válido.';
  if (!confirmEmail) errors.confirmEmail = 'Confirme seu e-mail.';
  else if (email.toLowerCase() !== confirmEmail.toLowerCase()) {
    errors.confirmEmail = 'Os e-mails informados não são iguais.';
  }
  if (!values.acceptedTerms) errors.acceptedTerms = 'Confirme que leu os termos provisórios para continuar.';
  if (cartIsEmpty) errors.fullName = 'Adicione ao menos um item ao carrinho antes de continuar.';

  return errors;
}

export interface ContactValues {
  name: string;
  email: string;
  subject: string;
  message: string;
}

export type ContactErrors = Partial<Record<keyof ContactValues, string>>;

export function validateContact(values: ContactValues): ContactErrors {
  const errors: ContactErrors = {};
  if (values.name.trim().length < 2) errors.name = 'Informe seu nome.';
  if (!emailPattern.test(values.email.trim())) errors.email = 'Informe um e-mail válido.';
  if (values.subject.trim().length < 3) errors.subject = 'Informe um assunto.';
  if (values.message.trim().length < 10) errors.message = 'Escreva uma mensagem com pelo menos 10 caracteres.';
  return errors;
}
