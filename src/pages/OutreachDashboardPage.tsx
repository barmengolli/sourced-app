// OutreachDashboardPage — the Outreach executive dashboard, migrated onto the
// shared reporting standard (Bite 3B) and the Bite 3A calculation contract.
//
// Timeframe is Month / Quarter / Year via the shared ReportingFilterBar with a
// Previous period / Previous year / Off comparison. Week is no longer an
// executive control (weekly rows stay in storage and on the Data tab). Every
// panel computes through src/lib/outreachReporting.ts: exact Thursday
// baselines, intermediate reset detection, metric-specific missing coverage,
// scoped duplicate handling, and explicit partial/missing states. Nothing here
// re-implements calculation logic; the page is presentation.
//
// Period membership uses export_date calendar boundaries only; the stored
// week_number and stored year are never used for calendar math.

import { useMemo, useState } from 'react';
import type { OutreachSubPageProps } from '../App';
import type {
  ComparisonMode,
  MetricDirection,
  ReportingPeriod,
  MonthIndex,
} from '../types/reporting';
import {
  periodLabel,
  comparisonLabel,
  previousPeriod,
} from '../lib/reportingPeriods';
import {
  dedupeSnapshots,
  filterDedupedSeries,
  aggregateActivity,
  sequencePeriodActivity,
  rateFromTotals,
  compareOutreachActivity,
  assessOutreachCompleteness,
  type ActivityCounter,
  type DedupedSeries,
  type MetricTotal,
  type OutreachReportingRow,
  type SequenceActivity,
  type OutreachCompleteness,
} from '../lib/outreachReporting';
import { toOutreachReportingRows } from '../lib/outreachSnapshotAdapter';
import { computeDelta, type DeltaResult } from '../lib/reportingDeltas';
import ReportingFilterBar from '../components/reporting/ReportingFilterBar';
import ReportingBasisDisclosure from '../components/reporting/ReportingBasisDisclosure';
import FilterChipGroup, { type FilterChip } from '../components/reporting/FilterChipGroup';
import DeltaDisplay from '../components/reporting/DeltaDisplay';
import SequenceMultiSelect from '../components/outreach/SequenceMultiSelect';
import {
  OUTREACH_REGIONS,
  OUTREACH_REGION_LABELS,
  type OutreachRegionKey,
} from '../constants/outreachRegions';
import { inferRegionFromSequenceName } from '../lib/outreach';

