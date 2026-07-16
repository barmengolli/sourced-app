import type {
  Attribution,
  AttributionStageKey,
  AttributionTouch,
  BdrQuota,
  CampaignCost,
  Channel,
  FunnelActual,
  FunnelProjection,
  Lead,
  PeriodIndex,
} from '../types/db';
import {
  BDRS,
  BDR_OPTIONS,
  BDR_STAGES,
  type BdrStage,
} from '../constants/bdr';
import { type RegionKey } from '../constants/regions';
import {
  REGION_STAGE_PRIORITY,
  deriveDealRegion,
  matchesRegionFilter,
} from './regionFilter';
import {
  FUNNEL_STAGES,
  PROJ_ROLLUP_STAGES,
  type FunnelStageKey,
} from '../constants/funnelStages';
import { quarterOfIsoDate, isoWeekOf, type IsoWeek } from './dates';
import { VELOCITY_THRESHOLDS } from '../constants/velocityThresholds';
import {
  EVENT_ACTIVATION_VALUES,
  type EventActivation,
} from '../constants/eventActivations';

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

  // Shared dedupe-key shape for the "compute pass wins, funnel_actuals
  // is fallback" pattern below. Used by both the leads pass (lead/mql)
  // and the attribution pass (hpp/opp/pursuit/closeWon/closeLost).
  const attribKey = (cid: string, y: number, p: number, s: string): string =>
    `${cid}\x1f${y}\x1f${p}\x1f${s}`;

  // 2. Lead pass: bucket each lead's lead-stage and (optional) mql-stage
  //    into its source channel's own counts. Region filter is applied at
  //    the top of each iteration so a filtered-out lead doesn't contribute
  //    to grid totals OR to the unassigned count.
  //
  //    Strict-cohort rule (MQL column): a lead only counts toward an
  //    (channel, period) MQL cell when BOTH its marketing_sourced_date
  //    AND any 'mql' stage_history entry fall in the same period. This
  //    keeps the Data Entry grid coherent for conversion-rate math:
  //    every cell counts members of the period's own cohort whose
  //    transition at this stage was also in the period. Cross-period
  //    transitions (a 2025 lead that converted to MQL in 2026) are
  //    intentionally invisible from the grid; the Opportunity Influence
  //    tabs on the Opportunities sub-tab surface them.
  //
  //    The manual fallback below dedupes against sourceCoverage (built from raw
  //    records before filtering), not against what these loops land, so a
  //    filtered-to-zero source cell is still treated as covered.
  let unassignedLeadCount = 0;
  for (const l of leads) {
    if (!matchesRegionFilter(l.region, regions)) continue;
    // Lead stage: bucket by marketing_sourced_date.
    const leadBucket = quarterOfIsoDate(l.marketing_sourced_date);
    const leadInPeriod = Boolean(
      leadBucket && matchesPeriod(leadBucket, year, filter),
    );
    if (leadInPeriod && leadBucket) {
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
    // MQL stage: strict cohort. Only count when the lead's own
    // marketing_sourced_date is ALSO in the selected period; otherwise
    // the MQL belongs to a different cohort and contributes nothing
    // to this period's MQL cell.
    if (!leadInPeriod) continue;
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

  // 3. Attribution-stage actuals (HPP / Opp / Pursuit / CloseWon / CloseLost).
  //
  //    Two dedupe patterns flow into the manualActuals fallback below:
  //    - For HPP+ stages, the attribution pass wins; funnel_actuals
  //      rows for the same cell are skipped.
  //    - For lead/mql stages, the leads pass above wins; funnel_actuals
  //      rows for the same cell are skipped. Historical-year backfills
  //      (e.g. 2025 pre-Sourced) typically have funnel_actuals lead/mql
  //      rows AND no leads, so the dedupe is a no-op in that case and
  //      the fallback row supplies the count.

  // Strict-cohort rule (non-HPP deal stages): an Opp / Pursuit /
  // closeWon / closeLost row only counts toward an (channel, period)
  // cell when the same deal's HPP transition was ALSO in the period.
  // This makes every conversion rate ≤ 100% under the standard funnel
  // path and keeps the grid coherent for cohort math. Cross-period
  // progressions (HPP in 2025-Q4, Opp in 2026-Q1) are intentionally
  // invisible from the grid; users see them via the Opportunity
  // Influence year tabs.
  //
  // hppPeriodsByDeal: deal_id → list of HPP (year, quarter) buckets.
  // A deal typically has at most one HPP row, but we accept multiple
  // defensively (re-source edge case) and treat any match as "HPP in
  // period". Region filter on the HPP row applies — a 2025 HPP for a
  // region the user has toggled off doesn't unlock downstream stages
  // for that deal under the active filter.
  const hppPeriodsByDeal = new Map<
    string,
    Array<{ year: number; quarter: PeriodIndex }>
  >();
  for (const a of attributions) {
    if (a.stage_key !== 'hpp') continue;
    if (!a.deal_id) continue;
    if (!matchesRegionFilter(a.region, regions)) continue;
    const arr = hppPeriodsByDeal.get(a.deal_id) ?? [];
    arr.push({ year: a.year, quarter: a.period_index });
    hppPeriodsByDeal.set(a.deal_id, arr);
  }
  const dealHppInPeriod = (dealId: string | null | undefined): boolean => {
    if (!dealId) return false;
    const buckets = hppPeriodsByDeal.get(dealId);
    if (!buckets) return false;
    for (const b of buckets) {
      if (matchesPeriod(b, year, filter)) return true;
    }
    return false;
  };

  // Count attributions per (channel, year, period, stage). One attribution row
  // contributes 1 to its leaf channel's stage cell. Channel rollup to parents
  // happens later in step 5. Region filter applied per attribution.
  for (const a of attributions) {
    if (!a.channel_id) continue;
    if (!matchesRegionFilter(a.region, regions)) continue;
    const bucket = { year: a.year, quarter: a.period_index };
    if (!matchesPeriod(bucket, year, filter)) continue;
    // Strict-cohort: non-HPP deal stages require the deal's HPP to
    // also fall in the selected period. HPP rows themselves are
    // exempt (they ARE the cohort anchor) — same with rows that lack
    // a deal_id (orphan singletons can't be cohort-joined, so we
    // continue to include them under the bucket they were entered).
    if (a.stage_key !== 'hpp' && a.deal_id && !dealHppInPeriod(a.deal_id)) {
      continue;
    }
    const row = rowMap.get(a.channel_id);
    if (!row) continue;
    const cell = row.cells[a.stage_key];
    cell.actual = (cell.actual ?? 0) + 1;
  }

  // Manual fallback (M3 fix): only contribute when no SOURCE RECORD covers this
  // (channel, year, quarter, stage) cell. Coverage is built from the raw lead
  // and attribution records BEFORE the region filter and the HPP-cohort gate,
  // so a cell whose source data was filtered or gated to zero is still "covered"
  // and does NOT get a manual value layered on top of a real-but-hidden zero.
  //
  // handledByLeads / handledByAttribution mark what actually LANDED after
  // filtering (used elsewhere); sourceCoverage marks what EXISTS at source.
  // Coverage is evaluated per STORED quarter even when the view is the full year,
  // so a Q1 manual actual can't sneak in against a real Q1 source record just
  // because the year view aggregates.
  //
  // Proxy limitation (Section 4.3): with no import-completeness table, a truly
  // empty source period is indistinguishable from an unimported one. Presence of
  // any eligible source record is the coverage signal for this cleanup.
  const sourceCoverage = new Set<string>();
  for (const l of leads) {
    if (!l.source_channel_id) continue;
    const lb = quarterOfIsoDate(l.marketing_sourced_date);
    if (lb) {
      sourceCoverage.add(attribKey(l.source_channel_id, lb.year, lb.quarter, 'lead'));
      const mqlIso = firstMqlDate(l);
      const mb = mqlIso ? quarterOfIsoDate(mqlIso) : null;
      if (mb) {
        sourceCoverage.add(attribKey(l.source_channel_id, mb.year, mb.quarter, 'mql'));
      }
    }
  }
  for (const a of attributions) {
    if (!a.channel_id) continue;
    sourceCoverage.add(
      attribKey(a.channel_id, a.year, a.period_index, a.stage_key),
    );
  }

  for (const m of manualActuals) {
    if (m.actual === null || m.actual === undefined) continue;
    const bucket = { year: m.year, quarter: m.period_index };
    if (!matchesPeriod(bucket, year, filter)) continue;
    const key = attribKey(m.channel_id, m.year, m.period_index, m.stage_key);
    // Suppress the fallback whenever a source record exists for this exact
    // stored cell, whether or not that record survives the current view filters.
    if (sourceCoverage.has(key)) continue;
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

  // 5. Tree rollup (recursive, N-level), computed post-order.
  //    - ACTUALS roll up for every stage (a parent's actual = sum of its
  //      sub-campaigns' rolled-up actuals).
  //    - PROJECTIONS roll up ONLY for lead & mql (PROJ_ROLLUP_STAGES). For
  //      HPP/Opp/Pursuit, a parent keeps its OWN entered projection: those
  //      late-funnel targets are set at the parent level (e.g. you project
  //      Events HPPs without attributing them to a specific sub-event), so
  //      they must stay directly editable and are not summed from children.
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
    const children = childrenByParent.get(nodeId) ?? [];
    for (const cid of children) {
      rollup(cid);
      const childRow = rowMap.get(cid);
      if (!childRow) continue;
      for (const stage of FUNNEL_STAGES) {
        const pc = node.cells[stage];
        const cc = childRow.cells[stage];
        if (cc.actual !== null) pc.actual = (pc.actual ?? 0) + cc.actual;
        if (PROJ_ROLLUP_STAGES.has(stage) && cc.projection !== null) {
          pc.projection = (pc.projection ?? 0) + cc.projection;
        }
      }
    }
  };
  for (const c of channels) {
    if (!c.parent_channel_id) rollup(c.id);
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
    if (!matchesRegionFilter(l.region, regions)) continue;
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
    if (!matchesRegionFilter(a.region, regions)) continue;
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

// ---------- Monthly compute (Compare tab) ----------
//
// Same shape as computeWeekly but bucketed by calendar month. Two
// changes from the weekly version: lead/MQL/attribution dates use
// month-of-year + year for bucketing (not ISO weeks), and the HPP /
// Opp / Pursuit / CloseWon / CloseLost stages bucket by
// stage_entered_at (the day the deal actually entered that stage),
// not created_at. stage_entered_at is the right field for a
// month-over-month view because it answers "how many deals
// progressed to this stage in this month?" rather than "how many
// rows were typed into Sourced this month?".

export interface MonthBucket {
  year: number;
  month: number; // 1..12
}

export interface MonthlyCellValues {
  // counts[i] is the actual for the month at months[i].
  counts: number[];
}

export interface MonthlyRow {
  channelId: string;
  hasChildren: boolean;
  parentId: string | null;
  depth: number;
  ancestors: string[];
  cells: Record<FunnelStageKey, MonthlyCellValues>;
}

export interface MonthlyGrid {
  months: MonthBucket[];
  rows: MonthlyRow[];
  totals: Record<FunnelStageKey, MonthlyCellValues>;
  unassignedLeadCount: number;
}

export interface ComputeMonthlyInput {
  leads: Lead[];
  channels: Channel[];
  attributions?: Attribution[];
  months: MonthBucket[];
  regions?: Set<RegionKey>;
}

function monthKey(m: MonthBucket): string {
  return `${m.year}-${m.month}`;
}

// Pulls (year, month) from an ISO date string. Local-month semantics
// match quarterOfIsoDate: parse Y/M/D from the leading digits so a
// UTC-shifted Date() doesn't kick a March 31 into April for negative
// timezones.
function monthOfIsoDate(
  iso: string | null | undefined,
): MonthBucket | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function emptyMonthlyCells(
  numMonths: number,
): Record<FunnelStageKey, MonthlyCellValues> {
  const out = {} as Record<FunnelStageKey, MonthlyCellValues>;
  for (const s of FUNNEL_STAGES) {
    out[s] = { counts: new Array<number>(numMonths).fill(0) };
  }
  return out;
}

export function computeMonthly(input: ComputeMonthlyInput): MonthlyGrid {
  const { leads, channels, attributions = [], months, regions } = input;
  const numMonths = months.length;
  const monthIndex = new Map<string, number>();
  months.forEach((m, i) => monthIndex.set(monthKey(m), i));

  // 1. Initialize rows.
  const rowMap = new Map<string, MonthlyRow>();
  for (const c of channels) {
    rowMap.set(c.id, {
      channelId: c.id,
      hasChildren: false,
      parentId: c.parent_channel_id ?? null,
      depth: 1,
      ancestors: [],
      cells: emptyMonthlyCells(numMonths),
    });
  }

  // 2. Lead pass. Lead bucket = marketing_sourced_date's month. MQL
  //    bucket = earliest stage_history entry with stage='mql'.
  let unassignedLeadCount = 0;
  for (const l of leads) {
    if (!matchesRegionFilter(l.region, regions)) continue;
    const leadMonth = monthOfIsoDate(l.marketing_sourced_date);
    if (leadMonth) {
      const idx = monthIndex.get(monthKey(leadMonth));
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
      const mqlMonth = monthOfIsoDate(mqlIso);
      if (mqlMonth) {
        const idx = monthIndex.get(monthKey(mqlMonth));
        if (idx !== undefined && l.source_channel_id) {
          const row = rowMap.get(l.source_channel_id);
          if (row) row.cells.mql.counts[idx] += 1;
        }
      }
    }
  }

  // 3. Attribution pass: bucket by stage_entered_at month, not
  //    created_at. This is the only semantic difference from
  //    computeWeekly's attribution loop.
  for (const a of attributions) {
    if (!a.channel_id) continue;
    if (!matchesRegionFilter(a.region, regions)) continue;
    const aMonth = monthOfIsoDate(a.stage_entered_at);
    if (!aMonth) continue;
    const idx = monthIndex.get(monthKey(aMonth));
    if (idx === undefined) continue;
    const row = rowMap.get(a.channel_id);
    if (!row) continue;
    row.cells[a.stage_key].counts[idx] += 1;
  }

  // 4. Tree rollup. Mirrors computeWeekly.
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
        for (let i = 0; i < numMonths; i++) {
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
  const orderedRows: MonthlyRow[] = [];
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
  const totals = emptyMonthlyCells(numMonths);
  for (const c of channels) {
    if (c.parent_channel_id) continue;
    const r = rowMap.get(c.id);
    if (!r) continue;
    for (const stage of FUNNEL_STAGES) {
      for (let i = 0; i < numMonths; i++) {
        totals[stage].counts[i] += r.cells[stage].counts[i];
      }
    }
  }

  return { months, rows: orderedRows, totals, unassignedLeadCount };
}

// Shift a MonthBucket by `delta` months (positive = forward, negative =
// backward). Wraps year correctly via Date arithmetic.
export function shiftMonth(m: MonthBucket, delta: number): MonthBucket {
  // Use day-1 so the Date doesn't roll over for variable month lengths.
  const d = new Date(Date.UTC(m.year, m.month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

// ---------- Monthly leads-for-year (Leads & MQLs tab year charts) ----------
//
// Powers the two year-wide bar charts on the Leads & MQLs tab. Always
// spans all 12 months of the input year. Region filter applies. Each
// lead rolls up to its top-level (root) channel via the
// parent_channel_id chain so the stacked-bar chart's legend stays
// short and stable. Leads without a source_channel_id are dropped
// (they can't be attributed to a channel).
//
// Historical-year backfill: when no leads exist for the year but
// funnel_actuals carries lead rows (e.g. 2025 pre-Sourced), spread
// the quarterly count across the three calendar months of the
// quarter (remainder pushed to the last month). The dedupe pattern
// matches computeGrid: a (channel, year, month, 'lead') cell with
// real leads suppresses the funnel_actuals fallback for that cell,
// so a year with both kinds of data won't double-count. Only
// stage_key='lead' rows feed this output; mql is irrelevant to the
// charts on this surface.

export interface MonthlyChannelLeads {
  channelId: string;
  channelName: string;
  perMonth: number[];   // length 12, index 0 = Jan, 11 = Dec
}

// A quarterly manual-actual lead count that is NOT distributed into monthly
// values (M4 fix). It is surfaced separately so the UI can show it as a labeled
// count annotation ("Q1 Lead actual: 30 (quarterly backfill)"), never as a
// monthly bar, point, or currency.
export interface QuarterlyLeadFallback {
  channelId: string;
  channelName: string;
  quarter: PeriodIndex; // 1..4
  value: number; // the quarterly lead count
}

export interface MonthlyLeadsForYear {
  // One entry per top-level channel with >= 1 lead in the year.
  // Sorted by year total descending so legend order is stable.
  byChannel: MonthlyChannelLeads[];
  // Length 12. Sum across all channels (including the unsorted set,
  // which by construction equals the sum of byChannel rows since
  // unattributed leads are excluded upstream). Contains ONLY source-dated
  // monthly lead counts; quarterly backfill is never spread into it.
  monthTotals: number[];
  // Quarterly manual actuals with NO real-lead coverage for that
  // (top-level channel, quarter). Presented separately by the UI (Step 7).
  quarterlyFallback: QuarterlyLeadFallback[];
}

export interface ComputeMonthlyLeadsForYearInput {
  leads: Lead[];
  channels: Channel[];
  year: number;
  regions: Set<RegionKey>;
  // Optional historical-year fallback. Quarterly lead actuals are
  // spread across the three months of the quarter when no real leads
  // cover the (channel, month) cell. Omitted callers get the same
  // behavior as before (no fallback).
  manualActuals?: FunnelActual[];
}


export function computeMonthlyLeadsForYear(
  input: ComputeMonthlyLeadsForYearInput,
): MonthlyLeadsForYear {
  const { leads, channels, year, regions, manualActuals } = input;
  const channelById = new Map(channels.map((c) => [c.id, c] as const));

  // Accumulator: top-level channel id → 12-element month array. We
  // also need a quick lookup for channel name when materializing.
  const perChannel = new Map<string, number[]>();
  const monthTotals = new Array<number>(12).fill(0);

  // M4 fix: source coverage is keyed at (top-level channel, QUARTER) grain,
  // built from real leads BEFORE the region filter. If any real lead covers a
  // quarter, the whole quarterly manual fallback for that channel+quarter is
  // suppressed. We never spread a quarterly value into invented months.
  //
  // Coverage is region-unfiltered on purpose (Section 4.3): a real lead that a
  // region toggle hides still means the period is "imported", so a backfill must
  // not fill the visible gap.
  const coverageKey = (cid: string, quarter: number): string =>
    `${cid}\x1f${quarter}`;
  const sourceCoverage = new Set<string>();
  for (const lead of leads) {
    if (!lead.source_channel_id) continue;
    const lm = monthOfIsoDate(lead.marketing_sourced_date);
    if (!lm || lm.year !== year) continue;
    const topId = resolveTopLevelChannelId(lead.source_channel_id, channelById);
    const quarter = Math.floor((lm.month - 1) / 3) + 1;
    sourceCoverage.add(coverageKey(topId, quarter));
  }

  // Monthly bars: source-dated real leads only (region-filtered for display).
  for (const lead of leads) {
    if (!lead.source_channel_id) continue;
    if (!matchesRegionFilter(lead.region, regions)) continue;
    const leadMonth = monthOfIsoDate(lead.marketing_sourced_date);
    if (!leadMonth || leadMonth.year !== year) continue;
    const topId = resolveTopLevelChannelId(
      lead.source_channel_id,
      channelById,
    );
    let row = perChannel.get(topId);
    if (!row) {
      row = new Array<number>(12).fill(0);
      perChannel.set(topId, row);
    }
    const idx = leadMonth.month - 1;
    row[idx] += 1;
    monthTotals[idx] += 1;
  }

  // Quarterly fallback: collected SEPARATELY, never added to monthly arrays. A
  // (channel, quarter) with any real-lead coverage is suppressed entirely.
  const quarterlyFallback: QuarterlyLeadFallback[] = [];
  for (const m of manualActuals ?? []) {
    if (m.stage_key !== 'lead') continue;
    if (m.year !== year) continue;
    if (m.actual === null || m.actual === undefined) continue;
    const value = Math.round(m.actual);
    if (value <= 0) continue;
    const topId = resolveTopLevelChannelId(m.channel_id, channelById);
    if (sourceCoverage.has(coverageKey(topId, m.period_index))) continue;
    quarterlyFallback.push({
      channelId: topId,
      channelName: channelById.get(topId)?.name ?? 'Unknown',
      quarter: m.period_index,
      value,
    });
  }

  const byChannel: MonthlyChannelLeads[] = [];
  for (const [channelId, perMonth] of perChannel) {
    const total = perMonth.reduce((s, n) => s + n, 0);
    if (total <= 0) continue;
    byChannel.push({
      channelId,
      channelName: channelById.get(channelId)?.name ?? 'Unknown',
      perMonth,
    });
  }
  byChannel.sort((a, b) => {
    const aTot = a.perMonth.reduce((s, n) => s + n, 0);
    const bTot = b.perMonth.reduce((s, n) => s + n, 0);
    return bTot - aTot;
  });

  return { byChannel, monthTotals, quarterlyFallback };
}

// ---------- Funnel Flow Sankey (Channel Influence chart) ----------
//
// Produces a 7-column Sankey: Channels → Leads → MQL → HPP → Opp → Pursuit
// → (Closed Won | Closed Lost). Each lead in the cohort is traced by its
// source_channel_id from the Channels column all the way through the
// funnel; each edge is tagged with the originating channel id so the
// renderer can color stacked ribbons per channel. Manual-entry deals
// (attributions with no lead_id) enter directly at HPP, skipping the Lead
// and MQL columns, and are colored by the attribution's own channel_id.
//
// Cohort definition (from the spec): leads with marketing_sourced_date in
// the selected period AND region in the active set; manual-entry deals
// matched by their (year, period_index) and region. Once in the cohort, a
// lead's downstream stage transitions are NOT re-filtered — the chart
// answers "for this period's cohort, where did they end up." Drop-off is
// implicit (the narrowing of the Sankey).

export interface FunnelSankeyEdge {
  source: string;       // node id, e.g. "channel:<uuid>" or "stage:lead"
  target: string;
  value: number;
  channelId: string;    // top-level channel id; drives the edge color
}

export interface FunnelSankeyNode {
  id: string;
  label: string;
  kind: 'channel' | 'stage' | 'terminal';
  channelId?: string;   // populated for channel nodes (used for color)
  // For stage / terminal nodes only; lets the renderer color closeLost in
  // red and closeWon in green without re-walking labels.
  stageKey?: FunnelStageKey;
}

export interface FunnelSankeyData {
  nodes: FunnelSankeyNode[];
  edges: FunnelSankeyEdge[];
}

export interface ComputeFunnelSankeyInput {
  leads: Lead[];
  attributions: Attribution[];
  channels: Channel[];
  year: number;
  filter: PeriodFilter;
  regions?: Set<RegionKey>;
}

// Walks parent_channel_id up to the root. Returns the channel id of the
// top-level ancestor (or the input id itself if it's already top-level).
// Cycles are guarded against via a visited set; an unresolvable id falls
// back to itself rather than throwing.
function resolveTopLevelChannelId(
  channelId: string,
  channelById: Map<string, Channel>,
): string {
  let current: string | undefined = channelId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) return channelId;
    seen.add(current);
    const node = channelById.get(current);
    if (!node) return channelId;
    if (!node.parent_channel_id) return current;
    current = node.parent_channel_id;
  }
  return channelId;
}

export function computeFunnelSankey(
  input: ComputeFunnelSankeyInput,
): FunnelSankeyData {
  const { leads, attributions, channels, year, filter, regions } = input;

  const channelById = new Map(channels.map((c) => [c.id, c] as const));
  const topLevelChannels = channels
    .filter((c) => !c.parent_channel_id)
    .slice()
    .sort((a, b) => {
      if (a.display_order !== b.display_order)
        return a.display_order - b.display_order;
      return a.name.localeCompare(b.name);
    });

  // Edge accumulator keyed by `${source}|${target}|${channelId}`. Multiple
  // leads/deals from the same channel making the same transition collapse
  // into one ribbon whose width is the cohort count.
  const edgeMap = new Map<string, FunnelSankeyEdge>();
  const bumpEdge = (source: string, target: string, channelId: string) => {
    const key = `${source}|${target}|${channelId}`;
    const existing = edgeMap.get(key);
    if (existing) existing.value += 1;
    else edgeMap.set(key, { source, target, value: 1, channelId });
  };

  // Build a deal_id → attribution[] index over all attributions. Used
  // when tracing a cohort lead through its downstream HPP/Opp/etc. rows
  // (matched by lead_id) so we can read the deal's stage set in one place.
  const attrsByLeadId = new Map<string, Attribution[]>();
  const attrsByDealId = new Map<string, Attribution[]>();
  for (const a of attributions) {
    if (a.lead_id) {
      const arr = attrsByLeadId.get(a.lead_id) ?? [];
      arr.push(a);
      attrsByLeadId.set(a.lead_id, arr);
    }
    if (a.deal_id) {
      const arr = attrsByDealId.get(a.deal_id) ?? [];
      arr.push(a);
      attrsByDealId.set(a.deal_id, arr);
    }
  }

  // Track which deals (by deal_id) we've already counted via lead-sourced
  // tracing; manual-entry pass below uses this to skip them so a deal
  // isn't double-counted under both its lead's channel AND its
  // attribution.channel_id.
  const dealsCountedViaLead = new Set<string>();

  // Emit the deal-stage edges for one deal (a chain of attribution rows sharing
  // a deal_id) under the given color channel. Used by both the cohort-lead and
  // sales-sourced passes.
  //
  // The deal subgraph (HPP and later) CONSERVES flow: every stage a deal reaches
  // has exactly one outgoing link, either to the next progression stage, to a
  // terminal (Won / Lost), or to an explicit OPEN sink for its highest reached
  // stage. So "inflow to stage X == sum of X's outgoing progression + sink
  // links". Lead/MQL upstream are unique-person counts and are NOT forced to
  // conserve across the person-to-deal boundary at HPP.
  const emitDealEdges = (
    dealAttrs: Attribution[],
    colorChannelId: string,
  ): void => {
    const stageSet = new Set(dealAttrs.map((a) => a.stage_key));
    const reached = (['hpp', 'opp', 'pursuit'] as const).filter((s) =>
      stageSet.has(s),
    );
    // Highest progression stage the deal reached among the open stages.
    const highestOpen = reached.length ? reached[reached.length - 1] : null;

    // Progression edges between consecutive open stages the deal hit.
    const openProgression: AttributionStageKey[] = ['hpp', 'opp', 'pursuit'];
    for (let i = 0; i < openProgression.length - 1; i++) {
      const from = openProgression[i];
      const to = openProgression[i + 1];
      if (stageSet.has(from) && stageSet.has(to)) {
        bumpEdge(`stage:${from}`, `stage:${to}`, colorChannelId);
      }
    }

    // Terminal or open sink from the deal's highest reached stage. Exactly one
    // of these fires, so the highest stage's outflow always equals its inflow.
    if (stageSet.has('closeWon')) {
      // Progressed to won: pursuit -> won (or the highest open -> won).
      const from = highestOpen ?? 'pursuit';
      bumpEdge(`stage:${from}`, 'terminal:closeWon', colorChannelId);
    } else if (stageSet.has('closeLost')) {
      const from = highestOpen ?? 'hpp';
      bumpEdge(`stage:${from}`, 'terminal:closeLost', colorChannelId);
    } else if (highestOpen) {
      // Still open: sink to the explicit "Open at <stage>" node so the deal is
      // accounted for and the stage conserves.
      bumpEdge(`stage:${highestOpen}`, `open:${highestOpen}`, colorChannelId);
    }
  };

  // Route a deal into HPP through exactly ONE ingress, then emit its stage
  // edges. `hppSource` is the node feeding HPP: an MQL node, a "no recorded
  // MQL" node, or the sales-sourced node.
  const enterHppAndEmit = (
    hppSource: string,
    dealAttrs: Attribution[],
    colorChannelId: string,
  ): void => {
    bumpEdge(hppSource, 'stage:hpp', colorChannelId);
    emitDealEdges(dealAttrs, colorChannelId);
  };

  // ---------- Pass 1: cohort leads ----------
  for (const lead of leads) {
    if (!matchesRegionFilter(lead.region, regions)) continue;
    const leadBucket = quarterOfIsoDate(lead.marketing_sourced_date);
    if (!leadBucket || !matchesPeriod(leadBucket, year, filter)) continue;
    if (!lead.source_channel_id) continue; // unattributed leads skip the Sankey

    const topId = resolveTopLevelChannelId(lead.source_channel_id, channelById);

    // Channel → Leads (always for any cohort lead with a source channel).
    bumpEdge(`channel:${topId}`, 'stage:lead', topId);

    // Leads → MQL if the lead reached MQL.
    if (firstMqlDate(lead) !== null) {
      bumpEdge('stage:lead', 'stage:mql', topId);
    }

    // For deal-side edges, follow this lead's attributions (if any). A
    // single lead may seed multiple deals over time; each is a separate
    // chain under attrsByLeadId, then grouped by deal_id.
    const leadAttrs = attrsByLeadId.get(lead.id) ?? [];
    if (leadAttrs.length === 0) continue;

    // Group this lead's attributions by deal_id (or by the row's own id
    // when deal_id is null, so an orphan attribution still flows).
    const dealsForLead = new Map<string, Attribution[]>();
    for (const a of leadAttrs) {
      const key = a.deal_id ?? a.id;
      const arr = dealsForLead.get(key) ?? [];
      arr.push(a);
      dealsForLead.set(key, arr);
    }

    // A lead reaching MQL is a unique-person edge; emit once per lead, not per
    // deal, so the MQL node keeps a person count.
    const leadReachedMql = firstMqlDate(lead) !== null;

    for (const [dealKey, dealAttrs] of dealsForLead) {
      const stageSet = new Set(dealAttrs.map((a) => a.stage_key));
      if (stageSet.has('hpp')) {
        // A deal enters HPP once, through the MQL node if the lead has recorded
        // MQL history, otherwise through the explicit "No recorded MQL" node.
        // A lead with an HPP deal but NO MQL history must NOT create an
        // MQL -> HPP edge (M5a).
        const hppSource = leadReachedMql ? 'stage:mql' : 'stage:no-mql';
        enterHppAndEmit(hppSource, dealAttrs, topId);
      }
      // Track the deal so the sales-sourced pass below skips it.
      if (dealAttrs.some((a) => a.deal_id)) {
        dealsCountedViaLead.add(dealKey);
      }
    }
  }

  // ---------- Pass 2: sales-sourced deals (no lead) ----------
  // These have no originating lead, so they enter the funnel at HPP through the
  // dedicated "Sales-sourced" node (M5b). In current production EVERY deal is
  // leadless, so this is the primary entry path, not an edge case.
  for (const [dealId, dealAttrs] of attrsByDealId) {
    if (dealsCountedViaLead.has(dealId)) continue;
    if (dealAttrs.some((a) => a.lead_id)) continue;

    const hpp = dealAttrs.find((a) => a.stage_key === 'hpp');
    if (!hpp) continue; // chains without an HPP entry don't enter the Sankey
    if (!matchesRegionFilter(deriveDealRegion(dealAttrs), regions)) continue;
    if (!matchesPeriod({ year: hpp.year, quarter: hpp.period_index }, year, filter)) {
      continue;
    }
    if (!hpp.channel_id) continue;

    const topId = resolveTopLevelChannelId(hpp.channel_id, channelById);
    enterHppAndEmit('source:sales', dealAttrs, topId);
  }

  // Pass 2b: HPP rows that lack a deal_id entirely (one-off rows, no chain).
  // Also sales-sourced, so they enter through the same node and take an open
  // HPP sink (a lone HPP row has no progression).
  for (const a of attributions) {
    if (a.lead_id) continue;
    if (a.deal_id) continue;
    if (a.stage_key !== 'hpp') continue;
    if (!matchesRegionFilter(a.region, regions)) continue;
    if (!matchesPeriod({ year: a.year, quarter: a.period_index }, year, filter)) {
      continue;
    }
    if (!a.channel_id) continue;
    const topId = resolveTopLevelChannelId(a.channel_id, channelById);
    enterHppAndEmit('source:sales', [a], topId);
  }

  // emitDealEdges targets terminal:closeWon directly, so no post-hoc retarget
  // is needed.

  // ---------- Build the node list ----------
  // Order is load-bearing: Recharts assigns column indexes in the order
  // nodes appear, which controls left-to-right placement.
  const nodes: FunnelSankeyNode[] = [];
  const nodeIdSet = new Set<string>();
  const pushNode = (n: FunnelSankeyNode) => {
    if (nodeIdSet.has(n.id)) return;
    nodeIdSet.add(n.id);
    nodes.push(n);
  };

  // Channels column: every top-level channel, in grid order. Always emitted so
  // an inactive channel still anchors the column; edgeless nodes are hidden by
  // the renderer's empty-data guard.
  for (const ch of topLevelChannels) {
    pushNode({
      id: `channel:${ch.id}`,
      label: ch.name,
      kind: 'channel',
      channelId: ch.id,
    });
  }

  // Sales-sourced entry: leadless deals enter here (upstream of HPP, alongside
  // the channel column since they have no channel-to-lead flow).
  pushNode({ id: 'source:sales', label: 'Sales-sourced', kind: 'stage' });

  // Person-side stages (unique people). "No recorded MQL" sits between MQL and
  // HPP as the ingress for cohort leads whose deal reached HPP without an MQL
  // history entry.
  const stageNodes: { id: string; label: string; key?: FunnelStageKey }[] = [
    { id: 'stage:lead', label: 'Leads', key: 'lead' },
    { id: 'stage:mql', label: 'MQL', key: 'mql' },
    { id: 'stage:no-mql', label: 'No recorded MQL' },
    { id: 'stage:hpp', label: 'HPP (SQL)', key: 'hpp' },
    { id: 'stage:opp', label: 'Opp (SAO)', key: 'opp' },
    { id: 'stage:pursuit', label: 'Pursuit', key: 'pursuit' },
  ];
  for (const s of stageNodes) {
    pushNode({ id: s.id, label: s.label, kind: 'stage', stageKey: s.key });
  }

  // Open sinks: a deal still open at a stage flows to its "Open at <stage>"
  // node so the deal subgraph conserves (Section 4.5). Terminals last.
  pushNode({ id: 'open:hpp', label: 'Open at HPP', kind: 'terminal' });
  pushNode({ id: 'open:opp', label: 'Open at Opp', kind: 'terminal' });
  pushNode({ id: 'open:pursuit', label: 'Open at Pursuit', kind: 'terminal' });
  pushNode({
    id: 'terminal:closeWon',
    label: 'Won',
    kind: 'terminal',
    stageKey: 'closeWon',
  });
  pushNode({
    id: 'terminal:closeLost',
    label: 'Lost',
    kind: 'terminal',
    stageKey: 'closeLost',
  });

  return { nodes, edges: [...edgeMap.values()] };
}

// ---------- Deal velocity (Marketing Funnel: Velocity sub-tab) ----------
//
// One DealVelocity per distinct deal_id. Walks each deal's attribution
// chain in canonical stage order (hpp → opp → pursuit → closeWon|closeLost)
// using stage_entered_at as the per-stage date. Lead/MQL are lead-side, not
// attribution-side, so they're ignored here.
//
// Future expansion (out of scope for v1): MQL → HPP velocity can be
// computed by joining attributions[].lead_id back to leads[].stage_history
// MQL entries; the lead's earliest MQL stage_history entry combined with
// the deal's HPP stage_entered_at yields the gap. Add the join + a third
// VELOCITY_THRESHOLDS key when business demand warrants it.

// Canonical progression among the four "real" stages. closeLost is a
// parallel terminal reached from any of HPP/Opp/Pursuit and isn't on
// the linear path, so we treat it separately.
const VELOCITY_PROGRESSION: AttributionStageKey[] = [
  'hpp',
  'opp',
  'pursuit',
  'closeWon',
];

function progressionRank(stage: AttributionStageKey): number {
  // closeLost: terminal but off-progression. Give it a rank equal to the
  // highest reached non-lost stage so the "current stage" pick still works
  // when a deal goes Lost. We special-case in the consumer.
  const idx = VELOCITY_PROGRESSION.indexOf(stage);
  return idx === -1 ? -1 : idx;
}

function daysBetween(fromIso: string, toIso: string): number {
  // Date subtraction in UTC-day terms. Both inputs are 'YYYY-MM-DD'.
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

export interface DealVelocity {
  dealId: string;
  label: string;
  account: string | null;
  amount: number | null;
  currentStage: AttributionStageKey;
  currentStageEnteredAt: string;       // ISO date
  daysInCurrentStage: number;
  hppEnteredAt: string | null;         // null if deal entered at a later stage manually
  daysSinceHpp: number | null;
  hppToOppDays: number | null;         // null if deal hasn't reached Opp
  oppToPursuitDays: number | null;     // null if deal hasn't reached Pursuit
  isTerminal: boolean;                 // true when current stage is closeWon or closeLost
  isStale: boolean;                    // currentStage covered by thresholds && daysInCurrentStage > stale
  // The HPP attribution's (year, period_index) — kept for any future
  // surface that needs the deal's cohort. The active-deals filter on
  // FunnelVelocityPage no longer reads these; it uses
  // stageEnteredAts below to enable the "any stage in period"
  // semantic (a 2025 deal still moving in 2026 appears in both
  // years).
  hppYear: number | null;
  hppPeriodIndex: PeriodIndex | null;
  // Sorted ascending ISO dates: every non-empty stage_entered_at on
  // the deal's attribution chain. Enables a single-pass "does any
  // stage fall in the selected period?" check on the page.
  stageEnteredAts: string[];
  // The deal's region (taken from the HPP row when present, else from
  // the earliest attribution in the chain). Drives region filtering.
  region: RegionKey | null;
  // The id of the attribution row representing the deal's current
  // stage. Used by the Active deals table's inline Edit button so
  // the page can open AttributionEditorModal against this row
  // directly.
  currentAttributionId: string;
  // sf_link from the current row, so the deal name can render as a
  // Salesforce link when the user has populated it. Null when the
  // row has no SF link configured.
  sfLink: string | null;
}

export interface ComputeDealVelocityInput {
  attributions: Attribution[];
  regions: Set<RegionKey>;
  // ISO date; defaults to current date. Injectable for testing.
  today?: string;
}

export function computeDealVelocities(
  input: ComputeDealVelocityInput,
): DealVelocity[] {
  const { attributions, regions, today } = input;
  const todayIso = today ?? new Date().toISOString().slice(0, 10);

  // Group attributions by deal_id. Rows without a deal_id can't be
  // chained, so we skip them (the velocity report is deal-level).
  const byDeal = new Map<string, Attribution[]>();
  for (const a of attributions) {
    if (!a.deal_id) continue;
    const arr = byDeal.get(a.deal_id) ?? [];
    arr.push(a);
    byDeal.set(a.deal_id, arr);
  }

  const out: DealVelocity[] = [];
  for (const [dealId, rows] of byDeal) {
    // Pick the row representing the deal's CURRENT stage:
    // - If closeLost or closeWon is present, that's terminal — use it.
    // - Else use the row with the highest progression rank.
    let currentRow: Attribution | null = null;
    const lost = rows.find((r) => r.stage_key === 'closeLost');
    const won = rows.find((r) => r.stage_key === 'closeWon');
    if (lost) currentRow = lost;
    else if (won) currentRow = won;
    else {
      let bestRank = -1;
      for (const r of rows) {
        const rank = progressionRank(r.stage_key);
        if (rank > bestRank) {
          bestRank = rank;
          currentRow = r;
        }
      }
    }
    if (!currentRow) continue;

    // Region filter: derive the deal's region from its earliest
    // stage row by REGION_STAGE_PRIORITY (matches the canonical
    // computeRegionDistribution pattern). Null region falls through
    // to 'Other' inside matchesRegionFilter so manual deals with no
    // region show up under 'Other'.
    const hppRow = rows.find((r) => r.stage_key === 'hpp') ?? null;
    const oppRow = rows.find((r) => r.stage_key === 'opp') ?? null;
    const pursuitRow = rows.find((r) => r.stage_key === 'pursuit') ?? null;
    const dealRegion = deriveDealRegion(rows);
    if (!matchesRegionFilter(dealRegion, regions)) continue;

    const currentStage = currentRow.stage_key;
    const currentStageEnteredAt = currentRow.stage_entered_at;
    const daysInCurrentStage = daysBetween(currentStageEnteredAt, todayIso);

    const hppEnteredAt = hppRow ? hppRow.stage_entered_at : null;
    const daysSinceHpp =
      hppEnteredAt !== null ? daysBetween(hppEnteredAt, todayIso) : null;
    const hppToOppDays =
      hppRow && oppRow
        ? daysBetween(hppRow.stage_entered_at, oppRow.stage_entered_at)
        : null;
    const oppToPursuitDays =
      oppRow && pursuitRow
        ? daysBetween(oppRow.stage_entered_at, pursuitRow.stage_entered_at)
        : null;

    const isTerminal =
      currentStage === 'closeWon' || currentStage === 'closeLost';

    // Stale check: look up the threshold for "currentStage → next stage".
    // Pursuit currently has no Pursuit→Won threshold defined in v1, so
    // those deals never flag.
    let isStale = false;
    if (!isTerminal) {
      const idx = VELOCITY_PROGRESSION.indexOf(currentStage);
      if (idx >= 0 && idx < VELOCITY_PROGRESSION.length - 1) {
        const next = VELOCITY_PROGRESSION[idx + 1];
        const threshold = VELOCITY_THRESHOLDS[`${currentStage}->${next}`];
        if (threshold && daysInCurrentStage > threshold.stale) {
          isStale = true;
        }
      }
    }

    // Collect every non-empty stage_entered_at across the chain so the
    // page-level "any stage in period" filter can do a single linear
    // scan. Sort ascending so future callers that want "earliest" /
    // "latest" can read off the ends without re-sorting.
    const stageEnteredAts = rows
      .map((r) => r.stage_entered_at)
      .filter((d): d is string => Boolean(d))
      .slice()
      .sort();

    out.push({
      dealId,
      label: currentRow.label ?? '(unlabeled)',
      account: currentRow.account ?? null,
      amount: currentRow.amount ?? null,
      currentStage,
      currentStageEnteredAt,
      daysInCurrentStage,
      hppEnteredAt,
      daysSinceHpp,
      hppToOppDays,
      oppToPursuitDays,
      isTerminal,
      isStale,
      hppYear: hppRow ? hppRow.year : null,
      hppPeriodIndex: hppRow ? (hppRow.period_index as PeriodIndex) : null,
      stageEnteredAts,
      region: dealRegion,
      currentAttributionId: currentRow.id,
      sfLink: currentRow.sf_link ?? null,
    });
  }

  return out;
}

export interface StageVelocityStats {
  transitionKey: string;               // e.g. 'hpp->opp'
  average: number | null;
  median: number | null;
  count: number;
}

// One entry per transition key in VELOCITY_THRESHOLDS. Reads the per-
// deal gap field that matches each transition key.
export function computeStageVelocityStats(
  velocities: DealVelocity[],
): StageVelocityStats[] {
  const fieldFor = (key: string): keyof DealVelocity | null => {
    if (key === 'hpp->opp') return 'hppToOppDays';
    if (key === 'opp->pursuit') return 'oppToPursuitDays';
    return null;
  };

  const out: StageVelocityStats[] = [];
  for (const key of Object.keys(VELOCITY_THRESHOLDS)) {
    const field = fieldFor(key);
    const values: number[] = [];
    if (field) {
      for (const v of velocities) {
        const raw = v[field];
        if (typeof raw === 'number') values.push(raw);
      }
    }
    if (values.length === 0) {
      out.push({ transitionKey: key, average: null, median: null, count: 0 });
      continue;
    }
    const sum = values.reduce((a, b) => a + b, 0);
    const average = sum / values.length;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 1
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
    out.push({
      transitionKey: key,
      average,
      median,
      count: values.length,
    });
  }
  return out;
}

// ---------- Region distribution (Deals by Region donut) ----------
//
// Counts distinct deals per region, where a "deal" is any deal_id with at
// least one attribution in the selected period. Region and dollar amount
// come from the deal's earliest stage row (HPP if present, else the
// earliest row in chain order). The region filter intentionally is NOT
// an input: this is a distribution view and always shows all regions
// with at least one deal.

export interface RegionDealStats {
  region: RegionKey;
  dealCount: number;
  totalAmount: number;
  percentageOfCount: number;   // 0-100
}

export interface RegionDistribution {
  regions: RegionDealStats[];  // only regions with dealCount > 0
  totalDeals: number;
  totalAmount: number;
}

export interface ComputeRegionDistributionInput {
  attributions: Attribution[];
  year: number;
  filter: PeriodFilter;
}

// Returns true when a deal's attribution chain is "open" — at least
// one row at hpp/opp/pursuit AND no row at closeWon/closeLost. Same
// definition the Active deals table uses (via !isTerminal on the
// current stage), exposed here so the Opportunities donuts and the
// table reconcile by construction.
export function isDealOpen(rows: Attribution[]): boolean {
  let hasOpen = false;
  for (const r of rows) {
    if (r.stage_key === 'closeWon' || r.stage_key === 'closeLost') {
      return false;
    }
    if (
      r.stage_key === 'hpp' ||
      r.stage_key === 'opp' ||
      r.stage_key === 'pursuit'
    ) {
      hasOpen = true;
    }
  }
  return hasOpen;
}

export function computeRegionDistribution(
  input: ComputeRegionDistributionInput,
): RegionDistribution {
  const { attributions, year, filter } = input;

  // 1. Group attributions by deal_id (singletons without deal_id can't
  //    form a chain; skip them).
  const rowsByDeal = new Map<string, Attribution[]>();
  for (const a of attributions) {
    if (!a.deal_id) continue;
    const arr = rowsByDeal.get(a.deal_id) ?? [];
    arr.push(a);
    rowsByDeal.set(a.deal_id, arr);
  }

  // 2. Keep only OPEN deals with at least one attribution row whose
  //    stage_entered_at falls within the selected period. Open means
  //    the chain has at least one HPP/Opp/Pursuit row and no
  //    closeWon/closeLost row — mirrors the Active deals table on
  //    the same page so the donut and the table reconcile.
  for (const [dealId, rows] of [...rowsByDeal]) {
    if (!isDealOpen(rows)) {
      rowsByDeal.delete(dealId);
      continue;
    }
    if (!dealMatchesPeriod(rows, year, filter)) {
      rowsByDeal.delete(dealId);
    }
  }

  // 3. Pick the deal's "first" row by REGION_STAGE_PRIORITY and tally per
  //    region. A deal whose first row has no region falls into 'Other' so
  //    every counted deal shows up somewhere.
  const tally = new Map<RegionKey, { count: number; amount: number }>();
  for (const [, rows] of rowsByDeal) {
    let primary: Attribution | null = null;
    for (const stage of REGION_STAGE_PRIORITY) {
      const found = rows.find((r) => r.stage_key === stage);
      if (found) {
        primary = found;
        break;
      }
    }
    if (!primary) continue;
    const region = (primary.region as RegionKey) ?? 'Other';
    const entry = tally.get(region) ?? { count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += primary.amount ?? 0;
    tally.set(region, entry);
  }

  // 4. Materialize as a sorted array (largest count first), filter zero
  //    regions, compute percentages, and roll up totals.
  let totalDeals = 0;
  let totalAmount = 0;
  for (const v of tally.values()) {
    totalDeals += v.count;
    totalAmount += v.amount;
  }
  const regionsOut: RegionDealStats[] = [];
  for (const [region, v] of tally) {
    if (v.count <= 0) continue;
    regionsOut.push({
      region,
      dealCount: v.count,
      totalAmount: v.amount,
      percentageOfCount:
        totalDeals === 0 ? 0 : (v.count / totalDeals) * 100,
    });
  }
  regionsOut.sort((a, b) => b.dealCount - a.dealCount);

  return { regions: regionsOut, totalDeals, totalAmount };
}

// ---------- Channel distribution (Deals by Channel donut) ----------
//
// Parallels computeRegionDistribution but buckets per TOP-LEVEL channel.
// A deal's channel comes from its earliest stage row in chain order
// (REGION_STAGE_PRIORITY); the row's channel_id is then resolved up to
// its root via parent_channel_id. Deals whose first-stage row has no
// channel_id land in a synthetic "No channel" bucket so they aren't
// silently dropped.

export const NO_CHANNEL_KEY = '__no_channel__';

export interface ChannelDealStats {
  channelId: string;       // root channel id or NO_CHANNEL_KEY
  channelName: string;
  // Year-aware label for surfaces (the Opportunities donut) that
  // need to distinguish a 2025 channel from a 2026 channel with the
  // same bare name. Evergreen channels (year IS NULL) fall back to
  // the bare name. channelName stays the canonical bare name for
  // any consumer that still wants it.
  displayLabel: string;
  dealCount: number;
  totalAmount: number;
  percentageOfCount: number;
}

export interface ChannelDistribution {
  channels: ChannelDealStats[];   // only buckets with dealCount > 0
  totalDeals: number;
  totalAmount: number;
}

export interface ComputeChannelDistributionInput {
  attributions: Attribution[];
  channels: Channel[];
  year: number;
  filter: PeriodFilter;
}

export function computeChannelDistribution(
  input: ComputeChannelDistributionInput,
): ChannelDistribution {
  const { attributions, channels, year, filter } = input;

  const channelById = new Map(channels.map((c) => [c.id, c] as const));

  // Walk parent_channel_id up to a root. Returns the root channel's id
  // (or the input id itself if already root or unresolvable). Mirrors
  // resolveTopLevelChannelId used by the Sankey compute.
  const rootIdFor = (channelId: string): string => {
    let current: string | undefined = channelId;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current)) return channelId;
      seen.add(current);
      const node = channelById.get(current);
      if (!node) return channelId;
      if (!node.parent_channel_id) return current;
      current = node.parent_channel_id;
    }
    return channelId;
  };

  // 1. Group attributions by deal_id (singletons without a deal_id
  //    can't form a chain; skip them).
  const rowsByDeal = new Map<string, Attribution[]>();
  for (const a of attributions) {
    if (!a.deal_id) continue;
    const arr = rowsByDeal.get(a.deal_id) ?? [];
    arr.push(a);
    rowsByDeal.set(a.deal_id, arr);
  }

  // 2. Keep only OPEN deals with at least one attribution row whose
  //    stage_entered_at falls within the selected period. Open means
  //    HPP/Opp/Pursuit present and no closeWon/closeLost — mirrors
  //    the Active deals table on the same page.
  for (const [dealId, rows] of [...rowsByDeal]) {
    if (!isDealOpen(rows)) {
      rowsByDeal.delete(dealId);
      continue;
    }
    if (!dealMatchesPeriod(rows, year, filter)) {
      rowsByDeal.delete(dealId);
    }
  }

  // 3. Tally per root channel. Deals whose first-stage row has no
  //    channel_id fall into the NO_CHANNEL bucket.
  const tally = new Map<string, { count: number; amount: number; name: string }>();
  for (const [, rows] of rowsByDeal) {
    let primary: Attribution | null = null;
    for (const stage of REGION_STAGE_PRIORITY) {
      const found = rows.find((r) => r.stage_key === stage);
      if (found) {
        primary = found;
        break;
      }
    }
    if (!primary) continue;
    let bucketId: string;
    let bucketName: string;
    if (!primary.channel_id) {
      bucketId = NO_CHANNEL_KEY;
      bucketName = 'No channel';
    } else {
      bucketId = rootIdFor(primary.channel_id);
      bucketName = channelById.get(bucketId)?.name ?? 'Unknown';
    }
    const entry = tally.get(bucketId) ?? { count: 0, amount: 0, name: bucketName };
    entry.count += 1;
    entry.amount += primary.amount ?? 0;
    // Keep the most-recently-seen name (channel renames mid-period are
    // rare; first-write semantics would work too).
    entry.name = bucketName;
    tally.set(bucketId, entry);
  }

  let totalDeals = 0;
  let totalAmount = 0;
  for (const v of tally.values()) {
    totalDeals += v.count;
    totalAmount += v.amount;
  }
  const channelsOut: ChannelDealStats[] = [];
  for (const [channelId, v] of tally) {
    if (v.count <= 0) continue;
    // displayLabel = the canonical channel name. The year prefix
    // ("2025 - Sales") now lives directly in channels.name in the DB,
    // so any year-prefix construction here would double up
    // ("2025 - 2025 - Sales") on the Opportunities donut legend.
    channelsOut.push({
      channelId,
      channelName: v.name,
      displayLabel: v.name,
      dealCount: v.count,
      totalAmount: v.amount,
      percentageOfCount:
        totalDeals === 0 ? 0 : (v.count / totalDeals) * 100,
    });
  }
  channelsOut.sort((a, b) => b.dealCount - a.dealCount);

  return { channels: channelsOut, totalDeals, totalAmount };
}

// ---------- Event activations (Events sub-tab) ----------
//
// Per-event aggregation of contacts and their SFDC event_activations
// values. "Events" here are the sub-channels under the year's parent
// "2026 - Events" channel (e.g. ITC Japan, Limra L&A, Semana del
// Seguro). We pick descendants by walking parent_channel_id, not by
// name pattern, so renaming an individual event channel doesn't break
// the report.
//
// Counts are unique contacts (one row in leads per email), bucketed
// by source_channel_id = an Events descendant and
// marketing_sourced_date in the selected period. Region filter
// applies. Empty events (no contacts in the period) are dropped.

export interface EventActivationCounts {
  channelId: string;
  channelName: string;
  totalContacts: number;        // unique contacts at this event in period
  withAnyActivation: number;    // contacts with >= 1 activation
  perType: Record<EventActivation, number>;
  preAndPost: number;           // contacts with both Pre-Event and Post-Event
  multiActivation: number;      // contacts with >= 2 activations
}

export interface ComputeEventActivationsInput {
  leads: Lead[];
  channels: Channel[];
  parentChannelName: string;    // e.g. "2026 - Events"
  year: number;
  filter: PeriodFilter;
  regions: Set<RegionKey>;
}

export function computeEventActivations(
  input: ComputeEventActivationsInput,
): EventActivationCounts[] {
  const { leads, channels, parentChannelName, year, filter, regions } = input;

  // Resolve the parent channel by name. If absent, return empty.
  const parent = channels.find((c) => c.name === parentChannelName);
  if (!parent) return [];

  // Walk the parent's subtree via parent_channel_id. The Events parent
  // typically has direct children (one per event); future shapes
  // (sub-events under an event) would still flow correctly because
  // this is a recursive descendant collector.
  const childrenByParent = new Map<string, string[]>();
  for (const c of channels) {
    if (!c.parent_channel_id) continue;
    const arr = childrenByParent.get(c.parent_channel_id) ?? [];
    arr.push(c.id);
    childrenByParent.set(c.parent_channel_id, arr);
  }
  const eventChannelIds = new Set<string>();
  const visit = (nodeId: string): void => {
    for (const childId of childrenByParent.get(nodeId) ?? []) {
      eventChannelIds.add(childId);
      visit(childId);
    }
  };
  visit(parent.id);
  if (eventChannelIds.size === 0) return [];

  const channelById = new Map(channels.map((c) => [c.id, c] as const));

  // Tally per event channel.
  interface Tally {
    channelId: string;
    channelName: string;
    totalContacts: number;
    withAnyActivation: number;
    perType: Record<EventActivation, number>;
    preAndPost: number;
    multiActivation: number;
  }
  const tally = new Map<string, Tally>();
  const blankPerType = (): Record<EventActivation, number> => {
    const out = {} as Record<EventActivation, number>;
    for (const v of EVENT_ACTIVATION_VALUES) out[v] = 0;
    return out;
  };

  for (const lead of leads) {
    if (!lead.source_channel_id) continue;
    if (!eventChannelIds.has(lead.source_channel_id)) continue;
    if (!matchesRegionFilter(lead.region, regions)) continue;
    const bucket = quarterOfIsoDate(lead.marketing_sourced_date);
    if (!bucket || !matchesPeriod(bucket, year, filter)) continue;

    const ch = channelById.get(lead.source_channel_id);
    let t = tally.get(lead.source_channel_id);
    if (!t) {
      t = {
        channelId: lead.source_channel_id,
        channelName: ch?.name ?? 'Unknown',
        totalContacts: 0,
        withAnyActivation: 0,
        perType: blankPerType(),
        preAndPost: 0,
        multiActivation: 0,
      };
      tally.set(lead.source_channel_id, t);
    }
    t.totalContacts += 1;

    const activations = (lead.event_activations ?? []).filter((v) =>
      (EVENT_ACTIVATION_VALUES as readonly string[]).includes(v),
    ) as EventActivation[];
    const set = new Set<EventActivation>(activations);
    if (set.size >= 1) t.withAnyActivation += 1;
    if (set.size >= 2) t.multiActivation += 1;
    if (set.has('Pre-Event Meeting') && set.has('Post-Event Meeting')) {
      t.preAndPost += 1;
    }
    for (const v of set) {
      t.perType[v] += 1;
    }
  }

  return [...tally.values()]
    .filter((t) => t.totalContacts > 0)
    .sort((a, b) => b.totalContacts - a.totalContacts);
}

// ---------- Channel spend (Spend sub-tab) ----------
//
// Joins campaign_costs (date-range budgets) with leads, attributions,
// and touches to compute pro-rated cost, lead/MQL counts, first-touch
// pipeline, and ROI per channel. Pro-rating uses inclusive day
// overlap of the budget's [start_date, end_date] with the selected
// period window. A budget that fully encloses the period contributes
// its full proportional share (overlapDays / totalBudgetDays *
// amount).
//
// Region filter applies to leads and to attributions (so a child of
// a Content Syndication-style parent splits cost based on its
// REGION-FILTERED lead share). Cost itself is NOT region-scoped:
// budgets are sunk and the same dollar amount shows regardless of
// region toggles.
//
// First-touch: each deal's first touch is the touch with the
// smallest touched_at (nulls last) and on tie the smallest
// touch_order. The first touch's channel_id is the deal's
// first-touch channel for ROI accounting.

export interface ChannelSpendBreakdown {
  channelId: string;
  channelName: string;
  isParent: boolean;
  parentId: string | null;
  depth: number;

  // Pro-rated direct cost on this channel's own campaign_cost rows.
  cost: number;

  // For sub-channels of a parent-only-cost channel: this is the
  // proportional slice of the parent's cost based on this row's
  // share of leads in the period. Equals `cost` for channels that
  // carry their own direct cost (no allocation).
  allocatedCost: number;

  leads: number;
  mqls: number;
  firstTouchOpps: number;
  pipelineAmount: number;
  wonAmount: number;

  costPerLead: number | null;     // null when leads = 0
  costPerMql: number | null;      // null when mqls = 0
  roi: number | null;              // wonAmount / allocatedCost, null when cost = 0
}

export interface ComputeChannelSpendInput {
  campaignCosts: CampaignCost[];
  channels: Channel[];
  leads: Lead[];
  attributions: Attribution[];
  attributionTouches: AttributionTouch[];
  year: number;
  filter: PeriodFilter;
  regions: Set<RegionKey>;
}

interface PeriodBounds {
  start: string;     // ISO date inclusive
  end: string;       // ISO date inclusive
}

export function periodBoundsFor(
  year: number,
  filter: PeriodFilter,
): PeriodBounds {
  // Inclusive day endpoints, stringly typed so date math stays a
  // simple lexicographic compare against the cost rows.
  if (filter === 'year') {
    return { start: `${year}-01-01`, end: `${year}-12-31` };
  }
  const q = parseInt(filter.slice(1), 10);
  const startMonth = (q - 1) * 3; // 0-indexed month for Date.UTC
  const endMonth = startMonth + 2;
  const lastDayUtc = new Date(Date.UTC(year, endMonth + 1, 0));
  const m = String(startMonth + 1).padStart(2, '0');
  const lastDay = String(lastDayUtc.getUTCDate()).padStart(2, '0');
  const lastMonth = String(endMonth + 1).padStart(2, '0');
  return {
    start: `${year}-${m}-01`,
    end: `${year}-${lastMonth}-${lastDay}`,
  };
}

// True when at least one attribution row's stage_entered_at falls
// within the selected period. Used by the Opportunities sub-tab to
// include deals that originated in a prior year but had a stage
// transition in the selected period.
export function dealMatchesPeriod(
  rows: Attribution[],
  year: number,
  filter: PeriodFilter,
): boolean {
  const period = periodBoundsFor(year, filter);
  for (const r of rows) {
    const d = r.stage_entered_at;
    if (!d) continue;
    if (d >= period.start && d <= period.end) return true;
  }
  return false;
}

// Inclusive day count between two ISO dates (a <= b). Local-day math
// via UTC midnight so DST shifts don't poke a hole in the result.
function daysInclusive(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

// Overlap of two inclusive ISO ranges. Returns 0 when disjoint.
function overlapDays(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): number {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  if (end < start) return 0;
  return daysInclusive(start, end);
}

// Earliest stage_entered_at among hpp/opp/pursuit/closeWon/closeLost
// rows for a deal. Used as the deal's "cohort date" so a deal whose
// HPP happened in Q1 doesn't pollute Q2 pipeline figures even if its
// later stages live in Q2.
function dealCohortDate(rows: Attribution[]): string | null {
  let best: string | null = null;
  for (const r of rows) {
    if (!r.stage_entered_at) continue;
    if (best === null || r.stage_entered_at < best) best = r.stage_entered_at;
  }
  return best;
}

// Highest amount on a deal's attribution chain — used as the deal's
// representative pipeline amount. amounts can vary across stages
// (rare); taking max keeps the reading conservative without
// double-counting.
function dealAmount(rows: Attribution[]): number {
  let best = 0;
  for (const r of rows) {
    const a = r.amount ?? 0;
    if (a > best) best = a;
  }
  return best;
}

// Chronological order for a deal's touches: earliest touched_at first, with
// nulls LAST, tie-broken by touch_order ascending.
//
// touch_order is ENTRY order, not chronology (setTouchesFor assigns i + 1 from
// the editor's array position), so it can only ever be a tie-breaker. Shared by
// computeChannelSpend's first-touch resolution and the campaign scorecard's
// touch ranking so the two agree on what "first touch" means.
export function compareTouchesChronologically(
  a: AttributionTouch,
  b: AttributionTouch,
): number {
  const aNull = !a.touched_at;
  const bNull = !b.touched_at;
  if (aNull !== bNull) return aNull ? 1 : -1;
  if (!aNull && !bNull && a.touched_at !== b.touched_at) {
    return a.touched_at! < b.touched_at! ? -1 : 1;
  }
  return a.touch_order - b.touch_order;
}

export function computeChannelSpend(
  input: ComputeChannelSpendInput,
): ChannelSpendBreakdown[] {
  const {
    campaignCosts,
    channels,
    leads,
    attributions,
    attributionTouches,
    year,
    filter,
    regions,
  } = input;

  const period = periodBoundsFor(year, filter);
  const channelById = new Map(channels.map((c) => [c.id, c] as const));

  // children index for the parent-cost-allocation walk below.
  const childrenByParent = new Map<string, string[]>();
  for (const c of channels) {
    if (!c.parent_channel_id) continue;
    const arr = childrenByParent.get(c.parent_channel_id) ?? [];
    arr.push(c.id);
    childrenByParent.set(c.parent_channel_id, arr);
  }

  // --- 1. Pro-rated direct cost per channel.
  const directCost = new Map<string, number>();
  for (const cc of campaignCosts) {
    const total = daysInclusive(cc.start_date, cc.end_date);
    if (total <= 0) continue;
    const overlap = overlapDays(
      cc.start_date,
      cc.end_date,
      period.start,
      period.end,
    );
    if (overlap <= 0) continue;
    const prorated = cc.amount * (overlap / total);
    directCost.set(
      cc.channel_id,
      (directCost.get(cc.channel_id) ?? 0) + prorated,
    );
  }

  // --- 2. Leads per channel (region-filtered, period-bound by
  //        marketing_sourced_date). MQLs per channel via the
  //        earliest stage_history MQL entered_at.
  const leadsByChannel = new Map<string, number>();
  const mqlsByChannel = new Map<string, number>();
  for (const lead of leads) {
    if (!lead.source_channel_id) continue;
    if (!matchesRegionFilter(lead.region, regions)) continue;
    const d = lead.marketing_sourced_date;
    if (d && d >= period.start && d <= period.end) {
      leadsByChannel.set(
        lead.source_channel_id,
        (leadsByChannel.get(lead.source_channel_id) ?? 0) + 1,
      );
    }
    const mqlIso = firstMqlDate(lead);
    if (mqlIso && mqlIso >= period.start && mqlIso <= period.end) {
      mqlsByChannel.set(
        lead.source_channel_id,
        (mqlsByChannel.get(lead.source_channel_id) ?? 0) + 1,
      );
    }
  }

  // --- 3. Group attributions by deal_id. Skip rows without a
  //        deal_id (can't form a chain).
  const rowsByDeal = new Map<string, Attribution[]>();
  for (const a of attributions) {
    if (!a.deal_id) continue;
    const arr = rowsByDeal.get(a.deal_id) ?? [];
    arr.push(a);
    rowsByDeal.set(a.deal_id, arr);
  }

  // --- 4. Group touches by attribution_id for fast lookup.
  const touchesByAttribution = new Map<string, AttributionTouch[]>();
  for (const t of attributionTouches) {
    const arr = touchesByAttribution.get(t.attribution_id) ?? [];
    arr.push(t);
    touchesByAttribution.set(t.attribution_id, arr);
  }

  // --- 5. For each deal, determine its first-touch channel.
  //        First touch = earliest touched_at across all touches on
  //        ALL of the deal's attribution rows (nulls last); on tie,
  //        smallest touch_order. Fall back to the deal's HPP row's
  //        channel_id when no touches exist (manual entry, no
  //        touches added).
  const firstTouchByDeal = new Map<string, string | null>();
  for (const [dealId, rows] of rowsByDeal) {
    // Channel-bearing touches only: a touch with no channel can't attribute.
    // Filter BEFORE sorting so it can never win the first-touch slot.
    const touches = rows
      .flatMap((r) => touchesByAttribution.get(r.id) ?? [])
      .filter((t) => t.channel_id);
    const best = touches.sort(compareTouchesChronologically)[0];
    if (best) {
      firstTouchByDeal.set(dealId, best.channel_id ?? null);
      continue;
    }
    // No touches: fall back to the HPP row's channel.
    const hpp = rows.find((r) => r.stage_key === 'hpp');
    firstTouchByDeal.set(dealId, hpp?.channel_id ?? null);
  }

  // --- 6. Aggregate first-touch pipeline / won amounts and counts
  //        per channel, scoped to deals whose cohort date (earliest
  //        stage_entered_at) is in the period and whose HPP region
  //        passes the region filter.
  const firstTouchOpps = new Map<string, number>();
  const pipelineByChannel = new Map<string, number>();
  const wonByChannel = new Map<string, number>();
  for (const [dealId, rows] of rowsByDeal) {
    const ftChannel = firstTouchByDeal.get(dealId) ?? null;
    if (!ftChannel) continue;
    // Region: derive from the earliest stage row by
    // REGION_STAGE_PRIORITY so every deal-level surface reads the
    // same region for the same deal.
    const dealRegion = deriveDealRegion(rows);
    if (!matchesRegionFilter(dealRegion, regions)) continue;

    const cohort = dealCohortDate(rows);
    if (!cohort || cohort < period.start || cohort > period.end) continue;

    const hasLost = rows.some((r) => r.stage_key === 'closeLost');
    const wonRow = rows.find((r) => r.stage_key === 'closeWon');

    // firstTouchOpps + pipeline: deal reached HPP and isn't lost.
    if (rows.some((r) => r.stage_key === 'hpp') && !hasLost) {
      firstTouchOpps.set(
        ftChannel,
        (firstTouchOpps.get(ftChannel) ?? 0) + 1,
      );
      pipelineByChannel.set(
        ftChannel,
        (pipelineByChannel.get(ftChannel) ?? 0) + dealAmount(rows),
      );
    }
    // Won: separate, only when there's a closeWon row.
    if (wonRow) {
      wonByChannel.set(
        ftChannel,
        (wonByChannel.get(ftChannel) ?? 0) + (wonRow.amount ?? 0),
      );
    }
  }

  // --- 7. Distribute parent-only budget down to descendants, and track how
  //        much of each channel's OWN direct cost was successfully distributed.
  //        See the spend contract (CLEANUP_PLAN_EXECUTION.md Section 8):
  //
  //          retained direct cost = direct cost - distributed own direct cost
  //          rolled allocated cost = retained direct + sum(child rolled)
  //
  //        allocatedCost starts as each channel's own direct cost. When a
  //        parent's budget is distributed to descendants by lead share, we ADD
  //        the slice to each descendant AND record the distributed amount on the
  //        parent, so the roll-up (below) can subtract it and never double-count.
  const allocatedCost = new Map<string, number>();
  for (const channel of channels) {
    allocatedCost.set(channel.id, directCost.get(channel.id) ?? 0);
  }
  // How much of a channel's own direct cost flowed OUT to descendants. Whatever
  // is not distributed stays retained on the channel itself.
  const distributedOwnCost = new Map<string, number>();
  for (const channel of channels) {
    const parentCost = directCost.get(channel.id) ?? 0;
    if (parentCost <= 0) continue;
    const childIds = childrenByParent.get(channel.id) ?? [];
    if (childIds.length === 0) continue;
    // Only distribute when NO direct child has its own direct cost. When a
    // child carries its own budget, the parent's cost is a separate aggregate
    // that stays retained on the parent and is added (not overwritten) at
    // roll-up. This preserves the parent-plus-child sum (M2a).
    const anyChildDirect = childIds.some(
      (cid) => (directCost.get(cid) ?? 0) > 0,
    );
    if (anyChildDirect) continue;
    // Descendant leads (BFS), so a grandchild's leads still pull a share.
    const descendants = new Set<string>();
    let frontier = [...childIds];
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) {
        if (descendants.has(id)) continue;
        descendants.add(id);
        for (const k of childrenByParent.get(id) ?? []) next.push(k);
      }
      frontier = next;
    }
    let totalLeads = 0;
    for (const id of descendants) totalLeads += leadsByChannel.get(id) ?? 0;
    // No descendant leads means nothing to distribute: the parent RETAINS its
    // full direct cost (do not zero it out).
    if (totalLeads === 0) continue;
    for (const id of descendants) {
      const share = (leadsByChannel.get(id) ?? 0) / totalLeads;
      allocatedCost.set(
        id,
        (allocatedCost.get(id) ?? 0) + parentCost * share,
      );
    }
    // The whole parent budget was distributed across descendants.
    distributedOwnCost.set(channel.id, parentCost);
  }

  // --- 8. Materialize rows.
  // Depth is the channel's distance from the root (1 = top-level).
  const depthCache = new Map<string, number>();
  const depthOf = (id: string): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const ch = channelById.get(id);
    if (!ch) return 1;
    const d = ch.parent_channel_id
      ? depthOf(ch.parent_channel_id) + 1
      : 1;
    depthCache.set(id, d);
    return d;
  };

  const out: ChannelSpendBreakdown[] = [];
  for (const channel of channels) {
    const c = directCost.get(channel.id) ?? 0;
    const ac = allocatedCost.get(channel.id) ?? 0;
    const leadsCount = leadsByChannel.get(channel.id) ?? 0;
    const mqlsCount = mqlsByChannel.get(channel.id) ?? 0;
    const opps = firstTouchOpps.get(channel.id) ?? 0;
    const pipeline = pipelineByChannel.get(channel.id) ?? 0;
    const won = wonByChannel.get(channel.id) ?? 0;
    const cpl = leadsCount > 0 ? ac / leadsCount : null;
    const cpmql = mqlsCount > 0 ? ac / mqlsCount : null;
    // ROI is won-based, not pipeline-based: pipeline can deflate as
    // deals fall through, and reporting unclosed dollars as "return"
    // inflates channels that haven't actually paid back yet.
    const roi = ac > 0 ? won / ac : null;
    out.push({
      channelId: channel.id,
      channelName: channel.name,
      isParent: (childrenByParent.get(channel.id) ?? []).length > 0,
      parentId: channel.parent_channel_id ?? null,
      depth: depthOf(channel.id),
      cost: c,
      allocatedCost: ac,
      leads: leadsCount,
      mqls: mqlsCount,
      firstTouchOpps: opps,
      pipelineAmount: pipeline,
      wonAmount: won,
      costPerLead: cpl,
      costPerMql: cpmql,
      roi,
    });
  }

  // --- 9. Roll up sub-channel metrics to their parents.
  //
  // A parent's displayed value = its OWN contribution + the sum of its direct
  // children's (already rolled-up) values. We walk post-order so deeper
  // subtrees aggregate before their ancestors. `cost` (direct only) is left
  // alone so callers that sum direct cost across rows stay double-count-free;
  // the displayed Cost column reads `allocatedCost`.
  //
  // For allocatedCost the parent contributes its RETAINED direct cost (own
  // direct cost minus whatever was distributed to descendants), per the spend
  // contract (Section 8):
  //
  //   rolled allocated = retained direct + sum(child rolled allocated)
  //
  //   - Distributed-down shape (e.g. Content Syndication): the parent's whole
  //     budget went to children, so retained = 0 and the parent reads the sum
  //     of the slices, which equals its budget. No double count.
  //   - Zero-descendant-lead shape: nothing distributed, retained = full budget,
  //     children contribute 0, so the parent keeps its budget instead of zeroing.
  //   - Parent-plus-child-direct shape (M2a): allocation is skipped, retained =
  //     the parent's own budget, and the child's own budget rolls up on top, so
  //     the parent shows the sum of both.
  const rowsById = new Map<string, ChannelSpendBreakdown>();
  for (const r of out) rowsById.set(r.channelId, r);
  const rolledUp = new Set<string>();
  const rollupRow = (channelId: string): void => {
    if (rolledUp.has(channelId)) return;
    rolledUp.add(channelId);
    const kids = childrenByParent.get(channelId) ?? [];
    if (kids.length === 0) return; // leaf, nothing to do
    for (const kid of kids) rollupRow(kid);
    const r = rowsById.get(channelId);
    if (!r) return;
    // Retained direct cost: the channel's own direct cost that was NOT
    // distributed to descendants.
    const own = directCost.get(channelId) ?? 0;
    const distributed = distributedOwnCost.get(channelId) ?? 0;
    let allocCost = own - distributed;
    let leads = leadsByChannel.get(channelId) ?? 0;
    let mqls = mqlsByChannel.get(channelId) ?? 0;
    let opps = firstTouchOpps.get(channelId) ?? 0;
    let pipe = pipelineByChannel.get(channelId) ?? 0;
    let won = wonByChannel.get(channelId) ?? 0;
    for (const kid of kids) {
      const cr = rowsById.get(kid);
      if (!cr) continue;
      allocCost += cr.allocatedCost;
      leads += cr.leads;
      mqls += cr.mqls;
      opps += cr.firstTouchOpps;
      pipe += cr.pipelineAmount;
      won += cr.wonAmount;
    }
    r.allocatedCost = allocCost;
    r.leads = leads;
    r.mqls = mqls;
    r.firstTouchOpps = opps;
    r.pipelineAmount = pipe;
    r.wonAmount = won;
    r.costPerLead = leads > 0 ? allocCost / leads : null;
    r.costPerMql = mqls > 0 ? allocCost / mqls : null;
    r.roi = allocCost > 0 ? won / allocCost : null;
  };
  for (const channel of channels) rollupRow(channel.id);

  return out;
}

// =============================================================
// BDR quota progress
// =============================================================
// A deal counts toward a BDR's HPP/SAO actuals when BOTH:
//   (a) its first-touch top-level channel's base name == "Marketing SDR"
//       (any sub-campaign under Marketing SDR qualifies), AND
//   (b) its bdr_name matches the BDR.
// Actuals are counts of the deal's hpp / opp stage rows whose year matches the
// selected year (a deal can contribute to both HPP and SAO). Quotas come from
// the bdr_quotas rows. Program totals sum across the roster.

export interface BdrMatchedDeal {
  dealId: string;
  label: string;
  account: string | null;
  stageKey: BdrStage;
  stageEnteredAt: string;
  // An attribution row id for this deal, so the UI can open the editor.
  attributionId: string;
}

export interface BdrStageProgress {
  stageKey: BdrStage;
  actual: number;
  quota: number | null;
  // actual / quota as a 0..1 fraction; null when no quota set.
  pct: number | null;
  deals: BdrMatchedDeal[];
}

export interface BdrProgressRow {
  // bdr_name, or 'Program' for the roll-up row.
  bdrName: string;
  isProgram: boolean;
  stages: Record<BdrStage, BdrStageProgress>;
}

// One quarter's HPP-created counts for the year-over-year chart.
export interface BdrQuarterlyCreated {
  quarter: PeriodIndex;     // 1..4
  currentYear: number;      // HPPs created in the selected year's quarter
  priorYear: number;        // HPPs created in (year - 1)'s quarter
}

export interface BdrQuotaProgress {
  rows: BdrProgressRow[];          // [program, ...per-BDR]
  quarterly: BdrQuarterlyCreated[]; // 4 entries, Q1..Q4 (year vs year-1)
}

export interface ComputeBdrQuotaProgressInput {
  attributions: Attribution[];
  quotas: BdrQuota[];
  year: number;
  // Gauge scope: 'year' counts the whole year; 'Q1'..'Q4' counts only deals
  // whose HPP (created) date falls in that quarter. The quarterly chart
  // ignores this and always shows all four quarters.
  filter: PeriodFilter;
}

export function computeBdrQuotaProgress(
  input: ComputeBdrQuotaProgressInput,
): BdrQuotaProgress {
  const { attributions, quotas, year, filter } = input;

  // A deal counts toward a BDR purely by its bdr_name tag — independent of
  // channel / first touch. (An earlier version also required first-touch =
  // Marketing SDR, but that silently excluded tagged deals; per product
  // decision the bdr_name field alone decides.)
  const rowsByDeal = new Map<string, Attribution[]>();
  for (const a of attributions) {
    if (!a.deal_id) continue;
    const arr = rowsByDeal.get(a.deal_id) ?? [];
    arr.push(a);
    rowsByDeal.set(a.deal_id, arr);
  }

  // Quota lookup: (bdr_name, stage) -> quota for the selected year.
  const quotaByKey = new Map<string, number | null>();
  for (const q of quotas) {
    if (q.year !== year) continue;
    quotaByKey.set(`${q.bdr_name}|${q.stage_key}`, q.quota);
  }

  // Seed an empty result for every roster BDR + the program row, so a BDR
  // with no matching deals still renders (at 0 / quota).
  const emptyStages = (): Record<BdrStage, BdrStageProgress> => {
    const out = {} as Record<BdrStage, BdrStageProgress>;
    for (const s of BDR_STAGES) {
      out[s] = { stageKey: s, actual: 0, quota: null, pct: null, deals: [] };
    }
    return out;
  };

  const byBdr = new Map<string, BdrProgressRow>();
  for (const bdr of BDRS) {
    byBdr.set(bdr, { bdrName: bdr, isProgram: false, stages: emptyStages() });
  }

  // The deal's "created" quarter = the quarter of its HPP row's date (fall
  // back to the earliest stage_entered_at if there's no HPP row). Used both to
  // scope the gauges by the quarter filter and to bucket the YoY chart.
  const createdQtrByDeal = new Map<
    string,
    { year: number; quarter: PeriodIndex } | null
  >();
  for (const [dealId, rows] of rowsByDeal) {
    const hpp = rows.find((r) => r.stage_key === 'hpp');
    const anchor =
      hpp?.stage_entered_at ??
      [...rows]
        .map((r) => r.stage_entered_at)
        .filter(Boolean)
        .sort()[0];
    createdQtrByDeal.set(dealId, quarterOfIsoDate(anchor) ?? null);
  }

  // Selected quarter from the filter ('year' = no quarter scoping).
  const selectedQuarter: PeriodIndex | null =
    filter === 'year' ? null : (Number(filter.slice(1)) as PeriodIndex);

  // YoY HPP-created series: per quarter, count BDR-tagged deals whose HPP
  // landed in that quarter, for `year` and `year - 1`. Always all 4 quarters.
  const quarterlyCurrent = [0, 0, 0, 0];
  const quarterlyPrior = [0, 0, 0, 0];

  // Two scopes:
  //   - `chartRoster` (active BDRs + 'Other') feeds the YoY created chart, so
  //     deals from departed reps still show in the trend.
  //   - `gaugeRoster` (active BDRs only) feeds the gauge cards + Program total;
  //     'Other' has no card and no quota, so it's excluded there.
  const chartRoster = new Set<string>(BDR_OPTIONS);
  const gaugeRoster = new Set<string>(BDRS);
  for (const [dealId, rows] of rowsByDeal) {
    const bdr = rows.find((r) => r.bdr_name)?.bdr_name ?? null;
    if (!bdr || !chartRoster.has(bdr)) continue;
    const created = createdQtrByDeal.get(dealId) ?? null;

    // YoY chart: bucket the deal's HPP-created quarter for this/prior year.
    // Includes 'Other'.
    const hasHpp = rows.some((r) => r.stage_key === 'hpp');
    if (created && hasHpp) {
      if (created.year === year) quarterlyCurrent[created.quarter - 1] += 1;
      else if (created.year === year - 1)
        quarterlyPrior[created.quarter - 1] += 1;
    }

    // Gauges: active BDRs only. Scope by the deal's CREATED quarter/year (HPP
    // date), so a deal created in Q2 counts both its HPP and SAO under Q2 —
    // matching "use the HPP date as the created date".
    if (!gaugeRoster.has(bdr)) continue;
    if (!created || created.year !== year) continue;
    if (selectedQuarter !== null && created.quarter !== selectedQuarter) {
      continue;
    }
    const row = byBdr.get(bdr)!;
    for (const r of rows) {
      if (r.stage_key !== 'hpp' && r.stage_key !== 'opp') continue;
      const stage = r.stage_key as BdrStage;
      const sp = row.stages[stage];
      sp.actual += 1;
      sp.deals.push({
        dealId,
        label: r.label ?? '(unnamed deal)',
        account: r.account ?? null,
        stageKey: stage,
        stageEnteredAt: r.stage_entered_at,
        attributionId: r.id,
      });
    }
  }

  // Attach quotas + pct, and build the program roll-up.
  const program: BdrProgressRow = {
    bdrName: 'Program',
    isProgram: true,
    stages: emptyStages(),
  };
  const rows: BdrProgressRow[] = [];
  for (const bdr of BDRS) {
    const row = byBdr.get(bdr)!;
    for (const s of BDR_STAGES) {
      const sp = row.stages[s];
      sp.quota = quotaByKey.get(`${bdr}|${s}`) ?? null;
      sp.pct = sp.quota && sp.quota > 0 ? sp.actual / sp.quota : null;
      // Roll into program.
      const ps = program.stages[s];
      ps.actual += sp.actual;
      ps.quota = (ps.quota ?? 0) + (sp.quota ?? 0);
      ps.deals.push(...sp.deals);
    }
    rows.push(row);
  }
  for (const s of BDR_STAGES) {
    const ps = program.stages[s];
    ps.pct = ps.quota && ps.quota > 0 ? ps.actual / ps.quota : null;
  }

  const quarterly: BdrQuarterlyCreated[] = [1, 2, 3, 4].map((q) => ({
    quarter: q as PeriodIndex,
    currentYear: quarterlyCurrent[q - 1],
    priorYear: quarterlyPrior[q - 1],
  }));

  return { rows: [program, ...rows], quarterly };
}
