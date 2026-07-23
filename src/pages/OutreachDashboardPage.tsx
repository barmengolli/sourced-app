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
  periodBounds,
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
import {
  metricIssueReasons,
  cadenceIssueReasons,
  sequenceActivityReason,
  incompleteDisclosure,
} from '../lib/outreachQualityText';
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

  // Aggregate totals for the counters the Sequence Performance table's Total
  // row shows. Computed once from the same filtered feed the KPI cards use, so
  // the table reconciles with the cards by construction.
  const tableTotals = useMemo(() => {
    if (!period) return {};
    const keys: TableCounter[] = [
      'total_sent', 'delivered', 'bounced', 'opened', 'clicked',
      'replied', 'opted_out', 'outbound_calls', 'linkedin_tasks_completed',
    ];
    const out: Partial<Record<TableCounter, MetricTotal>> = {};
    for (const k of keys) out[k] = aggregateActivity(deduped, k, period);
    return out;
  }, [deduped, period]);

  // A single concise, page-level data-quality disclosure built from the same
  // engine results (metric issue counts + cadence). Shown regardless of the
  // comparison mode, so Comparison Off never hides quality warnings.
  const pageDisclosure = useMemo(() => {
    const reasons = new Set<string>();
    for (const t of Object.values(tableTotals)) {
      if (!t) continue;
      for (const r of metricIssueReasons(t, completeness)) reasons.add(r);
    }
    if (completeness.completeness !== 'complete') {
      for (const r of cadenceIssueReasons(completeness)) reasons.add(r);
    }
    return reasons.size > 0 ? incompleteDisclosure([...reasons]) : '';
  }, [tableTotals, completeness]);

  const regionChips: FilterChip<OutreachRegionKey>[] = OUTREACH_REGIONS.map((r) => ({
    value: r,
    label: r,
  }));

  return (
    <div className="p-8 space-y-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-charcoal">
          Outreach Dashboard
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
              onClear={() => onRegionsChange(new Set())}
              onSelectAll={() => onRegionsChange(new Set(OUTREACH_REGIONS))}
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
            completeness={completeness}
          />

          {pageDisclosure && (
            <p className="text-xs text-slate-muted" data-testid="outreach-quality-disclosure">
              {pageDisclosure} A value like <span className="tabular-nums">0*</span> means zero
              in the safely measured data; the complete value is unknown.
            </p>
          )}

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
              completeness={completeness}
            />
            <EngagementFunnelCard deduped={deduped} period={period} completeness={completeness} />
            <SequencePerformanceTable
              deduped={deduped}
              period={period}
              snapshots={snapshots}
              completeness={completeness}
              kpiTotals={tableTotals}
            />
            <ActivityHeatmapCard deduped={deduped} period={period} feedRows={reportingRows} />
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
  completeness,
}: {
  deduped: DedupedSeries;
  period: ReportingPeriod;
  comparison: ComparisonMode;
  cadenceSuppress: boolean;
  completeness: OutreachCompleteness;
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
            {incomplete && cur.state === 'present' && (
              <div
                className="text-[10px] text-slate-muted"
                data-testid={`kpi-${key}-incomplete`}
                title={incompleteDisclosure(metricIssueReasons(cur, completeness))}
              >
                Incomplete*
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
  completeness,
}: {
  fullDeduped: DedupedSeries;
  sequenceOptions: { id: number; name: string }[];
  selectedSequences: Set<number>;
  regions: Set<OutreachRegionKey>;
  period: ReportingPeriod;
  comparison: ComparisonMode;
  cadenceSuppress: boolean;
  cmpLabel: string;
  completeness: OutreachCompleteness;
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
                  // Present-but-incomplete keeps the safe-known value with a
                  // visible/accessible marker; its delta stays suppressed
                  // (cmp.suppressDelta is already true for incomplete totals).
                  const incomplete = cur.state === 'present' && cur.incomplete;
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
                        <span
                          className="text-sm font-semibold text-charcoal tabular-nums"
                          data-incomplete={incomplete ? 'true' : undefined}
                        >
                          {totalText(cur)}
                          {incomplete && cur.state === 'present' && (
                            <span
                              aria-label="incomplete data"
                              title={incompleteDisclosure(metricIssueReasons(cur, completeness))}
                            >
                              *
                            </span>
                          )}
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
      {data.some((d) => d.metrics.some((m) => m.cmp.current.state === 'present' && m.cmp.current.incomplete)) && (
        <p className="mt-2 text-[10px] text-slate-muted" data-testid="region-incomplete-legend">
          * incomplete data
        </p>
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
  completeness,
}: {
  deduped: DedupedSeries;
  period: ReportingPeriod;
  completeness: OutreachCompleteness;
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
      const reason = incomplete && stage.total.state === 'present'
        ? incompleteDisclosure(metricIssueReasons(stage.total, completeness))
        : undefined;
      return {
        ...stage,
        value,
        incomplete,
        reason,
        rateText:
          i === 0
            ? ''
            : rate.state === 'present'
              ? `${rate.percent.toFixed(1)}%${rate.incomplete ? '*' : ''}`
              : 'n/a',
        rateTitle:
          i > 0 && rate.state === 'missing'
            ? 'Conversion rate unavailable: a stage total is missing or incomplete in this period.'
            : undefined,
        widthPct: value !== null ? Math.max((value / maxVal) * 100, 8) : 8,
      };
    });
  }, [deduped, period, completeness]);

  // Measured data exists when ANY stage total is present, even at a measured
  // zero. "No data" is reserved for every stage being genuinely missing.
  const hasData = stages.some((s) => s.value !== null);

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
                  <span className="text-white text-xs font-bold tabular-nums" title={stage.reason}>
                    {stage.value !== null ? stage.value.toLocaleString() : '—'}
                    {stage.incomplete ? '*' : ''}
                  </span>
                </div>
              </div>
              <div className="w-14 text-right text-xs text-slate-muted shrink-0" title={stage.rateTitle}>
                {stage.rateText}
              </div>
            </div>
          ))}
          {stages.some((s) => s.incomplete) && (
            <p className="text-[10px] text-slate-muted" title={stages.find((s) => s.reason)?.reason}>
              * incomplete data (hover a value for the reason)
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Sequence Performance ----------

// The sequence's name and enabled status AS OF the selected period end: taken
// from the latest snapshot on or before the period's end. Never reads a future
// snapshot; a rename never splits history (identity stays sequence_id).
function statusAsOfPeriodEnd(
  series: readonly OutreachReportingRow[],
  period: ReportingPeriod,
): { name: string; enabled: boolean } {
  const bounds = periodBounds(period);
  let name = series.length ? series[0].sequence_name : '';
  let enabled = false;
  for (const row of series) {
    if (bounds && row.export_date > bounds.end) break; // no future leakage
    name = row.sequence_name;
    enabled = row.enabled ?? false;
  }
  return { name, enabled };
}

// Table metric spec. All counts are safe period activity from the Bite 3A
// engine; every rate is recomputed from the row's aggregate numerator and
// denominator (never averaged).
const TABLE_COUNTERS = [
  'total_sent',
  'delivered',
  'bounced',
  'opened',
  'clicked',
  'replied',
  'opted_out',
  'outbound_calls',
  'linkedin_tasks_completed',
] as const;
type TableCounter = (typeof TABLE_COUNTERS)[number];

interface SeqCell {
  activity: SequenceActivity;
}

interface SeqRow {
  sequence_id: number;
  name: string;
  enabled: boolean;
  // Point-in-time audience snapshot: prospects_active from the latest raw
  // snapshot on or before the period end. null when no such snapshot exists.
  prospectsActive: number | null;
  cells: Record<TableCounter, SeqCell>;
  anyPresent: boolean;
  anyIncomplete: boolean;
}

function cellValue(c: SeqCell): number | null {
  return c.activity.state === 'present' ? c.activity.value : null;
}

// Rate text from a row's aggregate numerator/denominator cells. Undefined when
// either side is not a measured value or the denominator is zero. Marked with
// * when either side is an incomplete measured value.
function rowRate(num: SeqCell, den: SeqCell): string {
  const nv = cellValue(num);
  const dv = cellValue(den);
  if (nv === null || dv === null || dv <= 0) return '—';
  const incomplete =
    (num.activity.state === 'present' && (num.activity.baselineIncomplete || num.activity.missingMeasurements)) ||
    (den.activity.state === 'present' && (den.activity.baselineIncomplete || den.activity.missingMeasurements));
  return `${((nv / dv) * 100).toFixed(1)}%${incomplete ? '*' : ''}`;
}

// One table count cell: measured values (including 0) render as numbers with a
// * marker + reason tooltip when incomplete; non-present states render an em
// dash with the exact engine reason.
function CountCell({ cell, boundary }: { cell: SeqCell; boundary: string | null }) {
  const a = cell.activity;
  if (a.state !== 'present') {
    return (
      <td
        className="border border-border px-2 py-1 text-right text-slate-muted"
        title={sequenceActivityReason(a, boundary)}
        data-state={a.state}
      >
        {'—'}
      </td>
    );
  }
  const incomplete = a.baselineIncomplete || a.missingMeasurements;
  return (
    <td
      className="border border-border px-2 py-1 text-right tabular-nums text-charcoal"
      title={incomplete ? sequenceActivityReason(a, boundary) : undefined}
      data-state="present"
      data-incomplete={incomplete ? 'true' : undefined}
    >
      {a.value.toLocaleString()}
      {incomplete ? '*' : ''}
    </td>
  );
}

function SequencePerformanceTable({
  deduped,
  period,
  snapshots,
  completeness,
  kpiTotals,
}: {
  deduped: DedupedSeries;
  period: ReportingPeriod;
  // Raw snapshots for the point-in-time audience column only.
  snapshots: OutreachSubPageProps['snapshots'];
  completeness: OutreachCompleteness;
  // The KPI totals for the same period/filters; the Total row reuses them so
  // the table reconciles with the cards by construction.
  kpiTotals: Partial<Record<TableCounter, MetricTotal>>;
}) {
  const bounds = periodBounds(period);
  const boundary = completeness.requiredBaselineThursday;

  const rows = useMemo(() => {
    // Latest prospects_active per sequence on or before the period end
    // (snapshot semantics; never summed as activity).
    const audience = new Map<number, { date: string; value: number }>();
    if (bounds) {
      for (const s of snapshots) {
        if (s.export_date > bounds.end) continue;
        const prev = audience.get(s.sequence_id);
        if (!prev || s.export_date > prev.date) {
          audience.set(s.sequence_id, { date: s.export_date, value: s.prospects_active });
        }
      }
    }
    const out: SeqRow[] = [];
    for (const [id, series] of deduped.bySequence) {
      const status = statusAsOfPeriodEnd(series, period);
      const cells = {} as Record<TableCounter, SeqCell>;
      let anyPresent = false;
      let anyIncomplete = false;
      for (const key of TABLE_COUNTERS) {
        const activity = sequencePeriodActivity(series, key, period, deduped.feedStart ?? undefined);
        cells[key] = { activity };
        if (activity.state === 'present') {
          anyPresent = true;
          if (activity.baselineIncomplete || activity.missingMeasurements) anyIncomplete = true;
        } else if (activity.state !== 'missing') {
          anyIncomplete = true; // reset / missing_baseline / ambiguous are quality issues
        }
      }
      // Include every sequence contributing measured activity OR carrying a
      // quality issue for the period; skip only fully inactive sequences.
      if (!anyPresent && !anyIncomplete) continue;
      out.push({
        sequence_id: id,
        name: status.name,
        enabled: status.enabled,
        prospectsActive: audience.get(id)?.value ?? null,
        cells,
        anyPresent,
        anyIncomplete,
      });
    }
    // Default sort: Delivered descending; non-measured delivered sorts last.
    out.sort((a, b) => (cellValue(b.cells.delivered) ?? -1) - (cellValue(a.cells.delivered) ?? -1));
    return out;
  }, [deduped, period, snapshots, bounds]);

  // Section disclosure summarizing the period's quality issues, from the same
  // engine results that mark individual values (delivered as representative;
  // metric-specific gaps like LinkedIn surface via linkedin's own total).
  const disclosureReasons = useMemo(() => {
    const seen = new Set<string>();
    for (const key of TABLE_COUNTERS) {
      const t = kpiTotals[key];
      if (!t) continue;
      for (const r of metricIssueReasons(t, completeness)) seen.add(r);
    }
    for (const r of cadenceIssueReasons(completeness)) {
      if (completeness.completeness !== 'complete') seen.add(r);
    }
    return [...seen];
  }, [kpiTotals, completeness]);

  const totalCell = (key: TableCounter): string => {
    const t = kpiTotals[key];
    if (!t || t.state !== 'present') return '—';
    return `${t.value.toLocaleString()}${t.incomplete ? '*' : ''}`;
  };
  const totalRate = (numKey: TableCounter, denKey: TableCounter): string => {
    const n = kpiTotals[numKey];
    const d = kpiTotals[denKey];
    if (!n || !d || n.state !== 'present' || d.state !== 'present' || d.value <= 0) return '—';
    const incomplete = n.incomplete || d.incomplete;
    return `${((n.value / d.value) * 100).toFixed(1)}%${incomplete ? '*' : ''}`;
  };
  const totalTitle = (key: TableCounter): string | undefined => {
    const t = kpiTotals[key];
    if (!t || t.state !== 'present' || !t.incomplete) return undefined;
    return incompleteDisclosure(metricIssueReasons(t, completeness));
  };

  const cell = 'border border-border px-2 py-1';
  const head = `${cell} text-right font-medium`;

  return (
    <div className="bg-white rounded-lg border border-border shadow-sm p-4 lg:col-span-2" data-testid="outreach-sequence-performance">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h3 className="text-sm font-semibold text-charcoal">Sequence performance</h3>
        <span className="text-[10px] text-slate-muted">
          Selected period activity; sorted by Delivered. Prospects is a snapshot as of the latest run on or before the period end.
        </span>
      </div>
      {disclosureReasons.length > 0 && (
        <p className="mb-2 text-[10px] text-slate-muted" data-testid="sequence-performance-disclosure">
          {incompleteDisclosure(disclosureReasons)} A value like 0* is zero in the safely measured data; the complete value is unknown.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="py-6 text-center text-slate-muted text-sm italic">
          No sequence activity in the selected period
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs border-collapse border border-border">
            <thead className="text-[10px] text-slate-muted bg-muted/40">
              <tr>
                <th className={`${cell} text-left font-medium`} rowSpan={2}>Sequence</th>
                <th className={head} rowSpan={2} title="Active prospects, snapshot as of the latest run on or before the period end. Not period activity.">
                  Prospects
                </th>
                <th className={`${cell} text-center font-medium`} colSpan={8}>Email performance</th>
                <th className={`${cell} text-center font-medium`} colSpan={2}>Sales activity</th>
              </tr>
              <tr>
                <th className={head}>Sent</th>
                <th className={head}>Delivered</th>
                <th className={head} title="Delivered / Sent">Delivery</th>
                <th className={head} title="Opened / Delivered">Open</th>
                <th className={head} title="Clicked / Delivered">Click</th>
                <th className={head} title="Replied / Delivered">Reply</th>
                <th className={head} title="Bounced / Sent">Bounce</th>
                <th className={head} title="Opted out / Delivered">Opt-out</th>
                <th className={head}>Calls</th>
                <th className={head}>LinkedIn</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sequence_id} data-testid={`seq-row-${r.sequence_id}`}>
                  <td className={`${cell} text-charcoal max-w-[260px]`}>
                    {/* Names wrap to two lines then clamp; tabIndex keeps the full-name tooltip reachable by keyboard. */}
                    <div className="flex max-w-[230px] items-start gap-1">
                      <span
                        className="line-clamp-2 min-w-0 break-words rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo"
                        title={r.name}
                        aria-label={r.name}
                        tabIndex={0}
                        data-testid={`seq-name-${r.sequence_id}`}
                      >
                        {r.name}
                      </span>
                      {!r.enabled && (
                        <span className="shrink-0 rounded-full border border-border bg-muted px-1.5 text-[9px] text-slate-muted" title="Sequence was disabled as of the period end. Its historical activity is still reported.">
                          off
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={`${cell} text-right tabular-nums text-slate-muted`} title="Snapshot as of the latest run on or before the period end; not period activity.">
                    {r.prospectsActive !== null ? r.prospectsActive.toLocaleString() : '—'}
                  </td>
                  <CountCell cell={r.cells.total_sent} boundary={boundary} />
                  <CountCell cell={r.cells.delivered} boundary={boundary} />
                  <td className={`${cell} text-right tabular-nums text-slate-muted`}>{rowRate(r.cells.delivered, r.cells.total_sent)}</td>
                  <td className={`${cell} text-right tabular-nums text-slate-muted`}>{rowRate(r.cells.opened, r.cells.delivered)}</td>
                  <td className={`${cell} text-right tabular-nums text-slate-muted`}>{rowRate(r.cells.clicked, r.cells.delivered)}</td>
                  <td className={`${cell} text-right tabular-nums text-slate-muted`}>{rowRate(r.cells.replied, r.cells.delivered)}</td>
                  <td className={`${cell} text-right tabular-nums text-slate-muted`}>{rowRate(r.cells.bounced, r.cells.total_sent)}</td>
                  <td className={`${cell} text-right tabular-nums text-slate-muted`}>{rowRate(r.cells.opted_out, r.cells.delivered)}</td>
                  <CountCell cell={r.cells.outbound_calls} boundary={boundary} />
                  <CountCell cell={r.cells.linkedin_tasks_completed} boundary={boundary} />
                </tr>
              ))}
              <tr className="font-medium" data-testid="seq-total-row">
                <td className={`${cell} text-charcoal`}>Total</td>
                <td
                  className={`${cell} text-right text-slate-muted`}
                  title="Not totaled: prospects is a point-in-time snapshot per sequence and the same prospect can appear in several sequences, so a sum is not proven meaningful."
                >
                  {'—'}
                </td>
                <td className={`${cell} text-right tabular-nums text-charcoal`} title={totalTitle('total_sent')}>{totalCell('total_sent')}</td>
                <td className={`${cell} text-right tabular-nums text-charcoal`} title={totalTitle('delivered')}>{totalCell('delivered')}</td>
                <td className={`${cell} text-right tabular-nums text-charcoal`}>{totalRate('delivered', 'total_sent')}</td>
                <td className={`${cell} text-right tabular-nums text-charcoal`}>{totalRate('opened', 'delivered')}</td>
                <td className={`${cell} text-right tabular-nums text-charcoal`}>{totalRate('clicked', 'delivered')}</td>
                <td className={`${cell} text-right tabular-nums text-charcoal`}>{totalRate('replied', 'delivered')}</td>
                <td className={`${cell} text-right tabular-nums text-charcoal`}>{totalRate('bounced', 'total_sent')}</td>
                <td className={`${cell} text-right tabular-nums text-charcoal`}>{totalRate('opted_out', 'delivered')}</td>
                <td className={`${cell} text-right tabular-nums text-charcoal`} title={totalTitle('outbound_calls')}>{totalCell('outbound_calls')}</td>
                <td className={`${cell} text-right tabular-nums text-charcoal`} title={totalTitle('linkedin_tasks_completed')}>{totalCell('linkedin_tasks_completed')}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
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
  feedRows,
}: {
  deduped: DedupedSeries;
  period: ReportingPeriod;
  // The FULL normalized feed, for cadence assessment: a globally missed
  // Thursday makes a column partial regardless of which sequences are shown.
  feedRows: readonly OutreachReportingRow[];
}) {
  const [metric, setMetric] = useState<ActivityCounter>('total_sent');
  const windowPeriods = useMemo(() => rollingPeriods(period, 5), [period]);

  // Per-column Thursday-cadence completeness on the full feed.
  const columnCadence = useMemo(
    () =>
      windowPeriods.map((p) => ({
        period: p,
        label: periodLabel(p),
        completeness: assessOutreachCompleteness(feedRows, p).completeness,
      })),
    [windowPeriods, feedRows],
  );

  const { rows, maxVal } = useMemo(() => {
    const out: {
      id: number;
      name: string;
      cells: { key: string; label: string; activity: SequenceActivity }[];
    }[] = [];
    for (const [id, series] of deduped.bySequence) {
      const name = statusAsOfPeriodEnd(series, period).name;
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
  }, [deduped, windowPeriods, metric, period]);

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
                  {columnCadence.map((col) => (
                    <th
                      key={col.label}
                      className="text-center px-1 py-1 text-slate-muted font-medium w-14"
                      title={
                        col.completeness === 'complete'
                          ? `${col.label}: complete Thursday coverage`
                          : col.completeness === 'partial'
                            ? `${col.label}: partial period (a scheduled Thursday run is missing); values are safe-known, not complete totals`
                            : `${col.label}: no snapshots in this period`
                      }
                      data-cadence={col.completeness}
                    >
                      {col.label}
                      {col.completeness !== 'complete' ? '†' : ''}
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
                    {seq.cells.map((cell, ci) => (
                      <HeatCell
                        key={cell.key}
                        cell={cell}
                        seqName={seq.name}
                        maxVal={maxVal}
                        columnPartial={columnCadence[ci]?.completeness !== 'complete'}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3 mt-3 justify-end text-[9px] text-slate-muted">
            <span>† = partial period cadence, * = incomplete value, · = reset/no baseline, blank = missing</span>
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
// reset/missing-baseline cells show a distinct dot marker; missing cells are
// blank. Missing is never rendered as a zero. A cell in a column whose global
// Thursday cadence is partial keeps its safe-known value but is labeled
// partial (never presented as a complete total).
function HeatCell({
  cell,
  seqName,
  maxVal,
  columnPartial,
}: {
  cell: { key: string; label: string; activity: SequenceActivity };
  seqName: string;
  maxVal: number;
  columnPartial: boolean;
}) {
  const a = cell.activity;
  if (a.state === 'missing') {
    return (
      <td className="px-1 py-1 text-center" data-state="missing">
        <div className="rounded px-1 py-0.5 text-[9px]" title={`${seqName}, ${cell.label}: no data`} />
      </td>
    );
  }
  if (a.state !== 'present') {
    // reset / missing_baseline / ambiguous: visually distinct from zero, with
    // the exact engine reason so the marker is understandable on hover.
    return (
      <td className="px-1 py-1 text-center" data-state={a.state}>
        <div
          className="rounded px-1 py-0.5 text-[9px] font-medium border border-dashed border-border text-slate-muted"
          title={`${seqName}, ${cell.label}: ${sequenceActivityReason(a)}`}
        >
          ·
        </div>
      </td>
    );
  }
  const intensity = a.value / maxVal;
  const bg = heatColor(intensity);
  const text = intensity > 0.55 ? '#FFFFFF' : '#0F172A';
  const valueIncomplete = a.baselineIncomplete || a.missingMeasurements;
  const partial = columnPartial || valueIncomplete;
  const suffix = valueIncomplete ? '*' : columnPartial ? '†' : '';
  const titleNote = valueIncomplete
    ? ' (incomplete)'
    : columnPartial
      ? ' (partial period: safe-known value, not a complete total)'
      : '';
  return (
    <td className="px-1 py-1 text-center" data-state="present" data-partial={partial ? 'true' : 'false'}>
      <div
        className="rounded px-1 py-0.5 text-[9px] font-medium tabular-nums"
        style={{ backgroundColor: bg, color: text }}
        title={`${seqName}, ${cell.label}: ${a.value.toLocaleString()}${titleNote}`}
      >
        {a.value.toLocaleString()}
        {suffix}
      </div>
    </td>
  );
}
