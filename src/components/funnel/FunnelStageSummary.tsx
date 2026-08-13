import { FUNNEL_STAGE_LABELS, type FunnelStageKey } from '../../constants/funnelStages';
import type { ComputedGrid } from '../../lib/compute';

interface FunnelStageSummaryProps {
  totals: ComputedGrid['totals'];
  note?: string;
}

const PRIMARY_STAGES: FunnelStageKey[] = [
  'lead',
  'mql',
  'hpp',
  'opp',
  'pursuit',
  'closeWon',
];

const ACCENTS: Record<(typeof PRIMARY_STAGES)[number], string> = {
  lead: 'from-indigo/10 to-indigo/5 text-indigo',
  mql: 'from-teal/15 to-teal/5 text-teal',
  hpp: 'from-sky-500/10 to-sky-500/5 text-sky-700',
  opp: 'from-violet-500/10 to-violet-500/5 text-violet-700',
  pursuit: 'from-amber-500/10 to-amber-500/5 text-amber-700',
  closeWon: 'from-success/15 to-success/5 text-emerald-700',
  closeLost: 'from-danger/10 to-danger/5 text-danger',
};

function displayNumber(value: number | null): string {
  return value === null ? '—' : value.toLocaleString();
}

export default function FunnelStageSummary({
  totals,
  note = 'Exact totals from the table below · no separate calculation',
}: FunnelStageSummaryProps) {
  return (
    <section
      aria-labelledby="funnel-snapshot-title"
      className="space-y-4 rounded-2xl border border-border bg-bg p-4 shadow-sm sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">
            Executive scorecard
          </p>
          <h2 id="funnel-snapshot-title" className="mt-1 text-lg font-semibold text-charcoal">
            Funnel snapshot
          </h2>
          <p className="mt-1 text-xs text-slate-muted">{note}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {PRIMARY_STAGES.map((stage, index) => {
          const values = totals[stage];
          return (
            <article
              key={stage}
              className="relative overflow-hidden rounded-xl border border-border bg-bg p-4 shadow-sm"
            >
              <div
                aria-hidden="true"
                className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${ACCENTS[stage]}`}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-muted">
                  {FUNNEL_STAGE_LABELS[stage]}
                </span>
                <span className={`text-[10px] font-semibold ${ACCENTS[stage].split(' ').at(-1)}`}>
                  {String(index + 1).padStart(2, '0')}
                </span>
              </div>
              <p className="mt-3 text-2xl font-semibold tracking-tight text-charcoal tabular-nums">
                {displayNumber(values.actual)}
              </p>
              <div className="mt-2 flex items-center justify-between border-t border-border/70 pt-2 text-[11px]">
                <span className="text-slate-muted">Actual</span>
                <span className="font-medium text-charcoal tabular-nums">
                  Plan {displayNumber(values.projection)}
                </span>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
