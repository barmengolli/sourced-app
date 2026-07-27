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

// Dry-run configuration: the Bite 5A confirmed alias map (labels, legacy
// labels, developer names) plus the API-side history field tokens. The
// record-type history Field token is expected to be 'RecordType' via the
// API (the report export showed the LABEL 'Opportunity Record Type'); the
// dry run's field distribution verifies this on first execution.
export const DRY_RUN_STAGE_CONFIG: OpportunityStageConfig = {
  recordTypeFieldName: 'RecordType',
  recordTypeMap: DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP,
  stageFieldName: 'StageName',
  terminalStageMap: DEFAULT_OPPORTUNITY_TERMINAL_STAGE_MAP,
  openStageValues: DEFAULT_OPPORTUNITY_OPEN_STAGE_VALUES,
};

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
  closedInYear: number;
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
    closedInYear: 0,
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
    if (r.IsClosed === true && closeDate >= start) counts.closedInYear += 1;
    if (open && created !== '' && created < start) counts.olderOpen += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Sanitized dry-run summary
// ---------------------------------------------------------------------------

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
    unknownRecordTypeValues: number;
    unknownStageValues: number;
  };
  movement: {
    forwardMoves: number;
    backwardMoves: number;
    forwardSkips: number;
    backwardSkips: number;
    sameTimestampAmbiguities: number;
  };
  review: {
    opportunitiesRequiringReview: number;
    countsByIssue: Record<string, number>;
  };
}

// Build the authoritative dry-run summary: mapping, then the REAL Bite 5A
// derivation and Bite 5B review seeding, then aggregation. The output holds
// aggregates only; no identifier, name, account, owner, or campaign from the
// input can appear in it.
export function buildDryRunSummary(
  records: SalesforceOpportunityRecord[],
  historyRecords: SalesforceOpportunityHistoryRecord[],
  input: { executedAt: string; year: number },
): DryRunSummary {
  const rows = historyRecords.map(mapHistoryRecord);
  // Baselines are supplied for EVERY record: the Bite 5A adapter applies a
  // baseline only when the deal has no ACCEPTED record-type history, so a
  // deal whose only rows were rejected (for example an all-conflicted
  // History ID) still surfaces with its review issues instead of vanishing.
  const baselines = records.map((r) => mapBaselineObservation(r, input.executedAt));

  const result = adaptOpportunityHistory(rows, DRY_RUN_STAGE_CONFIG, baselines);

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
      unknownRecordTypeValues: issueCount('unknown_record_type'),
      unknownStageValues: issueCount('unknown_stage_value'),
    },
    movement: {
      forwardMoves,
      backwardMoves,
      forwardSkips,
      backwardSkips,
      sameTimestampAmbiguities: issueCount('ambiguous_same_timestamp'),
    },
    review: {
      opportunitiesRequiringReview: requiringReview,
      countsByIssue: reviewIssueCounts,
    },
  };
}
