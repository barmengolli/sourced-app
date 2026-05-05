import { useMemo } from 'react';
import { Sankey, Tooltip } from 'recharts';
import type { Channel } from '../../types/db';
import type { ComputedRow } from '../../lib/compute';
import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
} from '../../constants/funnelStages';
import { CHART_COLORS, CHART_PALETTE } from '../../constants/chartColors';

// Channel-to-stage Sankey driven by the rolled-up grid totals.
//
// Source nodes: every depth-1 channel, regardless of whether it has any
// attribution_touches yet (so high-volume top-of-funnel channels like
// Marketing SDR show up before any HPPs are created from them).
//
// Link weights:
//   • Lead and MQL stages: read from grid.rows (computed from leads
//     + stage_history in compute.ts step 2 + tree rollup in step 5).
//   • HPP/Opp/Pursuit/CloseWon stages: read from grid.rows as well —
//     compute.ts step 3 already counts attributions per cell and the
//     parent rollup in step 5 sums children's attribution counts up to
//     each top-level channel. Period filtering happens inside computeGrid
//     so this component doesn't re-do it.
//
// Stage nodes: always all 6 stages on the right. A stage with zero total
// incoming weight gets a tiny synthetic link (value < 0.001, suppressed by
// the custom link renderer) so Recharts keeps the node visible.

interface AttributionSummaryViewProps {
  rows: ComputedRow[];
  channels: Channel[];
}

// Synthetic-link epsilon: small enough that Recharts barely allocates any
// width to it but non-zero so the layout keeps the stage node visible.
const EPSILON_LINK = 0.0001;

interface NodePayload {
  name: string;
  isChannel: boolean;
  // Used by the custom node renderer to color channel nodes from the palette.
  paletteIndex?: number;
  // Set on stage nodes only. Lets the renderer pick a per-stage color
  // (Closed Lost in red, all others in charcoal).
  stageKey?: string;
}

interface SankeyData {
  nodes: NodePayload[];
  links: { source: number; target: number; value: number }[];
}

interface CustomNodeProps {
  x: number;
  y: number;
  width: number;
  height: number;
  payload: NodePayload;
}

function CustomNode({ x, y, width, height, payload }: CustomNodeProps) {
  const fill = payload.isChannel
    ? CHART_PALETTE[(payload.paletteIndex ?? 0) % CHART_PALETTE.length]
    : payload.stageKey === 'closeLost'
      ? '#EF4444'
      : CHART_COLORS.charcoal;
  const labelX = payload.isChannel ? x - 8 : x + width + 8;
  const anchor: 'start' | 'end' = payload.isChannel ? 'end' : 'start';
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} rx={2} />
      <text
        x={labelX}
        y={y + height / 2}
        textAnchor={anchor}
        dominantBaseline="central"
        fontSize={11}
        fill={CHART_COLORS.charcoal}
        fontWeight={500}
      >
        {payload.name}
      </text>
    </g>
  );
}

interface CustomLinkProps {
  sourceX: number;
  targetX: number;
  sourceY: number;
  targetY: number;
  sourceControlX: number;
  targetControlX: number;
  linkWidth: number;
  payload?: { value: number };
}

function CustomLink({
  sourceX,
  targetX,
  sourceY,
  targetY,
  sourceControlX,
  targetControlX,
  linkWidth,
  payload,
}: CustomLinkProps) {
  // Skip rendering for synthetic "presence" links used to keep zero-weight
  // stage nodes visible in the layout.
  if (payload && payload.value < 0.001) return null;
  const path =
    `M${sourceX},${sourceY}` +
    `C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`;
  return (
    <path
      d={path}
      fill="none"
      stroke={CHART_COLORS.slateMuted}
      strokeOpacity={0.25}
      strokeWidth={linkWidth}
    />
  );
}

