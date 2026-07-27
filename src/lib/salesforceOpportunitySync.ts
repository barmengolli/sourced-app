// salesforceOpportunitySync.ts: pure read-only mapping layer between
// Salesforce wire records and the Bite 5A Opportunity movement contract
// (Bite 5C1, docs/salesforce-opportunity-sync.md).
//
// This module proves the extraction queries and mapping BEFORE any database
// ingestion exists. It writes nothing anywhere: no Supabase, no network, no
// clock. Movement, milestone, and velocity semantics stay in
// opportunityStageHistory.ts (Bite 5A) and review semantics in
// opportunityImportStorage.ts (Bite 5B); nothing here re-derives them.
//
// Responsibilities:
//   - Wire types for the Opportunity SOQL and OpportunityFieldHistory rows.
//   - Mapping wire rows into the Bite 5A input types, preserving the full
//     Salesforce timestamps (never either duplicated report date column).
//   - Deterministic ID batching for history queries (SOQL IN-clause limits).
//   - Initial-sync scope classification (open / created-in-year /
//     modified-in-year / closed-in-year / older-open) so the production
//     backfill choice is made by a human from real counts, never silently.
//   - The sanitized dry-run summary: aggregates only, no names, accounts,
//     owners, campaigns, Salesforce IDs, or raw records, with
//     dry_run: true and writes_attempted: 0 hard-coded.

import {
  adaptOpportunityHistory,
  DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP,
  DEFAULT_OPPORTUNITY_TERMINAL_STAGE_MAP,
  DEFAULT_OPPORTUNITY_OPEN_STAGE_VALUES,
} from './opportunityStageHistory';
import type {
  OpportunityHistoryRow,
  OpportunityBaselineObservation,
  OpportunityStageConfig,
  OpportunityFunnelStage,
} from './opportunityStageHistory';
import { buildReviewSeed } from './opportunityImportStorage';
import type { ReviewIssueCode } from './opportunityImportStorage';
import { currentFunnelSnapshot } from './opportunityStageHistory';

// ---------------------------------------------------------------------------
// Wire shapes (standard Salesforce API names only; custom fields ride along
// untyped until the describe step confirms their exact API names)
// ---------------------------------------------------------------------------

export interface SalesforceOpportunityRecord {
  Id: string;
  Name?: string | null;
  AccountId?: string | null;
  Account?: { Name?: string | null } | null;
  RecordType?: { DeveloperName?: string | null; Name?: string | null } | null;
  StageName?: string | null;
  IsClosed?: boolean | null;
  IsWon?: boolean | null;
  CreatedDate?: string | null;
  LastModifiedDate?: string | null;
  SystemModstamp?: string | null;
  Amount?: number | null;
  CurrencyIsoCode?: string | null;
  CloseDate?: string | null;
  OwnerId?: string | null;
  Owner?: { Name?: string | null } | null;
  CampaignId?: string | null;
  Campaign?: { Name?: string | null } | null;
  // Custom fields (Commercial Region, milestone dates, BDR, GTM fields)
  // arrive here once their API names are confirmed by the describe step.
  [customField: string]: unknown;
}

export interface SalesforceOpportunityHistoryRecord {
  Id: string;
  OpportunityId: string;
  Field: string;
  OldValue?: string | null;
  NewValue?: string | null;
  // Full OpportunityFieldHistory.CreatedDate timestamp. The report export's
  // duplicated date-only columns are never used.
  CreatedDate: string;
}

// The three currently included record types by DeveloperName, the current
// authoritative classification. RecordType IDs are never used.
export const INCLUDED_DEVELOPER_NAMES: Record<string, OpportunityFunnelStage> = {
  High_Potential_Prospect: 'hpp',
  Leads: 'opp',
  Licensing: 'pursuit',
};

// Legacy Stage aliases confirmed from the second live dry run's label
// diagnostics. Explicit exact matches only (after whitespace and zero-width
// normalization); nothing is ever fuzzy-matched.
export const LEGACY_TERMINAL_STAGE_ALIASES: Record<
  string,
  'won' | 'lost' | 'disqualified' | 'nurture'
