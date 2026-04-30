import type { PeriodFilter } from '../../lib/compute';

interface PeriodSelectorProps {
  year: number;
  filter: PeriodFilter;
  yearOptions: number[];
  onYearChange: (y: number) => void;
  onFilterChange: (f: PeriodFilter) => void;
}

const FILTERS: { value: PeriodFilter; label: string }[] = [
  { value: 'year', label: 'Year' },
  { value: 'Q1', label: 'Q1' },
  { value: 'Q2', label: 'Q2' },
  { value: 'Q3', label: 'Q3' },
  { value: 'Q4', label: 'Q4' },
];

export default function PeriodSelector({
  year,
  filter,
  yearOptions,
  onYearChange,
  onFilterChange,
}: PeriodSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-2 text-xs text-slate-muted">
        Year
        <select
          value={year}
          onChange={(e) => onYearChange(parseInt(e.target.value, 10))}
          className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
        >
          {yearOptions.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-1">
        {FILTERS.map((f) => {
          const active = f.value === filter;
          return (
            <button
              key={f.value}
              type="button"
              onClick={() => onFilterChange(f.value)}
              className={
                'text-xs px-2 py-1 rounded border transition-colors ' +
                (active
                  ? 'bg-indigo text-white border-indigo'
                  : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
              }
            >
              {f.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
