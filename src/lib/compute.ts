import type {
  Attribution,
  AttributionStageKey,
  Channel,
  FunnelActual,
  FunnelProjection,
  Lead,
  PeriodIndex,
} from '../types/db';
import { REGIONS, type RegionKey } from '../constants/regions';
import {
  FUNNEL_STAGES,
  type FunnelStageKey,
} from '../constants/funnelStages';
import { quarterOfIsoDate, isoWeekOf, type IsoWeek } from './dates';

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
  // M7: attribution-driven counts for the four attribution stages. Optional
  // on the input shape so callers that don't need attributions (early tests,
  // fixtures) can pass minimal input without crashing.
  attributions?: Attribution[];
  year: number;
  filter: PeriodFilter;
  // Multi-select region filter. When undefined or fully populated (all five
  // regions), no filtering happens. When partial, leads and attributions
  // outside the selected regions are excluded. Null-region rows are
  // excluded under partial filters.
  regions?: Set<RegionKey>;
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

// Region filter helper. Returns true when the row should be included.
// Undefined regions or a fully-populated set means "no filter, include
// everything." A partial set excludes rows whose region is null/undefined
// or not in the set.
function regionMatches(
  rowRegion: RegionKey | string | null | undefined,
  regions: Set<RegionKey> | undefined,
): boolean {
  if (!regions) return true;
  if (regions.size === REGIONS.length) return true;
  if (!rowRegion) return false;
  return regions.has(rowRegion as RegionKey);
}

