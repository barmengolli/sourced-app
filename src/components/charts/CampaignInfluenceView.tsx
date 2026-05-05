// CampaignInfluenceView — per-opportunity Sankey cards on the Funnel
// Dashboard, ported verbatim from DataVis 1's DealJourneySankeyCard
// (DataVis/src/components/charts/AttributionSummaryView.tsx). The constants,
// CustomNode/CustomLink, buildDealJourneySankeyData, and DealJourneySankeyCard
// are copied as-is so the visual matches DataVis exactly.
//
// One Sourced-specific adapter: DataVis stores touches inline on
// attribution.touches[]. Sourced stores them as a separate
// attribution_touches table, so we join at the call site (lookup by
// attribution_id from useAttributionTouches) and pass an inline-shape array
// into the function.

import { useCallback, useMemo, useState } from 'react';
import { Sankey } from 'recharts';
import type {
  Attribution,
  AttributionStageKey,
  AttributionTouch,
  Channel,
  PeriodIndex,
} from '../../types/db';
import { FUNNEL_STAGE_LABELS } from '../../constants/funnelStages';
import type { PeriodFilter } from '../../lib/compute';

interface CampaignInfluenceViewProps {
  attributions: Attribution[];
  attributionTouches: AttributionTouch[];
  channels: Channel[];
  year: number;
  filter: PeriodFilter;
}

// ---------- DataVis-shape adapter types ----------
//
// Recreates the DataVis OpportunityAttribution + Touch shapes locally so the
// ported function body (which iterates inline `touches`) ports verbatim.

interface InlineTouch {
  channelId: string;
}

interface OpportunityAttribution {
  id: string;
  dealId?: string | null;
  stageKey: AttributionStageKey;
  channelId: string;
  year: number;
  periodIndex: PeriodIndex;
  label?: string | null;
  touches: InlineTouch[];
}

const STAGE_COLOR = '#6366f1';
const STAGE_LOST_COLOR = '#EF4444';
const TOUCH_NODE_COLORS = ['#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe', '#dbeafe'];
const TOUCH_WEIGHTS = [4, 2, 1, 0.5, 0.3];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomNode({ x, y, width, height, payload }: any) {
  const isStage = payload.isStage;
  const isLost = payload.stageKey === 'closeLost';
  const color = isStage
    ? isLost
      ? STAGE_LOST_COLOR
      : STAGE_COLOR
    : TOUCH_NODE_COLORS[Math.min(payload.touchPosition || 0, TOUCH_NODE_COLORS.length - 1)];
  const labelX = isStage ? x + width + 8 : x - 8;
  const anchor: 'start' | 'end' = isStage ? 'start' : 'end';
  const hasSub = !isStage && payload.subName;
  const centerY = y + height / 2;
  const lineHeight = 13;
  const lines = hasSub ? 3 : 2;
  const startY = centerY - ((lines - 1) * lineHeight) / 2;

  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={color} rx={2} />
      {isStage ? (
        <text x={labelX} y={centerY} textAnchor={anchor} dominantBaseline="central" fontSize={11} fill="#374151" fontWeight={600}>
          {payload.name}
        </text>
      ) : (
        <>
          <text x={labelX} y={startY} textAnchor={anchor} dominantBaseline="central" fontSize={10} fill="#374151" fontWeight={600}>
            {payload.parentName || payload.name}
          </text>
          {hasSub && (
            <text x={labelX} y={startY + lineHeight} textAnchor={anchor} dominantBaseline="central" fontSize={10} fill="#6b7280" fontWeight={400}>
              {payload.subName}
            </text>
          )}
          {payload.touchLabel && (
            <text x={labelX} y={startY + (hasSub ? 2 : 1) * lineHeight} textAnchor={anchor} dominantBaseline="central" fontSize={9} fill="#9ca3af">
              {payload.touchLabel}
            </text>
          )}
        </>
      )}
    </g>
  );
}

// Build Sankey for a deal journey: touches → stage1 → stage2 → ...
// Takes all attributions for the same deal (grouped by dealId)
// closeLost shares the terminal slot with closeWon. A real deal won't
// have both rows; if it somehow did, ordering them as siblings keeps the
// stage chain readable.
const STAGE_ORDER: Record<string, number> = {
  hpp: 0,
  opp: 1,
  pursuit: 2,
  closeWon: 3,
  closeLost: 3,
};

