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
import ReportingFilterBar from '../components/reporting/ReportingFilterBar';
import ReportingBasisDisclosure from '../components/reporting/ReportingBasisDisclosure';
import { reportingContractFor } from '../constants/reportingPages';
import {
  toPeriodFilter,
  LEGACY_FUNNEL_GRAINS,
  MONTH_DISABLED_REASON,
} from '../lib/reportingPeriodBridge';
import type { ComparisonMode, ReportingPeriod } from '../types/reporting';

interface BdrDashboardPageProps {
  attributions: Attribution[];
  quotas: BdrQuota[];
  loading: boolean;
  onNavigate: (p: PageKey) => void;
  onEditDeal: (attributionId: string) => void;
  // Shared reporting selection.
  explicitPeriod: ReportingPeriod | null;
  comparison: ComparisonMode;
  onPeriodChange: (p: ReportingPeriod) => void;
  onComparisonChange: (m: ComparisonMode) => void;
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

// Basis and anchor come from the single reporting-page registry, so the visible
// disclosure and the declared contract cannot disagree.
const REPORTING_BASIS = reportingContractFor('bdr-quota-dashboard')!;

export default function BdrDashboardPage({
  attributions,
  quotas,
  loading,
  onNavigate,
  onEditDeal,
  explicitPeriod,
  comparison,
  onPeriodChange,
  onComparisonChange,
}: BdrDashboardPageProps) {
  const yearOptions = useMemo(() => {
    const years = new Set<number>([new Date().getFullYear()]);
    for (const q of quotas) years.add(q.year);
    for (const a of attributions) years.add(a.year);
    return [...years].sort((a, b) => b - a);
  }, [quotas, attributions]);

  // Period comes from the SHARED reporting selection, so a timeframe chosen on
  // another reporting page carries here. The previous default read the browser
  // clock at mount, which opened an empty dashboard whenever the current
  // calendar year had no deals yet.
  //
  // Falls back to Year of the latest year that actually has data, never the
  // clock. Year is the default grain because quotas are stored annually and
  // Year is the only grain that can show attainment.
  const fallbackYear = useMemo(() => {
    let latest: number | null = null;
    for (const q of quotas) if (latest === null || q.year > latest) latest = q.year;
    for (const a of attributions) if (latest === null || a.year > latest) latest = a.year;
    return latest;
  }, [quotas, attributions]);

  const period: ReportingPeriod | null =
    explicitPeriod ?? (fallbackYear === null ? null : { grain: 'year', year: fallbackYear });
  const year = period?.year ?? fallbackYear ?? 0;
  const filter: PeriodFilter = (period ? toPeriodFilter(period) : null) ?? 'year';

  // Attainment is shown ONLY for the Year grain. Quotas are stored annually,
  // so a month or quarter would compare a partial actual against a full-year
  // target, painting an on-pace rep red.
  const showAttainment = period?.grain === 'year';

  function handlePeriodChange(next: ReportingPeriod) {
    onPeriodChange(next);
  }

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
          <ReportingBasisDisclosure
            basis={REPORTING_BASIS.basis}
            explanation={REPORTING_BASIS.anchor}
          />
          {period ? (
          <ReportingFilterBar
            period={period}
            comparison={comparison}
            years={yearOptions}
            supportedGrains={LEGACY_FUNNEL_GRAINS}
            disabledGrainReason={MONTH_DISABLED_REASON}
            onPeriodChange={handlePeriodChange}
            onComparisonChange={onComparisonChange}
          />
          ) : null}
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
                <StageGauges
                  row={program}
                  onEditDeal={onEditDeal}
                  showAttainment={showAttainment}
                />
              </ChartCard>
            )}
            {bdrRows.map((row) => (
              <ChartCard key={row.bdrName} title={row.bdrName}>
                <StageGauges
                  row={row}
                  onEditDeal={onEditDeal}
                  showAttainment={showAttainment}
                />
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
  showAttainment,
}: {
  row: BdrProgressRow;
  onEditDeal: (attributionId: string) => void;
  // False for Month and Quarter. Quotas are stored ANNUALLY, so a sub-year
  // period has quarterly actuals and a full-year quota: a rep with a 40 annual
  // quota who hit 10 in Q2, exactly on pace, rendered 10/40 = 25% in danger
  // red. Prorating the annual quota would assume flat seasonality that BDR
  // ramp and holiday quarters violate, and CLAUDE.md records that period quota
  // interpretation needs business approval. So the percentage, the gauge fill,
  // and the performance color are SUPPRESSED and the raw count stays visible.
  showAttainment: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {BDR_STAGES.map((s) => (
          <GaugeChart
            key={s}
            label={BDR_STAGE_LABELS[s]}
            actual={row.stages[s].actual}
            // A null quota is already the neutral path: no percentage, no
            // colored arc, no "/ quota". Suppression is expressed by
            // withholding the annual quota, never by inventing a smaller one.
            quota={showAttainment ? row.stages[s].quota : null}
          />
        ))}
      </div>
      {!showAttainment && (
        <p className="text-xs text-slate-muted">
          Quotas are set annually, so attainment is not shown for a month or
          quarter. Counts above are actual deals in the selected period. Switch
          the timeframe to Year to see attainment against the annual quota.
        </p>
      )}
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
