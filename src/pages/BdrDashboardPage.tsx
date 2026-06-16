// BDR Dashboard: progress gauges for each BDR and the whole program, for a
// selected year (optionally scoped to a quarter by the deal's HPP/created
// date). Actuals are computed from deals tagged with that BDR (bdr_name);
// quotas come from the bdr_quotas table. A year-over-year line chart up top
// shows HPPs created per quarter, this year vs last. Each gauge lists its
// matched named deals, openable in the deal editor.

import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PageKey } from '../App';
import type { Attribution, BdrQuota } from '../types/db';
import {
  computeBdrQuotaProgress,
  type BdrProgressRow,
  type BdrQuarterlyCreated,
  type BdrStageProgress,
  type PeriodFilter,
} from '../lib/compute';
import { BDR_STAGES, BDR_STAGE_LABELS } from '../constants/bdr';
import { CHART_COLORS } from '../constants/chartColors';
import ChartCard from '../components/charts/ChartCard';
import GaugeChart from '../components/charts/GaugeChart';

const FILTERS: { value: PeriodFilter; label: string }[] = [
  { value: 'year', label: 'Year' },
  { value: 'Q1', label: 'Q1' },
  { value: 'Q2', label: 'Q2' },
  { value: 'Q3', label: 'Q3' },
  { value: 'Q4', label: 'Q4' },
];

interface BdrDashboardPageProps {
  attributions: Attribution[];
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
  const [filter, setFilter] = useState<PeriodFilter>('year');

  const progress = useMemo(
    () =>
      computeBdrQuotaProgress({
        attributions,
        quotas,
        year,
        filter,
      }),
    [attributions, quotas, year, filter],
  );

  const program = progress.rows.find((r) => r.isProgram) ?? null;
  const bdrRows = progress.rows.filter((r) => !r.isProgram);

  return (
    <div className="p-8 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-charcoal">
            BDR Quota Tracker
          </h1>
          <p className="mt-1 text-sm text-slate-muted">
            HPP (SQL) and Opp (SAO) progress vs annual quota, per BDR and
            program-wide. Actuals are deals tagged to a BDR; deals bucket into a
            quarter by their HPP (created) date. Set quotas on the Quotas tab;
            tag deals to a BDR in the deal editor.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
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
          <div className="flex items-center gap-1">
            {FILTERS.map((f) => {
              const active = f.value === filter;
              return (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFilter(f.value)}
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
        <>
          {/* Year-over-year HPPs created per quarter. Always all four
              quarters; not affected by the quarter filter (which scopes the
              gauges below). */}
          <CreatedTrendChart
            quarterly={progress.quarterly}
            year={year}
            priorYear={year - 1}
          />

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {program && (
              <ChartCard
                title="Program"
                subtitle={
                  filter === 'year'
                    ? 'All BDRs combined'
                    : `All BDRs combined · ${filter} (by HPP date)`
                }
              >
                <StageGauges row={program} onEditDeal={onEditDeal} />
              </ChartCard>
            )}
            {bdrRows.map((row) => (
              <ChartCard key={row.bdrName} title={row.bdrName}>
                <StageGauges row={row} onEditDeal={onEditDeal} />
              </ChartCard>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

// Year-over-year line chart: HPPs created per quarter, selected year vs prior.
function CreatedTrendChart({
  quarterly,
  year,
  priorYear,
}: {
  quarterly: BdrQuarterlyCreated[];
  year: number;
  priorYear: number;
}) {
  const data = quarterly.map((q) => ({
    quarter: `Q${q.quarter}`,
    [String(year)]: q.currentYear,
    [String(priorYear)]: q.priorYear,
  }));
  return (
    <ChartCard
      title="Opportunities Created by Quarter"
      subtitle={`HPPs created per quarter, ${year} vs ${priorYear} (BDR-tagged deals)`}
    >
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.border} />
          <XAxis
            dataKey="quarter"
            tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
            axisLine={{ stroke: CHART_COLORS.border }}
            tickLine={{ stroke: CHART_COLORS.border }}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
            axisLine={{ stroke: CHART_COLORS.border }}
            tickLine={{ stroke: CHART_COLORS.border }}
            width={36}
          />
          <Tooltip
            contentStyle={{
              fontSize: 11,
              border: `1px solid ${CHART_COLORS.border}`,
              borderRadius: 6,
            }}
            labelStyle={{ color: CHART_COLORS.charcoal, fontWeight: 600 }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line
            type="monotone"
            dataKey={String(year)}
            stroke={CHART_COLORS.indigo}
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey={String(priorYear)}
            stroke={CHART_COLORS.slateMuted}
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={{ r: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
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
