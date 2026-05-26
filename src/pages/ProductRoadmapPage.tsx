import {
  ROADMAP_ITEMS,
  ROADMAP_RANGE,
  PHASE_ORDER,
  PHASE_COLORS,
  type RoadmapItem,
  type RoadmapPhase,
  type RoadmapStatus,
} from '../constants/roadmap';

// ---------- Timeline math helpers ----------

// Local-day parse (not UTC) so a 2026-05-21 date doesn't kick to
// 2026-05-20 in negative-offset timezones. Same pitfall guarded
// against in lib/dates.ts elsewhere in the codebase.
function parseIsoLocal(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const RANGE_START = parseIsoLocal(ROADMAP_RANGE.start);
const RANGE_END = parseIsoLocal(ROADMAP_RANGE.end);
const RANGE_TOTAL_MS = RANGE_END.getTime() - RANGE_START.getTime();

function isoToPercent(iso: string): number {
  const d = parseIsoLocal(iso);
  const clamped = Math.max(
    RANGE_START.getTime(),
    Math.min(RANGE_END.getTime(), d.getTime()),
  );
  return ((clamped - RANGE_START.getTime()) / RANGE_TOTAL_MS) * 100;
}

// Month boundaries inside the range. Drives the timeline header
// labels and the faint vertical gridlines on every bar row.
function monthMarkers() {
  const out: { label: string; startPercent: number }[] = [];
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short' });
  const cursor = new Date(RANGE_START.getFullYear(), RANGE_START.getMonth(), 1);
  while (cursor <= RANGE_END) {
    out.push({
      label: fmt(cursor),
      startPercent:
        ((cursor.getTime() - RANGE_START.getTime()) / RANGE_TOTAL_MS) * 100,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return out;
}

const TODAY_ISO = new Date().toISOString().slice(0, 10);

const STATUS_LABEL: Record<RoadmapStatus, string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  shipped: 'Shipped',
};

// ---------- Component ----------

export default function ProductRoadmapPage() {
  const grouped: Record<RoadmapPhase, RoadmapItem[]> = {
    Foundation: [],
    Integrations: [],
    'Channel Tabs': [],
    'Product Marketing': [],
    'Unified Campaign': [],
    Productization: [],
  };
  for (const item of ROADMAP_ITEMS) grouped[item.phase].push(item);

  const totals = {
    total: ROADMAP_ITEMS.length,
    shipped: ROADMAP_ITEMS.filter((i) => i.status === 'shipped').length,
    inProgress: ROADMAP_ITEMS.filter((i) => i.status === 'in-progress').length,
  };

  const months = monthMarkers();
  const today = parseIsoLocal(TODAY_ISO);
  const todayInRange =
    today.getTime() >= RANGE_START.getTime() &&
    today.getTime() <= RANGE_END.getTime();

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <header>
        <h1 className="text-2xl font-semibold text-charcoal">
          Product Roadmap
        </h1>
        <p className="mt-1 text-sm text-slate-muted">
          Where Sourced is going, on a timeline. {totals.shipped} of{' '}
          {totals.total} shipped, {totals.inProgress} in progress.
        </p>
      </header>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-slate-muted">Phases:</span>
        {PHASE_ORDER.map((p) => (
          <span key={p} className="flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm"
              style={{ backgroundColor: PHASE_COLORS[p].dark }}
            />
            <span className="text-charcoal">{p}</span>
          </span>
        ))}
        <span className="text-slate-muted ml-4">Status:</span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-1.5 rounded-sm bg-success" />
          <span className="text-charcoal">Shipped</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-1.5 rounded-sm bg-warning" />
          <span className="text-charcoal">In progress</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-1.5 rounded-sm bg-slate-muted/30 border border-slate-muted/50" />
          <span className="text-charcoal">Not started</span>
        </span>
      </div>

      {/* Gantt */}
      <div className="border border-border rounded-lg bg-bg overflow-x-auto">
        <div className="min-w-[900px]">
          {/* Header row: month labels */}
          <div
            className="grid border-b border-border"
            style={{ gridTemplateColumns: '260px 1fr' }}
          >
            <div className="px-3 py-2 text-xs font-medium text-slate-muted">
              Deliverable
            </div>
            <div className="relative h-8">
              {months.map((m, i) => (
                <div
                  key={i}
                  className="absolute top-0 bottom-0 border-l border-border flex items-center pl-1"
                  style={{ left: `${m.startPercent}%` }}
                >
                  <span className="text-xs font-medium text-charcoal">
                    {m.label}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Phase sections */}
          {PHASE_ORDER.map((phase) => {
            const items = grouped[phase];
            if (items.length === 0) return null;
            const color = PHASE_COLORS[phase];
            return (
              <div key={phase}>
                {/* Phase header */}
                <div
                  className="grid bg-muted/40 border-b border-border"
                  style={{ gridTemplateColumns: '260px 1fr' }}
                >
                  <div className="px-3 py-1.5 flex items-center gap-2">
                    <span
                      className="inline-block w-2 h-2 rounded-sm"
                      style={{ backgroundColor: color.dark }}
                    />
                    <h2 className="text-sm font-semibold text-charcoal">
                      {phase}
                    </h2>
                    <span className="text-xs text-slate-muted">
                      ({items.length})
                    </span>
                  </div>
                  <div></div>
                </div>

                {/* Item rows */}
                {items.map((item, i) => {
                  const startPct = isoToPercent(item.startDate);
                  const endPct = isoToPercent(item.endDate);
                  // Solid fill for shipped + in-progress; light fill
                  // with the phase's border color for not-started so
                  // future work reads at a glance.
                  const solid =
                    item.status === 'shipped' || item.status === 'in-progress';
                  const tooltip =
                    `${item.name} — ${item.startDate} to ${item.endDate}` +
                    ` — ${STATUS_LABEL[item.status]}\n${item.outcome}`;
                  return (
                    <div
                      key={`${phase}-${i}`}
                      className="grid border-b border-border last:border-b-0 hover:bg-muted/30 transition-colors"
                      style={{ gridTemplateColumns: '260px 1fr' }}
                    >
                      {/* Label cell */}
                      <div className="px-3 py-2 min-w-0">
                        <div
                          className="text-xs font-medium text-charcoal truncate"
                          title={item.name}
                        >
                          {item.name}
                        </div>
                        <div
                          className="text-[11px] text-slate-muted truncate"
                          title={item.outcome}
                        >
                          {item.owner}
                        </div>
                      </div>

                      {/* Bar cell */}
                      <div className="relative h-12">
                        {/* Faint vertical month gridlines for orientation */}
                        {months.map((m, j) => (
                          <div
                            key={j}
                            className="absolute top-0 bottom-0 border-l border-border/40"
                            style={{ left: `${m.startPercent}%` }}
                          />
                        ))}

                        {/* The bar */}
                        <div
                          className="absolute top-1/2 -translate-y-1/2 h-5 rounded flex items-center justify-end pr-1.5"
                          style={{
                            left: `${startPct}%`,
                            width: `${Math.max(endPct - startPct, 0.5)}%`,
                            backgroundColor: solid ? color.dark : color.light,
                            border: `1px solid ${color.dark}`,
                          }}
                          title={tooltip}
                        >
                          {item.status === 'shipped' && (
                            <span className="text-[10px] text-white">✓</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Today reference. The vertical-line overlay variant requires
          anchoring inside the bar column's local layout; the footnote
          is the safe v1 fallback the spec explicitly allows. */}
      {todayInRange && (
        <p className="text-xs text-slate-muted">
          Today is{' '}
          {today.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
          .
        </p>
      )}

      <footer className="text-xs text-slate-muted italic pt-4 border-t border-border">
        Statuses are updated by hand in <code>src/constants/roadmap.ts</code>.
        The companion timeline file (Marketing Reporting Roadmap.xlsx)
        and the Monday.com board are the project-management surfaces;
        this page is the public headline view.
      </footer>
    </div>
  );
}
