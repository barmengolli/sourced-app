// opportunityIngestionPlanner.ts: the pure Bite 5C2A staging-ingestion
// planner (docs/opportunity-staging-ingestion.md).
//
// Transforms validated Bite 5C1 discovery/history results plus the existing
// PROTECTED staging state into an explicit, allowlisted ingestion plan for
// the six sf_opportunity_* tables and nothing else. Salesforce discovery and
// staging must never cause an opportunity to appear in Sourced reporting:
// this planner can produce snapshot upserts, append-only event inserts,
// review creations/updates with their coupled audit events, and sync-run
// diagnostics. It can NEVER produce an approval, a link, a deal creation,
// an attribution operation, or any write outside the protected tables (the
// operation type system does not contain such an operation).
//
// Pure: no Supabase, no network, no clock (run timestamps are injected).
// Idempotent: the same input against the same existing state plans zero
// duplicate operations. Calculation semantics stay in Bite 5A; review
// semantics in Bite 5B; source preparation in Bite 5C1 (prepareHistoryRows,
// one shared pipeline).

import {
  adaptOpportunityHistory,
  DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP,
} from './opportunityStageHistory';
import type { OpportunityRecordTypeState } from './opportunityStageHistory';
import {
  buildReviewSeed,
  createReviewMutation,
  classifyIncomingEvent,
  buildRecordTypeEventInsert,
  buildTerminalEventInsert,
} from './opportunityImportStorage';
import type {
  ReviewState,
  ReviewIssueCode,
  ReviewSeed,
  ReviewEventInsert,
  ReviewProjection,
  EventInsert,
  EventRowContent,
} from './opportunityImportStorage';
import {
  DRY_RUN_STAGE_CONFIG,
  prepareHistoryRows,
  assertUniqueSourceIds,
  mapBaselineObservation,
  normalizeSourceValue,
} from './salesforceOpportunitySync';
import type {
  SalesforceOpportunityRecord,
  SalesforceOpportunityHistoryRecord,
  SalesforceRecordTypeRef,
} from './salesforceOpportunitySync';

// ---------------------------------------------------------------------------
// The allowlist: the ONLY tables any planned operation may target
// ---------------------------------------------------------------------------

export type ProtectedStagingTable =
  | 'sf_opportunities'
  | 'sf_opportunity_events'
  | 'sf_opportunity_deal_links'
  | 'sf_opportunity_reviews'
  | 'sf_opportunity_review_events'
  | 'sf_opportunity_sync_runs';

export const PROTECTED_STAGING_TABLES: ReadonlySet<ProtectedStagingTable> = new Set([
  'sf_opportunities',
  'sf_opportunity_events',
  'sf_opportunity_deal_links',
  'sf_opportunity_reviews',
  'sf_opportunity_review_events',
  'sf_opportunity_sync_runs',
]);

// ---------------------------------------------------------------------------
// Existing protected state (read by the executor, supplied to the planner)
// ---------------------------------------------------------------------------

export interface ExistingSnapshotState {
  contentHash: string | null;
  recordTypeDeveloperName: string | null;
}

export interface ExistingLinkState {
  dealId: string;
  linkState: 'active' | 'retired';
}

export interface ExistingReviewState {
  reviewState: ReviewState;
  issueCodes: ReviewIssueCode[];
  channelId: string | null;
  leadId?: string | null;
}

export interface ExistingStagingState {
  snapshots: Record<string, ExistingSnapshotState>;
  // Stored event content by Salesforce History Id, for duplicate/conflict
  // classification.
  eventContentByHistoryId: Record<string, EventRowContent>;
  reviews: Record<string, ExistingReviewState>;
  links: Record<string, ExistingLinkState>;
}

export interface IngestionConfig {
  // The approved first-run cohort year (2026). Explicit configuration:
  // never hardcoded, never derived from today's date.
  initialCohortYear: number;
  // Injected run timestamp for audit events and baselines.
  runStartedAt: string;
}