> = {
  '0. Recycle/Nurture': 'nurture',
  'Recycle / Nurture': 'nurture',
  '0) Recycle / Nurture': 'nurture',
  'Close-Lost-No Decision': 'lost',
  'Close-No Decision': 'lost',
  'Closed-Won': 'won',
  '9) Closed-Won': 'won',
  'CP DQ - Project Cancelled': 'disqualified',
};

export const LEGACY_OPEN_STAGE_ALIASES: string[] = [
  'Suspect',
  '1. Suspect',
  'Opportunity Assessment',
  '2. Opportunity Assessment',
  'Qualification',
  '1) Qualification',
  'Demo / Oral Presentations',
  'Pitching',
  '3) Pitching',
  'Proposal',
  'Discovery',
  '2) Discovery',
  'Initial Proposal / Term Sheet',
  'Proof of Concept',
  'Negotiation',
  'Risk Assessment',
  '4.1) Pursuit Evaluation',
  '9) Contract Agreement',
  'Contract Agreement / Awaiting Execution',
  'Awaiting Execution',
  'Contract Creation',
  'Contract Agreement',
  '7) Contract Agreement',
];

// Zero-width characters and surrounding whitespace are normalized away
// before EXACT matching; this is normalization, not fuzzy matching.
const ZERO_WIDTH = /\u200B|\u200C|\u200D|\uFEFF/g;

export function normalizeSourceValue(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = value.replace(ZERO_WIDTH, '').trim();
  return cleaned === '' ? null : cleaned;
}

// Dry-run configuration: the Bite 5A confirmed alias map (labels, legacy
// labels, developer names) plus the API-side history field tokens, which
// the first live run confirmed ('RecordType' and 'StageName'), extended
// with the legacy Stage aliases above. Current aliases are preserved.
export const DRY_RUN_STAGE_CONFIG: OpportunityStageConfig = {
  recordTypeFieldName: 'RecordType',
  recordTypeMap: DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP,
  stageFieldName: 'StageName',
  terminalStageMap: { ...DEFAULT_OPPORTUNITY_TERMINAL_STAGE_MAP, ...LEGACY_TERMINAL_STAGE_ALIASES },
  openStageValues: [...DEFAULT_OPPORTUNITY_OPEN_STAGE_VALUES, ...LEGACY_OPEN_STAGE_ALIASES],
};

// Custom-field API names confirmed via the runtime describe/FieldDefinition
// step (second live run). Labels map to exact API names; nothing is guessed.
export const CONFIRMED_CUSTOM_FIELDS: Record<string, string> = {
  'Commercial Region': 'Commercial_Region__c',
  'HPP Date': 'HPP_Date__c',
  'Opportunity Date': 'Opportunity_Date__c',
  'Pursuit Date': 'Pursuit_Date__c',
  'Sales Development Rep / BDR': 'Sales_Development_Rep__c',
  'SaaS Revenue': 'SaaS_Revenue__c',
  'SaaS Revenue USD': 'SaaS_Revenue_USD__c',
  Currency: 'CurrencyIsoCode',
  'GTM - Cube': 'GTM_Cube__c',
  'Customer Expansion': 'Existing_Customer_or_New_Business__c',
  'Line of Business (LOB)': 'Business_Units__c',
  'Primary Campaign Source': 'CampaignId',
};

// Industry Vertical stays intentionally unresolved: Salesforce carries
// several candidates and the business has not chosen one. The dry run
// reports nonblank coverage for the two directly-named candidates so the
// choice is made from data, never silently. Insurance_vertical__c is the
// third known candidate, documented but not pulled by default.
export const INDUSTRY_VERTICAL_CANDIDATES: string[] = [
  'Industry_Vertical__c',
  'Pursuit_Industry_Vertical__c',
];

// ---------------------------------------------------------------------------
// Mapping into the Bite 5A contract
// ---------------------------------------------------------------------------

export function mapHistoryRecord(rec: SalesforceOpportunityHistoryRecord): OpportunityHistoryRow {
  return {
    historyId: rec.Id,
    opportunityId: rec.OpportunityId,
    field: rec.Field,
    oldValue: rec.OldValue ?? null,
    newValue: rec.NewValue ?? null,
    changedAt: rec.CreatedDate,
  };
}

