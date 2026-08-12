// TouchDrilldownPanel: Bite 4E side panel listing the touches underlying a
// clicked Lead or MQL actual. Memberships, not just leads: a lead with two
// touches in the inspected scope appears once per touch. For MQL, the same
// effective stage-activity date used by the grid determines the period.
// Undated same-channel touches surface in their own group (they are excluded
// from period counts by rule and must never disappear silently).

import { useMemo } from 'react';
import type { Channel, Lead, LeadCampaignTouchRow } from '../../types/db';
import type { RegionKey } from '../../constants/regions';
import type { PeriodFilter } from '../../lib/compute';
import { computeTouchDrilldown } from '../../lib/touchDrilldown';
import type { TouchDrilldownEntry } from '../../lib/touchDrilldown';

interface TouchDrilldownPanelProps {
  stage: 'lead' | 'mql';
  channelLabel: string;
  channelIds: string[];
  touches: LeadCampaignTouchRow[];
  leads: Lead[];
  channels: Channel[];
  year: number;
  filter: PeriodFilter;
  regions?: Set<RegionKey>;
  onClose: () => void;
}

function sourceBadge(source: LeadCampaignTouchRow['source']) {
  const isSeed = source === 'backfill';
  return (
    <span
      className={
        'inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ' +
        (isSeed ? 'bg-warning/15 text-warning' : 'bg-indigo/10 text-indigo')
      }
      title={
        isSeed
          ? 'Preserved historical seed (primary source, no campaign identity)'
          : `Recorded by ${source}`
      }
    >
      {isSeed ? 'seed' : source}
    </span>
  );
}

export default function TouchDrilldownPanel({
  stage,
  channelLabel,
  channelIds,
  touches,
  leads,
  channels,
  year,
  filter,
  regions,
  onClose,
}: TouchDrilldownPanelProps) {
  const channelName = useMemo(() => {
    const byId = new Map(channels.map((c) => [c.id, c.name] as const));
    return (id: string) => byId.get(id) ?? 'Unknown channel';
  }, [channels]);

  const drilldown = useMemo(
    () =>
      computeTouchDrilldown({
        touches,
        leads,
        channelIds: new Set(channelIds),
        stage,
        year,
        filter,
        regions,
      }),
    [touches, leads, channelIds, stage, year, filter, regions],
  );

  const periodLabel = filter === 'year' ? String(year) : `${filter} ${year}`;

  const rows = (entries: TouchDrilldownEntry[]) => (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-slate-muted border-b border-border">
          {stage === 'mql' && <th className="py-1 pr-2 font-medium">MQL activity date</th>}
          <th className="py-1 pr-2 font-medium">Touch date</th>
          <th className="py-1 pr-2 font-medium">Channel</th>
          <th className="py-1 pr-2 font-medium">Account</th>
          <th className="py-1 pr-2 font-medium">Provenance</th>
          <th className="py-1 font-medium">Source</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e, i) => (
          <tr key={`${e.touchId}-${e.mqlActivityDate ?? i}`} className="border-b border-border last:border-b-0">
            {stage === 'mql' && (
              <td className="py-1 pr-2 tabular-nums">{e.mqlActivityDate ?? ''}</td>
            )}
            <td className="py-1 pr-2 tabular-nums">
              {e.touchDate ?? <span className="text-warning">undated</span>}
            </td>
            <td className="py-1 pr-2">{channelName(e.channelId)}</td>
            <td className="py-1 pr-2">{e.account ?? ''}</td>
            <td className="py-1 pr-2 text-slate-muted">
              {[e.parentCampaign, e.subCampaign].filter(Boolean).join(' / ')}
            </td>
            <td className="py-1">{sourceBadge(e.source)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-charcoal/30" onClick={onClose} />
      <div className="relative w-full max-w-2xl h-full bg-bg border-l border-border shadow-sm overflow-y-auto p-5 space-y-4">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-charcoal">
              {stage === 'lead' ? 'Lead memberships' : 'MQL memberships'}: {channelLabel}
            </h2>
            <p className="text-xs text-slate-muted mt-0.5">
              {periodLabel} · {drilldown.counted.length} counted{' '}
              {stage === 'lead'
                ? 'touches (one row per membership; a contact in several campaigns appears once per touch)'
                : 'memberships (a transition counts when observed; an already-MQL baseline stays with its touch date)'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-2 py-1 rounded border border-border text-charcoal hover:border-charcoal/30"
          >
            Close
          </button>
        </header>

        {drilldown.counted.length === 0 ? (
          <p className="text-sm text-slate-muted italic">
            No touches count in this cell for {periodLabel}.
          </p>
        ) : (
          rows(drilldown.counted)
        )}

        {drilldown.undated.length > 0 && (
          <section className="space-y-1">
            <h3 className="text-xs font-medium text-charcoal">
              Undated touches on this channel ({drilldown.undated.length})
            </h3>
            <p className="text-xs text-slate-muted">
              Excluded from period counts because they have no touch date;
              listed here so they are never silently dropped.
            </p>
            {rows(drilldown.undated)}
          </section>
        )}
      </div>
    </div>
  );
}
