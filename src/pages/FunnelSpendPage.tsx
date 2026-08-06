// FunnelSpendPage — Marketing Funnel: Spend sub-tab.
//
// Joins date-range campaign_costs with leads / MQLs / first-touch
// attributions to produce a per-channel table with cost-per-lead,
// cost-per-MQL, pipeline, won amounts, and ROI. Budgets prorate to
// the selected period (Q1-Q4 or Year). Region filter applies to
// leads and attributions; cost is NOT region-scoped (the budget is
// a sunk cost regardless of which region the user is filtering to).
//
// Sub-channels of a parent-only-cost channel (Content Syndication
// style) inherit a proportional slice of the parent's cost based on
// their lead share; sub-channels of a leaf-cost structure (Events)
// keep their own cost.

import { useMemo } from 'react';
import { useLeads } from '../hooks/useLeads';
import { useChannels } from '../hooks/useChannels';
import { useAttributions } from '../hooks/useAttributions';
import { useAttributionTouches } from '../hooks/useAttributionTouches';
import { useCampaignCosts } from '../hooks/useCampaignCosts';
import { useCollapsedChannels } from '../hooks/useCollapsedChannels';
import {
  computeChannelSpend,
  type ChannelSpendBreakdown,
  type PeriodFilter,
} from '../lib/compute';
import { filterChannelsByYear } from '../lib/channelFilter';
import { quarterOfIsoDate } from '../lib/dates';
import FunnelReportingFilters from '../components/funnel/FunnelReportingFilters';
import ChartCard from '../components/charts/ChartCard';
import type { RegionKey } from '../constants/regions';
import type { ComparisonMode } from '../types/reporting';
import ReportingBasisDisclosure from '../components/reporting/ReportingBasisDisclosure';
import { reportingContractFor } from '../constants/reportingPages';

interface FunnelSpendPageProps {
  year: number;
  filter: PeriodFilter;
  onYearChange: (y: number) => void;
  onFilterChange: (f: PeriodFilter) => void;
  regions: Set<RegionKey>;
  onRegionsChange: (next: Set<RegionKey>) => void;
  // Comparison mode from the shared reporting selection.
  comparison: ComparisonMode;
  onComparisonChange: (m: ComparisonMode) => void;
}

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

