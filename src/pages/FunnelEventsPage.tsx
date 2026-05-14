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
import {
  EVENT_ACTIVATION_SHORT_LABELS,
  EVENT_ACTIVATION_VALUES,
  EVENTS_PARENT_CHANNEL_NAME,
} from '../constants/eventActivations';
import type { RegionKey } from '../constants/regions';

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
                <th className="px-3 py-2 text-right font-medium tabular-nums">
                  Pre+Post
                </th>
                <th className="px-3 py-2 text-right font-medium tabular-nums">
                  2+ Activations
                </th>
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
                    {r.preAndPost}
                  </td>
                  <td className="px-3 py-2 text-right text-charcoal tabular-nums">
                    {r.multiActivation}
                  </td>
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