function buildDealJourneySankeyData(
  dealAttributions: OpportunityAttribution[],
  getChannelParts: (id: string) => { parentName: string; subName?: string; fullKey: string },
) {
  if (dealAttributions.length === 0) return null;

  // Sort attributions by stage order
  const sorted = [...dealAttributions].sort((a, b) => (STAGE_ORDER[a.stageKey] ?? 0) - (STAGE_ORDER[b.stageKey] ?? 0));
  const firstAttr = sorted[0];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeKeyMap = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getOrCreateNode = (key: string, extra: any) => {
    if (!nodeKeyMap.has(key)) {
      nodeKeyMap.set(key, nodes.length);
      nodes.push(extra);
    }
    return nodeKeyMap.get(key)!;
  };

  const linkCountMap = new Map<string, number>();

  // 1. Create touch nodes from the first (earliest) attribution's touches
  const touchNodeIndices: number[] = [];
  for (let i = 0; i < firstAttr.touches.length; i++) {
    const touch = firstAttr.touches[i];
    const parts = getChannelParts(touch.channelId);
    const ordinal = i === 0 ? '1st Touch' : i === 1 ? '2nd Touch' : i === 2 ? '3rd Touch' : `${i + 1}th Touch`;
    const nodeKey = `touch:${parts.fullKey}@${ordinal}`;
    touchNodeIndices.push(getOrCreateNode(nodeKey, {
      name: parts.subName ? `${parts.parentName} - ${parts.subName}` : parts.parentName,
      parentName: parts.parentName,
      subName: parts.subName,
      touchPosition: i,
      touchLabel: ordinal,
    }));
  }

  // 2. Create stage nodes for each stage the deal has reached
  const stageNodeIndices: number[] = [];
  for (const attr of sorted) {
    const stageLabel = FUNNEL_STAGE_LABELS[attr.stageKey] || attr.stageKey;
    const stageNodeIdx = getOrCreateNode(`stage:${attr.stageKey}`, { name: stageLabel, isStage: true, stageKey: attr.stageKey });
    stageNodeIndices.push(stageNodeIdx);
  }

  // 3. Links: last touch → first stage (weighted by touch position)
  if (touchNodeIndices.length > 0 && stageNodeIndices.length > 0) {
    // All touches point to first stage
    for (let i = 0; i < touchNodeIndices.length; i++) {
      const weight = TOUCH_WEIGHTS[Math.min(i, TOUCH_WEIGHTS.length - 1)];
      const linkKey = `${touchNodeIndices[i]}-${stageNodeIndices[0]}`;
      linkCountMap.set(linkKey, (linkCountMap.get(linkKey) || 0) + weight);
    }

    // 4. Links between consecutive stages (equal weight)
    for (let i = 0; i < stageNodeIndices.length - 1; i++) {
      const linkKey = `${stageNodeIndices[i]}-${stageNodeIndices[i + 1]}`;
      linkCountMap.set(linkKey, (linkCountMap.get(linkKey) || 0) + 3);
    }
  }

  const links = Array.from(linkCountMap.entries()).map(([key, value]) => {
    const [source, target] = key.split('-').map(Number);
    return { source, target, value: Math.max(value, 0.3) };
  });

  if (links.length === 0 || nodes.length < 2) return null;

  // Sort: touches first (by position), then stages (by order)
  const touchNodes = nodes
    .map((n, idx) => ({ ...n, originalIdx: idx }))
    .filter((n) => !n.isStage)
    .sort((a, b) => (a.touchPosition || 0) - (b.touchPosition || 0) || a.name.localeCompare(b.name));

  const stageNodes = nodes
    .map((n, idx) => ({ ...n, originalIdx: idx }))
    .filter((n) => n.isStage);

  const idxMap = new Map<number, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sortedNodes: any[] = [];
  for (const tn of touchNodes) {
    idxMap.set(tn.originalIdx, sortedNodes.length);
    sortedNodes.push({ name: tn.name, parentName: tn.parentName, subName: tn.subName, isStage: tn.isStage, touchPosition: tn.touchPosition, touchLabel: tn.touchLabel });
  }
  for (const sn of stageNodes) {
    idxMap.set(sn.originalIdx, sortedNodes.length);
    sortedNodes.push({ name: sn.name, isStage: true, stageKey: sn.stageKey });
  }

  const remappedLinks = links.map(l => ({
    source: idxMap.get(l.source) ?? l.source,
    target: idxMap.get(l.target) ?? l.target,
    value: l.value,
  }));

  return { nodes: sortedNodes, links: remappedLinks };
}