// Compact dollar formatting for tight columns ("$1.2K", "$45K", "$2.1M").
function fmtUsdCompact(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

function fmtPct1(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

// Basis and anchor come from the single reporting-page registry, so the
// visible disclosure and the declared contract cannot disagree.
const REPORTING_BASIS = reportingContractFor('funnel-spend')!;

export default function FunnelSpendPage({
  year,
  filter,
  onYearChange,
  onFilterChange,
  regions,
  onRegionsChange,
  comparison,
  onComparisonChange,
}: FunnelSpendPageProps) {
  const { leads } = useLeads();
  const channels = useChannels();
  const attributionsHook = useAttributions();
  const touchesHook = useAttributionTouches();
  const costsHook = useCampaignCosts();
  // collapse state intentionally tracks the FULL channel set so a
  // user's expand/collapse picks survive switching years.
  const collapse = useCollapsedChannels(channels);
  // Year-filtered channels feed computeChannelSpend so a 2026 channel
  // doesn't render as a $0 row in the 2025 view. Evergreen channels
  // (year IS NULL) always render.
  const visibleChannels = useMemo(
    () => filterChannelsByYear(channels, year),
    [channels, year],
  );

  const yearOptions = useMemo(() => {
    const years = new Set<number>([new Date().getFullYear()]);
    for (const l of leads) {
      const sourced = quarterOfIsoDate(l.marketing_sourced_date);
      if (sourced) years.add(sourced.year);
    }
    for (const a of attributionsHook.attributions) {
      years.add(a.year);
    }
    for (const c of costsHook.costs) {
      const m = /^(\d{4})/.exec(c.start_date);
      if (m) years.add(parseInt(m[1], 10));
    }
    return [...years].sort((a, b) => a - b);
  }, [leads, attributionsHook.attributions, costsHook.costs]);

  const breakdown: ChannelSpendBreakdown[] = useMemo(
    () =>
      computeChannelSpend({
        campaignCosts: costsHook.costs,
        channels: visibleChannels,
        leads,
        attributions: attributionsHook.attributions,
        attributionTouches: touchesHook.touches,
        year,
        filter,
        regions,
      }),
    [
      costsHook.costs,
      visibleChannels,
      leads,
      attributionsHook.attributions,
      touchesHook.touches,
      year,
      filter,
      regions,
    ],
  );

  // Build a quick lookup so the table render loop can pull a row by
  // channelId, and a parent → children index for the depth-first
  // visit order. We render in tree-order (parents first, then their
  // direct children in lead-count descending) so sub-channels sit
  // under their parent visually.
  const byId = useMemo(() => {
    const m = new Map<string, ChannelSpendBreakdown>();
    for (const r of breakdown) m.set(r.channelId, r);
    return m;
  }, [breakdown]);

  const childrenByParent = useMemo(() => {
    const m = new Map<string | null, ChannelSpendBreakdown[]>();
    for (const r of breakdown) {
      const key = r.parentId;
      const arr = m.get(key) ?? [];
      arr.push(r);
      m.set(key, arr);
    }
    // Sort each sibling group by pipelineAmount descending — the spec
    // default. Pipeline = 0 rows fall to the bottom; tiebreak by name
    // so the order is stable.
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        if (b.pipelineAmount !== a.pipelineAmount) {
          return b.pipelineAmount - a.pipelineAmount;
        }
        return a.channelName.localeCompare(b.channelName);
      });
    }
    return m;
  }, [breakdown]);

  // DFS to materialize the render order, attaching depth + ancestor
  // ids so the collapse hook can hide whole subtrees with one check.
  interface OrderedRow {
    row: ChannelSpendBreakdown;
    ancestors: string[];
  }
  const orderedRows: OrderedRow[] = useMemo(() => {
    const out: OrderedRow[] = [];
    const visit = (parentId: string | null, ancestors: string[]) => {
      const kids = childrenByParent.get(parentId) ?? [];
      for (const r of kids) {
        out.push({ row: r, ancestors });
        visit(r.channelId, [...ancestors, r.channelId]);
      }
    };
    visit(null, []);
    return out;
  }, [childrenByParent]);

  // Summary KPIs across all rows in scope. Parents now carry their
  // subtree's rolled-up totals (see computeChannelSpend), so summing
  // every row would double-count. Restrict the sum to leaves and read
  // `allocatedCost` (which captures both direct cost and any
  // parent-budget slice redistributed down to the leaf). This is
  // correct for both shapes:
  //   - Events shape: leaves carry their own direct costs.
  //   - Content Syndication shape: leaves carry redistributed slices
  //     that sum to the parent's budget.
  const totals = useMemo(() => {
    let totalCost = 0;
    let totalLeads = 0;
    let totalMqls = 0;
    let totalPipeline = 0;
    let totalWon = 0;
    for (const r of breakdown) {
      if (r.isParent) continue;
      totalCost += r.allocatedCost;
      totalLeads += r.leads;
      totalMqls += r.mqls;
      totalPipeline += r.pipelineAmount;
      totalWon += r.wonAmount;
    }
    void byId;
    return {
      totalCost,
      totalLeads,
      totalMqls,
      totalPipeline,
      totalWon,
      avgCpl: totalLeads > 0 ? totalCost / totalLeads : null,
      avgCpmql: totalMqls > 0 ? totalCost / totalMqls : null,
      // ROI is won-based: pipeline dollars can still slip, so the
      // conservative read is closed/won revenue ÷ spend.
      overallRoi: totalCost > 0 ? totalWon / totalCost : null,
      // Pipeline coverage = open pipeline ÷ spend. Surfaced as a
      // tooltip on the ROI tile so the unrealized return is one hover
      // away without taking up its own KPI slot.
      pipelineCoverage:
        totalCost > 0 ? totalPipeline / totalCost : null,
    };
  }, [breakdown, byId]);

  return (
    <div className="p-8 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-charcoal">
            Marketing Funnel: Spend
          </h1>
          <ReportingBasisDisclosure
            basis={REPORTING_BASIS.basis}
            explanation={REPORTING_BASIS.anchor}
          />
          <p className="mt-1 text-sm text-slate-muted">
            Cost per lead, cost per MQL, and first-touch ROI by channel.
            Date-range budgets are prorated to the selected period.
          </p>
          <p className="mt-1 text-xs text-slate-muted">
            Basis: primary source (one channel per contact). CPL and CPMQL
            denominators deliberately do NOT use campaign memberships, so
            they are lower than the membership lead counts on the funnel
            grid and each contact is charged to a single channel.
          </p>
        </div>
        <FunnelReportingFilters
          year={year}
          filter={filter}
          yearOptions={yearOptions}
          onYearChange={onYearChange}
          onFilterChange={onFilterChange}
          regions={regions}
          onRegionsChange={onRegionsChange}
          comparison={comparison}
          onComparisonChange={onComparisonChange}
        />
      </header>

      {/* Summary KPI tiles. ROI tile uses the overall ratio of
          pipeline-to-spend; CPL and CPMQL use the period's total
          spend divided by total leads / total MQLs. */}
      <section className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <KpiCard label="Total Spend" value={fmtUsd(totals.totalCost)} />
        <KpiCard
          label="Total Leads"
          value={totals.totalLeads.toLocaleString()}
        />
        <KpiCard
          label="Avg CPL"
          value={totals.avgCpl === null ? '—' : fmtUsd(totals.avgCpl)}
        />
        <KpiCard
          label="Avg CPMQL"
          value={totals.avgCpmql === null ? '—' : fmtUsd(totals.avgCpmql)}
        />
        <KpiCard label="Total Pipeline" value={fmtUsd(totals.totalPipeline)} />
        <KpiCard label="Total Won" value={fmtUsd(totals.totalWon)} />
        <KpiCard
          label="Overall ROI"
          value={
            totals.overallRoi === null ? '—' : fmtPct1(totals.overallRoi)
          }
          tooltip={
            totals.pipelineCoverage === null
              ? 'ROI = Total Won ÷ Total Spend. Pipeline coverage unavailable (no spend in scope).'
              : `ROI = Total Won ÷ Total Spend. Pipeline coverage (Total Pipeline ÷ Total Spend) is ${fmtPct1(totals.pipelineCoverage)}.`
          }
        />
      </section>

      <div className="overflow-x-auto border border-border rounded-lg bg-bg">
        <table className="min-w-full text-sm">
          <thead className="bg-muted/40 text-charcoal">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Channel</th>
              <th className="text-right px-3 py-2 font-medium">Cost</th>
              <th className="text-right px-3 py-2 font-medium">Leads</th>
              <th className="text-right px-3 py-2 font-medium">CPL</th>
              <th className="text-right px-3 py-2 font-medium">MQLs</th>
              <th className="text-right px-3 py-2 font-medium">CPMQL</th>
              <th className="text-right px-3 py-2 font-medium">First-Touch Opps</th>
              <th className="text-right px-3 py-2 font-medium">Pipeline $</th>
              <th className="text-right px-3 py-2 font-medium">Won $</th>
              <th className="text-right px-3 py-2 font-medium">ROI</th>
            </tr>
          </thead>
          <tbody>
            {orderedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={10}
                  className="px-3 py-6 text-sm text-slate-muted italic text-center"
                >
                  No channels configured.
                </td>
              </tr>
            ) : (
              orderedRows.map(({ row, ancestors }) => {
                if (collapse.isHiddenByAncestors(ancestors)) return null;
                const isCollapsed =
                  row.isParent && collapse.isCollapsed(row.channelId);
                const paddingLeft = 4 + (row.depth - 1) * 24;
                const bg =
                  row.depth === 1
                    ? 'bg-bg'
                    : row.depth === 2
                      ? 'bg-muted/30'
                      : 'bg-muted/50';
                return (
                  <tr
                    key={row.channelId}
                    className={`${bg} border-t border-border`}
                  >
                    <td
                      className={
                        'px-3 py-1.5 whitespace-nowrap ' +
                        (row.depth === 1
                          ? 'font-medium text-charcoal'
                          : 'text-charcoal')
                      }
                      style={{ paddingLeft }}
                    >
                      {row.isParent ? (
                        <button
                          type="button"
                          onClick={() => collapse.toggle(row.channelId)}
                          aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                          className="inline-flex items-center justify-center w-5 h-5 mr-1 text-slate-muted hover:text-charcoal align-middle"
                        >
                          <span className="text-[10px]">
                            {isCollapsed ? '▶' : '▼'}
                          </span>
                        </button>
                      ) : row.depth === 1 ? (
                        // Top-level leaves (e.g. Sales) reserve the
                        // chevron-sized space so their names align
                        // with sibling parents.
                        <span
                          className="inline-block w-5 h-5 mr-1 align-middle"
                          aria-hidden="true"
                        />
                      ) : null}
                      {row.channelName}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {fmtUsd(row.allocatedCost)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {row.leads}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-muted">
                      {row.costPerLead === null
                        ? '—'
                        : fmtUsd(row.costPerLead)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {row.mqls}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-muted">
                      {row.costPerMql === null
                        ? '—'
                        : fmtUsd(row.costPerMql)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {row.firstTouchOpps}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {fmtUsdCompact(row.pipelineAmount)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {fmtUsdCompact(row.wonAmount)}
                    </td>
                    <td
                      className={
                        'px-3 py-1.5 text-right tabular-nums ' +
                        (row.roi !== null && row.roi >= 1
                          ? 'text-success'
                          : row.roi !== null && row.roi < 1
                            ? 'text-danger'
                            : 'text-slate-muted')
                      }
                    >
                      {row.roi === null ? '—' : fmtPct1(row.roi)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-muted italic">
        Costs prorate by inclusive day overlap of the budget date range with
        the selected period. Sub-channels under a parent-cost channel
        inherit a proportional slice of the parent's cost based on their
        lead share. Edit budgets on the Channels page.
      </p>
    </div>
  );
}

function KpiCard({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: string;
  tooltip?: string;
}) {
  return (
    <ChartCard title={label}>
      <div
        className={
          'text-2xl font-semibold text-charcoal tabular-nums' +
          (tooltip ? ' cursor-help' : '')
        }
        title={tooltip}
      >
        {value}
      </div>
    </ChartCard>
  );
}
