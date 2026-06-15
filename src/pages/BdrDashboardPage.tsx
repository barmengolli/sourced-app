// BDR Dashboard: progress gauges for each BDR and the whole program, for a
// selected year. Actuals are computed from deals whose first-touch top-level
// channel is "Marketing SDR" and whose bdr_name matches; quotas come from the
// bdr_quotas table. Each gauge lists its matched named deals, openable in the
// deal editor (reuses the same onEditDeal handler as Opportunity Influence).

import { useMemo, useState } from 'react';
import type { PageKey } from '../App';
import type { Attribution, AttributionTouch, BdrQuota, Channel } from '../types/db';
import {
  computeBdrQuotaProgress,
  type BdrProgressRow,
  type BdrStageProgress,
} from '../lib/compute';
import { BDR_STAGES, BDR_STAGE_LABELS } from '../constants/bdr';
import ChartCard from '../components/charts/ChartCard';
import GaugeChart from '../components/charts/GaugeChart';

interface BdrDashboardPageProps {
  attributions: Attribution[];
  attributionTouches: AttributionTouch[];
  channels: Channel[];
  quotas: BdrQuota[];
  loading: boolean;
  onNavigate: (p: PageKey) => void;
  onEditDeal: (attributionId: string) => void;
}

function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}`;
}

export default function BdrDashboardPage({
  attributions,
  attributionTouches,
  channels,
  quotas,
  loading,
  onNavigate,
  onEditDeal,
}: BdrDashboardPageProps) {
  const yearOptions = useMemo(() => {
    const years = new Set<number>([new Date().getFullYear()]);
    for (const q of quotas) years.add(q.year);
    for (const a of attributions) years.add(a.year);
    return [...years].sort((a, b) => b - a);
  }, [quotas, attributions]);

  const [year, setYear] = useState<number>(() => new Date().getFullYear());

  const progress = useMemo(
    () =>
      computeBdrQuotaProgress({
        attributions,
        attributionTouches,
        channels,
        quotas,
        year,
      }),
    [attributions, attributionTouches, channels, quotas, year],
  );

  const program = progress.find((r) => r.isProgram) ?? null;
  const bdrRows = progress.filter((r) => !r.isProgram);

  return (
    <div className="p-8 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-charcoal">
            BDR quota tracking
          </h1>
          <p className="mt-1 text-sm text-slate-muted">
            HPP (SQL) and Opp (SAO) progress vs annual quota, per BDR and
            program-wide. Actuals are deals whose first touch is Marketing SDR,
            credited to a BDR. Set quotas on the Quotas tab; tag deals to a BDR
            in the deal editor.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-muted">
            Year
            <select
              value={year}
              onChange={(e) => setYear(parseInt(e.target.value, 10))}
              className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => onNavigate('bdr-quota-quotas')}
            className="text-xs px-3 py-1.5 rounded border border-border text-charcoal hover:border-charcoal/30"
          >
            Edit quotas
          </button>
        </div>
      </header>

      {loading ? (
        <p className="text-sm text-slate-muted italic">Loading…</p>
      ) : (
        <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {program && (
            <ChartCard title="Program" subtitle="All BDRs combined">
              <StageGauges row={program} onEditDeal={onEditDeal} />
            </ChartCard>
          )}
          {bdrRows.map((row) => (
            <ChartCard key={row.bdrName} title={row.bdrName}>
              <StageGauges row={row} onEditDeal={onEditDeal} />
            </ChartCard>
          ))}
        </section>
      )}
    </div>
  );
}

function StageGauges({
  row,
  onEditDeal,
}: {
  row: BdrProgressRow;
  onEditDeal: (attributionId: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {BDR_STAGES.map((s) => (
          <GaugeChart
            key={s}
            label={BDR_STAGE_LABELS[s]}
            actual={row.stages[s].actual}
            quota={row.stages[s].quota}
          />
        ))}
      </div>
      {BDR_STAGES.map((s) => (
        <DealList
          key={s}
          stageLabel={BDR_STAGE_LABELS[s]}
          stage={row.stages[s]}
          onEditDeal={onEditDeal}
        />
      ))}
    </div>
  );
}

// Collapsible list of the named deals behind a stage's actual count.
function DealList({
  stageLabel,
  stage,
  onEditDeal,
}: {
  stageLabel: string;
  stage: BdrStageProgress;
  onEditDeal: (attributionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (stage.deals.length === 0) return null;
  return (
    <div className="border-t border-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-left"
        aria-expanded={open}
      >
        <span className="text-xs font-medium text-slate-muted">
          {stageLabel} deals ({stage.deals.length})
        </span>
        <span className="text-[10px] text-slate-muted">{open ? '▼' : '▶'}</span>
      </button>
      {open && (
        <ul className="mt-1 divide-y divide-border">
          {stage.deals.map((d) => (
            <li
              key={d.attributionId}
              className="flex items-center justify-between gap-2 py-1"
            >
              <span className="text-xs text-charcoal truncate">
                {d.label}
                {d.account && d.account !== d.label ? (
                  <span className="text-slate-muted"> · {d.account}</span>
                ) : null}
              </span>
              <span className="flex items-center gap-2 flex-shrink-0">
                <span className="text-[11px] text-slate-muted">
                  {fmtDate(d.stageEnteredAt)}
                </span>
                <button
                  type="button"
                  onClick={() => onEditDeal(d.attributionId)}
                  title="Edit deal"
                  aria-label="Edit deal"
                  className="inline-flex items-center justify-center w-6 h-6 rounded text-slate-muted hover:bg-muted hover:text-charcoal"
                >
                  <span className="text-sm">✎</span>
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
