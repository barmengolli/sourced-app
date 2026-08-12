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
// Staging is RESTRICTED: a newly discovered, unlinked record is staged only
// when it is queue-eligible. Excluded records (current Service/out_of_scope,
// unknown record types, older closed outside the cohort) appear ONLY in
// aggregate diagnostics without identifiers. Existing links and existing
// reviews keep staging so protected history is preserved.
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
  recordIngestionConflict,
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
  INDUSTRY_VERTICAL_CANDIDATES,
} from './salesforceOpportunitySync';
import type {
  SalesforceOpportunityRecord,
  SalesforceOpportunityHistoryRecord,
  SalesforceRecordTypeRef,
} from './salesforceOpportunitySync';
import { sha256Hex } from './sha256';

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
  // The staged SystemModstamp: the stale-write guard.
  sfLastModifiedAt: string | null;
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
  // The approved source CreatedDate years. Explicit configuration: never
  // inferred from today's date and never widened silently.
  reportingYears: number[];
  // Exact Salesforce API values that represent New Logo business. In this
  // org the UI label "New Logo" is exposed by the API as "New Project".
  includedBusinessTypeApiValues: string[];
  // Injected run timestamp for audit events and baselines.
  runStartedAt: string;
}

// ---------------------------------------------------------------------------
// The full staged snapshot payload (apply-ready review evidence)
// ---------------------------------------------------------------------------
// Enough evidence to review a candidate WITHOUT querying raw Salesforce
// again. Classification evidence includes source user ids plus one narrowly
// approved, normalized BDR suggestion. That suggestion is review evidence
// only: it never selects a channel or creates attribution. No canonical
// Industry Vertical field is chosen and no Customer Expansion rule is
// applied; the raw values are evidence.

export interface SnapshotPayload {
  sf_opportunity_id: string;
  record_type_developer_name: string | null;
  record_type_label: string | null;
  normalized_record_type_state: OpportunityRecordTypeState | 'unknown';
  stage_name: string | null;
  is_closed: boolean | null;
  is_won: boolean | null;
  opportunity_name: string | null;
  account_id: string | null;
  account_name: string | null;
  amount: number | null;
  amount_currency: string | null;
  saas_revenue: number | null;
  saas_revenue_usd: number | null;
  close_date: string | null;
  market: string | null;
  commercial_region: string | null;
  opportunity_owner: string | null;
  primary_campaign_source: string | null;
  customer_expansion_raw: string | null;
  sales_development_rep_user_id: string | null;
  created_by_user_id: string | null;
  suggested_bdr_name: 'Dave Cummins' | 'Garrett McNally' | null;
  insurance_vertical_raw: string | null;
  industry_vertical_raw: string | null;
  pursuit_industry_vertical_raw: string | null;
  gtm_cube: string | null;
  business_units: string | null;
  sf_created_at: string | null;
  sf_last_modified_at: string;
  content_hash: string;
}

