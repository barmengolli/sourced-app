// LinkedinDashboardPage — the LinkedIn Ads section dashboard, migrated onto the
// shared reporting foundation (Bite 2).
//
// Timeframe is Month / Quarter / Year via the shared ReportingFilterBar, with a
// Previous period / Previous year / Off comparison. Week is no longer an
// executive control (weekly rows remain in storage; they are simply summed into
// the selected period). A whole week is assigned to the month, quarter, and year
// containing its week-ending Sunday, never prorated.
//
// All period math, totals, rate recomputation, comparison, breakdowns, and
// completeness live in the pure src/lib/linkedinReporting.ts helpers. This file
// is presentation only.

import { useMemo, useState } from 'react';
import type { LinkedinAdSnapshot } from '../types/db';
import type {
  ComparisonMode,
  MetricDirection,
  MetricValue,
  ReportingPeriod,
} from '../types/reporting';
import {
  comparePeriods,
  periodBreakdowns,
  ratesFromTotals,
  assessLinkedinCompleteness,
  defaultMonthPeriod,
  availableYears,
  type BreakdownRow,
  type LinkedinTotals,
} from '../lib/linkedinReporting';
import {
  computeDelta,
  computeRateDelta,
  type DeltaValueFormat,
} from '../lib/reportingDeltas';
import {
  periodLabel,
  comparisonLabel,
} from '../lib/reportingPeriods';
import ReportingFilterBar from '../components/reporting/ReportingFilterBar';
import ReportingBasisDisclosure from '../components/reporting/ReportingBasisDisclosure';
import DeltaDisplay from '../components/reporting/DeltaDisplay';
import ChartCard from '../components/charts/ChartCard';

// Timezone-safe "Jul 19, 2026" from a YYYY-MM-DD string (no Date construction).
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;
function formatWeekEnding(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  const mo = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (mo < 1 || mo > 12) return '';
  return `${MONTHS_SHORT[mo - 1]} ${day}, ${m[1]}`;
}