// Baseline observation for an Opportunity with no retained record-type
// history: its current DeveloperName as of the sync. The entry date stays
// unknown per the Bite 5A contract; observedAt is the sync time supplied by
// the caller (this module never reads the clock).
export function mapBaselineObservation(
  rec: SalesforceOpportunityRecord,
  observedAt: string,
): OpportunityBaselineObservation {
  return {
    opportunityId: rec.Id,
    recordTypeValue: rec.RecordType?.DeveloperName ?? '',
    observedAt,
    sourceId: `baseline:${rec.Id}`,
  };
}

// ---------------------------------------------------------------------------
// Runtime RecordType resolution
// ---------------------------------------------------------------------------
// OpportunityFieldHistory returns RecordTypeId values in OldValue/NewValue,
// not labels or DeveloperNames. The dry run queries RecordType read-only
// (SELECT Id, Name, DeveloperName, SobjectType FROM RecordType WHERE
// SobjectType = 'Opportunity') and resolves through a RUNTIME map:
// RecordType Id -> DeveloperName -> Bite 5A normalized stage. IDs are never
// hardcoded and never appear in the aggregate summary.

export interface SalesforceRecordTypeRef {
  Id: string;
  Name?: string | null;
  DeveloperName: string;
  SobjectType?: string | null;
}

export interface RecordTypeRefEntry {
  developerName: string;
  name: string;
  // Whether Salesforce runtime metadata confirms this record type belongs
  // to the Opportunity object.
  isOpportunityType: boolean;
}

// The workflow now queries ALL record types (no SobjectType filter) so a
// history value pointing at a non-Opportunity or retired record type can
// still be NAMED in diagnostics instead of remaining an anonymous id.
export function buildRecordTypeIdMap(
  refs: SalesforceRecordTypeRef[],
): Record<string, RecordTypeRefEntry> {
  const map: Record<string, RecordTypeRefEntry> = {};
  for (const ref of refs) {
    if (!ref.Id?.trim() || !ref.DeveloperName?.trim()) continue;
    const entry: RecordTypeRefEntry = {
      developerName: ref.DeveloperName.trim(),
      name: (ref.Name ?? ref.DeveloperName).trim(),
      isOpportunityType: (ref.SobjectType ?? '').trim() === 'Opportunity',
    };
    map[ref.Id.trim()] = entry;
    // Salesforce IDs appear in both 15- and 18-character forms; index the
    // 15-character prefix of an 18-character id too.
    if (ref.Id.trim().length === 18) map[ref.Id.trim().slice(0, 15)] = entry;
  }
  return map;
}

const SFDC_ID_SHAPE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

export type RecordTypeResolution =
  | { kind: 'blank' }
  | { kind: 'resolved_via_id_map'; value: string; ref: RecordTypeRefEntry }
  | { kind: 'resolved_known_value'; value: string }
  | { kind: 'unresolved_id_shaped'; value: string }
  | { kind: 'unmapped_label'; value: string };

// Resolve one raw record-type history value (normalized first). Unresolved
// values keep their raw form so the Bite 5A adapter classifies them unknown
// and routes them to review; nothing is fuzzy-matched or guessed.
export function resolveRecordTypeValue(
  raw: string | null,
  idMap: Record<string, RecordTypeRefEntry>,
): RecordTypeResolution {
  const v = normalizeSourceValue(raw);
  if (v === null) return { kind: 'blank' };
  const viaId = idMap[v];
  if (viaId !== undefined) {
    return { kind: 'resolved_via_id_map', value: viaId.developerName, ref: viaId };
  }
  if (DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP[v] !== undefined) {
    // Historical labels and DeveloperNames keep working directly.
    return { kind: 'resolved_known_value', value: v };
  }
  if (SFDC_ID_SHAPE.test(v)) return { kind: 'unresolved_id_shaped', value: v };
  return { kind: 'unmapped_label', value: v };
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

// Deterministic ID batching for history SOQL IN clauses. Deduplicates while
// preserving first-seen order; every unique id appears in exactly one batch.
export function chunkOpportunityIds(ids: string[], batchSize = 200): string[][] {
  if (batchSize < 1) throw new Error('batchSize must be at least 1');
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += batchSize) {
    batches.push(unique.slice(i, i + batchSize));
  }
  return batches;
}

// ---------------------------------------------------------------------------
// Initial-sync scope classification
// ---------------------------------------------------------------------------

