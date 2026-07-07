// LinkedinDashboardPage — the LinkedIn Ads section dashboard. Year selector +
// Week/Month toggle at top; summary tiles (spend, impressions, clicks, CTR, CPC,
// CPM) for the selected period; breakdowns by Product, Region, and Ad Set.
//
// LinkedIn metrics are PER-WEEK (not cumulative), so a period is just the sum of
// its matching rows. No delta math (unlike the Outreach dashboard).

import { useMemo, useState } from 'react';
import type { LinkedinAdSnapshot } from '../types/db';
import { monthOfSnapshotDate } from '../hooks/useLinkedinSnapshots';
import ChartCard from '../components/charts/ChartCard';

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

type Granularity = 'week' | 'month';

interface Totals {
  spend: number;
  impressions: number;
  clicks: number;
}

function sumRows(rows: LinkedinAdSnapshot[]): Totals {
  const t: Totals = { spend: 0, impressions: 0, clicks: 0 };
  for (const r of rows) {
    t.spend += r.spend ?? 0;
    t.impressions += r.impressions ?? 0;
    t.clicks += r.clicks ?? 0;
  }
  return t;
}

const money = (n: number) =>
  `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `$${n.toFixed(2)}`;
const pct = (num: number, den: number) =>
  den > 0 ? `${((num / den) * 100).toFixed(2)}%` : '—';
const ctr = (t: Totals) => pct(t.clicks, t.impressions);
const cpc = (t: Totals) => (t.clicks > 0 ? money2(t.spend / t.clicks) : '—');
const cpm = (t: Totals) =>
  t.impressions > 0 ? money2((t.spend / t.impressions) * 1000) : '—';

export default function LinkedinDashboardPage({
  snapshots,
  loading,
}: {
  snapshots: LinkedinAdSnapshot[];
  loading: boolean;
}) {
  const [granularity, setGranularity] = useState<Granularity>('week');

  const yearOptions = useMemo(() => {
    const ys = new Set<number>([new Date().getFullYear()]);
    for (const s of snapshots) ys.add(s.year);
    return [...ys].sort((a, b) => b - a);
  }, [snapshots]);
  const [year, setYear] = useState<number>(() =>
    snapshots.length ? snapshots[0].year : new Date().getFullYear(),
  );

  // Rows in the active year.
  const yearRows = useMemo(
    () => snapshots.filter((s) => s.year === year),
    [snapshots, year],
  );

  // The ordered period list for the toggle. Week = distinct week_numbers;
  // Month = distinct calendar months present in the year (by snapshot_date).
  const periods = useMemo(() => {
    if (granularity === 'week') {
      const weeks = [...new Set(yearRows.map((s) => s.week_number))].sort(
        (a, b) => a - b,
      );
      return weeks.map((w) => ({
        key: `W${w}`,
        label: `W${w}`,
        match: (s: LinkedinAdSnapshot) => s.week_number === w,
      }));
    }
    const months = new Set<number>();
    for (const s of yearRows) {
      const m = monthOfSnapshotDate(s.snapshot_date);
      if (m) months.add(m.month);
    }
    return [...months]
      .sort((a, b) => a - b)
      .map((mo) => ({
        key: `M${mo}`,
        label: MONTHS_SHORT[mo - 1],
        match: (s: LinkedinAdSnapshot) => {
          const m = monthOfSnapshotDate(s.snapshot_date);
          return m !== null && m.month === mo;
        },
      }));
  }, [granularity, yearRows]);

  const [periodKey, setPeriodKey] = useState<string | null>(null);
  const currentPeriod =
    periods.find((p) => p.key === periodKey) ?? periods[periods.length - 1];

  const rows = useMemo(
    () => (currentPeriod ? yearRows.filter(currentPeriod.match) : []),
    [yearRows, currentPeriod],
  );

  const totals = useMemo(() => sumRows(rows), [rows]);

  // Group helper for the breakdown tables.
  const groupBy = (key: (s: LinkedinAdSnapshot) => string) => {
    const m = new Map<string, Totals>();
    for (const s of rows) {
      const k = key(s) || '—';
      const t = m.get(k) ?? { spend: 0, impressions: 0, clicks: 0 };
      t.spend += s.spend ?? 0;
      t.impressions += s.impressions ?? 0;
      t.clicks += s.clicks ?? 0;
      m.set(k, t);
    }
    return [...m.entries()]
      .map(([name, t]) => ({ name, ...t }))
      .sort((a, b) => b.spend - a.spend);
  };
  const byProduct = useMemo(() => groupBy((s) => s.product ?? ''), [rows]);
  const byRegion = useMemo(() => groupBy((s) => s.region ?? ''), [rows]);
  const byAdset = useMemo(() => groupBy((s) => s.adset_name), [rows]);

  return (
    <div className="p-8 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-charcoal">
            LinkedIn Ads — Dashboard
          </h1>
          <p className="mt-1 text-sm text-slate-muted">
            Paid LinkedIn performance by {granularity === 'week' ? 'week' : 'month'}.
            Spend, impressions, clicks, and derived CTR / CPC / CPM.
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
          <div className="flex items-center gap-1">
            {(['week', 'month'] as const).map((g) => {
              const active = g === granularity;
              return (
                <button
                  key={g}
                  type="button"
                  onClick={() => {
                    setGranularity(g);
                    setPeriodKey(null);
                  }}
                  className={
                    'text-xs px-2 py-1 rounded border transition-colors capitalize ' +
                    (active
                      ? 'bg-indigo text-white border-indigo'
                      : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
                  }
                >
                  {g}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* Period pills */}
      {periods.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs text-slate-muted mr-1">
            {granularity === 'week' ? 'Week' : 'Month'}
          </span>
          {periods.map((p) => {
            const active = currentPeriod?.key === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => setPeriodKey(p.key)}
                className={
                  'text-xs px-2 py-1 rounded border transition-colors ' +
                  (active
                    ? 'bg-indigo text-white border-indigo'
                    : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
                }
              >
                {p.label}
              </button>
            );
          })}
        </div>
      )}

      {loading && snapshots.length === 0 ? (
        <p className="text-sm text-slate-muted italic">Loading…</p>
      ) : snapshots.length === 0 ? (
        <div className="border border-border rounded p-6 text-sm text-slate-muted">
          No LinkedIn Ads data yet. The n8n workflow populates
          linkedin_ads_snapshots from the weekly Google Sheet.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Tile label="Spend" value={money(totals.spend)} />
            <Tile label="Impressions" value={totals.impressions.toLocaleString()} />
            <Tile label="Clicks" value={totals.clicks.toLocaleString()} />
            <Tile label="CTR" value={ctr(totals)} />
            <Tile label="CPC" value={cpc(totals)} />
            <Tile label="CPM" value={cpm(totals)} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCard title="By Product" subtitle="Spend and delivery per product.">
              <BreakdownTable rows={byProduct} firstLabel="Product" />
            </ChartCard>
            <ChartCard title="By Region" subtitle="Spend and delivery per region.">
              <BreakdownTable rows={byRegion} firstLabel="Region" />
            </ChartCard>
          </div>

          <ChartCard title="By Ad Set" subtitle="Spend and delivery per ad set.">
            <BreakdownTable rows={byAdset} firstLabel="Ad set" />
          </ChartCard>
        </>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border rounded bg-muted/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-slate-muted">
        {label}
      </p>
      <p className="mt-0.5 text-lg font-semibold text-charcoal tabular-nums">
        {value}
      </p>
    </div>
  );
}

// Bordered/zebra breakdown table with a blended Total row (rates recomputed
// from the summed counts).
function BreakdownTable({
  rows,
  firstLabel,
}: {
  rows: (Totals & { name: string })[];
  firstLabel: string;
}) {
  const cols: { key: string; label: string; title?: string; value: (t: Totals) => string }[] = [
    { key: 'spend', label: 'Spend', value: (t) => money(t.spend) },
    { key: 'impr', label: 'Impr.', value: (t) => t.impressions.toLocaleString() },
    { key: 'clicks', label: 'Clicks', value: (t) => t.clicks.toLocaleString() },
    { key: 'ctr', label: 'CTR', title: 'Clicks / Impressions', value: (t) => ctr(t) },
    { key: 'cpc', label: 'CPC', title: 'Spend / Clicks', value: (t) => cpc(t) },
    { key: 'cpm', label: 'CPM', title: 'Spend / Impressions × 1000', value: (t) => cpm(t) },
  ];
  const shadeAt = (i: number) => (i % 2 === 1 ? 'bg-muted/50' : '');
  const total = rows.reduce(
    (acc, r) => ({
      spend: acc.spend + r.spend,
      impressions: acc.impressions + r.impressions,
      clicks: acc.clicks + r.clicks,
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
                  {col.value(r)}
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
