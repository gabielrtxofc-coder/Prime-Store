import { Icon } from './Icon';

interface QuantityControlProps {
  value: number;
  min?: number;
  max: number;
  label: string;
  onChange: (value: number) => void;
}

export function QuantityControl({ value, min = 1, max, label, onChange }: QuantityControlProps) {
  return (
    <div className="quantity-control" role="group" aria-label={label}>
      <button
        type="button"
        className="quantity-control__button"
        aria-label={`Diminuir ${label.toLowerCase()}`}
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
      >
        <Icon name="minus" size={16} />
      </button>
      <output className="quantity-control__value" aria-live="polite" aria-label={`${value} unidades`}>{value}</output>
      <button
        type="button"
        className="quantity-control__button"
        aria-label={`Aumentar ${label.toLowerCase()}`}
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
      >
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}