// A deal group: all attributions sharing a dealId (or a single unlinked attribution)
interface DealGroup {
  dealId: string;
  attributions: OpportunityAttribution[];
  label: string;
  highestStage: string;
  highestStageLabel: string;
  earliestAttr: OpportunityAttribution;
}

// Mini Sankey card for a deal journey (one or more stages)
function DealJourneySankeyCard({
  deal, index, getChannelParts, channelNameMap,
}: {
  deal: DealGroup;
  index: number;
  getChannelParts: (id: string) => { parentName: string; subName?: string; fullKey: string };
  channelNameMap: Map<string, string>;
}) {
  const [hoveredLinkIdx, setHoveredLinkIdx] = useState<number | null>(null);

  const data = useMemo(
    () => buildDealJourneySankeyData(deal.attributions, getChannelParts),
    [deal.attributions, getChannelParts]
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleMouseEnter = useCallback((_item: any, type: string) => {
    if (type === 'link') setHoveredLinkIdx(_item.index);
  }, []);
  const handleMouseLeave = useCallback(() => setHoveredLinkIdx(null), []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CustomLink = useCallback((props: any) => {
    const { sourceX, targetX, sourceY, targetY, sourceControlX, targetControlX, linkWidth, index: linkIndex } = props;
    const isHovered = hoveredLinkIdx === linkIndex;
    const isFaded = hoveredLinkIdx !== null && !isHovered;
    return (
      <path
        d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
        fill="none"
        stroke={isHovered ? '#8b5cf6' : '#94a3b8'}
        strokeWidth={linkWidth}
        strokeOpacity={isFaded ? 0.05 : isHovered ? 0.7 : 0.25}
        style={{ transition: 'stroke-opacity 0.2s, stroke 0.2s' }}
      />
    );
  }, [hoveredLinkIdx]);

  if (!data) return null;

  const label = deal.label || `Opportunity ${index + 1}`;
  const cellChannel = channelNameMap.get(deal.earliestAttr.channelId) || '';

  // Stage badges for all stages reached
  const stagesReached = deal.attributions
    .map(a => ({ key: a.stageKey, label: FUNNEL_STAGE_LABELS[a.stageKey] || a.stageKey }))
    .sort((a, b) => (STAGE_ORDER[a.key] ?? 0) - (STAGE_ORDER[b.key] ?? 0));

  return (
    <div className="border border-gray-100 rounded-lg p-3 bg-gray-50/30">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-gray-700">{label}</span>
          {stagesReached.map((s, i) => {
            // The latest stage is highlighted; older stages are dimmed.
            // Closed Lost overrides both states with red so the negative
            // outcome reads at a glance.
            const isLost = s.key === 'closeLost';
            const isLatest = i === stagesReached.length - 1;
            const cls = isLost
              ? 'text-danger bg-danger/10'
              : isLatest
                ? 'text-purple-600 bg-purple-100'
                : 'text-gray-500 bg-gray-100';
            return (
              <span
                key={s.key}
                className={`text-[10px] font-semibold rounded px-1.5 py-0.5 ${cls}`}
              >
                {s.label}
              </span>
            );
          })}
          {cellChannel && (
            <span className="text-[10px] text-gray-400">{cellChannel} — Q{deal.earliestAttr.periodIndex}</span>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <Sankey
          width={600}
          height={Math.max(100, data.nodes.length * 35)}
          data={data}
          nodeWidth={10}
          nodePadding={16}
          linkCurvature={0.4}
          node={CustomNode}
          link={CustomLink}
          margin={{ left: 200, right: 80, top: 10, bottom: 10 }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          sort={false}
        >
        </Sankey>
      </div>
    </div>
  );
}

// ---------- Sourced wrapper (replaces the old hand-drawn cards) ----------

const PAGE = 10;

export default function CampaignInfluenceView({
  attributions,
  attributionTouches,
  channels,
  year,
  filter,
}: CampaignInfluenceViewProps) {
  const [showAll, setShowAll] = useState(false);

  // Adapter: join attribution_touches onto each attribution by attribution_id
  // so the ported buildDealJourneySankeyData can iterate `touches` inline.
  const touchesByAttribution = useMemo(() => {
    const m = new Map<string, AttributionTouch[]>();
    for (const t of attributionTouches) {
      const arr = m.get(t.attribution_id) ?? [];
      arr.push(t);
      m.set(t.attribution_id, arr);
    }
    for (const [k, arr] of m) {
      m.set(k, arr.slice().sort((a, b) => a.touch_order - b.touch_order));
    }
    return m;
  }, [attributionTouches]);

  // Filter to selected period (year + Q or 'year') and reshape to the
  // DataVis OpportunityAttribution inline-touches form.
  const opportunityAttributions: OpportunityAttribution[] = useMemo(() => {
    return attributions
      .filter((a) => a.year === year)
      .filter((a) => filter === 'year' || `Q${a.period_index}` === filter)
      .map((a) => {
        const touches = (touchesByAttribution.get(a.id) ?? [])
          .map((t) => ({ channelId: t.channel_id ?? '' }))
          .filter((t) => t.channelId !== '');
        return {
          id: a.id,
          dealId: a.deal_id ?? null,
          stageKey: a.stage_key,
          channelId: a.channel_id ?? '',
          year: a.year,
          periodIndex: a.period_index,
          label: a.label ?? '',
          touches,
        };
      });
  }, [attributions, touchesByAttribution, year, filter]);

  // Channel parent/sub lookup. Sourced uses parent_channel_id (snake_case)
  // where DataVis used parentChannelId, otherwise identical.
  const getChannelParts = useCallback(
    (channelId: string): { parentName: string; subName?: string; fullKey: string } => {
      const ch = channels.find((c) => c.id === channelId);
      if (!ch) return { parentName: 'Unknown', fullKey: 'Unknown' };
      if (ch.parent_channel_id) {
        const parent = channels.find((c) => c.id === ch.parent_channel_id);
        const pName = parent?.name || 'Unknown';
        return { parentName: pName, subName: ch.name, fullKey: `${pName}|${ch.name}` };
      }
      return { parentName: ch.name, fullKey: ch.name };
    },
    [channels],
  );

  const channelNameMap = useMemo(
    () => new Map(channels.map((c) => [c.id, c.name])),
    [channels],
  );

  // Group by dealId. Singletons (no deal_id) use their own attribution id as
  // the key so they render as their own card.
  const dealGroups: DealGroup[] = useMemo(() => {
    const groupMap = new Map<string, DealGroup>();

    for (const attr of opportunityAttributions) {
      const key = attr.dealId || attr.id;
      if (groupMap.has(key)) {
        groupMap.get(key)!.attributions.push(attr);
      } else {
        groupMap.set(key, {
          dealId: key,
          attributions: [attr],
          label: attr.label || '',
          highestStage: attr.stageKey,
          highestStageLabel: '',
          earliestAttr: attr,
        });
      }
    }

    for (const group of groupMap.values()) {
      group.attributions.sort(
        (a, b) => (STAGE_ORDER[a.stageKey] ?? 0) - (STAGE_ORDER[b.stageKey] ?? 0),
      );
      group.earliestAttr = group.attributions[0];
      const highest = group.attributions[group.attributions.length - 1];
      group.highestStage = highest.stageKey;
      group.highestStageLabel = FUNNEL_STAGE_LABELS[highest.stageKey] || highest.stageKey;
      group.label = group.attributions.find((a) => a.label)?.label || '';
    }

    return [...groupMap.values()];
  }, [opportunityAttributions]);

  if (dealGroups.length === 0) {
    return (
      <p className="text-xs text-slate-muted italic">
        No opportunities created in this period. Use the Data Entry tab to
        create one.
      </p>
    );
  }

  const shown = showAll ? dealGroups : dealGroups.slice(0, PAGE);

  return (
    <div className="space-y-2">
      {shown.map((deal, idx) => (
        <DealJourneySankeyCard
          key={deal.dealId}
          deal={deal}
          index={idx}
          getChannelParts={getChannelParts}
          channelNameMap={channelNameMap}
        />
      ))}
      {dealGroups.length > PAGE && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs text-indigo hover:underline"
        >
          {showAll
            ? `Show first ${PAGE} only`
            : `Show all ${dealGroups.length} cards`}
        </button>
      )}
    </div>
  );
}