// Timezone-safe "Jul 23, 2026" from YYYY-MM-DD (no Date construction).
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;
function formatIsoDate(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  const mo = parseInt(m[2], 10);
  if (mo < 1 || mo > 12) return '';
  return `${MONTHS_SHORT[mo - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

// The Month period containing the latest valid export_date (clock-free
// data-driven default).
function defaultMonthFromRows(rows: readonly OutreachReportingRow[]): ReportingPeriod | null {
  let latest: string | null = null;
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.export_date)) continue;
    if (latest === null || r.export_date > latest) latest = r.export_date;
  }
  if (latest === null) return null;
  const [y, m] = latest.split('-').map((s) => parseInt(s, 10));
  return { grain: 'month', year: y, month: m as MonthIndex };
}

// KPI cards, directions per the Bite 3B brief: Opened/Replied higher-is-better;
// volume metrics neutral until a business target is approved.
const KPI_METRICS: { key: ActivityCounter; label: string; direction: MetricDirection }[] = [
  { key: 'total_sent', label: 'Emails Sent', direction: 'neutral' },
  { key: 'delivered', label: 'Delivered', direction: 'neutral' },
  { key: 'opened', label: 'Opened', direction: 'higher_is_better' },
  { key: 'replied', label: 'Replied', direction: 'higher_is_better' },
  { key: 'outbound_calls', label: 'Outbound Calls', direction: 'neutral' },
  { key: 'linkedin_tasks_completed', label: 'LinkedIn Tasks', direction: 'neutral' },
];

// Aggregate value -> display string, missing stays a dash, incomplete flagged.
function totalText(t: MetricTotal): string {
  return t.state === 'present' ? t.value.toLocaleString() : '—';
}

export default function OutreachDashboardPage({
  dashboardPeriod,
  dashboardComparison,
  regions,
  selectedSequences,
  onDashboardPeriodChange,
  onDashboardComparisonChange,
  onRegionsChange,
  onSelectedSequencesChange,
  snapshots,
  loading,
}: OutreachSubPageProps) {
  // Normalize + dedupe the COMPLETE feed once (missing-vs-zero restored by the
  // adapter; duplicates resolved; feed-wide feedStart preserved).
  const reportingRows = useMemo(() => toOutreachReportingRows(snapshots), [snapshots]);
  const fullDeduped = useMemo(() => dedupeSnapshots(reportingRows), [reportingRows]);

  // Effective period: the user's lifted selection, else the Month containing
  // the latest export_date. Derived during render (no effect), so realtime
  // updates and tab navigation never reset an explicit choice. The default is
  // memoized UNCONDITIONALLY to keep hook order fixed.
  const defaultPeriod = useMemo(() => defaultMonthFromRows(reportingRows), [reportingRows]);
  const period: ReportingPeriod | null = dashboardPeriod ?? defaultPeriod;

  // Sequence options from the deduped feed, using the LATEST name per
  // sequence_id so a rename shows its current label without splitting history.
  const sequenceOptions = useMemo(() => {
    const out: { id: number; name: string }[] = [];
    for (const [id, series] of fullDeduped.bySequence) {
      const name = series.length ? series[series.length - 1].sequence_name : String(id);
      out.push({ id, name });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [fullDeduped]);

  // Resolve region + sequence filters into ONE keep-set of sequence_ids,
  // applied identically to current and comparison periods. Region is inferred
  // from the latest sequence name (rename keeps identity via sequence_id).
  const keepSequenceIds = useMemo(() => {
    const allRegionsOn = regions.size === OUTREACH_REGIONS.length;
    const allSeqs =
      selectedSequences.size === 0 ||
      selectedSequences.size === sequenceOptions.length;
    if (allRegionsOn && allSeqs) return new Set<number>(); // empty = all
    const keep = new Set<number>();
    for (const { id, name } of sequenceOptions) {
      if (!allRegionsOn && !regions.has(inferRegionFromSequenceName(name))) continue;
      if (!allSeqs && !selectedSequences.has(id)) continue;
      keep.add(id);
    }
    // A non-empty filter that matches nothing must NOT fall back to "all":
    // use an impossible id so calculations correctly return missing.
    if (keep.size === 0) keep.add(-1);
    return keep;
  }, [regions, selectedSequences, sequenceOptions]);

  // Filtered feed for activity math; feed-wide feedStart is preserved so
  // filtering cannot fabricate pre-feed boundary exemptions.
  const deduped = useMemo(
    () => filterDedupedSeries(fullDeduped, keepSequenceIds),
    [fullDeduped, keepSequenceIds],
  );

  // Cadence completeness uses the FULL feed's run dates: a Thursday run
  // happened (or not) regardless of which sequences are selected.
  const completeness: OutreachCompleteness = useMemo(
    () =>
      period
        ? assessOutreachCompleteness(reportingRows, period)
        : {
            completeness: 'missing',
            missingThursdays: [],
            requiredBaselineThursday: null,
            missingBaselineThursday: false,
            finalExpectedThursday: null,
            dataThrough: latestDate(reportingRows),
            suppressDelta: true,
          },
    [reportingRows, period],
  );
  const cmpPeriodForCadence = period ? previousOrSame(period, dashboardComparison) : null;
  const cmpCompleteness = useMemo(
    () =>
      cmpPeriodForCadence
        ? assessOutreachCompleteness(reportingRows, cmpPeriodForCadence)
        : null,
    [reportingRows, cmpPeriodForCadence],
  );

  // Cadence-level suppression: current partial/missing, or (when comparing)
  // comparison partial/missing. Combined with the metric-level flag per KPI.
  const cadenceSuppress =
    completeness.suppressDelta || (cmpCompleteness ? cmpCompleteness.suppressDelta : dashboardComparison !== 'off');

  const cmpLabel = period ? comparisonLabel(period, dashboardComparison) : '';
  const showComparison = dashboardComparison !== 'off';

  const regionChips: FilterChip<OutreachRegionKey>[] = OUTREACH_REGIONS.map((r) => ({
    value: r,
    label: r,
  }));

  return (
    <div className="p-8 space-y-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-charcoal">
          Outreach — Dashboard
        </h1>
        <ReportingBasisDisclosure
          basis="derived_activity"
          explanation="Weekly lifetime counters converted to period activity using exact Thursday baselines."
        />
        <p className="text-xs text-slate-muted" data-testid="outreach-data-through">
          {completeness.dataThrough
            ? `Data through ${formatIsoDate(completeness.dataThrough)}`
            : 'No imported snapshots yet'}
          {period && completeness.completeness === 'partial' && (
            <span className="ml-2 rounded-md border border-border bg-muted px-2 py-0.5 font-medium text-charcoal">
              Partial period
            </span>
          )}
        </p>
      </header>

      {/* Control order: timeframe -> period -> year -> comparison -> sequence -> region */}
      {period && (
        <div className="flex flex-wrap items-end gap-3">
          <ReportingFilterBar
            period={period}
            comparison={dashboardComparison}
            years={yearsFrom(reportingRows, period.year)}
            onPeriodChange={onDashboardPeriodChange}
            onComparisonChange={onDashboardComparisonChange}
          >
            <div className="inline-flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-muted">Sequences</span>
              <SequenceMultiSelect
                sequences={sequenceOptions}
                selectedIds={selectedSequences}
                onChange={onSelectedSequencesChange}
              />
            </div>
            <FilterChipGroup
              label="Region"
              chips={regionChips}
              selected={[...regions]}
              onToggle={(r) => {
                const next = new Set(regions);
                if (next.has(r)) next.delete(r);
                else next.add(r);
                onRegionsChange(next);
              }}
              onClear={() => onRegionsChange(new Set(OUTREACH_REGIONS))}
            />
          </ReportingFilterBar>
        </div>
      )}

      {loading && snapshots.length === 0 ? (
        <p className="text-sm text-slate-muted italic">Loading…</p>
      ) : snapshots.length === 0 ? (
        <div className="border border-border rounded p-6 text-sm text-slate-muted">
          No Outreach data yet. The n8n workflow populates outreach_snapshots
          weekly.
        </div>
      ) : !period ? (
        <p className="text-sm text-slate-muted italic">Loading…</p>
      ) : (
        <>
          <p className="text-xs text-slate-muted">
            {periodLabel(period)}
            {!cadenceSuppress && showComparison && cmpLabel ? ` · ${cmpLabel}` : ''}
          </p>
          {completeness.completeness === 'missing' && (
            <div
              className="border border-border rounded p-4 text-sm text-slate-muted"
              data-testid="outreach-no-period-data"
            >
              No data for selected period.
            </div>
          )}

          <KpiCards
            deduped={deduped}
            period={period}
            comparison={dashboardComparison}
            cadenceSuppress={cadenceSuppress}
          />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <RegionPerformanceCard
              fullDeduped={fullDeduped}
              sequenceOptions={sequenceOptions}
              selectedSequences={selectedSequences}
              regions={regions}
              period={period}
              comparison={dashboardComparison}
              cadenceSuppress={cadenceSuppress}
              cmpLabel={cmpLabel}
            />
            <EngagementFunnelCard deduped={deduped} period={period} />
            <SequenceRankingsCard deduped={deduped} period={period} />
            <ActivityHeatmapCard deduped={deduped} period={period} />
          </div>
        </>
      )}
    </div>
  );
}

function latestDate(rows: readonly OutreachReportingRow[]): string | null {
  let latest: string | null = null;
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.export_date)) continue;
    if (latest === null || r.export_date > latest) latest = r.export_date;
  }
  return latest;
}

function yearsFrom(rows: readonly OutreachReportingRow[], anchor: number): number[] {
  const ys = new Set<number>([anchor]);
  for (const r of rows) {
    const m = /^(\d{4})-/.exec(r.export_date);
    if (m) ys.add(parseInt(m[1], 10));
  }
  return [...ys].sort((a, b) => b - a);
}

// The calendar period the comparison mode points at (for cadence assessment).
function previousOrSame(
  period: ReportingPeriod,
  mode: ComparisonMode,
): ReportingPeriod | null {
  if (mode === 'off') return null;
  if (mode === 'previous_year') {
    if (period.year <= 1) return null;
    if (period.grain === 'month') return { grain: 'month', year: period.year - 1, month: period.month };
    if (period.grain === 'quarter') return { grain: 'quarter', year: period.year - 1, quarter: period.quarter };
    return { grain: 'year', year: period.year - 1 };
  }
  return previousPeriod(period);
}

// ---------- KPI cards ----------

function KpiCards({
  deduped,
  period,
  comparison,
  cadenceSuppress,
}: {
  deduped: DedupedSeries;
  period: ReportingPeriod;
  comparison: ComparisonMode;
  cadenceSuppress: boolean;
}) {
  const cards = useMemo(
    () =>
      KPI_METRICS.map((m) => {
        const c = compareOutreachActivity(deduped, m.key, period, comparison);
        return { ...m, cmp: c };
      }),
    [deduped, period, comparison],
  );
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" data-testid="outreach-kpis">
      {cards.map(({ key, label, direction, cmp }) => {
        const cur = cmp.current;
        // A delta shows only when EVERY layer allows it: the metric-level
        // shared flag AND both calendar periods' cadence completeness.
        const suppress = cmp.suppressDelta || cadenceSuppress;
        const incomplete = cur.state === 'present' && cur.incomplete;
        let delta: DeltaResult | null = null;
        if (!suppress && cur.state === 'present' && cmp.comparison?.state === 'present') {
          delta = computeDelta(
            { state: 'present', value: cur.value },
            { state: 'present', value: cmp.comparison.value },
            direction,
          );
        }
        return (
          <div
            key={key}
            className="bg-white border border-border rounded-lg p-3 shadow-sm"
            data-testid={`kpi-${key}`}
          >
            <div className="text-[10px] uppercase tracking-wider text-slate-muted">
              {label}
            </div>
            <div className="mt-1 text-2xl font-semibold text-charcoal tabular-nums">
              {totalText(cur)}
            </div>
            {incomplete && (
              <div className="text-[10px] text-slate-muted" data-testid={`kpi-${key}-incomplete`}>
                Incomplete data
              </div>
            )}
            {delta && (
              <div className="mt-0.5">
                <DeltaDisplay result={delta} format={{ kind: 'number' }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------- Region Performance ----------

function RegionPerformanceCard({
  fullDeduped,
  sequenceOptions,
  selectedSequences,
  regions,
  period,
  comparison,
  cadenceSuppress,
  cmpLabel,
}: {
  fullDeduped: DedupedSeries;
  sequenceOptions: { id: number; name: string }[];
  selectedSequences: Set<number>;
  regions: Set<OutreachRegionKey>;
  period: ReportingPeriod;
  comparison: ComparisonMode;
  cadenceSuppress: boolean;
  cmpLabel: string;
}) {
  // One column per SELECTED region that has any sequences (never hardcoded to
  // NA/EMEA). The same sequence filter applies inside each region; region and
  // period filters are identical for current and comparison.
  const data = useMemo(() => {
    const allSeqs =
      selectedSequences.size === 0 ||
      selectedSequences.size === sequenceOptions.length;
    const activeRegions = OUTREACH_REGIONS.filter((r) => regions.has(r));
    return activeRegions
      .map((region) => {
        const keep = new Set<number>();
        for (const { id, name } of sequenceOptions) {
          if (inferRegionFromSequenceName(name) !== region) continue;
          if (!allSeqs && !selectedSequences.has(id)) continue;
          keep.add(id);
        }
        if (keep.size === 0) return null; // no sequences in this region
        const scoped = filterDedupedSeries(fullDeduped, keep);
        const metrics = KPI_METRICS.map((m) => ({
          ...m,
          cmp: compareOutreachActivity(scoped, m.key, period, comparison),
        }));
        return { region, metrics };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [fullDeduped, sequenceOptions, selectedSequences, regions, period, comparison]);

  return (
    <div className="bg-white rounded-lg border border-border shadow-sm p-4" data-testid="outreach-region-performance">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-sm font-semibold text-charcoal">Region Performance</h3>
        {!cadenceSuppress && cmpLabel && (
          <span className="text-[10px] text-slate-muted">{cmpLabel}</span>
        )}
      </div>
      {data.length === 0 ? (
        <p className="py-6 text-center text-slate-muted text-sm italic">
          No sequences in the selected regions
        </p>
      ) : (
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: `repeat(${Math.min(data.length, 3)}, minmax(0, 1fr))` }}
        >
          {data.map(({ region, metrics }) => (
            <div key={region}>
              <h4 className="text-sm font-bold text-charcoal mb-3 text-center" title={OUTREACH_REGION_LABELS[region]}>
                {region}
              </h4>
              <div className="divide-y divide-border">
                {metrics.map(({ key, label, direction, cmp }) => {
                  const suppress = cmp.suppressDelta || cadenceSuppress;
                  const cur = cmp.current;
                  const delta =
                    !suppress && cur.state === 'present' && cmp.comparison?.state === 'present'
                      ? computeDelta(
                          { state: 'present', value: cur.value },
                          { state: 'present', value: cmp.comparison.value },
                          direction,
                        )
                      : null;
                  return (
                    <div key={key} className="flex items-center justify-between py-2 gap-2">
                      <span className="text-xs text-slate-muted">{label}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-charcoal tabular-nums">
                          {totalText(cur)}
                        </span>
                        {delta && <DeltaDisplay result={delta} format={{ kind: 'number' }} />}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Engagement Funnel ----------

const FUNNEL_STAGES: { key: ActivityCounter; label: string; color: string }[] = [
  { key: 'total_sent', label: 'Sent', color: '#3b82f6' },
  { key: 'delivered', label: 'Delivered', color: '#6366f1' },
  { key: 'opened', label: 'Opened', color: '#8b5cf6' },
  { key: 'clicked', label: 'Clicked', color: '#a855f7' },
  { key: 'replied', label: 'Replied', color: '#c084fc' },
];

function EngagementFunnelCard({
  deduped,
  period,
}: {
  deduped: DedupedSeries;
  period: ReportingPeriod;
}) {
  const stages = useMemo(() => {
    const totals = FUNNEL_STAGES.map((stage) => ({
      ...stage,
      total: aggregateActivity(deduped, stage.key, period),
    }));
    const values = totals.map((t) => (t.total.state === 'present' ? t.total.value : 0));
    const maxVal = Math.max(...values, 1);
    return totals.map((stage, i) => {
      const prev = i > 0 ? totals[i - 1].total : null;
      // Conversion rate only when BOTH stages are present and complete;
      // otherwise the rate is unavailable rather than a trustworthy-looking %.
      const rate =
        prev !== null ? rateFromTotals(stage.total, prev) : { state: 'missing' as const };
      const value = stage.total.state === 'present' ? stage.total.value : null;
      const incomplete = stage.total.state === 'present' && stage.total.incomplete;
      return {
        ...stage,
        value,
        incomplete,
        rateText:
          i === 0
            ? ''
            : rate.state === 'present'
              ? `${rate.percent.toFixed(1)}%${rate.incomplete ? '*' : ''}`
              : 'n/a',
        widthPct: value !== null ? Math.max((value / maxVal) * 100, 8) : 8,
      };
    });
  }, [deduped, period]);

  const hasData = stages.some((s) => s.value !== null && s.value > 0);

  return (
    <div className="bg-white rounded-lg border border-border shadow-sm p-4" data-testid="outreach-funnel">
      <h3 className="text-sm font-semibold text-charcoal mb-4">Engagement Funnel</h3>
      {!hasData ? (
        <p className="py-6 text-center text-slate-muted text-sm italic">No data</p>
      ) : (
        <div className="space-y-2">
          {stages.map((stage) => (
            <div key={stage.key} className="flex items-center gap-3">
              <div className="w-20 text-right text-xs font-medium text-slate-muted shrink-0">
                {stage.label}
              </div>
              <div className="flex-1 relative">
                <div
                  className="h-9 rounded-md flex items-center justify-end px-3"
                  style={{
                    width: `${Math.min(Math.max(stage.widthPct, 5), 100)}%`,
                    backgroundColor: stage.value !== null ? stage.color : '#E2E8F0',
                    minWidth: '60px',
                  }}
                >
                  <span className="text-white text-xs font-bold tabular-nums">
                    {stage.value !== null ? stage.value.toLocaleString() : '—'}
                    {stage.incomplete ? '*' : ''}
                  </span>
                </div>
              </div>
              <div className="w-14 text-right text-xs text-slate-muted shrink-0">
                {stage.rateText}
              </div>
            </div>
          ))}
          {stages.some((s) => s.incomplete) && (
            <p className="text-[10px] text-slate-muted">* incomplete data</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Sequence Rankings ----------

type RankMetric =
  | { kind: 'rate'; key: 'open_rate' | 'reply_rate' | 'click_rate'; label: string; num: ActivityCounter; den: ActivityCounter }
  | { kind: 'count'; key: 'outbound_calls' | 'linkedin_tasks'; label: string; counter: ActivityCounter };

const RANK_METRICS: RankMetric[] = [
  { kind: 'rate', key: 'open_rate', label: 'Open Rate', num: 'opened', den: 'delivered' },
  { kind: 'rate', key: 'reply_rate', label: 'Reply Rate', num: 'replied', den: 'delivered' },
  { kind: 'rate', key: 'click_rate', label: 'Click Rate', num: 'clicked', den: 'delivered' },
  { kind: 'count', key: 'outbound_calls', label: 'Outbound Calls', counter: 'outbound_calls' },
  { kind: 'count', key: 'linkedin_tasks', label: 'LinkedIn Tasks', counter: 'linkedin_tasks_completed' },
];

interface RankedSequence {
  sequence_id: number;
  name: string;
  value: number; // rate as fraction or count
  display: string;
}

function seqActivityValue(a: SequenceActivity): number | null {
  return a.state === 'present' ? a.value : null;
}

function SequenceRankingsCard({
  deduped,
  period,
}: {
  deduped: DedupedSeries;
  period: ReportingPeriod;
}) {
  const [metricIdx, setMetricIdx] = useState(0);
  const metric = RANK_METRICS[metricIdx];

  const { ranked, excluded } = useMemo(() => {
    const out: RankedSequence[] = [];
    let excludedCount = 0;
    for (const [id, series] of deduped.bySequence) {
      const name = series.length ? series[series.length - 1].sequence_name : String(id);
      if (metric.kind === 'count') {
        const a = sequencePeriodActivity(series, metric.counter, period, deduped.feedStart ?? undefined);
        const v = seqActivityValue(a);
        if (v === null) {
          // reset / missing / missing_baseline: excluded, never ranked as zero
          if (a.state !== 'missing') excludedCount += 1;
          continue;
        }
        out.push({ sequence_id: id, name, value: v, display: v.toLocaleString() });
      } else {
        const num = sequencePeriodActivity(series, metric.num, period, deduped.feedStart ?? undefined);
        const den = sequencePeriodActivity(series, metric.den, period, deduped.feedStart ?? undefined);
        const nv = seqActivityValue(num);
        const dv = seqActivityValue(den);
        if (nv === null || dv === null) {
          if (num.state === 'reset' || den.state === 'reset' || num.state === 'missing_baseline' || den.state === 'missing_baseline') {
            excludedCount += 1;
          }
          continue;
        }
        // Meaningful rates need real delivery volume in the period.
        if (dv <= 10) continue;
        out.push({
          sequence_id: id,
          name,
          value: nv / dv,
          display: `${((nv / dv) * 100).toFixed(1)}%`,
        });
      }
    }
    out.sort((a, b) => b.value - a.value);
    return { ranked: out, excluded: excludedCount };
  }, [deduped, period, metric]);

  const top5 = ranked.slice(0, 5);
  const bottom5 = ranked.length > 5 ? ranked.slice(-5).reverse() : [];
  const maxVal = ranked.length > 0 ? ranked[0].value : 1;

  return (
    <div className="bg-white rounded-lg border border-border shadow-sm p-4" data-testid="outreach-rankings">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-sm font-semibold text-charcoal">Sequence Rankings</h3>
        <select
          value={metricIdx}
          onChange={(e) => setMetricIdx(Number(e.target.value))}
          aria-label="Ranking metric"
          className="text-xs border border-border rounded px-2 py-1 bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo/30"
        >
          {RANK_METRICS.map((m, i) => (
            <option key={m.key} value={i}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {ranked.length === 0 ? (
        <p className="py-6 text-center text-slate-muted text-sm italic">
          No sequences with enough data
        </p>
      ) : (
        <div className="space-y-4">
          <RankList title="Top Performers" tone="green" items={top5} maxVal={maxVal} startRank={1} />
          {bottom5.length > 0 && (
            <RankList
              title="Needs Attention"
              tone="red"
              items={bottom5}
              maxVal={maxVal}
              startRank={ranked.length - bottom5.length + 1}
            />
          )}
        </div>
      )}
      {excluded > 0 && (
        <p className="mt-3 text-[10px] text-slate-muted" data-testid="outreach-rankings-excluded">
          {excluded} sequence{excluded === 1 ? '' : 's'} excluded (incomplete data)
        </p>
      )}
    </div>
  );
}

function RankList({
  title,
  tone,
  items,
  maxVal,
  startRank,
}: {
  title: string;
  tone: 'green' | 'red';
  items: RankedSequence[];
  maxVal: number;
  startRank: number;
}) {
  const toneCls =
    tone === 'green'
      ? { label: 'text-green-600', track: 'bg-green-100', bar: 'bg-green-400', value: 'text-green-700' }
      : { label: 'text-red-500', track: 'bg-red-50', bar: 'bg-red-300', value: 'text-red-600' };
  return (
    <div>
      <p className={`text-[10px] ${toneCls.label} font-semibold uppercase tracking-wider mb-1.5`}>
        {title}
      </p>
      <div className="space-y-1">
        {items.map((s, i) => (
          <div key={s.sequence_id} className="flex items-center gap-2">
            <span className="text-[10px] text-slate-muted w-4 shrink-0">{startRank + i}.</span>
            <div className="flex-1 min-w-0">
              <div className={`h-5 rounded-full ${toneCls.track} relative overflow-hidden`}>
                <div
                  className={`h-full rounded-full ${toneCls.bar}`}
                  style={{ width: `${maxVal > 0 ? (s.value / maxVal) * 100 : 0}%` }}
                />
                <span className="absolute inset-0 flex items-center px-2 text-[10px] text-charcoal font-medium truncate">
                  {s.name}
                </span>
              </div>
            </div>
            <span className={`text-xs font-semibold ${toneCls.value} shrink-0 w-16 text-right tabular-nums`}>
              {s.display}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Activity Heatmap ----------

const HEATMAP_METRICS: { key: ActivityCounter; label: string }[] = [
  { key: 'total_sent', label: 'Emails Sent' },
  { key: 'replied', label: 'Replied' },
  { key: 'outbound_calls', label: 'Outbound Calls' },
  { key: 'linkedin_tasks_completed', label: 'LinkedIn Tasks' },
];

function heatColor(t: number): string {
  if (t <= 0) return '#FFFFFF';
  const x = Math.min(1, Math.max(0, t));
  const r = Math.round(0x06 + (0x4f - 0x06) * x);
  const g = Math.round(0xb6 + (0x46 - 0xb6) * x);
  const b = Math.round(0xd4 + (0xe5 - 0xd4) * x);
  const wash = (1 - x) * 0.6;
  const fr = Math.round(r + (255 - r) * wash);
  const fg = Math.round(g + (255 - g) * wash);
  const fb = Math.round(b + (255 - b) * wash);
  return `rgb(${fr}, ${fg}, ${fb})`;
}

// The rolling window: five periods of the selected grain ending at `period`.
// Periods that would underflow year 1 are dropped from the left edge.
function rollingPeriods(period: ReportingPeriod, count: number): ReportingPeriod[] {
  const out: ReportingPeriod[] = [period];
  let cur: ReportingPeriod | null = period;
  for (let i = 1; i < count; i++) {
    cur = previousPeriod(cur);
    if (!cur) break;
    out.unshift(cur);
  }
  return out;
}

function ActivityHeatmapCard({
  deduped,
  period,
}: {
  deduped: DedupedSeries;
  period: ReportingPeriod;
}) {
  const [metric, setMetric] = useState<ActivityCounter>('total_sent');
  const windowPeriods = useMemo(() => rollingPeriods(period, 5), [period]);

  const { rows, maxVal } = useMemo(() => {
    const out: {
      id: number;
      name: string;
      cells: { key: string; label: string; activity: SequenceActivity }[];
    }[] = [];
    for (const [id, series] of deduped.bySequence) {
      const name = series.length ? series[series.length - 1].sequence_name : String(id);
      const cells = windowPeriods.map((p) => ({
        key: periodLabel(p),
        label: periodLabel(p),
        activity: sequencePeriodActivity(series, metric, p, deduped.feedStart ?? undefined),
      }));
      // Skip sequences with nothing at all in the window.
      if (cells.every((c) => c.activity.state === 'missing')) continue;
      out.push({ id, name, cells });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    // Max over all measured cell values, derived after collection (no closure
    // mutation during map).
    const max = out.reduce(
      (m, seq) =>
        seq.cells.reduce(
          (mm, c) => (c.activity.state === 'present' && c.activity.value > mm ? c.activity.value : mm),
          m,
        ),
      0,
    );
    return { rows: out, maxVal: max || 1 };
  }, [deduped, windowPeriods, metric]);

  return (
    <div className="bg-white rounded-lg border border-border shadow-sm p-4" data-testid="outreach-heatmap">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-sm font-semibold text-charcoal">Activity Heatmap</h3>
        <select
          value={metric}
          onChange={(e) => setMetric(e.target.value as ActivityCounter)}
          aria-label="Heatmap metric"
          className="text-xs border border-border rounded px-2 py-1 bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo/30"
        >
          {HEATMAP_METRICS.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <p className="py-6 text-center text-slate-muted text-sm italic">
          No sequence activity in this window
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[10px]">
              <thead>
                <tr>
                  <th className="text-left px-2 py-1 text-slate-muted font-medium min-w-[180px]">
                    Sequence
                  </th>
                  {windowPeriods.map((p) => (
                    <th key={periodLabel(p)} className="text-center px-1 py-1 text-slate-muted font-medium w-14">
                      {periodLabel(p)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((seq) => (
                  <tr key={seq.id}>
                    <td className="px-2 py-1 text-charcoal font-medium truncate max-w-[220px]" title={seq.name}>
                      {seq.name}
                    </td>
                    {seq.cells.map((cell) => (
                      <HeatCell key={cell.key} cell={cell} seqName={seq.name} maxVal={maxVal} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3 mt-3 justify-end text-[9px] text-slate-muted">
            <span>· = incomplete/reset, blank = missing</span>
            <span>Low</span>
            <div className="flex gap-0.5">
              {[0.1, 0.3, 0.5, 0.7, 0.9].map((t) => (
                <div key={t} className="w-4 h-3 rounded" style={{ backgroundColor: heatColor(t) }} />
              ))}
            </div>
            <span>High</span>
          </div>
        </>
      )}
    </div>
  );
}

// One heatmap cell. A measured value (even zero) gets a heat tint and number;
// reset/missing-baseline/incomplete cells show a distinct dot marker; missing
// cells are blank. Missing is never rendered as a zero.
function HeatCell({
  cell,
  seqName,
  maxVal,
}: {
  cell: { key: string; label: string; activity: SequenceActivity };
  seqName: string;
  maxVal: number;
}) {
  const a = cell.activity;
  if (a.state === 'missing') {
    return (
      <td className="px-1 py-1 text-center" data-state="missing">
        <div className="rounded px-1 py-0.5 text-[9px]" title={`${seqName} — ${cell.label}: no data`} />
      </td>
    );
  }
  if (a.state !== 'present') {
    // reset / missing_baseline / ambiguous: visually distinct from zero.
    const label =
      a.state === 'reset' ? 'reset/correction' : a.state === 'missing_baseline' ? 'no baseline' : 'ambiguous data';
    return (
      <td className="px-1 py-1 text-center" data-state={a.state}>
        <div
          className="rounded px-1 py-0.5 text-[9px] font-medium border border-dashed border-border text-slate-muted"
          title={`${seqName} — ${cell.label}: ${label}`}
        >
          ·
        </div>
      </td>
    );
  }
  const intensity = a.value / maxVal;
  const bg = heatColor(intensity);
  const text = intensity > 0.55 ? '#FFFFFF' : '#0F172A';
  const suffix = a.baselineIncomplete || a.missingMeasurements ? '*' : '';
  return (
    <td className="px-1 py-1 text-center" data-state="present">
      <div
        className="rounded px-1 py-0.5 text-[9px] font-medium tabular-nums"
        style={{ backgroundColor: bg, color: text }}
        title={`${seqName} — ${cell.label}: ${a.value.toLocaleString()}${suffix ? ' (incomplete)' : ''}`}
      >
        {a.value.toLocaleString()}
        {suffix}
      </div>
    </td>
  );
}
