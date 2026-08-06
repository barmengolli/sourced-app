// FunnelEventsPage — Marketing Funnel: Events sub-tab.
//
// One row per event sub-channel under the year's parent "2026 - Events".
// Surfaces per-event activation counts so the user can answer "how
// many ITC Japan contacts had a Booth Meeting and a Post-Event
// Meeting?" at a glance.
//
// Counts are unique contacts (one row per email) bucketed by
// marketing_sourced_date in the selected period. Region filter
// applies. Future-year rollover only needs an update to
// EVENTS_PARENT_CHANNEL_NAME in constants/eventActivations.ts.

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useLeads } from '../hooks/useLeads';
import { useChannels } from '../hooks/useChannels';
import { useAttributions } from '../hooks/useAttributions';
import { useCampaignCosts } from '../hooks/useCampaignCosts';
import { useFunnelActuals } from '../hooks/useFunnelActuals';
import { useFunnelProjections } from '../hooks/useFunnelProjections';
import {
  computeEventActivations,
  type EventActivationCounts,
  type PeriodFilter,
} from '../lib/compute';
import { filterChannelsByYear } from '../lib/channelFilter';
import { quarterOfIsoDate } from '../lib/dates';
import FunnelReportingFilters from '../components/funnel/FunnelReportingFilters';
import ChartCard from '../components/charts/ChartCard';
import { CHART_COLORS } from '../constants/chartColors';
import {
  EVENT_ACTIVATION_VALUES,
  EVENT_ACTIVATION_ALL,
  EVENTS_PARENT_CHANNEL_NAME,
  type EventActivationValue,
} from '../constants/eventActivations';
import type { RegionKey } from '../constants/regions';
import type { ComparisonMode } from '../types/reporting';
import ReportingBasisDisclosure from '../components/reporting/ReportingBasisDisclosure';
import { reportingContractFor } from '../constants/reportingPages';

// Pluralized labels for the KPI tiles. The compute layer keys on the
// singular SFDC names, but at the top of the page we're showing a sum
// of contacts, so plural reads more naturally. "Registered" is shown
// but is not an activation: it counts registration volume, not
// engagement, so it is excluded from Active Contacts / % Active.
const KPI_TILE_LABELS: Record<EventActivationValue, string> = {
  'Pre-Event Meeting': 'Pre-Event Meetings',
  'Booth Meeting': 'Booth Meetings',
  'Session Attendee': 'Session Attendees',
  'Post-Event Meeting': 'Post-Event Meetings',
  Registered: 'Registered',
};