const str = (v: unknown): string | null => normalizeSourceValue(typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function normalizedRecordTypeState(
  rec: SalesforceOpportunityRecord,
): OpportunityRecordTypeState | 'unknown' {
  const dev = normalizeSourceValue(rec.RecordType?.DeveloperName ?? null);
  if (dev === null) return 'unknown';
  return DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP[dev] ?? 'unknown';
}

export function suggestedBdrName(
  rec: SalesforceOpportunityRecord,
): 'Dave Cummins' | 'Garrett McNally' | null {
  const creator = str(rec.CreatedBy?.Name);
  if (creator === 'Dave Cummins' || creator === 'David Cummins') return 'Dave Cummins';
  if (creator === 'Garrett McNally') return 'Garrett McNally';
  return null;
}

// Parse a source timestamp into a numeric instant. Deterministic (no clock
// read); returns null for unparseable values. Comparison always happens on
// instants, never on raw strings, preserving timezone semantics.
export function parseSourceInstant(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function buildSnapshotPayload(rec: SalesforceOpportunityRecord): SnapshotPayload {
  const modstampRaw = str(rec.SystemModstamp) ?? str(rec.LastModifiedDate);
  const modstampMs = parseSourceInstant(modstampRaw);
  if (modstampRaw === null || modstampMs === null) {
    // A staged snapshot without a REAL, parseable source modification
    // timestamp cannot participate in stale-write protection: fail
    // validation, never guess.
    throw new Error('snapshot validation: missing or unparseable source SystemModstamp/LastModifiedDate');
  }
  // Normalized to a canonical UTC instant so fingerprints and comparisons
  // are representation-independent; the instant (timezone semantics) is
  // preserved exactly.
  const modstamp = new Date(modstampMs).toISOString();
  const withoutHash: Omit<SnapshotPayload, 'content_hash'> = {
    sf_opportunity_id: rec.Id,
    record_type_developer_name: str(rec.RecordType?.DeveloperName),
    record_type_label: str(rec.RecordType?.Name),
    normalized_record_type_state: normalizedRecordTypeState(rec),
    stage_name: str(rec.StageName),
    is_closed: typeof rec.IsClosed === 'boolean' ? rec.IsClosed : null,
    is_won: typeof rec.IsWon === 'boolean' ? rec.IsWon : null,
    opportunity_name: str(rec.Name),
    account_id: str(rec.AccountId),
    account_name: str(rec.Account?.Name),
    amount: num(rec.Amount),
    amount_currency: str(rec.CurrencyIsoCode),
    saas_revenue: num(rec.SaaS_Revenue__c),
    saas_revenue_usd: num(rec.SaaS_Revenue_USD__c),
    close_date: str(rec.CloseDate),
    market: str(rec.Market__c),
    commercial_region: str(rec.Commercial_Region__c),
    // Human-facing review evidence uses the Salesforce owner name. OwnerId
    // remains a transport concern and must not leak into the review UI.
    opportunity_owner: str(rec.Owner?.Name),
    primary_campaign_source: str(rec.CampaignId),
    customer_expansion_raw: str(rec.Existing_Customer_or_New_Business__c),
    sales_development_rep_user_id: str(rec.Sales_Development_Rep__c),
    created_by_user_id: str(rec.CreatedById),
    suggested_bdr_name: suggestedBdrName(rec),
    insurance_vertical_raw: str(rec[INDUSTRY_VERTICAL_CANDIDATES_FULL[0]]),
    industry_vertical_raw: str(rec[INDUSTRY_VERTICAL_CANDIDATES_FULL[1]]),
    pursuit_industry_vertical_raw: str(rec[INDUSTRY_VERTICAL_CANDIDATES_FULL[2]]),
    gtm_cube: str(rec.GTM_Cube__c),
    business_units: str(rec.Business_Units__c),
    sf_created_at: str(rec.CreatedDate),
    sf_last_modified_at: modstamp,
  };
  return { ...withoutHash, content_hash: snapshotFingerprint(withoutHash) };
}

// All three unresolved Industry Vertical candidates ride along as separate
// raw evidence fields.
const INDUSTRY_VERTICAL_CANDIDATES_FULL = [
  'Insurance_vertical__c',
  ...INDUSTRY_VERTICAL_CANDIDATES.filter((f) => f !== 'Insurance_vertical__c'),
];

// Collision-resistant deterministic fingerprint: SHA-256 over an explicitly
// ORDERED canonical [field, value] list covering every staged snapshot
// field. Key order of the source object is irrelevant by construction.
export function snapshotFingerprint(payload: Omit<SnapshotPayload, 'content_hash'>): string {
  const orderedFields = Object.keys(payload).sort();
  const canonical = JSON.stringify(
    orderedFields.map((field) => [field, (payload as Record<string, unknown>)[field] ?? null]),
  );
  return `sha256:${sha256Hex(canonical)}`;
}

// Canonical event fingerprint for the database-boundary conflict check.
export function eventContentFingerprint(event: EventInsert): string {
  const canonical = JSON.stringify([
    event.sf_opportunity_id,
    event.sf_history_id,
    event.source_field,
    event.old_value,
    event.new_value,
    event.event_kind,
    event.from_record_type_state,
    event.to_record_type_state,
    event.from_terminal_state,
    event.to_terminal_state,
    event.changed_at,
  ]);
  return `sha256:${sha256Hex(canonical)}`;
}

// Canonical fingerprint of stored/incoming event CONTENT, used as conflict
// evidence (accepted versus conflicting hashes) in the audit ledger.
export function eventRowContentFingerprint(content: EventRowContent): string {
  const canonical = JSON.stringify([
    content.sfOpportunityId,
    content.sourceField,
    content.oldValue,
    content.newValue,
    content.changedAt,
  ]);
  return `sha256:${sha256Hex(canonical)}`;
}

// ---------------------------------------------------------------------------
// Planned operations (discriminated, table-typed, allowlisted)
// ---------------------------------------------------------------------------

export type PlannedOperation =
  | {
      op: 'upsert_snapshot';
      table: 'sf_opportunities';
      sfOpportunityId: string;
      payload: SnapshotPayload;
      changed: boolean; // false = brand new insert
    }
  | { op: 'noop_snapshot'; table: 'sf_opportunities'; sfOpportunityId: string }
  | { op: 'noop_stale_snapshot'; table: 'sf_opportunities'; sfOpportunityId: string }
  | { op: 'block_snapshot_conflict'; table: 'sf_opportunities'; sfOpportunityId: string }
  | { op: 'insert_event'; table: 'sf_opportunity_events'; event: EventInsert; contentHash: string }
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
      // review_created first, plus any conflict_observed evidence: coupled
      // atomically by construction.
      auditEvents: ReviewEventInsert[];
    }
  | {
      op: 'update_review_issues';
      table: 'sf_opportunity_reviews';
      sfOpportunityId: string;
      projection: ReviewProjection;
      // issues_updated plus any conflict_observed evidence.
      auditEvents: ReviewEventInsert[];
    }
  | {
      op: 'append_review_audit';
      table: 'sf_opportunity_review_events';
      sfOpportunityId: string;
      // conflict_observed evidence for an existing review whose issue codes
      // did not change; SQL dedupe makes reobservation a no-op.
      auditEvents: ReviewEventInsert[];
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
  // Discovered records excluded from staging entirely (aggregate only; no
  // identifiers are retained for them anywhere).
  excludedNotStaged: number;
  eventsPlanned: number;
  exactDuplicateEvents: number;
  conflictingEvents: number;
  snapshotsPlanned: number;
  snapshotNoops: number;
  staleSnapshotsSkipped: number;
  snapshotConflicts: number;
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
  | 'excluded_outside_reporting_years'
  | 'excluded_missing_business_type'
  | 'excluded_non_new_logo'
  | 'linked_active'
  | 'linked_retired';

export interface IngestionPlan {
  dryRunCompatible: true;
  operations: PlannedOperation[];
  diagnostics: SyncRunDiagnostics;
}

// ---------------------------------------------------------------------------
// Eligibility (evidence fields never include, exclude, attribute, or assign)
// ---------------------------------------------------------------------------

const FUNNEL_STATES: ReadonlySet<string> = new Set(['hpp', 'opp', 'pursuit']);

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

  const createdYear = Number((rec.CreatedDate ?? '').slice(0, 4));
  if (!Number.isInteger(createdYear) || !config.reportingYears.includes(createdYear)) {
    return 'excluded_outside_reporting_years';
  }

  const businessType = normalizeSourceValue(
    typeof rec.Existing_Customer_or_New_Business__c === 'string'
      ? rec.Existing_Customer_or_New_Business__c
      : null,
  );
  if (businessType === null) return 'excluded_missing_business_type';
  if (!config.includedBusinessTypeApiValues.includes(businessType)) {
    return 'excluded_non_new_logo';
  }

  const review = existing.reviews[rec.Id];
  if (review) {
    if (review.reviewState === 'pending') return 'already_pending_review';
    // ignored / resolved / blocked / approved / linked: the state machine
    // owns these; the planner never reopens or bypasses a human decision.
    return 'blocked_by_review_state';
  }
  return 'eligible_new_candidate';
}

// A record is STAGED (snapshot + history) only when queue-eligible, already
// under review (protected history is retained even while temporarily out of
// scope), or linked (active or retired: preserved, never reactivated).
// Everything else stays out of protected storage entirely.
function isStaged(outcome: EligibilityOutcome, hasExistingReview: boolean): boolean {
  switch (outcome) {
    case 'eligible_new_candidate':
    case 'already_pending_review':
    case 'blocked_by_review_state':
    case 'linked_active':
    case 'linked_retired':
      return true;
    case 'excluded_out_of_scope':
    case 'excluded_unknown_record_type':
    case 'excluded_outside_reporting_years':
    case 'excluded_missing_business_type':
    case 'excluded_non_new_logo':
      return hasExistingReview;
  }
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

  const operations: PlannedOperation[] = [];
  const eligibility: Record<EligibilityOutcome, number> = {
    eligible_new_candidate: 0,
    already_pending_review: 0,
    blocked_by_review_state: 0,
    excluded_out_of_scope: 0,
    excluded_unknown_record_type: 0,
    excluded_outside_reporting_years: 0,
    excluded_missing_business_type: 0,
    excluded_non_new_logo: 0,
    linked_active: 0,
    linked_retired: 0,
  };
  const linked = { activeSynced: 0, nowUnavailableService: 0, restoredToFunnel: 0, retiredNoAction: 0 };
  let excludedNotStaged = 0;
  let reviewsCreated = 0;
  let reviewIssueUpdates = 0;
  let snapshotsPlanned = 0;
  let snapshotNoops = 0;
  let staleSnapshotsSkipped = 0;
  let snapshotConflicts = 0;

  // Classify first: staging is restricted to eligible, reviewed, or linked
  // records. Excluded records appear only in the aggregate counters.
  const outcomes = new Map<string, EligibilityOutcome>();
  const stagedRecords: SalesforceOpportunityRecord[] = [];
  for (const rec of records) {
    const outcome = classifyCandidateEligibility(rec, existing, config);
    outcomes.set(rec.Id, outcome);
    eligibility[outcome] += 1;
    if (isStaged(outcome, existing.reviews[rec.Id] !== undefined)) {
      stagedRecords.push(rec);
    } else {
      excludedNotStaged += 1;
    }
  }
  const stagedIds = new Set(stagedRecords.map((r) => r.Id));

  // Bite 5A derivation over the prepared rows of STAGED opportunities:
  // issue detection feeds review seeding exactly as in the dry run.
  const stagedRows = prepared.rows.filter((row) => stagedIds.has(row.opportunityId));
  const baselines = stagedRecords.map((r) => mapBaselineObservation(r, config.runStartedAt));
  const derived = adaptOpportunityHistory(stagedRows, DRY_RUN_STAGE_CONFIG, baselines);
  const derivedById = new Map(derived.opportunities.map((o) => [o.opportunityId, o]));

  // --- Snapshots with stale-write and same-timestamp-conflict protection.
  for (const rec of stagedRecords) {
    const payload = buildSnapshotPayload(rec);
    const prior = existing.snapshots[rec.Id];
    if (prior) {
      const priorMs = parseSourceInstant(prior.sfLastModifiedAt);
      const incomingMs = parseSourceInstant(payload.sf_last_modified_at)!;
      if (priorMs !== null && incomingMs < priorMs) {
        // Older source data can never overwrite newer staged data.
        operations.push({ op: 'noop_stale_snapshot', table: 'sf_opportunities', sfOpportunityId: rec.Id });
        staleSnapshotsSkipped += 1;
        continue;
      }
      if (priorMs !== null && incomingMs === priorMs) {
        if (prior.contentHash === payload.content_hash) {
          operations.push({ op: 'noop_snapshot', table: 'sf_opportunities', sfOpportunityId: rec.Id });
          snapshotNoops += 1;
          continue;
        }
        // Same source timestamp, different content: never silently choose.
        operations.push({ op: 'block_snapshot_conflict', table: 'sf_opportunities', sfOpportunityId: rec.Id });
        snapshotConflicts += 1;
        continue;
      }
      if (prior.contentHash === payload.content_hash) {
        operations.push({ op: 'noop_snapshot', table: 'sf_opportunities', sfOpportunityId: rec.Id });
        snapshotNoops += 1;
        continue;
      }
    }
    operations.push({
      op: 'upsert_snapshot',
      table: 'sf_opportunities',
      sfOpportunityId: rec.Id,
      payload,
      changed: prior !== undefined,
    });
    snapshotsPlanned += 1;
  }

  // --- Append-only history events for staged opportunities only.
  const conflictedByOpportunity = new Map<
    string,
    Array<{ historyId: string; acceptedHash: string; conflictingHash: string }>
  >();
  let exactDuplicateEvents = 0;
  const recordTypeField = DRY_RUN_STAGE_CONFIG.recordTypeFieldName;
  const stageField = DRY_RUN_STAGE_CONFIG.stageFieldName ?? 'StageName';
  for (const row of stagedRows) {
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
      list.push({
        historyId: row.historyId,
        // The stored version stays authoritative; both versions travel to
        // the audit ledger as hashes, never as competing event rows.
        acceptedHash: eventRowContentFingerprint(stored!),
        conflictingHash: eventRowContentFingerprint(incoming),
      });
      conflictedByOpportunity.set(row.opportunityId, list);
      continue;
    }
    const ledgerEvent = derived.ledger.find((e) => e.sourceHistoryId === row.historyId);
    const terminalEvent = derived.terminalLedger.find((e) => e.sourceHistoryId === row.historyId);
    if (terminalEvent) {
      const event = buildTerminalEventInsert(terminalEvent, row.field);
      operations.push({
        op: 'insert_event',
        table: 'sf_opportunity_events',
        event,
        contentHash: eventContentFingerprint(event),
      });
    } else if (ledgerEvent && !ledgerEvent.baselineObservation) {
      const event = buildRecordTypeEventInsert(ledgerEvent, row.field);
      operations.push({
        op: 'insert_event',
        table: 'sf_opportunity_events',
        event,
        contentHash: eventContentFingerprint(event),
      });
    }
  }

  // --- Per-opportunity review planning (staged records only).
  for (const rec of stagedRecords) {
    const outcome = outcomes.get(rec.Id)!;

    if (outcome === 'linked_active') {
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
    // conflict_observed audit evidence per the Bite 5B contract: hashes and
    // the Salesforce History Id, deterministic dedupe key, no competing
    // event version stored. Built against the projection each mutation
    // produces so codes and evidence stay consistent.
    const buildConflictAudits = (projection: ReviewProjection): ReviewEventInsert[] =>
      (conflictedByOpportunity.get(rec.Id) ?? []).map((c) =>
        recordIngestionConflict(
          projection,
          {
            sfHistoryId: c.historyId,
            acceptedContentHash: c.acceptedHash,
            conflictingContentHash: c.conflictingHash,
          },
          { actorType: 'ingestion', occurredAt: config.runStartedAt },
        ).auditEvent,
      );

    if (outcome === 'eligible_new_candidate' && !existingReview) {
      const mutation = createReviewMutation(seed, {
        actorType: 'ingestion',
        occurredAt: config.runStartedAt,
      });
      operations.push({
        op: 'create_review',
        table: 'sf_opportunity_reviews',
        seed,
        auditEvents: [mutation.auditEvent, ...buildConflictAudits(mutation.projection)],
      });
      reviewsCreated += 1;
      continue;
    }
    if (outcome === 'already_pending_review' && existingReview) {
      // Reviewer-controlled state is inviolable: channel, lead, notes, and
      // human decisions are never touched, and a populated channel means
      // missing_channel is RESOLVED by a human; ingestion never re-adds it.
      let nextIssueCodes = seed.issue_codes;
      if (existingReview.channelId !== null) {
        nextIssueCodes = nextIssueCodes.filter((c) => c !== 'missing_channel');
      }
      const currentCodes = [...existingReview.issueCodes].sort().join('|');
      const nextCodes = [...nextIssueCodes].sort().join('|');
      const projection: ReviewProjection = {
        reviewState: existingReview.reviewState,
        issueCodes: nextIssueCodes,
        channelId: existingReview.channelId,
        leadId: existingReview.leadId ?? null,
      };
      if (currentCodes !== nextCodes) {
        operations.push({
          op: 'update_review_issues',
          table: 'sf_opportunity_reviews',
          sfOpportunityId: rec.Id,
          projection,
          auditEvents: [
            {
              event_type: 'issues_updated',
              previous_state: null,
              new_state: null,
              issue_codes_snapshot: [...nextIssueCodes].sort(),
              actor_type: 'ingestion',
              actor_id: null,
              note: null,
              sf_history_id: null,
              accepted_content_hash: null,
              conflicting_content_hash: null,
              dedupe_key: `issues:${rec.Id}:${nextCodes}`,
              occurred_at: config.runStartedAt,
            },
            ...buildConflictAudits(projection),
          ],
        });
        reviewIssueUpdates += 1;
      } else if (conflictedByOpportunity.has(rec.Id)) {
        // Codes unchanged (the conflict was already recorded) but the
        // evidence still travels: SQL dedupe makes an identical
        // reobservation a no-op while a different conflicting hash stays
        // separately auditable.
        operations.push({
          op: 'append_review_audit',
          table: 'sf_opportunity_review_events',
          sfOpportunityId: rec.Id,
          auditEvents: buildConflictAudits(projection),
        });
      }
    }
  }

  // --- Watermarks: proposed only; persisted exclusively on full success.
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
    excludedNotStaged,
    eventsPlanned: operations.filter((o) => o.op === 'insert_event').length,
    exactDuplicateEvents,
    conflictingEvents: [...conflictedByOpportunity.values()].reduce((a, b) => a + b.length, 0),
    snapshotsPlanned,
    snapshotNoops,
    staleSnapshotsSkipped,
    snapshotConflicts,
    reviewsCreated,
    reviewIssueUpdates,
    eligibility,
    linked,
  };
  operations.push({ op: 'record_sync_run', table: 'sf_opportunity_sync_runs', diagnostics });

  return { dryRunCompatible: true, operations, diagnostics };
}

