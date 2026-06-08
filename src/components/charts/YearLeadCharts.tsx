// YearLeadCharts — two side-by-side bar charts for the Leads & MQLs
// tab. Always spans all 12 months of the input year regardless of
// the page's quarter selector; respects the region filter (via the
// already-filtered MonthlyLeadsForYear that the caller computes).
//
// Left card stacks leads by top-level channel per month. Right card
// shows the per-month total with inline value labels above each bar.

import { useEffect, useMemo, useState } from 'react';
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
  // Optional YoY overlay for the Total Leads per Month card. When
  // both are provided, render a second muted bar per month for the
  // prior year and add a legend. When omitted, the totals card
  // renders exactly as before (single current-year series, no legend).
  priorYearTotals?: number[];
  priorYear?: number;
  // Optional per-channel prior-year breakdown, same shape as
  // data.byChannel. When both this and priorYear are provided, the
  // Leads by Channel chart renders prior-year and current-year
  // stacks side by side per month with shared channel colors.
  priorYearByChannel?: MonthlyChannelLeads[];
}

const MONTH_AXIS_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export default function YearLeadCharts({
  data,
  year,
  priorYearTotals,
  priorYear,
  priorYearByChannel,
}: YearLeadChartsProps) {
  const hasPriorYear =
    Array.isArray(priorYearTotals) && typeof priorYear === 'number';
  const hasPriorYearChannels =
    typeof priorYear === 'number' &&
    Array.isArray(priorYearByChannel) &&
    priorYearByChannel.length > 0;
  // Union of channels across current and prior years, KEYED BY NAME
  // (case-insensitive). Channels are year-scoped in the data model:
  // "Content Syndication" has a distinct row per year, so keying by
  // channel id would duplicate every name in the dropdown. We dedupe
  // by name and carry both ids so the chart can read each year's
  // perMonth array from the right source.
  //
  // Display name uses whichever side has data first; current year
  // wins when both exist so the dropdown reads "Content Syndication"
  // exactly as it does in the rest of the current-year UI.
  const mergedChannels = useMemo(() => {
    const map = new Map<
      string,
      {
        nameKey: string;
        channelName: string;
        currentChannelId: string | null;
        priorChannelId: string | null;
        current: number[];
        prior: number[];
        currentTotal: number;
      }
    >();
    const keyOf = (name: string) => name.trim().toLowerCase();
    for (const c of data.byChannel) {
      const k = keyOf(c.channelName);
      const existing = map.get(k);
      if (existing) {
        existing.currentChannelId = c.channelId;
        existing.current = c.perMonth;
        existing.currentTotal = c.perMonth.reduce((a, b) => a + (b ?? 0), 0);
      } else {
        map.set(k, {
          nameKey: k,
          channelName: c.channelName,
          currentChannelId: c.channelId,
          priorChannelId: null,
          current: c.perMonth,
          prior: new Array(12).fill(0),
          currentTotal: c.perMonth.reduce((a, b) => a + (b ?? 0), 0),
        });
      }
    }
    if (hasPriorYearChannels) {
      for (const c of priorYearByChannel!) {
        const k = keyOf(c.channelName);
        const existing = map.get(k);
        if (existing) {
          existing.priorChannelId = c.channelId;
          existing.prior = c.perMonth;
        } else {
          map.set(k, {
            nameKey: k,
            channelName: c.channelName,
            currentChannelId: null,
            priorChannelId: c.channelId,
            current: new Array(12).fill(0),
            prior: c.perMonth,
            currentTotal: 0,
          });
        }
      }
    }
    // Current-year total desc, then prior-year total desc as
    // tiebreaker so prior-only channels keep a stable position.
    return [...map.values()].sort((a, b) => {
      if (b.currentTotal !== a.currentTotal) {
        return b.currentTotal - a.currentTotal;
      }
      const ap = a.prior.reduce((x, y) => x + (y ?? 0), 0);
      const bp = b.prior.reduce((x, y) => x + (y ?? 0), 0);
      return bp - ap;
    });
  }, [data.byChannel, priorYearByChannel, hasPriorYearChannels]);

  // Channel filter: required single-select. The option value is the
  // channel NAME (deduped, lowercased nameKey) so a year-scoped pair
  // of "Content Syndication" rows collapses to one selectable entry.
  // Default is the first merged entry (sorted by current-year total
  // desc), so the busiest current-year channel anchors the chart;
  // prior-only scopes pick the busiest prior-year channel by way of
  // the tiebreaker. Empty union renders an empty-state message.
  const channelKey = useMemo(
    () => mergedChannels.map((c) => c.nameKey).join('|'),
    [mergedChannels],
  );
  const defaultChannelKey = mergedChannels[0]?.nameKey ?? '';
  const [channelFilter, setChannelFilter] =
    useState<string>(defaultChannelKey);
  useEffect(() => {
    if (!mergedChannels.some((c) => c.nameKey === channelFilter)) {
      setChannelFilter(defaultChannelKey);
    }
  }, [channelKey, mergedChannels, channelFilter, defaultChannelKey]);
  const colorByName = useMemo(() => {
    const m = new Map<string, string>();
    mergedChannels.forEach((c, idx) => {
      m.set(c.nameKey, CHART_PALETTE[idx % CHART_PALETTE.length]);
    });
    return m;
  }, [mergedChannels]);
  const selectedChannel =
    mergedChannels.find((c) => c.nameKey === channelFilter) ?? null;

  // Independent channel filter for the "Total Leads per Year by
  // Channel" card. Same default rule as the monthly chart (top
  // merged entry), but its own state — changing one card's
  // dropdown doesn't move the other.
  const [channelFilterTotals, setChannelFilterTotals] =
    useState<string>(defaultChannelKey);
  useEffect(() => {
    if (!mergedChannels.some((c) => c.nameKey === channelFilterTotals)) {
      setChannelFilterTotals(defaultChannelKey);
    }
  }, [
    channelKey,
    mergedChannels,
    channelFilterTotals,
    defaultChannelKey,
  ]);
  const selectedChannelTotals =
    mergedChannels.find((c) => c.nameKey === channelFilterTotals) ?? null;
  const hasPriorForTotals = Boolean(selectedChannelTotals?.priorChannelId);
  const hasCurrentForTotals = Boolean(
    selectedChannelTotals?.currentChannelId,
  );
  const totalsCurrentForChannel = selectedChannelTotals
    ? selectedChannelTotals.current.reduce((a, b) => a + (b ?? 0), 0)
    : 0;
  const totalsPriorForChannel = selectedChannelTotals
    ? selectedChannelTotals.prior.reduce((a, b) => a + (b ?? 0), 0)
    : 0;
  const totalsByYearData = useMemo(() => {
    const rows: Array<{
      yearLabel: string;
      total: number;
      kind: 'prior' | 'current';
    }> = [];
    if (hasPriorForTotals) {
      rows.push({
        yearLabel: String(priorYear),
        total: totalsPriorForChannel,
        kind: 'prior',
      });
    }
    if (hasCurrentForTotals) {
      rows.push({
        yearLabel: String(year),
        total: totalsCurrentForChannel,
        kind: 'current',
      });
    }
    return rows;
  }, [
    hasPriorForTotals,
    hasCurrentForTotals,
    priorYear,
    year,
    totalsPriorForChannel,
    totalsCurrentForChannel,
  ]);
  const channelByYearSubtitle = selectedChannelTotals
    ? hasPriorForTotals
      ? `${selectedChannelTotals.channelName}: ${year} vs ${priorYear}. Region filter applies.`
      : `${selectedChannelTotals.channelName}: ${year}. Region filter applies.`
    : `Region filter applies.`;
  const yoyDelta =
    hasPriorForTotals && hasCurrentForTotals
      ? totalsCurrentForChannel - totalsPriorForChannel
      : null;

  // Per-month rows for the selected channel. Each entry carries
  // current and prior values for the chosen name across the two
  // years, or null when that year has no row for this name. The
  // chart conditionally omits the prior <Bar> when no prior id
  // resolves so a single-year channel renders just one bar per
  // month (acceptance criterion 4).
  const hasPriorForSelected = Boolean(selectedChannel?.priorChannelId);
  const hasCurrentForSelected = Boolean(selectedChannel?.currentChannelId);
  const singleChannelData = useMemo(() => {
    if (!selectedChannel) return [];
    return MONTH_AXIS_LABELS.map((label, i) => {
      const c = selectedChannel.current[i];
      const p = selectedChannel.prior[i];
      return {
        month: label,
        current:
          hasCurrentForSelected && typeof c === 'number' ? c : null,
        prior:
          hasPriorForSelected && typeof p === 'number' ? p : null,
      };
    });
  }, [selectedChannel, hasCurrentForSelected, hasPriorForSelected]);

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
  const channelSubtitle = selectedChannel
    ? hasPriorForSelected
      ? `${selectedChannel.channelName}: ${year} vs ${priorYear}. ${priorYear} may reflect spread quarterly actuals. Region filter applies.`
      : `${selectedChannel.channelName}: ${year} months. Region filter applies.`
    : `All ${year} months. Region filter applies.`;
  const hasAnyData = data.byChannel.length > 0;
  const currentYearKey = String(year);
  const priorYearKey = hasPriorYear ? String(priorYear) : '';
  const priorYearChannelKey = hasPriorYearChannels ? String(priorYear) : '';

  return (
    <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <ChartCard
        title="Total Leads per Year by Channel"
        subtitle={channelByYearSubtitle}
      >
        {hasAnyData ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-muted">Channel</label>
              <select
                value={channelFilterTotals}
                onChange={(e) => setChannelFilterTotals(e.target.value)}
                className="text-xs px-2 py-1 border border-border rounded bg-bg text-charcoal"
              >
                {mergedChannels.map((c) => (
                  <option key={c.nameKey} value={c.nameKey}>
                    {c.channelName}
                  </option>
                ))}
              </select>
            </div>
            {selectedChannelTotals && totalsByYearData.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart
                    data={totalsByYearData}
                    margin={{ top: 16, right: 12, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke={CHART_COLORS.border}
                    />
                    <XAxis
                      dataKey="yearLabel"
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
                      {totalsByYearData.map((row, i) => (
                        <Cell
                          key={`${row.kind}-${i}`}
                          fill={
                            colorByName.get(selectedChannelTotals.nameKey) ??
                            CHART_PALETTE[0]
                          }
                          fillOpacity={row.kind === 'prior' ? 0.45 : 1}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                {yoyDelta !== null && (
                  <p
                    className="text-xs text-right"
                    style={{
                      color:
                        yoyDelta > 0
                          ? CHART_COLORS.success
                          : yoyDelta < 0
                            ? CHART_COLORS.danger
                            : CHART_COLORS.slateMuted,
                      fontWeight: 600,
                    }}
                  >
                    {yoyDelta > 0 ? '+' : yoyDelta < 0 ? '−' : ''}
                    {Math.abs(yoyDelta).toLocaleString()} YoY
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-slate-muted italic h-[240px] flex items-center justify-center">
                No data for the selected channel.
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
            No leads in {year} matching the region filter.
          </p>
        )}
      </ChartCard>

      <ChartCard title="Total Leads per Month" subtitle={totalsSubtitle}>
        {hasAnyData ? (
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

      <ChartCard title="Leads by Channel per Month" subtitle={channelSubtitle}>
        {hasAnyData ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-muted">Channel</label>
              <select
                value={channelFilter}
                onChange={(e) => setChannelFilter(e.target.value)}
                className="text-xs px-2 py-1 border border-border rounded bg-bg text-charcoal"
              >
                {mergedChannels.map((c) => (
                  <option key={c.nameKey} value={c.nameKey}>
                    {c.channelName}
                  </option>
                ))}
              </select>
            </div>
            {selectedChannel ? (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart
                  data={singleChannelData}
                  margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                  barCategoryGap={hasPriorForSelected ? '20%' : undefined}
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
                    content={
                      <SingleChannelYoYTooltip
                        channelName={selectedChannel.channelName}
                        color={
                          colorByName.get(selectedChannel.nameKey) ??
                          CHART_PALETTE[0]
                        }
                        currentYearKey={currentYearKey}
                        priorYearKey={priorYearChannelKey}
                        hasPriorYear={hasPriorForSelected}
                      />
                    }
                  />
                  {hasPriorForSelected && (
                    <Bar
                      dataKey="prior"
                      name={priorYearChannelKey}
                      fill={
                        colorByName.get(selectedChannel.nameKey) ??
                        CHART_PALETTE[0]
                      }
                      fillOpacity={0.45}
                      radius={[3, 3, 0, 0]}
                      legendType="none"
                    />
                  )}
                  {hasCurrentForSelected && (
                    <Bar
                      dataKey="current"
                      name={currentYearKey}
                      fill={
                        colorByName.get(selectedChannel.nameKey) ??
                        CHART_PALETTE[0]
                      }
                      radius={[3, 3, 0, 0]}
                      legendType="none"
                      isAnimationActive={false}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
                No channels to display.
              </p>
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

// Single-channel YoY tooltip. Shows the hovered month's prior-year
// value, current-year value, and the signed delta for the one
// channel currently isolated by the dropdown.
interface SingleChannelYoYTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: ReadonlyArray<{
    dataKey?: string;
    value?: number | string | null;
  }>;
  channelName: string;
  color: string;
  currentYearKey: string;
  priorYearKey: string;
  // When false, omit the prior-year row and the YoY delta — used on
  // years where no prior-year data was loaded.
  hasPriorYear: boolean;
}

function SingleChannelYoYTooltip({
  active,
  label,
  payload,
  channelName,
  color,
  currentYearKey,
  priorYearKey,
  hasPriorYear,
}: SingleChannelYoYTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const rawCurrent = payload.find((p) => p.dataKey === 'current')?.value;
  const rawPrior = payload.find((p) => p.dataKey === 'prior')?.value;
  const current = typeof rawCurrent === 'number' ? rawCurrent : null;
  const prior = typeof rawPrior === 'number' ? rawPrior : null;
  const fmt = (n: number | null) =>
    n === null ? '—' : Number.isFinite(n) ? n.toLocaleString() : String(n);
  const showDelta = hasPriorYear && current !== null && prior !== null;
  const delta = showDelta ? (current as number) - (prior as number) : 0;
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
        minWidth: 160,
      }}
    >
      <div
        style={{
          color: CHART_COLORS.charcoal,
          fontWeight: 600,
          marginBottom: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: 2,
            background: color,
          }}
        />
        <span>{channelName}</span>
        <span style={{ color: CHART_COLORS.slateMuted, fontWeight: 400 }}>
          {String(label ?? '')}
        </span>
      </div>
      {hasPriorYear && (
        <div
          style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}
        >
          <span style={{ color: CHART_COLORS.slateMuted }}>{priorYearKey}</span>
          <span style={{ color: CHART_COLORS.charcoal }}>{fmt(prior)}</span>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ color: CHART_COLORS.indigo }}>{currentYearKey}</span>
        <span style={{ color: CHART_COLORS.charcoal }}>{fmt(current)}</span>
      </div>
      {showDelta && (
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
      )}
    </div>
  );
}

// Custom tooltip for the Total Leads per Month card when the YoY
// overlay is on. Shows current, prior, and the delta (current minus
// prior) for the hovered month. Number formatting matches the rest
// of the card (toLocaleString, integers).
interface YoYTooltipProps {
  active?: boolean;
  label?: string | number;
  // Recharts' payload shape is loosely typed; we only read dataKey
  // and value, both of which we control via the Bar definitions above.
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

