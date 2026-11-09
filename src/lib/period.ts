/**
 * Filtro de período compartilhado pelas telas administrativas (visão geral e
 * pedidos). Toda a filtragem usa as datas reais dos registros (`created_at`):
 * os limites são convertidos para ISO e enviados ao backend (`orders.list`,
 * que aceita `p_from`/`p_to` desde a migração 0012).
 *
 * Não existe no servidor uma agregação de receita parametrizada por período —
 * por isso a receita mostrada por período é somada sobre os pedidos retornados
 * (pagamento aprovado) e sinalizada quando truncar o limite da página.
 */

export type PeriodPreset = '7d' | '30d' | '90d' | 'all' | 'custom';

export interface PeriodRange {
  /** ISO string ou null (sem limite inferior). */
  from: string | null;
  /** ISO string ou null (sem limite superior). */
  to: string | null;
}

export const PERIOD_OPTIONS: Array<{ value: PeriodPreset; label: string }> = [
  { value: '7d', label: 'Últimos 7 dias' },
  { value: '30d', label: 'Últimos 30 dias' },
  { value: '90d', label: 'Últimos 90 dias' },
  { value: 'all', label: 'Todo o período' },
  { value: 'custom', label: 'Personalizado…' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Converte o preset (e as datas do modo personalizado) em um intervalo ISO.
 * `now` é injetável para testes determinísticos.
 */
export function presetToRange(
  preset: PeriodPreset,
  customFrom = '',
  customTo = '',
  now: Date = new Date(),
): PeriodRange {
  if (preset === 'all') return { from: null, to: null };
  if (preset === 'custom') {
    const start = customFrom ? new Date(`${customFrom}T00:00:00`) : null;
    const end = customTo ? new Date(`${customTo}T23:59:59.999`) : null;
    return {
      from: start && !Number.isNaN(start.getTime()) ? start.toISOString() : null,
      to: end && !Number.isNaN(end.getTime()) ? end.toISOString() : null,
    };
  }
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  return { from: new Date(now.getTime() - days * DAY_MS).toISOString(), to: null };
}
