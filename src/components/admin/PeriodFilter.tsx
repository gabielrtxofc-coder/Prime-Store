import { PERIOD_OPTIONS, type PeriodPreset } from '../../lib/period';

interface PeriodFilterProps {
  idPrefix: string;
  preset: PeriodPreset;
  customFrom: string;
  customTo: string;
  onPresetChange: (preset: PeriodPreset) => void;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
}

/**
 * Seletor de período compartilhado (visão geral e pedidos). Os limites são
 * aplicados sobre `created_at` via `adminApi.listOrders({ from, to })`, que o
 * backend já suporta (`p_from`/`p_to`). Em modo "Personalizado" as duas datas
 * são opcionais — um lado vazio significa "sem limite" naquele lado.
 */
export function PeriodFilter({
  idPrefix,
  preset,
  customFrom,
  customTo,
  onPresetChange,
  onCustomFromChange,
  onCustomToChange,
}: PeriodFilterProps) {
  return (
    <div className="admin-period">
      <label className="field-hint" htmlFor={`${idPrefix}-preset`}>
        Período
      </label>
      <select
        id={`${idPrefix}-preset`}
        className="form-control"
        value={preset}
        onChange={(event) => onPresetChange(event.target.value as PeriodPreset)}
        aria-label="Período dos indicadores"
      >
        {PERIOD_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {preset === 'custom' && (
        <>
          <label className="field-hint" htmlFor={`${idPrefix}-from`}>De</label>
          <input
            id={`${idPrefix}-from`}
            className="form-control"
            type="date"
            value={customFrom}
            onChange={(event) => onCustomFromChange(event.target.value)}
            aria-label="Data inicial"
          />
          <label className="field-hint" htmlFor={`${idPrefix}-to`}>Até</label>
          <input
            id={`${idPrefix}-to`}
            className="form-control"
            type="date"
            value={customTo}
            onChange={(event) => onCustomToChange(event.target.value)}
            aria-label="Data final"
          />
        </>
      )}
    </div>
  );
}
