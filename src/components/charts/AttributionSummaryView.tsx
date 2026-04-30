import { useMemo } from 'react';
import { Sankey, Tooltip } from 'recharts';
import type { Channel } from '../../types/db';
import type { ComputedRow } from '../../lib/compute';
import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
} from '../../constants/funnelStages';
import { CHART_COLORS, CHART_PALETTE } from '../../constants/chartColors';

interface AttributionSummaryViewProps {
  rows: ComputedRow[];
  channels: Channel[];
}

// Placeholder visualization: flow from depth-1 channels into the 6 funnel
// stages, weighted by each channel's actual at that stage. Real
// touch-attribution Sankey lands in M7 with the attribution_touches data
// model; until then this just shows the channel × stage cross-section.

interface NodePayload {
  name: string;
  isChannel: boolean;
  // Used by the custom node renderer to color channel nodes from the palette.
  paletteIndex?: number;
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
}

function CustomLink({
  sourceX,
  targetX,
  sourceY,
  targetY,
  sourceControlX,
  targetControlX,
  linkWidth,
}: CustomLinkProps) {
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
    const sourceRows = rows.filter((r) => r.depth === 1);
    const sourcesWithSignal = sourceRows.filter((r) =>
      FUNNEL_STAGES.some((s) => (r.cells[s].actual ?? 0) > 0),
    );

    const nodes: NodePayload[] = [];
    const channelNodeIndex = new Map<string, number>();
    sourcesWithSignal.forEach((r, i) => {
      const channel = channelById.get(r.channelId);
      const name = channel?.name ?? 'Unknown';
      channelNodeIndex.set(r.channelId, nodes.length);
      nodes.push({ name, isChannel: true, paletteIndex: i });
    });
    const stageNodeIndex = new Map<string, number>();
    for (const stage of FUNNEL_STAGES) {
      stageNodeIndex.set(stage, nodes.length);
      nodes.push({ name: FUNNEL_STAGE_LABELS[stage], isChannel: false });
    }

    const links: { source: number; target: number; value: number }[] = [];
    for (const r of sourcesWithSignal) {
      const srcIdx = channelNodeIndex.get(r.channelId);
      if (srcIdx === undefined) continue;
      for (const stage of FUNNEL_STAGES) {
        const v = r.cells[stage].actual ?? 0;
        if (v <= 0) continue;
        const tgtIdx = stageNodeIndex.get(stage);
        if (tgtIdx === undefined) continue;
        links.push({ source: srcIdx, target: tgtIdx, value: v });
      }
    }

    return { nodes, links };
  }, [rows, channelById]);

  if (data.links.length === 0) {
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
            return Number.isNaN(n) ? '' : n.toLocaleString();
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