interface FunnelEventsPageProps {
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

// Basis and anchor come from the single reporting-page registry, so the
// visible disclosure and the declared contract cannot disagree.
const REPORTING_BASIS = reportingContractFor('funnel-events')!;

export default function FunnelEventsPage({
  year,
  filter,
  onYearChange,
  onFilterChange,
  regions,
  onRegionsChange,
  comparison,
  onComparisonChange,
}: FunnelEventsPageProps) {
  const { leads } = useLeads();
  const channels = useChannels();
  // Only consumed by the year-selector derivation below; this page's
  // table doesn't read these directly.
  const attributionsHook = useAttributions();
  const costsHook = useCampaignCosts();
  const actualsHook = useFunnelActuals();
  const projectionsHook = useFunnelProjections();

  const yearOptions = useMemo(() => {
    // Unified derivation: any year touched by a lead, attribution,
    // budget, actual, or projection surfaces in the dropdown. Lets
    // historical-year backfills (e.g. 2025 pre-Sourced) be
    // reachable even when no lead-level data was imported.
    const years = new Set<number>([new Date().getFullYear()]);
    for (const l of leads) {
      const sourced = quarterOfIsoDate(l.marketing_sourced_date);
      if (sourced) years.add(sourced.year);
      for (const h of l.stage_history ?? []) {
        const q = quarterOfIsoDate(h.entered_at);
        if (q) years.add(q.year);
      }
    }
    for (const a of attributionsHook.attributions) {
      years.add(a.year);
    }
    for (const c of costsHook.costs) {
      const m = /^(\d{4})/.exec(c.start_date);
      if (m) years.add(parseInt(m[1], 10));
    }
    for (const a of actualsHook.actuals) {
      years.add(a.year);
    }
    for (const p of projectionsHook.projections) {
      years.add(p.year);
    }
    return [...years].sort((a, b) => a - b);
  }, [
    leads,
    attributionsHook.attributions,
    costsHook.costs,
    actualsHook.actuals,
    projectionsHook.projections,
  ]);

  // Year-filtered channel set: a 2025 view excludes the "2026 - Events"
  // taxonomy. EVENTS_PARENT_CHANNEL_NAME is still hard-coded to the
  // 2026 parent, so historical years (without a same-named parent in
  // the filtered set) render an empty table here — a known follow-up
  // for the events-parent-by-year resolver.
  const visibleChannels = useMemo(
    () => filterChannelsByYear(channels, year),
    [channels, year],
  );

  const activations = useMemo(
    () =>
      computeEventActivations({
        leads,
        channels: visibleChannels,
        parentChannelName: EVENTS_PARENT_CHANNEL_NAME,
        year,
        filter,
        regions,
      }),
    [leads, visibleChannels, year, filter, regions],
  );
  const rows: EventActivationCounts[] = activations.rows;
  // Whether the events taxonomy for the SELECTED year exists at all. When it
  // does not, every count below is unknown rather than zero, and the tiles
  // must say so.
  const taxonomyMissing = activations.status !== 'ok';

  // KPI tile totals: sum each activation type across every event in
  // the current view. Column totals in the table equal these by
  // construction (same source rows).
  const totals = useMemo(() => {
    const sum: Record<EventActivationValue, number> = {
      'Pre-Event Meeting': 0,
      'Booth Meeting': 0,
      'Session Attendee': 0,
      'Post-Event Meeting': 0,
      Registered: 0,
    };
    for (const e of rows) {
      for (const type of EVENT_ACTIVATION_ALL) {
        sum[type] += e.perType[type];
      }
    }
    return sum;
  }, [rows]);

  // Period label for the tile subtitles: "Q2 2026" when a quarter is
  // selected, just "2026" when the user picked the Year view.
  const periodLabel =
    filter === 'year' ? `${year}` : `${filter} ${year}`;

  // Per-activation-type bar chart data. One series per type; every
  // event appears as a bar (zero-value events sort to the bottom but
  // stay visible so the user can see "we tracked 0 here, 80 there").
  // Always emits all 4 entries; the card renders an empty-state
  // placeholder when hasAnyData is false.
  const chartsToRender = useMemo(
    () =>
      EVENT_ACTIVATION_VALUES.map((type) => {
        const data = rows
          .map((e) => ({ name: e.channelName, value: e.perType[type] }))
          .sort((a, b) => b.value - a.value);
        const hasAnyData = data.some((d) => d.value > 0);
        return { type, data, hasAnyData };
      }),
    [rows],
  );

  return (
    <div className="p-8 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-charcoal">
            Marketing Funnel: Events
          </h1>
          <ReportingBasisDisclosure
            basis={REPORTING_BASIS.basis}
            explanation={REPORTING_BASIS.anchor}
          />
          <p className="mt-1 text-sm text-slate-muted">
            Event-marketing engagement by activation type. Counts are
            unique contacts per event in the selected period.
          </p>
          <p className="mt-1 text-xs text-slate-muted">
            Basis: unique contacts on their primary source channel, not
            campaign memberships. An activation is a person-level fact, so
            these numbers do not overlap and will not match the
            membership counts on the funnel grid.
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

      {/* KPI tiles. A real zero (the taxonomy exists, nobody activated) shows
          0. A MISSING taxonomy shows a dash: rendering 0 there would claim we
          ran events that nobody engaged with, when in fact this year's events
          structure was never set up. */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {EVENT_ACTIVATION_ALL.map((v) => (
          <ChartCard
            key={v}
            title={KPI_TILE_LABELS[v]}
            subtitle={
              taxonomyMissing
                ? `No events structure for ${year}`
                : `Across all events in ${periodLabel}`
            }
          >
            <div className="text-3xl font-semibold text-charcoal tabular-nums">
              {taxonomyMissing ? '—' : totals[v].toLocaleString()}
            </div>
          </ChartCard>
        ))}
      </section>

      {taxonomyMissing ? (
        <p className="text-sm text-slate-muted italic px-4 py-6 border border-border rounded bg-muted/40">
          {activations.status === 'no-parent'
            ? `No events parent channel exists for ${year}, so event activations cannot be reported for this year. Add a "${year} - Events" channel, or tag an existing events parent with the year, on the Channels page.`
            : `The events parent for ${year} has no event channels yet, so there is nothing to report. Add event sub-channels under "${activations.parentName}" on the Channels page.`}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-muted italic px-4 py-6 border border-border rounded bg-muted/40">
          No events with contacts in the selected period.
        </p>
      ) : (
        <div className="border border-border rounded overflow-x-auto bg-bg">
          <table className="min-w-full text-sm">
            <thead className="bg-muted text-xs text-slate-muted uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Event</th>
                {EVENT_ACTIVATION_ALL.map((v) => (
                  <th
                    key={v}
                    className="px-3 py-2 text-right font-medium tabular-nums"
                  >
                    {v}
                  </th>
                ))}
                {/* Pre+Post and 2+ Activations columns removed from
                    the table; the compute helper still returns them
                    (preAndPost, multiActivation) so a future chart
                    can pick them up. */}
                <th className="px-3 py-2 text-right font-medium tabular-nums">
                  Total Contacts
                </th>
                <th className="px-3 py-2 text-right font-medium tabular-nums">
                  Active Contacts
                </th>
                <th className="px-3 py-2 text-right font-medium tabular-nums">
                  % Active
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                // Share of event contacts with at least one tracked
                // activation. "—" when no contacts to avoid a
                // division-by-zero result like NaN%.
                const pctActive =
                  r.totalContacts > 0
                    ? `${((r.withAnyActivation / r.totalContacts) * 100).toFixed(1)}%`
                    : '—';
                return (
                  <tr
                    key={r.channelId}
                    className={
                      (i % 2 === 0 ? 'bg-bg' : 'bg-muted/40') +
                      ' hover:bg-indigo/5'
                    }
                  >
                    <td className="px-3 py-2 text-charcoal">{r.channelName}</td>
                    {EVENT_ACTIVATION_ALL.map((v) => (
                      <td
                        key={v}
                        className="px-3 py-2 text-right text-charcoal tabular-nums"
                      >
                        {r.perType[v]}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right text-charcoal tabular-nums font-medium">
                      {r.totalContacts}
                    </td>
                    <td className="px-3 py-2 text-right text-charcoal tabular-nums">
                      {r.withAnyActivation}
                    </td>
                    <td className="px-3 py-2 text-right text-charcoal tabular-nums">
                      {pctActive}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-activation-type bar charts. 2x2 grid on lg+, single
          column below. All 4 cards always render; an activation
          type with no data across events shows an empty-state
          placeholder inside the card. */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {chartsToRender.map(({ type, data, hasAnyData }) => {
          // Height scales with event count so long rosters don't
          // squeeze the bars together. 40px per row plus a 60px
          // floor for the axis, clamped to 280px minimum.
          const height = Math.max(280, data.length * 40 + 60);
          return (
            <ChartCard key={type} title={`${type} per Event`}>
              {hasAnyData ? (
                <ResponsiveContainer width="100%" height={height}>
                  <BarChart
                    layout="vertical"
                    data={data}
                    margin={{ top: 8, right: 48, left: 8, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke={CHART_COLORS.border}
                      horizontal={false}
                    />
                    <XAxis
                      type="number"
                      tick={{
                        fontSize: 11,
                        fill: CHART_COLORS.slateMuted,
                      }}
                      axisLine={{ stroke: CHART_COLORS.border }}
                      tickLine={{ stroke: CHART_COLORS.border }}
                      allowDecimals={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={140}
                      tick={{
                        fontSize: 11,
                        fill: CHART_COLORS.charcoal,
                      }}
                      axisLine={{ stroke: CHART_COLORS.border }}
                      tickLine={{ stroke: CHART_COLORS.border }}
                    />
                    <Tooltip
                      contentStyle={{
                        fontSize: 11,
                        border: `1px solid ${CHART_COLORS.border}`,
                        borderRadius: 6,
                      }}
                      labelStyle={{
                        color: CHART_COLORS.charcoal,
                        fontWeight: 600,
                      }}
                      formatter={(v) => {
                        const n =
                          typeof v === 'number' ? v : Number(v);
                        return Number.isFinite(n)
                          ? n.toLocaleString()
                          : String(v);
                      }}
                    />
                    <Bar
                      dataKey="value"
                      name={type}
                      fill={CHART_COLORS.indigo}
                      radius={[0, 3, 3, 0]}
                      label={{
                        position: 'right',
                        fill: CHART_COLORS.charcoal,
                        fontSize: 11,
                        formatter: (v) => {
                          const n =
                            typeof v === 'number' ? v : Number(v);
                          return Number.isFinite(n) && n !== 0
                            ? n.toLocaleString()
                            : '';
                        },
                      }}
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-slate-muted italic h-[200px] flex items-center justify-center">
                  No data yet for {type}.
                </p>
              )}
            </ChartCard>
          );
        })}
      </section>
    </div>
  );
}
