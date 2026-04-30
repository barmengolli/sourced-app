import type {
  AttributionStageKey,
  Channel,
  FunnelActual,
  FunnelProjection,
  Lead,
  PeriodIndex,
} from '../types/db';
import {
  FUNNEL_STAGES,
  type FunnelStageKey,
} from '../constants/funnelStages';
import { quarterOfIsoDate } from './dates';

export type PeriodFilter = 'year' | 'Q1' | 'Q2' | 'Q3' | 'Q4';

export interface CellValues {
  actual: number | null;
  projection: number | null;
}

export interface ComputedRow {
  channelId: string;
  // True when any other channel points at this one as parent. Renamed from
  // isParent because under N-level the binary parent/child distinction
  // collapses — every non-leaf is a "parent" of something.
  hasChildren: boolean;
  parentId: string | null;
  // 1 = top-level, 2 = direct child of a root, 3 = grandchild, ...
  depth: number;
  // Ordered ancestor channel ids, root → immediate parent. Empty for roots.
  // Used by the table to test "is any of my ancestors collapsed?" without
  // re-walking the tree on every render.
  ancestors: string[];
  cells: Record<FunnelStageKey, CellValues>;
}

export interface ComputedGrid {
  rows: ComputedRow[];
  totals: Record<FunnelStageKey, CellValues>;
  unassignedLeadCount: number;
}

interface ComputeInput {
  leads: Lead[];
  channels: Channel[];
  projections: FunnelProjection[];
  manualActuals: FunnelActual[];
  year: number;
  filter: PeriodFilter;
}

function emptyCells(): Record<FunnelStageKey, CellValues> {
  const out = {} as Record<FunnelStageKey, CellValues>;
  for (const s of FUNNEL_STAGES) {
    out[s] = { actual: null, projection: null };
  }
  return out;
}

function matchesPeriod(
  bucket: { year: number; quarter: PeriodIndex },
  year: number,
  filter: PeriodFilter,
): boolean {
  if (bucket.year !== year) return false;
  if (filter === 'year') return true;
  return `Q${bucket.quarter}` === filter;
}

// Find the earliest stage_history entry whose stage === 'mql'. Returns the
// entered_at ISO string, or null if the lead never reached MQL.
function firstMqlDate(lead: Lead): string | null {
  let best: string | null = null;
  for (const e of lead.stage_history ?? []) {
    if (e.stage !== 'mql' || !e.entered_at) continue;
    if (best === null || e.entered_at < best) best = e.entered_at;
  }
  return best;
}

