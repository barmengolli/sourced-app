import type { PeriodFilter } from '../../lib/compute';
import {
  REGIONS,
  REGION_LABELS,
  type RegionKey,
} from '../../constants/regions';

interface PeriodSelectorProps {
  year: number;
  filter: PeriodFilter;
  yearOptions: number[];
  onYearChange: (y: number) => void;
  onFilterChange: (f: PeriodFilter) => void;
  // Multi-select region filter. When the set has all five regions, no
  // filtering happens (same as no filter). When a partial set is active,
  // leads and attributions outside the selected regions are excluded from
  // computeGrid (null-region rows excluded too).
  regions: Set<RegionKey>;
  onRegionsChange: (next: Set<RegionKey>) => void;
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
  regions,
  onRegionsChange,
}: PeriodSelectorProps) {
  const allOn = regions.size === REGIONS.length;
  const toggleRegion = (r: RegionKey) => {
    const next = new Set(regions);
    if (next.has(r)) next.delete(r);
    else next.add(r);
    onRegionsChange(next);
  };
  const setAllRegions = (all: boolean) => {
    onRegionsChange(all ? new Set(REGIONS) : new Set());
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
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
      <div className="flex items-center gap-1">
        <span className="text-xs text-slate-muted mr-1">Region</span>
        <button
          type="button"
          onClick={() => setAllRegions(!allOn)}
          className="text-xs px-2 py-1 rounded-full border border-border text-slate-muted hover:text-charcoal hover:border-charcoal/30"
        >
          {allOn ? 'Clear' : 'All'}
        </button>
        {REGIONS.map((r) => {
          const on = regions.has(r);
          return (
            <button
              key={r}
              type="button"
              onClick={() => toggleRegion(r)}
              title={REGION_LABELS[r]}
              className={
                'text-xs px-2 py-1 rounded-full border transition-colors ' +
                (on
                  ? 'bg-indigo text-white border-indigo'
                  : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
              }
            >
              {r}
            </button>
          );
        })}
      </div>
    </div>
  );
}