export function computeGrid(input: ComputeInput): ComputedGrid {
  const {
    leads,
    channels,
    projections,
    manualActuals,
    attributions = [],
    year,
    filter,
    regions,
  } = input;

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
  //    into its source channel's own counts. Region filter is applied at
  //    the top of each iteration so a filtered-out lead doesn't contribute
  //    to grid totals OR to the unassigned count.
  let unassignedLeadCount = 0;
  for (const l of leads) {
    if (!regionMatches(l.region, regions)) continue;
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

  // 3. Attribution-stage actuals (HPP / Opp / Pursuit / CloseWon).
  //
  //    Prefer count(attributions where channel_id, year, period_index,
  //    stage_key match) over funnel_actuals when one or more attribution
  //    rows exist for that exact cell. Fall back to funnel_actuals only
  //    when no attribution covers the cell — this keeps the old cell-edit
  //    path working through the migration window.
  //
  //    M8 cleanup note: once teams commit to attribution-only data entry,
  //    drop the manualActuals fallback (and useFunnelActuals + the
  //    funnel_actuals table itself can be retired).
  const attribKey = (cid: string, y: number, p: number, s: string): string =>
    `${cid}\x1f${y}\x1f${p}\x1f${s}`;

  // Count attributions per (channel, year, period, stage). One attribution row
  // contributes 1 to its leaf channel's stage cell. Channel rollup to parents
  // happens later in step 5. Region filter applied per attribution.
  const handledByAttribution = new Set<string>();
  for (const a of attributions) {
    if (!a.channel_id) continue;
    if (!regionMatches(a.region, regions)) continue;
    const bucket = { year: a.year, quarter: a.period_index };
    if (!matchesPeriod(bucket, year, filter)) continue;
    const row = rowMap.get(a.channel_id);
    if (!row) continue;
    const cell = row.cells[a.stage_key];
    cell.actual = (cell.actual ?? 0) + 1;
    handledByAttribution.add(
      attribKey(a.channel_id, a.year, a.period_index, a.stage_key),
    );
  }

  // Manual fallback: only contribute when no attribution covers this exact
  // (channel, year, period, stage) cell.
  for (const m of manualActuals) {
    if (m.actual === null || m.actual === undefined) continue;
    const bucket = { year: m.year, quarter: m.period_index };
    if (!matchesPeriod(bucket, year, filter)) continue;
    if (
      handledByAttribution.has(
        attribKey(m.channel_id, m.year, m.period_index, m.stage_key),
      )
    ) {
      continue;
    }
    const row = rowMap.get(m.channel_id);
    if (!row) continue;
    const cell = row.cells[m.stage_key];
    cell.actual = (cell.actual ?? 0) + m.actual;
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
  return (
    s === 'hpp' ||
    s === 'opp' ||
    s === 'pursuit' ||
    s === 'closeWon' ||
    s === 'closeLost'
  );
}

// ---------- Weekly compute (Compare tab) ----------

export interface WeeklyCellValues {
  // counts[i] is the actual for the ISO week at weekIndices[i].
  counts: number[];
}

export interface WeeklyRow {
  channelId: string;
  hasChildren: boolean;
  parentId: string | null;
  depth: number;
  ancestors: string[];
  cells: Record<FunnelStageKey, WeeklyCellValues>;
}

export interface WeeklyGrid {
  // Order matches input weekIndices.
  weeks: IsoWeek[];
  rows: WeeklyRow[];
  totals: Record<FunnelStageKey, WeeklyCellValues>;
  unassignedLeadCount: number;
}

export interface ComputeWeeklyInput {
  leads: Lead[];
  channels: Channel[];
  attributions?: Attribution[];
  // ISO weeks to bucket into; results preserve order.
  weeks: IsoWeek[];
  regions?: Set<RegionKey>;
}

function weekKey(w: IsoWeek): string {
  return `${w.year}-${w.week}`;
}

function emptyWeeklyCells(numWeeks: number): Record<FunnelStageKey, WeeklyCellValues> {
  const out = {} as Record<FunnelStageKey, WeeklyCellValues>;
  for (const s of FUNNEL_STAGES) {
    out[s] = { counts: new Array<number>(numWeeks).fill(0) };
  }
  return out;
}

// Compute per-channel × stage actuals bucketed by ISO week. Lead and MQL
// counts come from leads.marketing_sourced_date and stage_history. HPP / Opp /
// Pursuit / CloseWon counts come from attributions.created_at — i.e., the week
// the deal was logged at that stage, NOT the underlying transition date in
// SFDC. This matches how the Funnel Data Entry tab attributes deals (one row
// per stage) and keeps the math consistent with quarterly compute.
export function computeWeekly(input: ComputeWeeklyInput): WeeklyGrid {
  const { leads, channels, attributions = [], weeks, regions } = input;
  const numWeeks = weeks.length;
  const weekIndex = new Map<string, number>();
  weeks.forEach((w, i) => weekIndex.set(weekKey(w), i));

  // 1. Initialize rows.
  const rowMap = new Map<string, WeeklyRow>();
  for (const c of channels) {
    rowMap.set(c.id, {
      channelId: c.id,
      hasChildren: false,
      parentId: c.parent_channel_id ?? null,
      depth: 1,
      ancestors: [],
      cells: emptyWeeklyCells(numWeeks),
    });
  }

  // 2. Lead pass.
  let unassignedLeadCount = 0;
  for (const l of leads) {
    if (!regionMatches(l.region, regions)) continue;
    const leadWeek = isoWeekOf(l.marketing_sourced_date);
    if (leadWeek) {
      const idx = weekIndex.get(weekKey(leadWeek));
      if (idx !== undefined) {
        if (!l.source_channel_id) {
          unassignedLeadCount += 1;
        } else {
          const row = rowMap.get(l.source_channel_id);
          if (row) row.cells.lead.counts[idx] += 1;
        }
      }
    }
    const mqlIso = firstMqlDate(l);
    if (mqlIso) {
      const mqlWeek = isoWeekOf(mqlIso);
      if (mqlWeek) {
        const idx = weekIndex.get(weekKey(mqlWeek));
        if (idx !== undefined && l.source_channel_id) {
          const row = rowMap.get(l.source_channel_id);
          if (row) row.cells.mql.counts[idx] += 1;
        }
      }
    }
  }

  // 3. Attribution pass: bucket by created_at week (week-of-creation, not
  //    week-of-stage-transition; see the doc comment above).
  for (const a of attributions) {
    if (!a.channel_id) continue;
    if (!regionMatches(a.region, regions)) continue;
    const w = isoWeekOf(a.created_at);
    if (!w) continue;
    const idx = weekIndex.get(weekKey(w));
    if (idx === undefined) continue;
    const row = rowMap.get(a.channel_id);
    if (!row) continue;
    row.cells[a.stage_key].counts[idx] += 1;
  }

  // 4. Tree rollup. Mirrors computeGrid: parents get their own + sum of all
  //    descendants.
  const childrenByParent = new Map<string, string[]>();
  for (const c of channels) {
    if (!c.parent_channel_id) continue;
    const arr = childrenByParent.get(c.parent_channel_id) ?? [];
    arr.push(c.id);
    childrenByParent.set(c.parent_channel_id, arr);
  }
  const rolledUp = new Set<string>();
  const rollup = (nodeId: string): void => {
    if (rolledUp.has(nodeId)) return;
    rolledUp.add(nodeId);
    const node = rowMap.get(nodeId);
    if (!node) return;
    for (const cid of childrenByParent.get(nodeId) ?? []) {
      rollup(cid);
      const childRow = rowMap.get(cid);
      if (!childRow) continue;
      for (const stage of FUNNEL_STAGES) {
        for (let i = 0; i < numWeeks; i++) {
          node.cells[stage].counts[i] += childRow.cells[stage].counts[i];
        }
      }
    }
  };
  for (const c of channels) {
    if (!c.parent_channel_id) rollup(c.id);
  }

  // 5. DFS ordering.
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
  const orderedRows: WeeklyRow[] = [];
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

  // 6. Totals: sum across roots.
  const totals = emptyWeeklyCells(numWeeks);
  for (const c of channels) {
    if (c.parent_channel_id) continue;
    const r = rowMap.get(c.id);
    if (!r) continue;
    for (const stage of FUNNEL_STAGES) {
      for (let i = 0; i < numWeeks; i++) {
        totals[stage].counts[i] += r.cells[stage].counts[i];
      }
    }
  }

  return { weeks, rows: orderedRows, totals, unassignedLeadCount };
}
