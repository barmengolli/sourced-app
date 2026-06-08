// YearLeadCharts — three side-by-side cards on the Leads & MQLs tab.
// Always spans all 12 months of the input year regardless of the
// page's quarter selector; respects the region filter (via the
// already-filtered MonthlyLeadsForYear that the caller computes).
//
// LEFT and RIGHT cards share a single multi-select channel state
// (lifted here). The user picks any combination of (year, channel)
// pairs from a checkbox dropdown rendered above the LEFT card:
//
//   - LEFT  ("Total Leads per Year by Channel"): one bar per
//     selected channel, total leads for that channel on Y axis,
//     channel name on X.
//   - RIGHT ("Leads by Channel per Month"): grouped bars per month,
//     one Bar per selected channel id.
//
// Channels are year-scoped in the data model: the 2025 "Sales" row
// and the 2026 "Sales" row are distinct rows with distinct ids.
// channels.name now contains the year prefix ("2025 - Sales"), so
// every (year, channel) pair is an addressable entity by name.
// MIDDLE card ("Total Leads per Month") is unchanged: current-year
// bars with optional prior-year YoY overlay.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_COLORS, CHART_PALETTE } from '../../constants/chartColors';
import type {
  MonthlyChannelLeads,
  MonthlyLeadsForYear,
} from '../../lib/compute';
import ChartCard from './ChartCard';

interface YearLeadChartsProps {
  data: MonthlyLeadsForYear;
  year: number;
  // YoY overlay for the MIDDLE card only. When both are provided,
  // render a second muted bar per month for the prior year and add
  // a legend.
  priorYearTotals?: number[];
  priorYear?: number;
  // Per-channel prior-year breakdown. The shared multi-select
  // dropdown lists the UNION of current and prior channels (e.g.
  // both "2025 - Events" and "2026 - Events"), and the LEFT and
  // RIGHT cards read each selected channel's perMonth array from
  // whichever side carries it.
  priorYearByChannel?: MonthlyChannelLeads[];
}

const MONTH_AXIS_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function sumPerMonth(perMonth: number[]): number {
  return perMonth.reduce((a, b) => a + (b ?? 0), 0);
}