export default function AttributionSummaryView({
  rows,
  channels,
}: AttributionSummaryViewProps) {
  const channelById = useMemo(
    () => new Map(channels.map((c) => [c.id, c] as const)),
    [channels],
  );

  const data: SankeyData = useMemo(() => {
    // Top-level channel rows in their existing display order. We always
    // emit a node for each, regardless of stage signal, so high-volume
    // top-of-funnel channels stay visible before any deals are created.
    const topRows = rows.filter((r) => r.depth === 1);

    const nodes: NodePayload[] = [];
    const channelNodeIndex = new Map<string, number>();
    topRows.forEach((r, i) => {
      const channel = channelById.get(r.channelId);
      const name = channel?.name ?? 'Unknown';
      channelNodeIndex.set(r.channelId, nodes.length);
      nodes.push({ name, isChannel: true, paletteIndex: i });
    });
    const stageNodeIndex = new Map<string, number>();
    for (const stage of FUNNEL_STAGES) {
      stageNodeIndex.set(stage, nodes.length);
      nodes.push({
        name: FUNNEL_STAGE_LABELS[stage],
        isChannel: false,
        stageKey: stage,
      });
    }

    // Real links: weight = each top-level channel's rolled-up actual at
    // each stage. Drop zero-weight links so the Sankey stays readable.
    const links: { source: number; target: number; value: number }[] = [];
    const stageHasRealLink = new Set<string>();
    for (const r of topRows) {
      const srcIdx = channelNodeIndex.get(r.channelId);
      if (srcIdx === undefined) continue;
      for (const stage of FUNNEL_STAGES) {
        const v = r.cells[stage].actual ?? 0;
        if (v <= 0) continue;
        const tgtIdx = stageNodeIndex.get(stage);
        if (tgtIdx === undefined) continue;
        links.push({ source: srcIdx, target: tgtIdx, value: v });
        stageHasRealLink.add(stage);
      }
    }

    // Synthetic presence links: keep every stage node visible even if it
    // has no real signal in the period. The custom link renderer suppresses
    // links below the epsilon threshold so they don't render as visible
    // ribbons. Source: the first top-level channel (any source works; this
    // one minimizes layout disturbance).
    if (topRows.length > 0) {
      const firstSrc = channelNodeIndex.get(topRows[0].channelId);
      if (firstSrc !== undefined) {
        for (const stage of FUNNEL_STAGES) {
          if (stageHasRealLink.has(stage)) continue;
          const tgtIdx = stageNodeIndex.get(stage);
          if (tgtIdx === undefined) continue;
          links.push({
            source: firstSrc,
            target: tgtIdx,
            value: EPSILON_LINK,
          });
        }
      }
    }

    return { nodes, links };
  }, [rows, channelById]);

  // Recharts Sankey requires at least one link. If there are zero top-level
  // channels we fall back to the empty-state copy.
  const hasAnyVisibleLink = data.links.some((l) => l.value > EPSILON_LINK);
  if (data.nodes.length === 0 || (!hasAnyVisibleLink && data.links.length === 0)) {
    return (
      <p className="text-xs text-slate-muted italic h-[260px] flex items-center justify-center">
        No channel signal in the selected period.
      </p>
    );
  }

  return (
    <div className="w-full overflow-x-auto">
      <Sankey
        width={900}
        height={Math.max(260, data.nodes.length * 24)}
        data={data}
        nodeWidth={10}
        nodePadding={16}
        linkCurvature={0.4}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={CustomNode as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        link={CustomLink as any}
        margin={{ top: 12, right: 120, bottom: 12, left: 160 }}
        sort={false}
      >
        <Tooltip
          formatter={(v) => {
            if (v === null || v === undefined) return '';
            const n = typeof v === 'number' ? v : Number(v);
            if (Number.isNaN(n)) return '';
            // Hide synthetic presence links so empty stages don't show "0".
            if (n < 0.001) return '';
            return n.toLocaleString();
          }}
          contentStyle={{
            fontSize: 11,
            border: `1px solid ${CHART_COLORS.border}`,
            borderRadius: 6,
          }}
        />
      </Sankey>
    </div>
  );
}
