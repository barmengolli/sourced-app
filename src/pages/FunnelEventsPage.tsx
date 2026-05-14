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
import { useLeads } from '../hooks/useLeads';
import { useChannels } from '../hooks/useChannels';
import {
  computeEventActivations,
  type EventActivationCounts,
  type PeriodFilter,
} from '../lib/compute';
import { quarterOfIsoDate } from '../lib/dates';
import PeriodSelector from '../components/funnel/PeriodSelector';
import ChartCard from '../components/charts/ChartCard';
import {
  EVENT_ACTIVATION_SHORT_LABELS,
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

  const yearOptions = useMemo(() => {
    const years = new Set<number>([new Date().getFullYear()]);
    for (const l of leads) {
      const sourced = quarterOfIsoDate(l.marketing_sourced_date);
      if (sourced) years.add(sourced.year);
    }
    return [...years].sort((a, b) => a - b);
  }, [leads]);

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
                    {EVENT_ACTIVATION_SHORT_LABELS[v]}
                  </th>
                ))}
                {/* Pre+Post and 2+ Activations columns removed from
                    the table; the compute helper still returns them
                    (preAndPost, multiActivation) so a future chart
                    can pick them up. */}
                <th className="px-3 py-2 text-right font-medium tabular-nums">
                  Active Contacts
                </th>
                <th className="px-3 py-2 text-right font-medium tabular-nums">
                  Total Contacts
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
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
                  <td className="px-3 py-2 text-right text-charcoal tabular-nums">
                    {r.withAnyActivation}
                  </td>
                  <td className="px-3 py-2 text-right text-charcoal tabular-nums font-medium">
                    {r.totalContacts}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