// ---------------------------------------------------------------------------
// Planned operations (discriminated, table-typed, allowlisted)
// ---------------------------------------------------------------------------

export type PlannedOperation =
  | {
      op: 'upsert_snapshot';
      table: 'sf_opportunities';
      sfOpportunityId: string;
      contentHash: string;
      recordTypeDeveloperName: string | null;
      changed: boolean; // false = brand new insert
    }
  | { op: 'noop_snapshot'; table: 'sf_opportunities'; sfOpportunityId: string }
  | { op: 'insert_event'; table: 'sf_opportunity_events'; event: EventInsert }
  | { op: 'noop_duplicate_event'; table: 'sf_opportunity_events'; sfHistoryId: string }
  | {
      op: 'block_conflicting_event';
      table: 'sf_opportunity_events';
      sfHistoryId: string;
      sfOpportunityId: string;
    }
  | {
      op: 'create_review';
      table: 'sf_opportunity_reviews';
      seed: ReviewSeed;
      auditEvent: ReviewEventInsert; // review_created, coupled by construction
    }
  | {
      op: 'update_review_issues';
      table: 'sf_opportunity_reviews';
      sfOpportunityId: string;
      projection: ReviewProjection;
      auditEvent: ReviewEventInsert; // issues_updated, coupled by construction
    }
  | {
      op: 'record_sync_run';
      table: 'sf_opportunity_sync_runs';
      diagnostics: SyncRunDiagnostics;
    };

export interface SyncRunDiagnostics {
  runStartedAt: string;
  // Watermarks the executor may persist ONLY after the complete batch
  // succeeds; a failed or partial run must record status failed and leave
  // the previous watermark untouched.
  proposedWatermarkSystemModstamp: string | null;
  proposedWatermarkHistoryCreatedAt: string | null;
  rowsDiscovered: number;
  eventsPlanned: number;
  exactDuplicateEvents: number;
  conflictingEvents: number;
  snapshotsPlanned: number;
  snapshotNoops: number;
  reviewsCreated: number;
  reviewIssueUpdates: number;
  eligibility: Record<EligibilityOutcome, number>;
  linked: {
    activeSynced: number;
    nowUnavailableService: number;
    restoredToFunnel: number;
    retiredNoAction: number;
  };
}

export type EligibilityOutcome =
  | 'eligible_new_candidate'
  | 'already_pending_review'
  | 'blocked_by_review_state'
  | 'excluded_out_of_scope'
  | 'excluded_unknown_record_type'
  | 'excluded_older_closed'
  | 'linked_active'
  | 'linked_retired';

