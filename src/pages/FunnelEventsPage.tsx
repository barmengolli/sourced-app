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
import { quarterOfIsoDate } from '../lib/dates';
import PeriodSelector from '../components/funnel/PeriodSelector';
import ChartCard from '../components/charts/ChartCard';
import { CHART_COLORS } from '../constants/chartColors';
import {
  EVENT_ACTIVATION_VALUES,
  EVENTS_PARENT_CHANNEL_NAME,
  type EventActivation,
} from '../constants/eventActivations';
import type { RegionKey } from '../constants/regions';

// Pluralized labels for the KPI tiles. The compute layer keys on the
// singular SFDC names, but at the top of the page we're showing a sum
// of contacts, so plural reads more naturally.
const KPI_TILE_LABELS: Record<EventActivation, string> = {
  'Pre-Event Meeting': 'Pre-Event Meetings',
  'Booth Meeting': 'Booth Meetings',
  'Session Attendee': 'Session Attendees',
  'Post-Event Meeting': 'Post-Event Meetings',
};

interface FunnelEventsPageProps {
  year: number;
  filter: PeriodFilter;
  onYearChange: (y: number) => void;
  onFilterChange: (f: PeriodFilter) => void;
  regions: Set<RegionKey>;
  onRegionsChange: (next: Set<RegionKey>) => void;
}

export default function FunnelEventsPage({
  year,
  filter,
  onYearChange,
  onFilterChange,
  regions,
  onRegionsChange,
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

  const rows: EventActivationCounts[] = useMemo(
    () =>
      computeEventActivations({
        leads,
        channels,
        parentChannelName: EVENTS_PARENT_CHANNEL_NAME,
        year,
        filter,
        regions,
      }),
    [leads, channels, year, filter, regions],
  );

  // KPI tile totals: sum each activation type across every event in
  // the current view. Column totals in the table equal these by
  // construction (same source rows).
  const totals = useMemo(() => {
    const sum: Record<EventActivation, number> = {
      'Pre-Event Meeting': 0,
      'Booth Meeting': 0,
      'Session Attendee': 0,
      'Post-Event Meeting': 0,
    };
    for (const e of rows) {
      for (const type of EVENT_ACTIVATION_VALUES) {
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
          <p className="mt-1 text-sm text-slate-muted">
            Event-marketing engagement by activation type. Counts are
            unique contacts per event in the selected period.
          </p>
        </div>
        <PeriodSelector
          year={year}
          filter={filter}
          yearOptions={yearOptions}
          onYearChange={onYearChange}
          onFilterChange={onFilterChange}
          regions={regions}
          onRegionsChange={onRegionsChange}
        />
      </header>

      {/* KPI tiles: total contacts by activation type across all
          events in the current period and region. Always render so
          the user sees "0 across all events" rather than a blank
          card on empty periods. */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {EVENT_ACTIVATION_VALUES.map((v) => (
          <ChartCard
            key={v}
            title={KPI_TILE_LABELS[v]}
            subtitle={`Across all events in ${periodLabel}`}
          >
            <div className="text-3xl font-semibold text-charcoal tabular-nums">
              {totals[v].toLocaleString()}
            </div>
          </ChartCard>
        ))}
      </section>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-muted italic px-4 py-6 border border-border rounded bg-muted/40">
          No events with contacts in the selected period.
        </p>
      ) : (
        <div className="border border-border rounded overflow-x-auto bg-bg">
          <table className="min-w-full text-sm">
            <thead className="bg-muted text-xs text-slate-muted uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Event</th>
                {EVENT_ACTIVATION_VALUES.map((v) => (
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
                    {EVENT_ACTIVATION_VALUES.map((v) => (
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