// Display formatters for KPI values (period totals). Rates show em dash when the
// denominator is zero (undefined rate), matching the pre-migration behavior.
const money0 = (n: number) =>
  `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `$${n.toFixed(2)}`;
const count = (n: number) => n.toLocaleString();
const rateOrDash = (v: number | null, fmt: (n: number) => string) =>
  v === null ? '—' : fmt(v);

// KPI spec: label, direction, how to read the current value, the MetricValue
// pair for the delta, and the delta's display format. Directions come from
// CLAUDE.md section 6 (Step 6 of the migration brief).
interface Kpi {
  key: string;
  label: string;
  title?: string;
  direction: MetricDirection;
  isRate: boolean;
  format: string | DeltaValueFormat;
}

const KPIS: Kpi[] = [
  { key: 'spend', label: 'Spend', direction: 'neutral', isRate: false, format: { kind: 'currency', decimals: 0 } },
  { key: 'impressions', label: 'Impressions', direction: 'neutral', isRate: false, format: { kind: 'number' } },
  { key: 'clicks', label: 'Clicks', direction: 'higher_is_better', isRate: false, format: { kind: 'number' } },
  { key: 'ctrPercent', label: 'CTR', title: 'Clicks / Impressions', direction: 'higher_is_better', isRate: true, format: { kind: 'points', decimals: 2 } },
  { key: 'cpc', label: 'CPC', title: 'Spend / Clicks', direction: 'lower_is_better', isRate: false, format: { kind: 'currency', decimals: 2 } },
  { key: 'cpm', label: 'CPM', title: 'Spend / Impressions x 1000', direction: 'neutral', isRate: false, format: { kind: 'currency', decimals: 2 } },
];

export default function LinkedinDashboardPage({
  snapshots,
  loading,
}: {
  snapshots: LinkedinAdSnapshot[];
  loading: boolean;
}) {
  // Default period: the Month containing the latest imported week (clock-free).
  // Fallback keeps a valid shape when there is no data yet.
  const initialPeriod: ReportingPeriod = useMemo(
    () => defaultMonthPeriod(snapshots) ?? { grain: 'year', year: 2026 },
    [snapshots],
  );
  const [period, setPeriod] = useState<ReportingPeriod>(initialPeriod);
  const [comparison, setComparison] = useState<ComparisonMode>('previous_period');

  const years = useMemo(
    () => availableYears(snapshots, period.year),
    [snapshots, period.year],
  );

  const cmp = useMemo(
    () => comparePeriods(snapshots, period, comparison),
    [snapshots, period, comparison],
  );
  const completeness = useMemo(
    () => assessLinkedinCompleteness(snapshots, period),
    [snapshots, period],
  );
  const breakdowns = useMemo(
    () => periodBreakdowns(snapshots, period),
    [snapshots, period],
  );

  const cmpLabel = comparisonLabel(period, comparison);
  const suppress = completeness.suppressDelta;

  // Build the delta for a KPI: rates use pp deltas, counts/currency use absolute
  // deltas. Suppressed for a partial current period.
  function deltaFor(kpi: Kpi) {
    const curV = cmp.current.values[kpi.key as keyof typeof cmp.current.values] as MetricValue;
    const cmpV = (cmp.comparison?.values[kpi.key as keyof typeof cmp.current.values] ?? { state: 'missing' }) as MetricValue;
    return kpi.isRate
      ? computeRateDelta(curV, cmpV, kpi.direction)
      : computeDelta(curV, cmpV, kpi.direction);
  }

  function kpiValueText(kpi: Kpi): string {
    const t = cmp.current.totals;
    const r = cmp.current.rates;
    if (!cmp.current.hasData) return '—';
    switch (kpi.key) {
      case 'spend': return money0(t.spend);
      case 'impressions': return count(t.impressions);
      case 'clicks': return count(t.clicks);
      case 'ctrPercent': return rateOrDash(r.ctrPercent, (n) => `${n.toFixed(2)}%`);
      case 'cpc': return rateOrDash(r.cpc, money2);
      case 'cpm': return rateOrDash(r.cpm, money2);
      default: return '—';
    }
  }

  return (
    <div className="p-8 space-y-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-charcoal">
          LinkedIn Ads — Dashboard
        </h1>
        <ReportingBasisDisclosure
          basis="activity"
          explanation="Weekly LinkedIn Ads activity assigned by week-ending Sunday."
        />
        <p className="text-xs text-slate-muted" data-testid="linkedin-data-through">
          {completeness.dataThrough
            ? `Data through week ending ${formatWeekEnding(completeness.dataThrough)}`
            : 'No imported weeks yet'}
          {completeness.completeness === 'partial' && (
            <span className="ml-2 rounded-md border border-border bg-muted px-2 py-0.5 font-medium text-charcoal">
              Partial period
            </span>
          )}
        </p>
      </header>

      <ReportingFilterBar
        period={period}
        comparison={comparison}
        years={years}
        onPeriodChange={setPeriod}
        onComparisonChange={setComparison}
      />

      {loading && snapshots.length === 0 ? (
        <p className="text-sm text-slate-muted italic">Loading…</p>
      ) : snapshots.length === 0 ? (
        <div className="border border-border rounded p-6 text-sm text-slate-muted">
          No LinkedIn Ads data yet. The n8n workflow populates
          linkedin_ads_snapshots from the weekly Google Sheet.
        </div>
      ) : (
        <>
          <p className="text-xs text-slate-muted">
            {periodLabel(period)}
            {!suppress && cmpLabel ? ` · ${cmpLabel}` : ''}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {KPIS.map((kpi) => (
              <Tile
                key={kpi.key}
                label={kpi.label}
                title={kpi.title}
                value={kpiValueText(kpi)}
                delta={
                  suppress ? null : (
                    <DeltaDisplay result={deltaFor(kpi)} format={kpi.format} />
                  )
                }
              />
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCard title="By Product" subtitle="Spend and delivery per product.">
              <BreakdownTable rows={breakdowns.byProduct} firstLabel="Product" />
            </ChartCard>
            <ChartCard title="By Region" subtitle="Spend and delivery per region.">
              <BreakdownTable rows={breakdowns.byRegion} firstLabel="Region" />
            </ChartCard>
          </div>

          <ChartCard title="By Ad Set" subtitle="Spend and delivery per ad set.">
            <BreakdownTable rows={breakdowns.byAdset} firstLabel="Ad set" />
          </ChartCard>
        </>
      )}
    </div>
  );
}

function Tile({
  label,
  title,
  value,
  delta,
}: {
  label: string;
  title?: string;
  value: string;
  delta: React.ReactNode;
}) {
  return (
    <div className="border border-border rounded bg-muted/40 px-3 py-2" title={title}>
      <p className="text-[10px] uppercase tracking-wider text-slate-muted">
        {label}
      </p>
      <p className="mt-0.5 text-lg font-semibold text-charcoal tabular-nums">
        {value}
      </p>
      {delta ? <div className="mt-0.5">{delta}</div> : null}
    </div>
  );
}

// Breakdown table. Rates are recomputed from each row's aggregate counts, and
// the Total row recomputes from the summed counts, so the table reconciles to
// the KPI totals for the same period and filters.
function BreakdownTable({
  rows,
  firstLabel,
}: {
  rows: BreakdownRow[];
  firstLabel: string;
}) {
  const cols: {
    key: string;
    label: string;
    title?: string;
    value: (totals: LinkedinTotals) => string;
  }[] = [
    { key: 'spend', label: 'Spend', value: (t) => money0(t.spend) },
    { key: 'impr', label: 'Impr.', value: (t) => count(t.impressions) },
    { key: 'clicks', label: 'Clicks', value: (t) => count(t.clicks) },
    { key: 'ctr', label: 'CTR', title: 'Clicks / Impressions', value: (t) => rateOrDash(ratesFromTotals(t).ctrPercent, (n) => `${n.toFixed(2)}%`) },
    { key: 'cpc', label: 'CPC', title: 'Spend / Clicks', value: (t) => rateOrDash(ratesFromTotals(t).cpc, money2) },
    { key: 'cpm', label: 'CPM', title: 'Spend / Impressions x 1000', value: (t) => rateOrDash(ratesFromTotals(t).cpm, money2) },
  ];
  const shadeAt = (i: number) => (i % 2 === 1 ? 'bg-muted/50' : '');
  const total = rows.reduce<LinkedinTotals>(
    (acc, r) => ({
      spend: acc.spend + r.totals.spend,
      impressions: acc.impressions + r.totals.impressions,
      clicks: acc.clicks + r.totals.clicks,
    }),
    { spend: 0, impressions: 0, clicks: 0 },
  );
  const cell = 'border border-border px-2 py-1';

  if (rows.length === 0) {
    return (
      <p className="text-sm text-slate-muted italic">
        No data for the selected period.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm border-collapse border border-border">
        <thead className="text-xs text-slate-muted bg-muted/40">
          <tr>
            <th className={`${cell} text-left font-medium`}>{firstLabel}</th>
            {cols.map((col, i) => (
              <th key={col.key} title={col.title} className={`${cell} text-right font-medium ${shadeAt(i)}`}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className={`${cell} text-charcoal truncate max-w-[240px]`} title={r.name}>
                {r.name}
              </td>
              {cols.map((col, i) => (
                <td key={col.key} className={`${cell} text-right tabular-nums text-slate-muted ${shadeAt(i)}`}>
                  {col.value(r.totals)}
                </td>
              ))}
            </tr>
          ))}
          <tr className="font-medium">
            <td className={`${cell} text-charcoal`}>Total</td>
            {cols.map((col, i) => (
              <td key={col.key} className={`${cell} text-right tabular-nums text-charcoal ${shadeAt(i)}`}>
                {col.value(total)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
