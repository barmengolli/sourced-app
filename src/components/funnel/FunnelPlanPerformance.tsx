import { FUNNEL_STAGE_LABELS, type FunnelStageKey } from '../../constants/funnelStages';
import { onTargetPercent, type ComputedGrid } from '../../lib/compute';

interface FunnelPlanPerformanceProps {
  totals: ComputedGrid['totals'];
}

const STAGES: FunnelStageKey[] = ['lead', 'mql', 'hpp', 'opp', 'pursuit', 'closeWon'];

function display(value: number | null): string {
  return value === null ? '—' : value.toLocaleString();
}

export default function FunnelPlanPerformance({ totals }: FunnelPlanPerformanceProps) {
  return (
    <section className="rounded-xl border border-border bg-bg p-4 shadow-sm sm:p-5">
      <header className="mb-4 border-b border-border pb-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo">Plan performance</p>
        <h2 className="mt-1 text-base font-semibold text-charcoal">Performance against plan</h2>
        <p className="mt-1 text-xs text-slate-muted">Actual volume compared with the selected-period target.</p>
      </header>

      <ul className="space-y-3">
        {STAGES.map((stage) => {
          const values = totals[stage];
          const percent = onTargetPercent(values.actual, values.projection);
          const visualWidth = percent === null ? 0 : Math.min(100, Math.max(0, percent));
          return (
            <li key={stage} className="grid grid-cols-[6.5rem_minmax(0,1fr)_5.5rem] items-center gap-3">
              <span className="text-xs font-medium text-charcoal">{FUNNEL_STAGE_LABELS[stage]}</span>
              <div className="relative h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-indigo"
                  style={{ width: `${visualWidth}%` }}
                />
              </div>
              <span className="text-right text-[11px] tabular-nums text-slate-muted">
                {display(values.actual)} / {display(values.projection)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