// ---------------------------------------------------------------------------
// Serialization boundary: IngestionPlan -> sf_apply_opportunity_ingestion
// parameters. Typed and fail-closed: an unknown operation kind throws, and
// nothing outside the allowlisted parameters can be produced.
// ---------------------------------------------------------------------------

export interface ApplyPayload {
  p_snapshots: SnapshotPayload[];
  p_events: Array<EventInsert & { content_hash: string }>;
  // Reviews carry their audit events INSIDE the item so the SQL function
  // can enforce projection/audit coupling atomically; audit_only items add
  // conflict evidence to an existing review without touching it.
  p_reviews: Array<{
    kind: 'create' | 'update_issues' | 'audit_only';
    sf_opportunity_id: string;
    issue_codes: ReviewIssueCode[];
    audits: ReviewEventInsert[];
  }>;
  p_run: {
    started_at: string;
    watermark_system_modstamp: string | null;
    watermark_history_created_at: string | null;
    rows_discovered: number;
    conflicts: number;
  };
}

export function serializeApplyPayload(plan: IngestionPlan): ApplyPayload {
  // Conflict policy: a planner-detected conflict withholds ONLY the
  // disputed piece (the blocked snapshot or event stays out of the
  // payload) while unrelated safe data still applies; the review carries
  // the conflict evidence. A database-level race that surfaces an
  // unexpected conflict during apply fails the atomic batch instead.
  const payload: ApplyPayload = {
    p_snapshots: [],
    p_events: [],
    p_reviews: [],
    p_run: {
      started_at: plan.diagnostics.runStartedAt,
      watermark_system_modstamp: plan.diagnostics.proposedWatermarkSystemModstamp,
      watermark_history_created_at: plan.diagnostics.proposedWatermarkHistoryCreatedAt,
      rows_discovered: plan.diagnostics.rowsDiscovered,
      conflicts: plan.diagnostics.conflictingEvents,
    },
  };
  for (const operation of plan.operations) {
    switch (operation.op) {
      case 'upsert_snapshot':
        payload.p_snapshots.push(operation.payload);
        break;
      case 'insert_event':
        payload.p_events.push({ ...operation.event, content_hash: operation.contentHash });
        break;
      case 'create_review':
        payload.p_reviews.push({
          kind: 'create',
          sf_opportunity_id: operation.seed.sf_opportunity_id,
          issue_codes: operation.seed.issue_codes,
          audits: operation.auditEvents,
        });
        break;
      case 'update_review_issues':
        payload.p_reviews.push({
          kind: 'update_issues',
          sf_opportunity_id: operation.sfOpportunityId,
          issue_codes: operation.projection.issueCodes,
          audits: operation.auditEvents,
        });
        break;
      case 'append_review_audit':
        payload.p_reviews.push({
          kind: 'audit_only',
          sf_opportunity_id: operation.sfOpportunityId,
          issue_codes: [],
          audits: operation.auditEvents,
        });
        break;
      case 'noop_snapshot':
      case 'noop_stale_snapshot':
      case 'noop_duplicate_event':
      case 'block_snapshot_conflict':
      case 'block_conflicting_event':
      case 'record_sync_run':
        // No-ops carry nothing; blocked pieces stay out of the payload
        // (their evidence rides on the review); the run row is written by
        // the function.
        break;
      default: {
        // Fail closed on anything the serializer does not explicitly know.
        const exhaustive: never = operation;
        throw new Error(`serialize: unknown operation kind ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  // Deterministic ordering so two concurrent invocations lock rows in the
  // same order (deadlock avoidance at the database boundary).
  payload.p_snapshots.sort((a, b) => a.sf_opportunity_id.localeCompare(b.sf_opportunity_id));
  payload.p_events.sort((a, b) => a.sf_history_id.localeCompare(b.sf_history_id));
  payload.p_reviews.sort((a, b) => a.sf_opportunity_id.localeCompare(b.sf_opportunity_id));
  return payload;
}

// Dry-run serialization: aggregate counts only, zero writes attempted.
export function summarizeDryRunPlan(plan: IngestionPlan): {
  dry_run: true;
  writes_attempted: 0;
  wouldApply: { snapshots: number; events: number; reviewCreates: number; reviewIssueUpdates: number };
  diagnostics: SyncRunDiagnostics;
} {
  return {
    dry_run: true,
    writes_attempted: 0,
    wouldApply: {
      snapshots: plan.diagnostics.snapshotsPlanned,
      events: plan.diagnostics.eventsPlanned,
      reviewCreates: plan.diagnostics.reviewsCreated,
      reviewIssueUpdates: plan.diagnostics.reviewIssueUpdates,
    },
    diagnostics: plan.diagnostics,
  };
}