export default function YearLeadCharts({
  data,
  year,
  priorYearTotals,
  priorYear,
  priorYearByChannel,
}: YearLeadChartsProps) {
  const hasPriorYear =
    Array.isArray(priorYearTotals) && typeof priorYear === 'number';

  // Union of channels across current and prior years, keyed by
  // channel ID. Every distinct (year, channel) pair is its own
  // entry — the year prefix in channelName makes them visually
  // distinct in the dropdown ("2025 - Events" vs "2026 - Events").
  // Current-year totals desc, then prior-year totals desc as
  // tiebreaker so the busiest items surface first.
  const mergedChannels = useMemo(() => {
    interface Entry {
      channelId: string;
      channelName: string;
      perMonth: number[];
      total: number;
      // True when this entry came from the current-year (data.byChannel)
      // side; used to sort prior-only channels after current ones.
      isCurrent: boolean;
    }
    const out: Entry[] = [];
    const seen = new Set<string>();
    for (const c of data.byChannel) {
      if (seen.has(c.channelId)) continue;
      seen.add(c.channelId);
      out.push({
        channelId: c.channelId,
        channelName: c.channelName,
        perMonth: c.perMonth,
        total: sumPerMonth(c.perMonth),
        isCurrent: true,
      });
    }
    if (Array.isArray(priorYearByChannel)) {
      for (const c of priorYearByChannel) {
        if (seen.has(c.channelId)) continue;
        seen.add(c.channelId);
        out.push({
          channelId: c.channelId,
          channelName: c.channelName,
          perMonth: c.perMonth,
          total: sumPerMonth(c.perMonth),
          isCurrent: false,
        });
      }
    }
    out.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.isCurrent) return b.total - a.total;
      return a.channelName.localeCompare(b.channelName);
    });
    return out;
  }, [data.byChannel, priorYearByChannel]);

  // Stable color per channel id across both cards (acceptance #4).
  const colorById = useMemo(() => {
    const m = new Map<string, string>();
    mergedChannels.forEach((c, idx) => {
      m.set(c.channelId, CHART_PALETTE[idx % CHART_PALETTE.length]);
    });
    return m;
  }, [mergedChannels]);

  // Default: top 2 channels by current-year total. If fewer than 2
  // current-year channels exist, fall back to "everything available".
  const channelKey = useMemo(
    () => mergedChannels.map((c) => c.channelId).join('|'),
    [mergedChannels],
  );
  const computeDefault = (): Set<string> => {
    const currentOnly = mergedChannels.filter((c) => c.isCurrent);
    const ranked =
      currentOnly.length >= 2
        ? [...currentOnly].sort((a, b) => b.total - a.total).slice(0, 2)
        : mergedChannels;
    return new Set(ranked.map((c) => c.channelId));
  };
  const [selectedChannelIds, setSelectedChannelIds] = useState<Set<string>>(
    () => computeDefault(),
  );
  // Re-anchor selection to the new default whenever the union
  // changes AND every previously-selected id has fallen out (e.g.
  // year switch with completely different channel set). When only a
  // subset of the user's selections falls out, prune in place — the
  // user keeps any selection that's still valid.
  useEffect(() => {
    const valid = new Set(mergedChannels.map((c) => c.channelId));
    let dropped = false;
    const pruned = new Set<string>();
    for (const id of selectedChannelIds) {
      if (valid.has(id)) pruned.add(id);
      else dropped = true;
    }
    if (pruned.size === 0 && mergedChannels.length > 0) {
      setSelectedChannelIds(computeDefault());
    } else if (dropped) {
      setSelectedChannelIds(pruned);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelKey]);

  // Channels selected for rendering, in the same sort order as the
  // dropdown so colors and bar order match across both cards.
  const selectedChannels = useMemo(
    () => mergedChannels.filter((c) => selectedChannelIds.has(c.channelId)),
    [mergedChannels, selectedChannelIds],
  );

  // Per-month rows for the RIGHT card. One key per selected channel
  // id so Recharts renders one Bar series per channel, grouped side
  // by side per month (no stackId).
  const monthlyRows = useMemo(() => {
    return MONTH_AXIS_LABELS.map((label, i) => {
      const row: Record<string, string | number> = { month: label };
      for (const c of selectedChannels) {
        row[c.channelId] = c.perMonth[i] ?? 0;
      }
      return row;
    });
  }, [selectedChannels]);

  // Per-channel totals for the LEFT card.
  const totalsByChannel = useMemo(() => {
    return selectedChannels.map((c) => ({
      channelId: c.channelId,
      channelName: c.channelName,
      total: c.total,
    }));
  }, [selectedChannels]);

  const totalsData = useMemo(() => {
    return MONTH_AXIS_LABELS.map((label, i) => ({
      month: label,
      total: data.monthTotals[i] ?? 0,
      priorTotal: hasPriorYear ? priorYearTotals?.[i] ?? 0 : 0,
    }));
  }, [data, hasPriorYear, priorYearTotals]);

  const subtitle = `All ${year} months. Region filter applies.`;
  const totalsSubtitle = hasPriorYear
    ? `All ${year} months vs ${priorYear}. ${priorYear} may reflect spread quarterly actuals. Region filter applies.`
    : subtitle;
  const channelCountSubtitle = `${selectedChannels.length} channel${selectedChannels.length === 1 ? '' : 's'} selected. Region filter applies.`;
  const hasAnyData = data.byChannel.length > 0 || (priorYearByChannel?.length ?? 0) > 0;
  const currentYearKey = String(year);
  const priorYearKey = hasPriorYear ? String(priorYear) : '';

  const toggleChannel = (id: string) => {
    setSelectedChannelIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAll = () =>
    setSelectedChannelIds(new Set(mergedChannels.map((c) => c.channelId)));
  const clearAll = () => setSelectedChannelIds(new Set());

  return (
    <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <ChartCard
        title="Total Leads per Year by Channel"
        subtitle={channelCountSubtitle}
      >
        {hasAnyData ? (
          <div className="space-y-2">
            <ChannelMultiSelect
              channels={mergedChannels}
              selectedIds={selectedChannelIds}
              colorOf={(id) => colorById.get(id) ?? CHART_PALETTE[0]}
              onToggle={toggleChannel}
              onSelectAll={selectAll}
              onClear={clearAll}
            />
            {selectedChannels.length === 0 ? (
              <p className="text-xs text-slate-muted italic h-[240px] flex items-center justify-center">
                Select channels from the dropdown to see totals.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart
                  data={totalsByChannel}
                  margin={{ top: 16, right: 12, left: 0, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke={CHART_COLORS.border}
                  />
                  <XAxis
                    dataKey="channelName"
                    tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
                    axisLine={{ stroke: CHART_COLORS.border }}
                    tickLine={{ stroke: CHART_COLORS.border }}
                    interval={0}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
                    axisLine={{ stroke: CHART_COLORS.border }}
                    tickLine={{ stroke: CHART_COLORS.border }}
                    tickFormatter={(v) =>
                      typeof v === 'number' ? v.toLocaleString() : String(v)
                    }
                    width={48}
                    allowDecimals={false}
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
                      const n = typeof v === 'number' ? v : Number(v);
                      return Number.isFinite(n)
                        ? n.toLocaleString()
                        : String(v);
                    }}
                  />
                  <Bar
                    dataKey="total"
                    radius={[3, 3, 0, 0]}
                    isAnimationActive={false}
                    label={{
                      position: 'top',
                      fill: CHART_COLORS.charcoal,
                      fontSize: 11,
                      formatter: (v) => {
                        const n = typeof v === 'number' ? v : Number(v);
                        return Number.isFinite(n) && n !== 0
                          ? n.toLocaleString()
                          : '';
                      },
                    }}
                  >
                    {totalsByChannel.map((row) => (
                      <Cell
                        key={row.channelId}
                        fill={colorById.get(row.channelId) ?? CHART_PALETTE[0]}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        ) : (
          <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
            No leads in {year} matching the region filter.
          </p>
        )}
      </ChartCard>

      <ChartCard title="Total Leads per Month" subtitle={totalsSubtitle}>
        {data.byChannel.length > 0 ? (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart
              data={totalsData}
              margin={{ top: 16, right: 12, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.border} />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
                axisLine={{ stroke: CHART_COLORS.border }}
                tickLine={{ stroke: CHART_COLORS.border }}
              />
              <YAxis
                tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
                axisLine={{ stroke: CHART_COLORS.border }}
                tickLine={{ stroke: CHART_COLORS.border }}
                tickFormatter={(v) =>
                  typeof v === 'number' ? v.toLocaleString() : String(v)
                }
                width={48}
                allowDecimals={false}
              />
              {hasPriorYear ? (
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
                  content={
                    <YoYTooltip
                      currentYearKey={currentYearKey}
                      priorYearKey={priorYearKey}
                    />
                  }
                />
              ) : (
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
                    const n = typeof v === 'number' ? v : Number(v);
                    return Number.isFinite(n) ? n.toLocaleString() : String(v);
                  }}
                />
              )}
              {hasPriorYear && <Legend wrapperStyle={{ fontSize: 11 }} />}
              <Bar
                dataKey="total"
                name={currentYearKey}
                fill={CHART_COLORS.indigo}
                radius={[3, 3, 0, 0]}
                label={{
                  position: 'top',
                  fill: CHART_COLORS.charcoal,
                  fontSize: 11,
                  formatter: (v) => {
                    const n = typeof v === 'number' ? v : Number(v);
                    return Number.isFinite(n) && n !== 0
                      ? n.toLocaleString()
                      : '';
                  },
                }}
              />
              {hasPriorYear && (
                <Bar
                  dataKey="priorTotal"
                  name={priorYearKey}
                  fill={CHART_COLORS.slateMuted}
                  radius={[3, 3, 0, 0]}
                />
              )}
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
            No leads in {year} matching the region filter.
          </p>
        )}
      </ChartCard>

      <ChartCard
        title="Leads by Channel per Month"
        subtitle={channelCountSubtitle}
      >
        {hasAnyData ? (
          <div className="space-y-2">
            <ChannelSelectionSummary
              selectedCount={selectedChannels.length}
              totalCount={mergedChannels.length}
            />
            {selectedChannels.length === 0 ? (
              <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
                Select channels from the dropdown on the left card.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart
                  data={monthlyRows}
                  margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                  barCategoryGap="20%"
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke={CHART_COLORS.border}
                  />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
                    axisLine={{ stroke: CHART_COLORS.border }}
                    tickLine={{ stroke: CHART_COLORS.border }}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
                    axisLine={{ stroke: CHART_COLORS.border }}
                    tickLine={{ stroke: CHART_COLORS.border }}
                    tickFormatter={(v) =>
                      typeof v === 'number' ? v.toLocaleString() : String(v)
                    }
                    width={48}
                    allowDecimals={false}
                  />
                  <Tooltip
                    cursor={{ fill: CHART_COLORS.border, fillOpacity: 0.2 }}
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
                      const n = typeof v === 'number' ? v : Number(v);
                      return Number.isFinite(n)
                        ? n.toLocaleString()
                        : String(v);
                    }}
                  />
                  {selectedChannels.map((c) => (
                    <Bar
                      key={c.channelId}
                      dataKey={c.channelId}
                      name={c.channelName}
                      fill={colorById.get(c.channelId) ?? CHART_PALETTE[0]}
                      radius={[3, 3, 0, 0]}
                      isAnimationActive={false}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        ) : (
          <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
            No leads in {year} matching the region filter.
          </p>
        )}
      </ChartCard>
    </section>
  );
}

// ---------- ChannelMultiSelect: checkbox dropdown ----------
//
// Button + popover with one checkbox per channel. Sorted by the
// caller (current-year total desc, prior-only alphabetical after).
// Selections apply immediately as the user clicks; the popover
// stays open so the user can toggle multiple channels in one go.

interface ChannelOption {
  channelId: string;
  channelName: string;
}

function ChannelMultiSelect({
  channels,
  selectedIds,
  colorOf,
  onToggle,
  onSelectAll,
  onClear,
}: {
  channels: ChannelOption[];
  selectedIds: Set<string>;
  colorOf: (id: string) => string;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const empty = channels.length === 0;

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const node = containerRef.current;
      if (node && e.target instanceof Node && !node.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          if (empty) return;
          setOpen((v) => !v);
        }}
        disabled={empty}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={
          'text-xs px-2 py-1 rounded border inline-flex items-center gap-1 ' +
          (empty
            ? 'bg-bg text-slate-muted/60 border-border/60 cursor-not-allowed'
            : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
        }
      >
        <span>Channels ({selectedIds.size} selected)</span>
        <span className="text-[10px] leading-none">▾</span>
      </button>
      {open && !empty && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="absolute top-full left-0 mt-1 z-10 min-w-[14rem] max-h-72 overflow-y-auto bg-bg border border-border rounded shadow-sm"
        >
          <div className="sticky top-0 flex items-center justify-between px-2 py-1 border-b border-border bg-bg">
            <button
              type="button"
              onClick={onSelectAll}
              className="text-xs text-indigo hover:underline"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={onClear}
              className="text-xs text-slate-muted hover:text-charcoal"
            >
              Clear
            </button>
          </div>
          <ul className="py-1">
            {channels.map((c) => {
              const checked = selectedIds.has(c.channelId);
              const color = colorOf(c.channelId);
              return (
                <li key={c.channelId}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={checked}
                    onClick={() => onToggle(c.channelId)}
                    className="w-full flex items-center gap-2 px-2 py-1 text-xs text-charcoal hover:bg-muted text-left"
                  >
                    <span
                      aria-hidden
                      className={
                        'inline-flex items-center justify-center w-3.5 h-3.5 rounded border ' +
                        (checked
                          ? 'border-transparent text-white'
                          : 'bg-bg border-border')
                      }
                      style={
                        checked
                          ? { backgroundColor: color, borderColor: color }
                          : undefined
                      }
                    >
                      {checked ? '✓' : ''}
                    </span>
                    <span className="flex-1 truncate">{c.channelName}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// Read-only summary above the RIGHT card. Points the user at the
// left card's dropdown rather than rendering a second control,
// keeping channel selection state single-sourced.
function ChannelSelectionSummary({
  selectedCount,
  totalCount,
}: {
  selectedCount: number;
  totalCount: number;
}) {
  return (
    <p className="text-xs text-slate-muted">
      Showing {selectedCount} of {totalCount} channels. Edit the selection
      on the left card.
    </p>
  );
}

// ---------- Custom tooltip for the MIDDLE card ----------
//
// Shows current, prior, and the delta (current minus prior) for the
// hovered month. Number formatting matches the rest of the card
// (toLocaleString, integers).
interface YoYTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: ReadonlyArray<{ dataKey?: string; value?: number | string }>;
  currentYearKey: string;
  priorYearKey: string;
}

function YoYTooltip({
  active,
  label,
  payload,
  currentYearKey,
  priorYearKey,
}: YoYTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const current = Number(
    payload.find((p) => p.dataKey === 'total')?.value ?? 0,
  );
  const prior = Number(
    payload.find((p) => p.dataKey === 'priorTotal')?.value ?? 0,
  );
  const delta = current - prior;
  const fmt = (n: number) =>
    Number.isFinite(n) ? n.toLocaleString() : String(n);
  const deltaSign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  const deltaColor =
    delta > 0
      ? CHART_COLORS.success
      : delta < 0
        ? CHART_COLORS.danger
        : CHART_COLORS.slateMuted;
  return (
    <div
      style={{
        fontSize: 11,
        border: `1px solid ${CHART_COLORS.border}`,
        borderRadius: 6,
        background: '#fff',
        padding: '6px 8px',
        minWidth: 120,
      }}
    >
      <div
        style={{ color: CHART_COLORS.charcoal, fontWeight: 600, marginBottom: 4 }}
      >
        {String(label ?? '')}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ color: CHART_COLORS.indigo }}>{currentYearKey}</span>
        <span style={{ color: CHART_COLORS.charcoal }}>{fmt(current)}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ color: CHART_COLORS.slateMuted }}>{priorYearKey}</span>
        <span style={{ color: CHART_COLORS.charcoal }}>{fmt(prior)}</span>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12,
          borderTop: `1px solid ${CHART_COLORS.border}`,
          marginTop: 4,
          paddingTop: 4,
        }}
      >
        <span style={{ color: CHART_COLORS.slateMuted }}>YoY</span>
        <span style={{ color: deltaColor, fontWeight: 600 }}>
          {deltaSign}
          {fmt(Math.abs(delta))}
        </span>
      </div>
    </div>
  );
}
