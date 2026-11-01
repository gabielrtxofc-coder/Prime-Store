import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { readLastRequestReceipt } from '../services/requestService';

/**
 * Porta de entrada do acompanhamento: número do pedido + código.
 *
 * O par é obrigatório. O número sozinho não identifica ninguém: o servidor
 * devolve "não encontrado" tanto para pedido inexistente quanto para código
 * errado, então a página não revela se um pedido existe.
 */
export function TrackingPage() {
  const navigate = useNavigate();
  const last = readLastRequestReceipt();
  const [reference, setReference] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedReference = reference.trim().toUpperCase();
    const normalizedCode = code.trim();

    if (!/^PS-[0-9A-Z]{6}$/.test(normalizedReference)) {
      setError('Informe o número do pedido no formato PS-XXXXXX.');
      return;
    }
    if (normalizedCode.length < 32) {
      setError('Informe o código de acompanhamento completo (32 caracteres ou mais).');
      return;
    }

    setError(null);
    // O código vai no fragmento da URL: o navegador não o envia ao servidor e a
    // página do pedido consegue abrir sem depender do armazenamento local.
    navigate(`/pedido/${normalizedReference}#codigo=${encodeURIComponent(normalizedCode)}`);
  };

  return (
    <section className="container page-section tracking-page">
      <div className="page-heading">
        <span className="eyebrow-label">ACOMPANHAMENTO</span>
        <h1>Acompanhar pedido</h1>
        <p>Informe o número do pedido e o código recebido na confirmação para ver o estado atual.</p>
      </div>

      <div className="tracking-layout">
        <form className="tracking-form" onSubmit={handleSubmit} noValidate>
          <div className="form-field form-field--full">
            <label htmlFor="tracking-reference">Número do pedido</label>
            <input
              id="tracking-reference"
              className={`form-control${error ? ' has-error' : ''}`}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="PS-ABC123"
              autoComplete="off"
              spellCheck={false}
              required
            />
            <p className="field-hint">Formato PS-XXXXXX, exibido na confirmação do pedido.</p>
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="tracking-code">Código de acompanhamento</label>
            <input
              id="tracking-code"
              className={`form-control${error ? ' has-error' : ''}`}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={error ? 'tracking-error' : undefined}
              required
            />
          </div>
          {error && <p className="field-error" id="tracking-error" role="alert">{error}</p>}
          <button className="button button--primary" type="submit">Ver estado do pedido <Icon name="arrow-right" size={17} /></button>
        </form>

        <aside className="tracking-help">
          <h2>Onde encontro esses dados?</h2>
          <p>Ambos aparecem na tela de confirmação, logo depois de enviar a solicitação:</p>
          <ul>
            <li><strong>Número do pedido</strong> — gerado pela loja (ex.: PS-ABC123).</li>
            <li><strong>Código</strong> — sequência longa exibida abaixo do número.</li>
          </ul>
          <p>Perdeu o código? Sem ele não é possível abrir o pedido, por privacidade. Nesse caso, fale com o atendimento.</p>
          {last && (
            <p className="tracking-help__last">
              Último pedido neste navegador: <strong>{last.reference || '(sem número)'}</strong>{' '}
              <Link to={`/pedido/${last.orderId}`}>abrir</Link>
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}