export interface ScopeCounts {
  // Every pulled Opportunity in the three included record types.
  discovered: number;
  openNow: number;
  closedNow: number;
  createdInYear: number;
  modifiedInYear: number;
  // Closed deals whose Salesforce CloseDate falls in the year. Named
  // precisely: CloseDate is a plan/report field, not proof of when closure
  // actually happened; true closure timing comes from Stage history.
  closedWithCloseDateInYear: number;
  // Open Opportunities created BEFORE the year: the group a CreatedDate-only
  // backfill would silently drop, which is why that filter is unsafe.
  olderOpen: number;
}

export function classifyScope(
  records: SalesforceOpportunityRecord[],
  year: number,
): ScopeCounts {
  const start = `${year}-01-01`;
  const counts: ScopeCounts = {
    discovered: records.length,
    openNow: 0,
    closedNow: 0,
    createdInYear: 0,
    modifiedInYear: 0,
    closedWithCloseDateInYear: 0,
    olderOpen: 0,
  };
  for (const r of records) {
    const created = (r.CreatedDate ?? '').slice(0, 10);
    const modified = (r.SystemModstamp ?? r.LastModifiedDate ?? '').slice(0, 10);
    const closeDate = (r.CloseDate ?? '').slice(0, 10);
    const open = r.IsClosed === false;
    if (open) counts.openNow += 1;
    if (r.IsClosed === true) counts.closedNow += 1;
    if (created >= start) counts.createdInYear += 1;
    if (modified >= start) counts.modifiedInYear += 1;
    if (r.IsClosed === true && closeDate >= start) counts.closedWithCloseDateInYear += 1;
    if (open && created !== '' && created < start) counts.olderOpen += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Sanitized dry-run summary
// ---------------------------------------------------------------------------

// Occurrences count individual OldValue/NewValue instances; affectedRows
// counts history rows containing at least one such instance. The two units
// are reported separately and never mixed.
export interface ValueResolutionCounts {
  resolvedViaIdMap: number;
  resolvedAsKnownValue: number;
  // Blank OldValue on an initial history row is a normal baseline, not an
  // unknown value.
  blankBaseline: number;
  unresolvedIdShaped: number;
  unmappedNonblankLabel: number;
  affectedRows: number;
}

export interface UnknownStageLabelDiagnostic {
  label: string;
  occurrences: number;
  seenAs: 'old' | 'new' | 'both';
}

// A nonblank record-type value that resolved to runtime metadata outside
// the funnel mapping (or to no metadata at all). Named for a business
// decision; never auto-classified, and RecordType ids never appear.
export interface UnmappedRecordTypeDiagnostic {
  name: string;
  developerName: string | null;
  occurrences: number;
  seenAs: 'old' | 'new' | 'both';
  // True when Salesforce runtime metadata confirms the record type belongs
  // to the Opportunity object.
  confirmedOpportunityType: boolean;
}

// MUTUALLY EXCLUSIVE categories satisfying:
// candidateGroups = harmlessCrossLedgerGroups
//   + uniquelyProvableOrOrderIndependent + materiallyAmbiguous.
export interface SameTimestampClassification {
  // Every (opportunity, timestamp) group with two or more funnel-relevant
  // history rows: candidates, not errors.
  candidateGroups: number;
  // Groups without competing record-type rows (cross-ledger co-timing or
  // stage-only multiples): independently interpretable.
  harmlessCrossLedgerGroups: number;
  // Record-type-conflicting groups Bite 5A accepted: order proven by
  // old-value chaining or outcome order-independent.
  uniquelyProvableOrOrderIndependent: number;
  // Only these create ambiguous_same_timestamp review issues, decided by
  // the authoritative Bite 5A calculation.
  materiallyAmbiguous: number;
}

export interface DryRunSummary {
  executedAt: string;
  dry_run: true;
  writes_attempted: 0;
  scope: ScopeCounts;
  countsByRecordTypeDeveloperName: Record<string, number>;
  countsByNormalizedCurrentStage: Record<string, number>;
  history: {
    rowsDiscovered: number;
    recordTypeRows: number;
    stageRows: number;
    otherFieldRows: number;
    exactDuplicates: number;
    conflictingDuplicateHistoryIds: number;
    invalidTimestamps: number;
    recordTypeValues: ValueResolutionCounts;
    recordTypeDiagnostics: UnmappedRecordTypeDiagnostic[];
    stageValues: {
      resolved: number;
      blankBaseline: number;
      unknownNonblank: number;
      affectedRows: number;
      // Aggregate label diagnostics: labels are picklist configuration
      // metadata, never record data. No fuzzy mapping is ever applied.
      unknownLabels: UnknownStageLabelDiagnostic[];
    };
  };
  movement: {
    forwardMoves: number;
    backwardMoves: number;
    forwardSkips: number;
    backwardSkips: number;
    sameTimestamp: SameTimestampClassification;
  };
  review: {
    opportunitiesRequiringReview: number;
    countsByIssue: Record<string, number>;
  };
  // Nonblank coverage per Industry Vertical candidate so the field choice
  // is a data-informed business decision, never a silent default.
  industryVertical: {
    candidates: string[];
    nonblankCoverage: Record<string, number>;
  };
}

// Build the authoritative dry-run summary: RecordType-Id resolution, then
// mapping, then the REAL Bite 5A derivation and Bite 5B review seeding,
// then aggregation. The output holds aggregates only; no identifier, name,
// account, owner, campaign, or RecordType Id from the input can appear.
export function buildDryRunSummary(
  records: SalesforceOpportunityRecord[],
  historyRecords: SalesforceOpportunityHistoryRecord[],
  recordTypeRefs: SalesforceRecordTypeRef[],
  input: { executedAt: string; year: number },
): DryRunSummary {
  const idMap = buildRecordTypeIdMap(recordTypeRefs);

  // Resolve record-type history values through the runtime map BEFORE the
  // Bite 5A derivation, counting occurrences and affected rows separately.
  const rtValueCounts: ValueResolutionCounts = {
    resolvedViaIdMap: 0,
    resolvedAsKnownValue: 0,
    blankBaseline: 0,
    unresolvedIdShaped: 0,
    unmappedNonblankLabel: 0,
    affectedRows: 0,
  };
  const unmappedRecordTypes = new Map<
    string,
    { name: string; developerName: string | null; occurrences: number; old: boolean; new: boolean; confirmedOpportunityType: boolean }
  >();
  const noteUnmapped = (
    key: string,
    entry: { name: string; developerName: string | null; confirmedOpportunityType: boolean },
    side: 'old' | 'new',
  ): void => {
    const d = unmappedRecordTypes.get(key) ?? { ...entry, occurrences: 0, old: false, new: false };
    d.occurrences += 1;
    d[side] = true;
    unmappedRecordTypes.set(key, d);
  };
  const resolveSide = (raw: string | null, side: 'old' | 'new'): string | null => {
    const r = resolveRecordTypeValue(raw, idMap);
    switch (r.kind) {
      case 'blank':
        rtValueCounts.blankBaseline += 1;
        return null;
      case 'resolved_via_id_map':
        rtValueCounts.resolvedViaIdMap += 1;
        // Resolved to real runtime metadata, but OUTSIDE the funnel mapping:
        // name it for a business decision instead of leaving an anonymous
        // unknown. The id itself never leaves this function.
        if (DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP[r.value] === undefined) {
          noteUnmapped(
            r.ref.developerName,
            { name: r.ref.name, developerName: r.ref.developerName, confirmedOpportunityType: r.ref.isOpportunityType },
            side,
          );
        }
        return r.value;
      case 'resolved_known_value':
        rtValueCounts.resolvedAsKnownValue += 1;
        return r.value;
      case 'unresolved_id_shaped':
        rtValueCounts.unresolvedIdShaped += 1;
        return r.value;
      case 'unmapped_label':
        rtValueCounts.unmappedNonblankLabel += 1;
        noteUnmapped(r.value, { name: r.value, developerName: null, confirmedOpportunityType: false }, side);
        return r.value;
    }
  };
  const rows = historyRecords.map((rec) => {
    const mapped = mapHistoryRecord(rec);
    if (mapped.field === DRY_RUN_STAGE_CONFIG.stageFieldName) {
      // Normalization only (whitespace, zero-width characters); exact
      // matching happens against the alias sets downstream.
      return {
        ...mapped,
        oldValue: normalizeSourceValue(mapped.oldValue),
        newValue: normalizeSourceValue(mapped.newValue),
      };
    }
    if (mapped.field !== DRY_RUN_STAGE_CONFIG.recordTypeFieldName) return mapped;
    const before = rtValueCounts.unresolvedIdShaped + rtValueCounts.unmappedNonblankLabel;
    const oldValue = resolveSide(mapped.oldValue, 'old');
    const newValue = resolveSide(mapped.newValue, 'new');
    const after = rtValueCounts.unresolvedIdShaped + rtValueCounts.unmappedNonblankLabel;
    if (after > before) rtValueCounts.affectedRows += 1;
    return { ...mapped, oldValue, newValue };
  });

  // Stage-value diagnostics: blank baselines are normal; only nonblank
  // labels outside both closed sets are unknown, tracked per label with
  // where they appeared. No fuzzy mapping.
  const stageKnown = new Set<string>([
    ...Object.keys(DRY_RUN_STAGE_CONFIG.terminalStageMap ?? {}),
    ...(DRY_RUN_STAGE_CONFIG.openStageValues ?? []),
  ]);
  const stageValueCounts = { resolved: 0, blankBaseline: 0, unknownNonblank: 0, affectedRows: 0 };
  const unknownStageLabels = new Map<string, { occurrences: number; old: boolean; new: boolean }>();
  for (const rec of historyRecords) {
    if (rec.Field !== DRY_RUN_STAGE_CONFIG.stageFieldName) continue;
    let rowAffected = false;
    for (const side of ['old', 'new'] as const) {
      const raw = side === 'old' ? rec.OldValue : rec.NewValue;
      const v = normalizeSourceValue(raw ?? null) ?? '';
      if (!v) {
        stageValueCounts.blankBaseline += 1;
        continue;
      }
      if (stageKnown.has(v)) {
        stageValueCounts.resolved += 1;
        continue;
      }
      stageValueCounts.unknownNonblank += 1;
      rowAffected = true;
      const entry = unknownStageLabels.get(v) ?? { occurrences: 0, old: false, new: false };
      entry.occurrences += 1;
      entry[side] = true;
      unknownStageLabels.set(v, entry);
    }
    if (rowAffected) stageValueCounts.affectedRows += 1;
  }

  // Baselines are supplied for EVERY record: the Bite 5A adapter applies a
  // baseline only when the deal has no ACCEPTED record-type history, so a
  // deal whose only rows were rejected (for example an all-conflicted
  // History ID) still surfaces with its review issues instead of vanishing.
  const baselines = records.map((r) => mapBaselineObservation(r, input.executedAt));

  const result = adaptOpportunityHistory(rows, DRY_RUN_STAGE_CONFIG, baselines);

  // Same-timestamp classification with MUTUALLY EXCLUSIVE categories:
  // candidateGroups = harmless + provable + materiallyAmbiguous. A group is
  // every (opportunity, timestamp) instant carrying two or more
  // funnel-relevant rows; only record-type-conflicting groups can be
  // material, and Bite 5A alone decides which of those actually are.
  const stampCounts = new Map<string, { rt: number; stage: number }>();
  for (const rec of historyRecords) {
    if (
      rec.Field !== DRY_RUN_STAGE_CONFIG.recordTypeFieldName &&
      rec.Field !== DRY_RUN_STAGE_CONFIG.stageFieldName
    ) {
      continue;
    }
    const key = `${rec.OpportunityId}|${rec.CreatedDate}`;
    const c = stampCounts.get(key) ?? { rt: 0, stage: 0 };
    if (rec.Field === DRY_RUN_STAGE_CONFIG.recordTypeFieldName) c.rt += 1;
    else c.stage += 1;
    stampCounts.set(key, c);
  }
  let candidateGroups = 0;
  let harmlessCrossLedgerGroups = 0;
  let rtConflictGroups = 0;
  for (const c of stampCounts.values()) {
    if (c.rt + c.stage < 2) continue;
    candidateGroups += 1;
    if (c.rt < 2) harmlessCrossLedgerGroups += 1;
    else rtConflictGroups += 1;
  }
  const materiallyAmbiguous = result.review.filter((x) => x.reason === 'ambiguous_same_timestamp').length;

  const byDeveloperName: Record<string, number> = {};
  for (const r of records) {
    const dn = r.RecordType?.DeveloperName ?? 'missing';
    byDeveloperName[dn] = (byDeveloperName[dn] ?? 0) + 1;
  }

  const snapshot = currentFunnelSnapshot(result.opportunities);
  const countsByStage: Record<string, number> = {
    hpp: snapshot.counts.hpp,
    opp: snapshot.counts.opp,
    pursuit: snapshot.counts.pursuit,
    out_of_scope: snapshot.outOfScope,
    unknown: snapshot.unknown,
  };

  let forwardMoves = 0;
  let backwardMoves = 0;
  let forwardSkips = 0;
  let backwardSkips = 0;
  for (const o of result.opportunities) {
    forwardMoves += o.forwardMoves;
    backwardMoves += o.backwardMoves;
    forwardSkips += o.skips.forward;
    backwardSkips += o.skips.backward;
  }

  const issueCount = (kind: string): number =>
    result.review.filter((x) => x.reason === kind).length;

  const reviewIssueCounts: Record<string, number> = {};
  let requiringReview = 0;
  for (const o of result.opportunities) {
    const seed = buildReviewSeed(
      o,
      // Region/campaign evidence is per-record; the dry run counts the
      // structural issues and always-present missing_channel only.
      { primaryCampaignSource: null, commercialRegion: null },
      result.review,
    );
    requiringReview += 1;
    for (const code of seed.issue_codes as ReviewIssueCode[]) {
      reviewIssueCounts[code] = (reviewIssueCounts[code] ?? 0) + 1;
    }
  }

  const stageRows = historyRecords.filter((h) => h.Field === DRY_RUN_STAGE_CONFIG.stageFieldName).length;
  const recordTypeRows = historyRecords.filter((h) => h.Field === DRY_RUN_STAGE_CONFIG.recordTypeFieldName).length;

  return {
    executedAt: input.executedAt,
    dry_run: true,
    writes_attempted: 0,
    scope: classifyScope(records, input.year),
    countsByRecordTypeDeveloperName: byDeveloperName,
    countsByNormalizedCurrentStage: countsByStage,
    history: {
      rowsDiscovered: historyRecords.length,
      recordTypeRows,
      stageRows,
      otherFieldRows: historyRecords.length - recordTypeRows - stageRows,
      exactDuplicates: result.duplicatesIgnored,
      conflictingDuplicateHistoryIds: issueCount('conflicting_duplicate_history_id'),
      invalidTimestamps: issueCount('invalid_history_timestamp'),
      recordTypeValues: rtValueCounts,
      recordTypeDiagnostics: [...unmappedRecordTypes.values()]
        .map((d) => ({
          name: d.name,
          developerName: d.developerName,
          occurrences: d.occurrences,
          seenAs: (d.old && d.new ? 'both' : d.old ? 'old' : 'new') as 'old' | 'new' | 'both',
          confirmedOpportunityType: d.confirmedOpportunityType,
        }))
        .sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name)),
      stageValues: {
        ...stageValueCounts,
        unknownLabels: [...unknownStageLabels.entries()]
          .map(([label, x]) => ({
            label,
            occurrences: x.occurrences,
            seenAs: (x.old && x.new ? 'both' : x.old ? 'old' : 'new') as 'old' | 'new' | 'both',
          }))
          .sort((a, b) => b.occurrences - a.occurrences || a.label.localeCompare(b.label)),
      },
    },
    movement: {
      forwardMoves,
      backwardMoves,
      forwardSkips,
      backwardSkips,
      sameTimestamp: {
        candidateGroups,
        harmlessCrossLedgerGroups,
        uniquelyProvableOrOrderIndependent: Math.max(0, rtConflictGroups - materiallyAmbiguous),
        materiallyAmbiguous,
      },
    },
    review: {
      opportunitiesRequiringReview: requiringReview,
      countsByIssue: reviewIssueCounts,
    },
    industryVertical: {
      candidates: INDUSTRY_VERTICAL_CANDIDATES,
      nonblankCoverage: Object.fromEntries(
        INDUSTRY_VERTICAL_CANDIDATES.map((field) => [
          field,
          records.filter((r) => typeof r[field] === 'string' && (r[field] as string).trim() !== '').length,
        ]),
      ),
    },
  };
}
