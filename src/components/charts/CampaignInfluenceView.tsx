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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ResponsiveContainer, Sankey } from 'recharts';
import type {
  Attribution,
  AttributionStageKey,
  AttributionTouch,
  Channel,
  PeriodIndex,
} from '../../types/db';
import { FUNNEL_STAGE_LABELS } from '../../constants/funnelStages';
import { REGIONS, REGION_LABELS, type RegionKey } from '../../constants/regions';

// Two independent multi-select filter axes for the Opportunity
// Influence section: a Set<number> of selected years, and a
// Set<InfluenceStatus> of selected statuses. Region and Channel
// rows live inside this component and compose on top via AND.
//
// Empty set on either axis is treated as "no filter on that axis"
// (mirrors the Region row's empty-set semantics). A full set
// covering every option is also treated as "no filter" so toggling
// the last pill off and then back on is a no-op.
export type InfluenceStatus = 'open' | 'closeWon' | 'closeLost';

// "Feb 3, 2026" formatter for the stage-entry-date sub-label under each
// stage node. Returns '' for an empty/invalid ISO so the renderer can
// no-op cleanly. Local-date parse to dodge the same UTC-day pitfall the
// rest of the codebase guards against (lib/dates.ts).
function formatStageEnteredAt(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '';
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (mo < 1 || mo > 12) return '';
  return new Date(y, mo - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface CampaignInfluenceViewProps {
  attributions: Attribution[];
  attributionTouches: AttributionTouch[];
  channels: Channel[];
  // Year axis: a chain matches when at least one of its rows falls
  // in a selected year. Empty set or a set covering every available
  // year means "no year filter".
  yearFilter: Set<number>;
  // Status axis: a chain matches when its derived status is in the
  // selected set. Empty set or full set means "no status filter".
  // Status semantics:
  //   open       — at least one HPP/Opp/Pursuit row, no closeWon/closeLost.
  //   closeWon   — at least one closeWon row.
  //   closeLost  — at least one closeLost row.
  statusFilter: Set<InfluenceStatus>;
  // Reference set of available years, used to detect the "full set
  // = no filter" sentinel without re-deriving from attributions.
  allYearsSet: Set<number>;
  // When provided, each deal card shows an edit pencil that opens the deal
  // editor with the given attribution id. Omit to keep the view read-only.
  onEditDeal?: (attributionId: string) => void;
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
  account?: string | null;
  // ISO date the deal entered this stage; rendered as a sub-label under
  // the stage node in the Sankey so each node shows both the stage and
  // when the deal got there.
  stageEnteredAt: string;
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

  // For stage nodes we render the stage label plus an optional
  // stage_entered_at sub-label one line below. When a date is present,
  // shift both lines so they're centered around the node's midline.
  const stageDate = isStage ? formatStageEnteredAt(payload.stageEnteredAt) : '';
  const stageHasDate = stageDate !== '';
  const stageLineHeight = 12;
  const stageLabelY = stageHasDate ? centerY - stageLineHeight / 2 : centerY;
  const stageDateY = stageHasDate ? centerY + stageLineHeight / 2 : centerY;

  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={color} rx={2} />
      {isStage ? (
        <>
          <text x={labelX} y={stageLabelY} textAnchor={anchor} dominantBaseline="central" fontSize={11} fill="#374151" fontWeight={600}>
            {payload.name}
          </text>
          {stageHasDate && (
            <text x={labelX} y={stageDateY} textAnchor={anchor} dominantBaseline="central" fontSize={9} fill="#9ca3af" fontWeight={400}>
              {stageDate}
            </text>
          )}
        </>
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

  // 1. Create touch nodes from the first (earliest) attribution's
  //    touches. Fallback path: when the deal has zero touches, or
  //    every touch resolves to an Unknown channel (e.g. backfilled
  //    2025 deals where the bulk-create flow's Touch section was
  //    left empty), synthesize a single "1st Touch" node from the
  //    earliest stage row's own channel_id. Mirrors the
  //    computeChannelSpend first-touch fallback so the Sankey and
  //    the Spend tab read the deal's channel the same way.
  //
  //    Acceptance: a deal whose HPP channel_id itself points at a
  //    since-deleted channel still resolves to Unknown — we don't
  //    paper over real data issues, we only paper over the missing-
  //    touch case.
  const resolvedTouches = firstAttr.touches.map((t) => ({
    channelId: t.channelId,
    parts: getChannelParts(t.channelId),
  }));
  const anyUsableTouch = resolvedTouches.some(
    (r) => r.parts.parentName !== 'Unknown',
  );
  const useFallback = resolvedTouches.length === 0 || !anyUsableTouch;

  const touchNodeIndices: number[] = [];
  if (useFallback) {
    // sorted[0] is already the chain's earliest row by STAGE_ORDER
    // (HPP first when present, else the lowest-ranked stage). Use
    // its channel_id as the implicit first touch.
    const fallbackChannelId = sorted[0]?.channelId ?? '';
    const parts = getChannelParts(fallbackChannelId);
    const ordinal = '1st Touch';
    const nodeKey = `touch:${parts.fullKey}@${ordinal}`;
    touchNodeIndices.push(
      getOrCreateNode(nodeKey, {
        name: parts.subName ? `${parts.parentName} - ${parts.subName}` : parts.parentName,
        parentName: parts.parentName,
        subName: parts.subName,
        touchPosition: 0,
        touchLabel: ordinal,
      }),
    );
  } else {
    for (let i = 0; i < resolvedTouches.length; i++) {
      const { parts } = resolvedTouches[i];
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
  }

  // 2. Create stage nodes for each stage the deal has reached. We carry
  //    stage_entered_at through on the payload so CustomNode can render
  //    it as a sub-label under the stage name.
  const stageNodeIndices: number[] = [];
  for (const attr of sorted) {
    const stageLabel = FUNNEL_STAGE_LABELS[attr.stageKey] || attr.stageKey;
    const stageNodeIdx = getOrCreateNode(`stage:${attr.stageKey}`, {
      name: stageLabel,
      isStage: true,
      stageKey: attr.stageKey,
      stageEnteredAt: attr.stageEnteredAt,
    });
    stageNodeIndices.push(stageNodeIdx);
  }

  // 3. Links: last touch → first stage (weighted by touch position).
  //    Synthetic fallback first-touch uses weight 1 (single thin
  //    ribbon) so it doesn't visually dominate stage-to-stage links.
  if (touchNodeIndices.length > 0 && stageNodeIndices.length > 0) {
    // All touches point to first stage
    for (let i = 0; i < touchNodeIndices.length; i++) {
      const weight = useFallback
        ? 1
        : TOUCH_WEIGHTS[Math.min(i, TOUCH_WEIGHTS.length - 1)];
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
    sortedNodes.push({
      name: sn.name,
      isStage: true,
      stageKey: sn.stageKey,
      stageEnteredAt: sn.stageEnteredAt,
    });
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
  account: string;
  highestStage: string;
  highestStageLabel: string;
  earliestAttr: OpportunityAttribution;
}

// Mini Sankey card for a deal journey (one or more stages)
function DealJourneySankeyCard({
  deal, index, getChannelParts, channelNameMap, onEditDeal,
}: {
  deal: DealGroup;
  index: number;
  getChannelParts: (id: string) => { parentName: string; subName?: string; fullKey: string };
  channelNameMap: Map<string, string>;
  onEditDeal?: (attributionId: string) => void;
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
        {onEditDeal && (
          <button
            type="button"
            onClick={() => onEditDeal(deal.earliestAttr.id)}
            title="Edit deal"
            aria-label="Edit deal"
            className="inline-flex items-center justify-center w-6 h-6 rounded text-slate-muted hover:bg-muted hover:text-charcoal flex-shrink-0"
          >
            <span className="text-sm">✎</span>
          </button>
        )}
      </div>
      <div className="w-full">
        <ResponsiveContainer
          width="100%"
          height={Math.max(100, data.nodes.length * 35)}
        >
          <Sankey
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
        </ResponsiveContainer>
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
  yearFilter,
  statusFilter,
  allYearsSet,
  onEditDeal,
}: CampaignInfluenceViewProps) {
  const [showAll, setShowAll] = useState(false);

  // Section-local filter state. Defaults match what the spec calls
  // out: Region defaults to "all five selected"; Channel defaults to
  // empty (treated as "no explicit selection = include everything").
  // Year/Status are independent upstream axes; toggling them no
  // longer wipes Region/Channel (multi-select is incremental, not a
  // mode switch).
  const [influenceRegions, setInfluenceRegions] = useState<Set<RegionKey>>(
    () => new Set(REGIONS),
  );
  const [influenceParentChannels, setInfluenceParentChannels] = useState<
    Set<string>
  >(() => new Set());
  // Free-text search over opportunity name (label) OR account name.
  const [influenceSearch, setInfluenceSearch] = useState('');

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

  // Reshape every attribution into the DataVis-shape inline-touches
  // form. No region/channel narrowing here — those filters apply
  // downstream so the chip-count derivations have an un-narrowed base
  // to work from.
  const opportunityAttributions: OpportunityAttribution[] = useMemo(() => {
    return attributions.map((a) => {
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
        account: a.account ?? '',
        stageEnteredAt: a.stage_entered_at,
        touches,
      };
    });
  }, [attributions, touchesByAttribution]);

  // Per-attribution region lookup (so a deal-level "any attribution
  // in selected region" check doesn't need to re-walk the original
  // attribution list).
  const regionByAttrId = useMemo(() => {
    const m = new Map<string, RegionKey | null>();
    for (const a of attributions) {
      m.set(a.id, (a.region as RegionKey | null) ?? null);
    }
    return m;
  }, [attributions]);

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

  // Resolve a channel id up to its top-level (root) channel id. The
  // Channel chip filter operates on parents, so any sub-channel rolls
  // up to its parent for membership. Cycles are guarded just in case
  // of malformed parent chains.
  const topLevelIdOf = useCallback(
    (channelId: string): string => {
      let cur: string | undefined = channelId;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const node = channels.find((c) => c.id === cur);
        if (!node) return channelId;
        if (!node.parent_channel_id) return cur;
        cur = node.parent_channel_id;
      }
      return channelId;
    },
    [channels],
  );

  // Group every reshaped attribution by deal_id. Singleton attributions
  // (no deal_id) become their own group keyed by attribution id so the
  // Sankey still has something to render.
  const allGroups: DealGroup[] = useMemo(() => {
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
          account: attr.account || '',
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
      group.account = group.attributions.find((a) => a.account)?.account || '';
    }
    return [...groupMap.values()];
  }, [opportunityAttributions]);

  // Apply Year and Status filters. This is the base set for the
  // Region chip counts and the next narrowing steps. Each axis uses
  // the empty-set OR full-set "no filter" sentinel so toggling all
  // pills off (or all on) is equivalent to "everything".
  const tabFilteredGroups = useMemo(() => {
    const yearActive =
      yearFilter.size > 0 && yearFilter.size < allYearsSet.size;
    const statusActive = statusFilter.size > 0 && statusFilter.size < 3;
    return allGroups.filter((g) => {
      if (yearActive) {
        const yearOk = g.attributions.some((a) => yearFilter.has(a.year));
        if (!yearOk) return false;
      }
      if (statusActive) {
        const hasOpen = g.attributions.some(
          (a) =>
            a.stageKey === 'hpp' ||
            a.stageKey === 'opp' ||
            a.stageKey === 'pursuit',
        );
        const hasWon = g.attributions.some((a) => a.stageKey === 'closeWon');
        const hasLost = g.attributions.some((a) => a.stageKey === 'closeLost');
        // Open = hpp/opp/pursuit present AND no closeWon/closeLost.
        // Matches the isDealOpen contract used by the Opportunities
        // donuts so the section reconciles with the page's other
        // open-pipeline surfaces.
        const isOpen = hasOpen && !hasWon && !hasLost;
        const ok =
          (statusFilter.has('open') && isOpen) ||
          (statusFilter.has('closeWon') && hasWon) ||
          (statusFilter.has('closeLost') && hasLost);
        if (!ok) return false;
      }
      return true;
    });
  }, [allGroups, yearFilter, statusFilter, allYearsSet]);

  // Region chip counts: for each region R, how many tab-in-scope
  // deals have any attribution in R. Drives the chip's enabled/
  // muted appearance and matches the spec's "smart" affordance. A
  // deal can contribute to multiple regions if its chain spans them.
  const regionChipCounts = useMemo(() => {
    const counts: Record<RegionKey, number> = {} as Record<RegionKey, number>;
    for (const r of REGIONS) counts[r] = 0;
    for (const g of tabFilteredGroups) {
      const seen = new Set<RegionKey>();
      for (const a of g.attributions) {
        const r = regionByAttrId.get(a.id);
        if (r && (REGIONS as readonly string[]).includes(r) && !seen.has(r)) {
          seen.add(r);
          counts[r] += 1;
        }
      }
    }
    return counts;
  }, [tabFilteredGroups, regionByAttrId]);

  // Region filter: drop a deal when none of its attributions sit in
  // a selected region. Spec semantic — deal-level filtering, not
  // attribution-level pruning. A multi-region deal still renders its
  // full chain when any of its regions match.
  const regionFilteredGroups = useMemo(() => {
    // Both "empty set" and "all five selected" mean no filter.
    if (
      influenceRegions.size === 0 ||
      influenceRegions.size === REGIONS.length
    ) {
      return tabFilteredGroups;
    }
    return tabFilteredGroups.filter((g) =>
      g.attributions.some((a) => {
        const r = regionByAttrId.get(a.id);
        return r ? influenceRegions.has(r) : false;
      }),
    );
  }, [tabFilteredGroups, influenceRegions, regionByAttrId]);

  // Available parent channels for the Channel dropdown: every
  // top-level channel that has at least one deal in the tab+region-
  // in-scope set. Sorted alphabetically so the dropdown is easy to
  // scan; the previous count-desc ordering on the chip row made the
  // top entries jump around as the user toggled filters.
  const availableChannels = useMemo(() => {
    const seen = new Map<string, { name: string }>();
    for (const g of regionFilteredGroups) {
      const seenForGroup = new Set<string>();
      for (const a of g.attributions) {
        if (!a.channelId) continue;
        const topId = topLevelIdOf(a.channelId);
        if (seenForGroup.has(topId)) continue;
        seenForGroup.add(topId);
        if (!seen.has(topId)) {
          seen.set(topId, { name: channelNameMap.get(topId) ?? 'Unknown' });
        }
      }
    }
    return [...seen.entries()]
      .map(([id, v]) => ({ id, name: v.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [regionFilteredGroups, topLevelIdOf, channelNameMap]);

  // Channel filter: when a non-empty parent set is selected, keep
  // only deals where at least one attribution's top-level channel is
  // in the set. Empty set means "no explicit selection = include
  // everything".
  const displayedGroups = useMemo(() => {
    let groups = regionFilteredGroups;
    // Text search: opportunity name OR account name, case-insensitive
    // substring. Composes with the Region/Channel/Year/Status filters.
    const q = influenceSearch.trim().toLowerCase();
    if (q) {
      groups = groups.filter(
        (g) =>
          g.label.toLowerCase().includes(q) ||
          g.account.toLowerCase().includes(q),
      );
    }
    if (influenceParentChannels.size > 0) {
      groups = groups.filter((g) =>
        g.attributions.some((a) => {
          if (!a.channelId) return false;
          return influenceParentChannels.has(topLevelIdOf(a.channelId));
        }),
      );
    }
    // Sort: open deals (current stage HPP/Opp/Pursuit) before terminal
    // deals (closeWon/closeLost). Within each bucket, newest first —
    // open deals by HPP stage_entered_at (or the earliest stage_entered_at
    // if there's no HPP row), terminal deals by the terminal stage's
    // stage_entered_at.
    const isTerminalStage = (s: string) =>
      s === 'closeWon' || s === 'closeLost';
    const sortDate = (g: DealGroup): string => {
      const cur = g.highestStage;
      if (isTerminalStage(cur)) {
        const terminal = g.attributions.find((a) => a.stageKey === cur);
        return terminal?.stageEnteredAt ?? '';
      }
      const hpp = g.attributions.find((a) => a.stageKey === 'hpp');
      if (hpp) return hpp.stageEnteredAt;
      return [...g.attributions]
        .sort((a, b) => a.stageEnteredAt.localeCompare(b.stageEnteredAt))[0]
        .stageEnteredAt;
    };
    return [...groups].sort((a, b) => {
      const aTerm = isTerminalStage(a.highestStage);
      const bTerm = isTerminalStage(b.highestStage);
      if (aTerm !== bTerm) return aTerm ? 1 : -1;
      return sortDate(b).localeCompare(sortDate(a));
    });
  }, [regionFilteredGroups, influenceParentChannels, influenceSearch, topLevelIdOf]);

  const toggleRegion = (r: RegionKey) => {
    setInfluenceRegions((prev) => {
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });
  };
  const clearRegions = () => setInfluenceRegions(new Set(REGIONS));
  const clearChannels = () => setInfluenceParentChannels(new Set());

  const filterBar = (
    <div className="pl-3 border-l-2 border-border space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-slate-muted mr-1 w-14">Search</span>
        <button
          type="button"
          onClick={() => setInfluenceSearch('')}
          className="text-xs px-2 py-1 rounded-full border border-border text-slate-muted hover:text-charcoal hover:border-charcoal/30"
        >
          Clear
        </button>
        <input
          type="text"
          value={influenceSearch}
          onChange={(e) => setInfluenceSearch(e.target.value)}
          placeholder="Opportunity or account name"
          className="text-xs px-2 py-1 rounded border border-border bg-bg text-charcoal min-w-[240px] focus:outline-none focus:ring-2 focus:ring-indigo/30"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-slate-muted mr-1 w-14">Region</span>
        <button
          type="button"
          onClick={clearRegions}
          className="text-xs px-2 py-1 rounded-full border border-border text-slate-muted hover:text-charcoal hover:border-charcoal/30"
        >
          Clear
        </button>
        {REGIONS.map((r) => {
          const on = influenceRegions.has(r);
          const empty = regionChipCounts[r] === 0;
          const cls = on
            ? 'bg-indigo text-white border-indigo'
            : empty
              ? 'bg-bg text-slate-muted/60 border-border/60'
              : 'bg-bg text-charcoal border-border hover:border-charcoal/30';
          return (
            <button
              key={r}
              type="button"
              onClick={() => toggleRegion(r)}
              title={
                empty
                  ? `${REGION_LABELS[r]}: no deals in this tab`
                  : REGION_LABELS[r]
              }
              className={`text-xs px-2 py-1 rounded-full border transition-colors ${cls}`}
            >
              {r}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-slate-muted mr-1 w-14">Channel</span>
        <button
          type="button"
          onClick={clearChannels}
          className="text-xs px-2 py-1 rounded-full border border-border text-slate-muted hover:text-charcoal hover:border-charcoal/30"
        >
          Clear
        </button>
        <ChannelDropdown
          available={availableChannels}
          selected={influenceParentChannels}
          onSetChecked={(id, checked) => {
            setInfluenceParentChannels((prev) => {
              // Empty set means "include everything" by convention.
              // The first uncheck from that default has to first
              // materialize the full set so we can then drop the
              // clicked id — otherwise we'd flip into "1 selected"
              // when the user expected "N-1 selected".
              const base =
                prev.size === 0
                  ? new Set(availableChannels.map((c) => c.id))
                  : new Set(prev);
              if (checked) base.add(id);
              else base.delete(id);
              return base;
            });
          }}
          onSelectAll={() =>
            setInfluenceParentChannels(
              new Set(availableChannels.map((c) => c.id)),
            )
          }
          onClear={clearChannels}
        />
      </div>
    </div>
  );

  if (displayedGroups.length === 0) {
    return (
      <div className="space-y-3">
        {filterBar}
        <p className="text-xs text-slate-muted italic">
          No deals match the current filters.
        </p>
      </div>
    );
  }

  const shown = showAll ? displayedGroups : displayedGroups.slice(0, PAGE);

  return (
    <div className="space-y-3">
      {filterBar}
      {shown.map((deal, idx) => (
        <DealJourneySankeyCard
          key={deal.dealId}
          deal={deal}
          index={idx}
          getChannelParts={getChannelParts}
          channelNameMap={channelNameMap}
          onEditDeal={onEditDeal}
        />
      ))}
      {displayedGroups.length > PAGE && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs text-indigo hover:underline"
        >
          {showAll
            ? `Show first ${PAGE} only`
            : `Show all ${displayedGroups.length} cards`}
        </button>
      )}
    </div>
  );
}

// Compact multi-select for the Channel filter. Button label adapts
// to the current selection: "All channels" when nothing's explicitly
// selected (empty set means "include everything" per the filter
// contract), a single channel name when one is on, "N channels"
// otherwise. Panel opens just below the button, closes on outside
// click / Escape / re-clicking the button. Selections apply
// immediately as the user toggles them.
interface ChannelOption {
  id: string;
  name: string;
}

function ChannelDropdown({
  available,
  selected,
  onSetChecked,
  onSelectAll,
  onClear,
}: {
  available: ChannelOption[];
  selected: Set<string>;
  // Set the checkbox state for one channel. Implemented at the call
  // site so the parent owns the "empty set = all included" idiom
  // (materializing the full set on the first uncheck-from-default
  // happens there, not here).
  onSetChecked: (id: string, checked: boolean) => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const empty = available.length === 0;

  // Close on outside click + Escape. Both listeners are bound only
  // while the panel is open so the component is quiet at rest.
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

  // Force-close when the available set drops to zero (e.g. user
  // switched to a tab with no in-scope channels). Keeps the panel
  // from sticking around with stale chips.
  useEffect(() => {
    if (empty && open) setOpen(false);
  }, [empty, open]);

  const label = (() => {
    if (selected.size === 0 || selected.size === available.length) {
      return 'All channels';
    }
    if (selected.size === 1) {
      const onlyId = [...selected][0];
      const match = available.find((c) => c.id === onlyId);
      return match?.name ?? '1 channel';
    }
    return `${selected.size} channels`;
  })();

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          if (empty) return;
          setOpen((v) => !v);
        }}
        disabled={empty}
        title={empty ? 'No channels in scope' : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={
          'text-xs px-2 py-1 rounded-full border inline-flex items-center gap-1 ' +
          (empty
            ? 'bg-bg text-slate-muted/60 border-border/60 cursor-not-allowed'
            : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
        }
      >
        <span>{label}</span>
        <span className="text-[10px] leading-none">▾</span>
      </button>
      {open && !empty && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="absolute top-full left-0 mt-1 z-10 min-w-[12rem] max-h-72 overflow-y-auto bg-bg border border-border rounded shadow-sm"
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
            {available.map((c) => {
              // Empty selection means "all included" per the filter
              // contract, so render every checkbox checked in that
              // state so the user can confidently toggle one off.
              const allChecked = selected.size === 0;
              const checked = allChecked || selected.has(c.id);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={checked}
                    onClick={() => onSetChecked(c.id, !checked)}
                    className="w-full flex items-center gap-2 px-2 py-1 text-xs text-charcoal hover:bg-muted text-left"
                  >
                    <span
                      aria-hidden="true"
                      className={
                        'inline-flex items-center justify-center w-3.5 h-3.5 rounded border ' +
                        (checked
                          ? 'bg-indigo border-indigo text-white'
                          : 'bg-bg border-border')
                      }
                    >
                      {checked ? '✓' : ''}
                    </span>
                    <span className="flex-1">{c.name}</span>
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
