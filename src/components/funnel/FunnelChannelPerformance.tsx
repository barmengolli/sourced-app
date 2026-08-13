import { useMemo, useState } from 'react';
import { FUNNEL_STAGE_LABELS, type FunnelStageKey } from '../../constants/funnelStages';
import type { ComputedRow } from '../../lib/compute';
import type { Channel } from '../../types/db';

interface FunnelChannelPerformanceProps {
  rows: ComputedRow[];
  channels: Channel[];
  embedded?: boolean;
}

const STAGES: FunnelStageKey[] = ['lead', 'mql', 'hpp', 'opp', 'pursuit'];
const DEFAULT_VISIBLE_ROWS = 6;

function display(value: number | null): string {
  return value === null ? '—' : value.toLocaleString();
}

export default function FunnelChannelPerformance({
  rows,
  channels,
  embedded = false,
}: FunnelChannelPerformanceProps) {
  const [showAll, setShowAll] = useState(false);
  const channelById = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel] as const)),
    [channels],
  );
  const rankedRows = useMemo(
    () => rows
      .filter((row) => row.depth === 1)
      .filter((row) => STAGES.some((stage) => (row.cells[stage].actual ?? 0) > 0))
      .slice()
      .sort((a, b) => {
        const leadDifference = (b.cells.lead.actual ?? 0) - (a.cells.lead.actual ?? 0);
        if (leadDifference !== 0) return leadDifference;
        return (channelById.get(a.channelId)?.name ?? '')
          .localeCompare(channelById.get(b.channelId)?.name ?? '');
      }),
    [rows, channelById],
  );
  const visibleRows = showAll ? rankedRows : rankedRows.slice(0, DEFAULT_VISIBLE_ROWS);

  return (
    <section className={embedded ? 'border-t border-border pt-4' : 'rounded-xl border border-border bg-bg shadow-sm'}>
      <header className={`flex flex-wrap items-start justify-between gap-3 ${embedded ? 'pb-4' : 'border-b border-border px-4 py-4 sm:px-5'}`}>
        <div>
          <h3 className="text-sm font-semibold text-charcoal">Channel performance</h3>
          <p className="mt-1 text-xs text-slate-muted">Parent channels ranked by Lead volume for the selected period.</p>
        </div>
        {rankedRows.length > DEFAULT_VISIBLE_ROWS && (
          <button
            type="button"
            onClick={() => setShowAll((value) => !value)}
            className="rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs font-medium text-charcoal transition hover:border-indigo/40 hover:text-indigo"
          >
            {showAll ? 'Show top channels' : `Show all ${rankedRows.length}`}
          </button>
        )}
      </header>

      {visibleRows.length === 0 ? (
        <p className="flex h-36 items-center justify-center text-xs italic text-slate-muted">No channel activity for this period.</p>
      ) : (
        <div className={`overflow-x-auto ${embedded ? 'rounded-xl border border-border' : ''}`}>
          <table className="w-full min-w-[42rem] border-collapse text-xs">
            <thead>
              <tr className="bg-muted/45 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-muted">
                <th className="px-4 py-2.5 sm:px-5">Channel</th>
                {STAGES.map((stage) => (
                  <th key={stage} className="px-3 py-2.5 text-right">{FUNNEL_STAGE_LABELS[stage]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.channelId} className="border-t border-border/70">
                  <th scope="row" className="px-4 py-3 text-left font-medium text-charcoal sm:px-5">
                    {channelById.get(row.channelId)?.name ?? 'Unknown channel'}
                  </th>
                  {STAGES.map((stage) => (
                    <td key={stage} className="px-3 py-3 text-right tabular-nums text-charcoal">
                      {display(row.cells[stage].actual)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
