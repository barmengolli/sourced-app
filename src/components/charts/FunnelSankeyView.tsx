// FunnelSankeyView — multi-column funnel-flow Sankey on the Funnel
// Dashboard. Replaces the older 2-column Channel→Stage Sankey
// (AttributionSummaryView) so late-stage volumes don't get squished
// against the dominant Leads totals.
//
// Layout: 7 columns left-to-right.
//   Channels → Leads → MQL → HPP → Opp → Pursuit → (Closed Won | Closed Lost)
//
// Per-channel coloring is preserved end-to-end: each ribbon carries the
// originating channel's palette color, so a viewer can trace a single
// channel's contribution through the funnel by following a single color.
//
// Data: pulls leads + attributions + channels at the page level and
// delegates the cohort math to lib/compute.ts (computeFunnelSankey).
// Drop-off is implicit — the visual gap between a stage's incoming and
// outgoing edges IS the dropped-off count.

import { useMemo } from 'react';
import { ResponsiveContainer, Sankey, Tooltip } from 'recharts';
import type { Attribution, Channel, Lead } from '../../types/db';
import {
  computeFunnelSankey,
  type FunnelSankeyData,
  type FunnelSankeyNode,
  type PeriodFilter,
} from '../../lib/compute';
import type { RegionKey } from '../../constants/regions';
import { CHART_COLORS, CHART_PALETTE } from '../../constants/chartColors';

interface FunnelSankeyViewProps {
  leads: Lead[];
  attributions: Attribution[];
  channels: Channel[];
  year: number;
  filter: PeriodFilter;
  regions: Set<RegionKey>;
}

// Recharts' Sankey expects {nodes, links} with numeric source/target
// indices. We translate compute.ts's id-keyed graph into that shape, and
// stash the original FunnelSankeyNode payload on each node so the custom
// renderers can color by kind/channelId.
interface RechartsLink {
  source: number;
  target: number;
  value: number;
  channelId: string;
  // Carried so the Tooltip formatter can look up channel + edge labels.
  sourceLabel: string;
  targetLabel: string;
  channelLabel: string;
}

interface NodePayload extends FunnelSankeyNode {
  // The renderer reads paletteIndex (not channelId) to pick a color, so
  // we resolve once during graph build instead of every paint.
  paletteIndex?: number;
}

