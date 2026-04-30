import type { StageKey } from '../../types/db';
import { STAGE_LABELS, STAGE_ORDER } from '../../constants/stages';

interface LeadsFilterBarProps {
  stageFilter: Set<StageKey>;
  onToggleStage: (stage: StageKey) => void;
  onSetAllStages: (all: boolean) => void;

  countries: string[];
  countryFilter: string;
  onCountryChange: (country: string) => void;

  owners: string[];
  ownerFilter: string;
  onOwnerChange: (owner: string) => void;

  search: string;
  onSearchChange: (q: string) => void;
}

export default function LeadsFilterBar({
  stageFilter,
  onToggleStage,
  onSetAllStages,
  countries,
  countryFilter,
  onCountryChange,
  owners,
  ownerFilter,
  onOwnerChange,
  search,
  onSearchChange,
}: LeadsFilterBarProps) {
  const allOn = stageFilter.size === STAGE_ORDER.length;
  return (
    <div className="border border-border rounded-lg bg-bg p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-muted uppercase tracking-wide mr-1">
          Stage
        </span>
        <button
          type="button"
          onClick={() => onSetAllStages(!allOn)}
          className="text-xs px-2 py-1 rounded-full border border-border text-slate-muted hover:text-charcoal hover:border-charcoal/30"
        >
          {allOn ? 'Clear' : 'All'}
        </button>
        {STAGE_ORDER.map((s) => {
          const on = stageFilter.has(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => onToggleStage(s)}
              className={
                'text-xs px-2 py-1 rounded-full border transition-colors ' +
                (on
                  ? 'bg-indigo text-white border-indigo'
                  : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
              }
            >
              {STAGE_LABELS[s]}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-muted">
          Country
          <select
            value={countryFilter}
            onChange={(e) => onCountryChange(e.target.value)}
            className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
          >
            <option value="">All</option>
            {countries.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-slate-muted">
          Owner
          <select
            value={ownerFilter}
            onChange={(e) => onOwnerChange(e.target.value)}
            className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
          >
            <option value="">All</option>
            {owners.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-slate-muted flex-1 min-w-[200px]">
          Search
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Email, name, account"
            className="flex-1 text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo focus:border-indigo"
          />
        </label>
      </div>
    </div>
  );
}
