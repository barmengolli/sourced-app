// Compact, labeled annotation for quarterly lead backfill that is intentionally
// NOT plotted on the monthly chart (M4 fix). Each line is a count, never a
// currency value, and is never rendered as a bar, point, or reference line.
//
// Example line: "Q1 Lead actual: 30 (quarterly backfill)".

import type { QuarterlyLeadFallback } from '../../lib/compute';

export default function QuarterlyBackfillNote({
  fallback,
}: {
  fallback: QuarterlyLeadFallback[];
}) {
  if (fallback.length === 0) return null;

  // Group by channel so a channel with backfill in several quarters reads as
  // one line per channel.
  const byChannel = new Map<string, QuarterlyLeadFallback[]>();
  for (const f of fallback) {
    const arr = byChannel.get(f.channelName) ?? [];
    arr.push(f);
    byChannel.set(f.channelName, arr);
  }

  return (
    <div
      className="mb-2 rounded border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-slate-muted"
      data-testid="quarterly-backfill-note"
    >
      <p className="font-medium text-charcoal">
        Quarterly backfill (not shown as monthly bars)
      </p>
      <ul className="mt-1 space-y-0.5">
        {[...byChannel.entries()].map(([channelName, items]) => (
          <li key={channelName}>
            {channelName}:{' '}
            {items
              .slice()
              .sort((a, b) => a.quarter - b.quarter)
              .map(
                (f) => `Q${f.quarter} Lead actual: ${f.value} (quarterly backfill)`,
              )
              .join(', ')}
          </li>
        ))}
      </ul>
    </div>
  );
}