export default function FunnelSankeyView({
  leads,
  attributions,
  channels,
  year,
  filter,
  regions,
}: FunnelSankeyViewProps) {
  // Re-run the cohort trace whenever any input changes. The output is
  // node ids + edges; we don't memoize the Recharts shape separately
  // because the translation is O(nodes + edges) and trivial.
  const sankey: FunnelSankeyData = useMemo(
    () => computeFunnelSankey({
      leads,
      attributions,
      channels,
      year,
      filter,
      regions,
    }),
    [leads, attributions, channels, year, filter, regions],
  );

  const channelNameById = useMemo(
    () => new Map(channels.map((c) => [c.id, c.name] as const)),
    [channels],
  );

  // paletteIndex is assigned in the order top-level channels appear in the
  // Sankey nodes array; that order already follows the channel display
  // order from compute.ts, so the colors stay stable across re-renders.
  const { rechartsNodes, rechartsLinks, hasAnyEdge } = useMemo(() => {
    const idToIndex = new Map<string, number>();
    const nodesOut: NodePayload[] = [];
    let palettePos = 0;
    for (const n of sankey.nodes) {
      const node: NodePayload = { ...n };
      if (n.kind === 'channel') {
        node.paletteIndex = palettePos;
        palettePos += 1;
      }
      idToIndex.set(n.id, nodesOut.length);
      nodesOut.push(node);
    }
    const linksOut: RechartsLink[] = [];
    for (const e of sankey.edges) {
      const s = idToIndex.get(e.source);
      const t = idToIndex.get(e.target);
      if (s === undefined || t === undefined) continue;
      linksOut.push({
        source: s,
        target: t,
        value: e.value,
        channelId: e.channelId,
        sourceLabel: nodesOut[s].label,
        targetLabel: nodesOut[t].label,
        channelLabel: channelNameById.get(e.channelId) ?? 'Unknown',
      });
    }
    return {
      rechartsNodes: nodesOut,
      rechartsLinks: linksOut,
      hasAnyEdge: linksOut.length > 0,
    };
  }, [sankey, channelNameById]);

  // Channel id → palette color, computed once after the indexing pass so
  // the link renderer can read it without re-walking nodes per paint.
  const colorByChannelId = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of rechartsNodes) {
      if (n.kind !== 'channel' || !n.channelId) continue;
      m.set(
        n.channelId,
        CHART_PALETTE[(n.paletteIndex ?? 0) % CHART_PALETTE.length],
      );
    }
    return m;
  }, [rechartsNodes]);

  if (!hasAnyEdge) {
    return (
      <p className="text-xs text-slate-muted italic h-[260px] flex items-center justify-center">
        No funnel signal in the selected period.
      </p>
    );
  }

  // The renderers are inline so they can close over colorByChannelId
  // without prop-drilling through Recharts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const NodeRenderer = (props: any) => {
    const { x, y, width, height, payload } = props as {
      x: number;
      y: number;
      width: number;
      height: number;
      payload: NodePayload;
    };
    let fill: string;
    let labelAnchor: 'start' | 'end' | 'middle';
    let labelX: number;
    if (payload.kind === 'channel') {
      fill =
        CHART_PALETTE[(payload.paletteIndex ?? 0) % CHART_PALETTE.length];
      labelAnchor = 'end';
      labelX = x - 8;
    } else if (payload.kind === 'terminal') {
      fill =
        payload.stageKey === 'closeWon'
          ? CHART_COLORS.success
          : CHART_COLORS.danger;
      labelAnchor = 'start';
      labelX = x + width + 8;
    } else {
      fill = CHART_COLORS.slateMuted;
      labelAnchor = 'start';
      labelX = x + width + 8;
    }
    return (
      <g>
        <rect x={x} y={y} width={width} height={height} fill={fill} rx={2} />
        <text
          x={labelX}
          y={y + height / 2}
          textAnchor={labelAnchor}
          dominantBaseline="central"
          fontSize={11}
          fill={CHART_COLORS.charcoal}
          fontWeight={500}
        >
          {payload.label}
        </text>
      </g>
    );
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const LinkRenderer = (props: any) => {
    const {
      sourceX,
      targetX,
      sourceY,
      targetY,
      sourceControlX,
      targetControlX,
      linkWidth,
      payload,
    } = props as {
      sourceX: number;
      targetX: number;
      sourceY: number;
      targetY: number;
      sourceControlX: number;
      targetControlX: number;
      linkWidth: number;
      payload?: RechartsLink;
    };
    const stroke =
      colorByChannelId.get(payload?.channelId ?? '') ?? CHART_COLORS.slateMuted;
    const path =
      `M${sourceX},${sourceY}` +
      `C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`;
    return (
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeOpacity={0.45}
        strokeWidth={linkWidth}
      />
    );
  };

  return (
    <div className="w-full">
      <ResponsiveContainer width="100%" height={400}>
        <Sankey
          data={{ nodes: rechartsNodes, links: rechartsLinks }}
          nodeWidth={10}
          nodePadding={16}
          linkCurvature={0.4}
          node={NodeRenderer}
          link={LinkRenderer}
          margin={{ top: 12, right: 120, bottom: 12, left: 160 }}
          sort={false}
        >
          <Tooltip
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            content={({ active, payload }: any) => {
              if (!active || !payload || payload.length === 0) return null;
              const datum = payload[0]?.payload;
              if (!datum) return null;
              // Recharts tooltip fires for both nodes and links; the link
              // payload carries our RechartsLink shape.
              if ('channelId' in datum && 'sourceLabel' in datum) {
                const link = datum as RechartsLink;
                return (
                  <div
                    style={{
                      fontSize: 11,
                      border: `1px solid ${CHART_COLORS.border}`,
                      borderRadius: 6,
                      padding: '6px 8px',
                      background: '#FFFFFF',
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>
                      {link.sourceLabel} → {link.targetLabel}
                    </div>
                    <div style={{ color: CHART_COLORS.slateMuted }}>
                      {link.channelLabel}: {link.value.toLocaleString()}
                    </div>
                  </div>
                );
              }
              const node = datum as NodePayload;
              return (
                <div
                  style={{
                    fontSize: 11,
                    border: `1px solid ${CHART_COLORS.border}`,
                    borderRadius: 6,
                    padding: '6px 8px',
                    background: '#FFFFFF',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{node.label}</div>
                </div>
              );
            }}
          />
        </Sankey>
      </ResponsiveContainer>
    </div>
  );
}