export function computeGrid(input: ComputeInput): ComputedGrid {
  const { leads, channels, projections, manualActuals, year, filter } = input;

  // 1. Initialize per-channel rows (own counts only at this stage; rollup
  //    happens after the lead pass). hasChildren / depth / ancestors are
  //    placeholders and get filled in during step 6 (DFS ordering).
  const rowMap = new Map<string, ComputedRow>();
  for (const c of channels) {
    rowMap.set(c.id, {
      channelId: c.id,
      hasChildren: false,
      parentId: c.parent_channel_id ?? null,
      depth: 1,
      ancestors: [],
      cells: emptyCells(),
    });
  }

  // 2. Lead pass: bucket each lead's lead-stage and (optional) mql-stage
  //    into its source channel's own counts.
  let unassignedLeadCount = 0;
  for (const l of leads) {
    // Lead stage: bucket by marketing_sourced_date.
    const leadBucket = quarterOfIsoDate(l.marketing_sourced_date);
    if (leadBucket && matchesPeriod(leadBucket, year, filter)) {
      if (!l.source_channel_id) {
        unassignedLeadCount += 1;
      } else {
        const row = rowMap.get(l.source_channel_id);
        if (row) {
          const cell = row.cells.lead;
          cell.actual = (cell.actual ?? 0) + 1;
        }
      }
    }
    // MQL stage: bucket by first stage_history entry where stage === 'mql'.
    const mqlIso = firstMqlDate(l);
    if (mqlIso) {
      const mqlBucket = quarterOfIsoDate(mqlIso);
      if (mqlBucket && matchesPeriod(mqlBucket, year, filter)) {
        if (l.source_channel_id) {
          const row = rowMap.get(l.source_channel_id);
          if (row) {
            const cell = row.cells.mql;
            cell.actual = (cell.actual ?? 0) + 1;
          }
        }
      }
    }
  }

  // 3. Manual actuals (HPP / Opp / Pursuit / CloseWon).
  for (const a of manualActuals) {
    if (a.actual === null || a.actual === undefined) continue;
    const bucket = { year: a.year, quarter: a.period_index };
    if (!matchesPeriod(bucket, year, filter)) continue;
    const row = rowMap.get(a.channel_id);
    if (!row) continue;
    const cell = row.cells[a.stage_key];
    cell.actual = (cell.actual ?? 0) + a.actual;
  }

  // 4. Projections (all 6 stages).
  for (const p of projections) {
    if (p.projection === null || p.projection === undefined) continue;
    const bucket = { year: p.year, quarter: p.period_index };
    if (!matchesPeriod(bucket, year, filter)) continue;
    const row = rowMap.get(p.channel_id);
    if (!row) continue;
    const stage = p.stage_key as FunnelStageKey;
    if (!FUNNEL_STAGES.includes(stage)) continue;
    const cell = row.cells[stage];
    cell.projection = (cell.projection ?? 0) + p.projection;
  }

  // 5. Tree rollup (recursive, N-level). Each node's actuals become own +
  //    sum of children's rolled-up actuals, computed post-order. Projections
  //    are NOT rolled up — parents own their projection independently in
  //    funnel_projections (keyed by channel_id). OT% on a non-leaf is
  //    `rolled-up actual / node's own projection`.
  const childrenByParent = new Map<string, string[]>();
  for (const c of channels) {
    if (!c.parent_channel_id) continue;
    const arr = childrenByParent.get(c.parent_channel_id) ?? [];
    arr.push(c.id);
    childrenByParent.set(c.parent_channel_id, arr);
  }

  const rolledUp = new Set<string>();
  const rollupActuals = (nodeId: string): void => {
    if (rolledUp.has(nodeId)) return;
    rolledUp.add(nodeId);
    const node = rowMap.get(nodeId);
    if (!node) return;
    const children = childrenByParent.get(nodeId) ?? [];
    for (const cid of children) {
      rollupActuals(cid);
      const childRow = rowMap.get(cid);
      if (!childRow) continue;
      for (const stage of FUNNEL_STAGES) {
        const pc = node.cells[stage];
        const cc = childRow.cells[stage];
        if (cc.actual !== null) pc.actual = (pc.actual ?? 0) + cc.actual;
      }
    }
  };
  for (const c of channels) {
    if (!c.parent_channel_id) rollupActuals(c.id);
  }

  // 6. Depth-first row ordering. Each root, then all of its descendants in
  //    DFS order. Fills depth, ancestors, and hasChildren on each row as it
  //    visits.
  const sortKey = (c: Channel): [number, string] => [c.display_order, c.name];
  const cmp = (a: Channel, b: Channel) => {
    const [ao, an] = sortKey(a);
    const [bo, bn] = sortKey(b);
    if (ao !== bo) return ao - bo;
    return an.localeCompare(bn);
  };
  const channelById = new Map(channels.map((c) => [c.id, c] as const));
  const sortedChildren = (parentId: string | null): Channel[] => {
    const ids =
      parentId === null
        ? channels.filter((c) => !c.parent_channel_id).map((c) => c.id)
        : (childrenByParent.get(parentId) ?? []);
    return ids
      .map((id) => channelById.get(id))
      .filter((c): c is Channel => Boolean(c))
      .slice()
      .sort(cmp);
  };

  const orderedRows: ComputedRow[] = [];
  const visit = (nodeId: string, depth: number, ancestors: string[]): void => {
    const channel = channelById.get(nodeId);
    if (!channel) return;
    const row = rowMap.get(nodeId);
    if (!row) return;
    row.depth = depth;
    row.ancestors = ancestors;
    row.hasChildren = (childrenByParent.get(nodeId)?.length ?? 0) > 0;
    orderedRows.push(row);
    for (const child of sortedChildren(nodeId)) {
      visit(child.id, depth + 1, [...ancestors, nodeId]);
    }
  };
  for (const root of sortedChildren(null)) {
    visit(root.id, 1, []);
  }

  // Defensive: pick up any rowMap entries that DFS missed (would happen if a
  // channel has parent_channel_id pointing at an id that doesn't exist).
  const seen = new Set(orderedRows.map((r) => r.channelId));
  for (const c of channels) {
    if (seen.has(c.id)) continue;
    const row = rowMap.get(c.id);
    if (!row) continue;
    row.depth = 1;
    row.ancestors = [];
    row.hasChildren = false;
    orderedRows.push(row);
  }

  // 7. Totals: sum across roots (depth-1 rows). Each root carries its full
  //    subtree's rolled-up actual, so this never double-counts.
  const totals = emptyCells();
  for (const c of channels) {
    if (c.parent_channel_id) continue;
    const r = rowMap.get(c.id);
    if (!r) continue;
    for (const stage of FUNNEL_STAGES) {
      const t = totals[stage];
      const cc = r.cells[stage];
      if (cc.actual !== null) t.actual = (t.actual ?? 0) + cc.actual;
      if (cc.projection !== null)
        t.projection = (t.projection ?? 0) + cc.projection;
    }
  }

  return { rows: orderedRows, totals, unassignedLeadCount };
}

// Conversion %: numerator / denominator * 100. null if denom is 0 or null.
export function conversionPercent(
  num: number | null,
  den: number | null,
): number | null {
  if (num === null || den === null) return null;
  if (den === 0) return null;
  return (num / den) * 100;
}

// On-target %: actual / projection. null if projection is 0/null.
export function onTargetPercent(
  actual: number | null,
  projection: number | null,
): number | null {
  if (actual === null || projection === null || projection === 0) return null;
  return (actual / projection) * 100;
}

// Funnel efficiency: actual at this stage / actual at previous stage.
export function funnelEfficiencyPercent(
  thisActual: number | null,
  prevActual: number | null,
): number | null {
  if (thisActual === null || prevActual === null || prevActual === 0)
    return null;
  return (thisActual / prevActual) * 100;
}

// Used by the manual-actual upsert UI; returns the AttributionStageKey type
// guard since FunnelStageKey is wider.
export function isAttributionStage(
  s: FunnelStageKey,
): s is AttributionStageKey {
  return s === 'hpp' || s === 'opp' || s === 'pursuit' || s === 'closeWon';
}