export interface IngestionPlan {
  dryRunCompatible: true;
  operations: PlannedOperation[];
  diagnostics: SyncRunDiagnostics;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Deterministic FNV-1a content hash over the snapshot-relevant fields. Pure
// and dependency-free; collisions only cause a harmless extra update.
export function snapshotContentHash(rec: SalesforceOpportunityRecord): string {
  const material = JSON.stringify([
    rec.Id,
    rec.RecordType?.DeveloperName ?? null,
    rec.RecordType?.Name ?? null,
    rec.StageName ?? null,
    rec.IsClosed ?? null,
    rec.IsWon ?? null,
    rec.Name ?? null,
    rec.AccountId ?? null,
    rec.Account?.Name ?? null,
    rec.Amount ?? null,
    rec.CurrencyIsoCode ?? null,
    rec.CloseDate ?? null,
    rec.OwnerId ?? null,
    rec.CampaignId ?? null,
    rec.CreatedDate ?? null,
    rec.SystemModstamp ?? rec.LastModifiedDate ?? null,
    rec.Commercial_Region__c ?? null,
    rec.Sales_Development_Rep__c ?? null,
    rec.Existing_Customer_or_New_Business__c ?? null,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, '0')}:${material.length}`;
}

function normalizedRecordTypeState(rec: SalesforceOpportunityRecord): OpportunityRecordTypeState | 'unknown' {
  const dev = normalizeSourceValue(rec.RecordType?.DeveloperName ?? null);
  if (dev === null) return 'unknown';
  return DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP[dev] ?? 'unknown';
}

const FUNNEL_STATES: ReadonlySet<string> = new Set(['hpp', 'opp', 'pursuit']);

// ---------------------------------------------------------------------------
// Eligibility (evidence fields never include, exclude, attribute, or assign)
// ---------------------------------------------------------------------------

export function classifyCandidateEligibility(
  rec: SalesforceOpportunityRecord,
  existing: ExistingStagingState,
  config: IngestionConfig,
): EligibilityOutcome {
  const link = existing.links[rec.Id];
  if (link?.linkState === 'active') return 'linked_active';
  if (link?.linkState === 'retired') return 'linked_retired';

  const state = normalizedRecordTypeState(rec);
  if (state === 'unknown') return 'excluded_unknown_record_type';
  if (!FUNNEL_STATES.has(state)) return 'excluded_out_of_scope';

  const createdYear = (rec.CreatedDate ?? '').slice(0, 4);
  const inCohort = rec.IsClosed === false || createdYear === String(config.initialCohortYear);
  if (!inCohort) return 'excluded_older_closed';

  const review = existing.reviews[rec.Id];
  if (review) {
    if (review.reviewState === 'pending') return 'already_pending_review';
    // ignored / resolved / blocked / approved / linked: the state machine
    // owns these; the planner never reopens or bypasses a human decision.
    return 'blocked_by_review_state';
  }
  return 'eligible_new_candidate';
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

export function planStagingIngestion(
  records: SalesforceOpportunityRecord[],
  historyRecords: SalesforceOpportunityHistoryRecord[],
  recordTypeRefs: SalesforceRecordTypeRef[],
  existing: ExistingStagingState,
  config: IngestionConfig,
): IngestionPlan {
  assertUniqueSourceIds(records.map((r) => r.Id), 'Opportunity');
  const prepared = prepareHistoryRows(historyRecords, recordTypeRefs);

  // Bite 5A derivation over the prepared rows: issue detection (unknown
  // values, ambiguity, conflicts) feeds review seeding exactly as in the
  // dry run. Baselines are supplied for every record; the adapter applies
  // them only where no accepted history exists.
  const baselines = records.map((r) => mapBaselineObservation(r, config.runStartedAt));
  const derived = adaptOpportunityHistory(prepared.rows, DRY_RUN_STAGE_CONFIG, baselines);
  const derivedById = new Map(derived.opportunities.map((o) => [o.opportunityId, o]));

  const operations: PlannedOperation[] = [];
  const eligibility: Record<EligibilityOutcome, number> = {
    eligible_new_candidate: 0,
    already_pending_review: 0,
    blocked_by_review_state: 0,
    excluded_out_of_scope: 0,
    excluded_unknown_record_type: 0,
    excluded_older_closed: 0,
    linked_active: 0,
    linked_retired: 0,
  };
  const linked = { activeSynced: 0, nowUnavailableService: 0, restoredToFunnel: 0, retiredNoAction: 0 };
  let reviewsCreated = 0;
  let reviewIssueUpdates = 0;
  let snapshotsPlanned = 0;
  let snapshotNoops = 0;

  // --- Snapshots: staged for EVERY discovered record. Staging never affects
  // reporting, so mirroring source truth (including out-of-scope and
  // older-closed records) is safe and preserves history; only REVIEW
  // operations are eligibility-gated.
  for (const rec of records) {
    const hash = snapshotContentHash(rec);
    const prior = existing.snapshots[rec.Id];
    if (prior && prior.contentHash === hash) {
      operations.push({ op: 'noop_snapshot', table: 'sf_opportunities', sfOpportunityId: rec.Id });
      snapshotNoops += 1;
    } else {
      operations.push({
        op: 'upsert_snapshot',
        table: 'sf_opportunities',
        sfOpportunityId: rec.Id,
        contentHash: hash,
        recordTypeDeveloperName: normalizeSourceValue(rec.RecordType?.DeveloperName ?? null),
        changed: prior !== undefined,
      });
      snapshotsPlanned += 1;
    }
  }

  // --- Append-only history events: insert only what is new; exact repeats
  // are informational no-ops; a same-Id conflict blocks (no version chosen)
  // and routes the opportunity to review.
  const conflictedByOpportunity = new Map<string, string[]>();
  let exactDuplicateEvents = 0;
  const recordTypeField = DRY_RUN_STAGE_CONFIG.recordTypeFieldName;
  const stageField = DRY_RUN_STAGE_CONFIG.stageFieldName ?? 'StageName';
  for (const row of prepared.rows) {
    if (row.field !== recordTypeField && row.field !== stageField) continue;
    const incoming: EventRowContent = {
      sfOpportunityId: row.opportunityId,
      sourceField: row.field,
      oldValue: row.oldValue,
      newValue: row.newValue,
      changedAt: row.changedAt,
    };
    const stored = existing.eventContentByHistoryId[row.historyId];
    const cls = classifyIncomingEvent(stored, incoming);
    if (cls === 'exact_duplicate') {
      operations.push({ op: 'noop_duplicate_event', table: 'sf_opportunity_events', sfHistoryId: row.historyId });
      exactDuplicateEvents += 1;
      continue;
    }
    if (cls === 'conflict') {
      operations.push({
        op: 'block_conflicting_event',
        table: 'sf_opportunity_events',
        sfHistoryId: row.historyId,
        sfOpportunityId: row.opportunityId,
      });
      const list = conflictedByOpportunity.get(row.opportunityId) ?? [];
      list.push(row.historyId);
      conflictedByOpportunity.set(row.opportunityId, list);
      continue;
    }
    // New event. The ledger event is derived from the Bite 5A ledger so the
    // normalized states travel with the raw values.
    const ledgerEvent = derived.ledger.find((e) => e.sourceHistoryId === row.historyId);
    const terminalEvent = derived.terminalLedger.find((e) => e.sourceHistoryId === row.historyId);
    if (terminalEvent) {
      operations.push({
        op: 'insert_event',
        table: 'sf_opportunity_events',
        event: buildTerminalEventInsert(terminalEvent, row.field),
      });
    } else if (ledgerEvent && !ledgerEvent.baselineObservation) {
      operations.push({
        op: 'insert_event',
        table: 'sf_opportunity_events',
        event: buildRecordTypeEventInsert(ledgerEvent, row.field),
      });
    }
    // Rows the derivation rejected (invalid/unknown) produce no event insert;
    // their issues surface through review seeding below.
  }

  // --- Per-opportunity review planning.
  for (const rec of records) {
    const outcome = classifyCandidateEligibility(rec, existing, config);
    eligibility[outcome] += 1;

    if (outcome === 'linked_active') {
      // Snapshot and history sync only: an active exact link never reopens
      // approval. Service transitions are represented by the snapshot's
      // normalized state; the future application layer derives active-funnel
      // availability from it, and a return to hpp/opp/pursuit restores
      // availability with no new review.
      linked.activeSynced += 1;
      const nowState = normalizedRecordTypeState(rec);
      const priorDev = existing.snapshots[rec.Id]?.recordTypeDeveloperName;
      const priorState =
        priorDev === null || priorDev === undefined
          ? null
          : (DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP[priorDev] ?? 'unknown');
      if (nowState === 'out_of_scope' && priorState !== 'out_of_scope') linked.nowUnavailableService += 1;
      if (FUNNEL_STATES.has(nowState) && priorState === 'out_of_scope') linked.restoredToFunnel += 1;
      continue;
    }
    if (outcome === 'linked_retired') {
      // A retired link is never silently reactivated and never becomes an
      // automatic candidate again; human review owns it.
      linked.retiredNoAction += 1;
      continue;
    }
    if (outcome !== 'eligible_new_candidate' && outcome !== 'already_pending_review') {
      continue;
    }

    const derivedState = derivedById.get(rec.Id);
    if (!derivedState) continue;
    const seed = buildReviewSeed(
      derivedState,
      {
        primaryCampaignSource: normalizeSourceValue(rec.CampaignId ?? null),
        commercialRegion: normalizeSourceValue((rec.Commercial_Region__c as string | null) ?? null),
      },
      derived.review,
    );
    if (conflictedByOpportunity.has(rec.Id) && !seed.issue_codes.includes('conflicting_history_id')) {
      const withConflict: ReviewIssueCode[] = [...seed.issue_codes, 'conflicting_history_id'];
      seed.issue_codes = withConflict.sort();
    }

    const existingReview = existing.reviews[rec.Id];
    if (outcome === 'eligible_new_candidate' && !existingReview) {
      // Coupled by construction: the mutation carries the projection and its
      // review_created audit event together.
      const mutation = createReviewMutation(seed, {
        actorType: 'ingestion',
        occurredAt: config.runStartedAt,
      });
      operations.push({
        op: 'create_review',
        table: 'sf_opportunity_reviews',
        seed,
        auditEvent: mutation.auditEvent,
      });
      reviewsCreated += 1;
      continue;
    }
    if (outcome === 'already_pending_review' && existingReview) {
      const currentCodes = [...existingReview.issueCodes].sort().join('|');
      const nextCodes = [...seed.issue_codes].sort().join('|');
      if (currentCodes !== nextCodes) {
        operations.push({
          op: 'update_review_issues',
          table: 'sf_opportunity_reviews',
          sfOpportunityId: rec.Id,
          projection: {
            reviewState: existingReview.reviewState,
            issueCodes: seed.issue_codes,
            channelId: existingReview.channelId,
            leadId: existingReview.leadId ?? null,
          },
          auditEvent: {
            event_type: 'issues_updated',
            previous_state: null,
            new_state: null,
            issue_codes_snapshot: [...seed.issue_codes].sort(),
            actor_type: 'ingestion',
            actor_id: null,
            note: null,
            sf_history_id: null,
            accepted_content_hash: null,
            conflicting_content_hash: null,
            dedupe_key: `issues:${rec.Id}:${nextCodes}`,
            occurred_at: config.runStartedAt,
          },
        });
        reviewIssueUpdates += 1;
      }
    }
  }

  // --- Watermarks: proposed only; the executor persists them exclusively on
  // full-batch success.
  let maxModstamp: string | null = null;
  for (const rec of records) {
    const stamp = rec.SystemModstamp ?? rec.LastModifiedDate ?? null;
    if (stamp && (maxModstamp === null || stamp > maxModstamp)) maxModstamp = stamp;
  }
  let maxHistory: string | null = null;
  for (const h of historyRecords) {
    if (h.CreatedDate && (maxHistory === null || h.CreatedDate > maxHistory)) maxHistory = h.CreatedDate;
  }

  const diagnostics: SyncRunDiagnostics = {
    runStartedAt: config.runStartedAt,
    proposedWatermarkSystemModstamp: maxModstamp,
    proposedWatermarkHistoryCreatedAt: maxHistory,
    rowsDiscovered: records.length,
    eventsPlanned: operations.filter((o) => o.op === 'insert_event').length,
    exactDuplicateEvents,
    conflictingEvents: [...conflictedByOpportunity.values()].reduce((a, b) => a + b.length, 0),
    snapshotsPlanned,
    snapshotNoops,
    reviewsCreated,
    reviewIssueUpdates,
    eligibility,
    linked,
  };
  operations.push({ op: 'record_sync_run', table: 'sf_opportunity_sync_runs', diagnostics });

  return { dryRunCompatible: true, operations, diagnostics };
}
