// lifecycleObservationPlanner.ts: Bite 4G2A pure lifecycle-observation
// planner (docs/lead-lifecycle-observation-ledger.md).
//
// Turns one complete normalized extraction batch plus the authoritative
// prior state into an explicit plan of allowlisted operations. Pure: no
// Supabase, no Salesforce, no network, no clock. It attempts zero writes
// and reports so.
//
// Authority reuse, not duplication:
//   - Transition calculation is Bite 4A's eventsFromObservation. This
//     module does NOT reimplement Lead->MQL, returns, or requalification.
//   - Value normalization is Bite 4G1's APPROVED_LIFECYCLE_VALUE_MAP. No
//     fuzzy matching; unmapped values become 'unknown' and route to review.
//
// The one deliberate narrowing of 4A (documented in the contract): on a
// FIRST observation, 4A emits a null->lead baseline AND, when the current
// stage is already mql, a second null->mql event. Under 4G2 the org has no
// lifecycle history at all, so that second event would assert a transition
// nothing can evidence. The planner keeps only the baseline on a first
// observation. Every later observation flows through 4A untouched.

import { eventsFromObservation } from './funnelCohorts';
import type { LifecycleEvent } from './funnelCohorts';
import { APPROVED_LIFECYCLE_VALUE_MAP } from './leadSyncDiscovery';
import { sha256Hex } from './sha256';

// ---------------------------------------------------------------------------
// Normalized states and provenance
// ---------------------------------------------------------------------------

// 'lead' and 'mql' are the funnel-relevant states; 'out_of_scope' covers
// real org values beyond them (deal-side and administrative); 'unknown' is
// a value the approved map does not cover, which is always reviewable and
// never guessed.
export type NormalizedLifecycleState = 'lead' | 'mql' | 'out_of_scope' | 'unknown';

// Salesforce supplied no lifecycle history (Bite 4G1), so every observation
// this bite plans is 'n8n_observed'. 'salesforce_confirmed' exists for the
// day field history becomes available and would outrank observations from
// its activation date forward; no backfill is implemented here.
export type ObservationProvenance = 'n8n_observed' | 'salesforce_confirmed';

export type SourceObject = 'Lead' | 'Contact';

export function normalizeLifecycleValue(raw: string | null | undefined): NormalizedLifecycleState {
  const value = (raw ?? '').trim();
  if (value === '') return 'unknown';
  const mapped = APPROVED_LIFECYCLE_VALUE_MAP[value];
  return mapped === undefined ? 'unknown' : mapped;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

// One extracted Salesforce record, already normalized by the extraction
// layer. Synthetic in tests; private at run time.
export interface ExtractedLifecycleRow {
  sourceObject: SourceObject;
  // Salesforce record id: server-side evidence only, never browser-facing.
  sourceRecordId: string;
  rawLifecycleValue: string | null;
  // Salesforce SystemModstamp (preferred) or LastModifiedDate.
  sourceModifiedAt: string | null;
  // When n8n observed the row (full ISO timestamp).
  observedAt: string;
  // Supporting evidence only; never creates or moves an event.
  becameLeadDate?: string | null;
  becameMqlDate?: string | null;
}

// An exact Salesforce conversion relationship. The ONLY identity signal
// accepted: never name, email, company, or similarity.
export interface ConvertedIdentityPair {
  leadId: string;
  convertedContactId: string;
}

// Prior authoritative state for one canonical person.
export interface PriorPersonState {
  personId: string;
  normalizedState: NormalizedLifecycleState;
  // Whether an 'mql' state was ever observed before, so 4A can tell a
  // residual historical MQL date from a genuine contradiction.
  mqlSeenBefore: boolean;
  // Newest source timestamp already recorded, for stale detection.
  lastSourceModifiedAt: string | null;
  // Fingerprint of the last stored observation, for same-timestamp
  // duplicate-versus-conflict classification.
  lastContentFingerprint: string | null;
}

export interface PriorState {
  // Salesforce record id -> canonical person id.
  aliasToPerson: Record<string, string>;
  // Canonical person id -> their prior state.
  persons: Record<string, PriorPersonState>;
}

// Completeness of ONE extraction axis. Lifecycle and identity extraction
// fail independently, so they are tracked separately.
export interface AxisCompleteness {
  pagesExpected: number;
  pagesCompleted: number;
  failed: boolean;
}

export interface PlannerConfig {
  syncRunId: string;
  // The run's observation timestamp, supplied by the caller: this module
  // never reads the clock.
  runStartedAt: string;
  lifecyclePages: AxisCompleteness;
  identityPages: AxisCompleteness;
  // Watermark this batch would advance to, applied only on a complete run.
  proposedWatermarkSystemModstamp: string | null;
}

export interface PlannerInput {
  rows: ExtractedLifecycleRow[];
  identityPairs: ConvertedIdentityPair[];
  prior: PriorState;
  config: PlannerConfig;
}

// ---------------------------------------------------------------------------
// Operations (allowlisted)
// ---------------------------------------------------------------------------

export type IssueKind =
  | 'unknown_lifecycle_value'
  | 'blank_lifecycle_value'
  | 'same_timestamp_content_conflict'
  | 'identity_conflict'
  | 'malformed_supporting_date'
  | 'reversed_supporting_dates'
  | 'duplicate_source_id_across_pages'
  | 'ambiguous_transition_sequence';

export interface ObservationRow {
  personId: string;
  sourceObject: SourceObject;
  sourceRecordId: string;
  rawLifecycleValue: string | null;
  normalizedState: NormalizedLifecycleState;
  sourceModifiedAt: string | null;
  observedAt: string;
  contentFingerprint: string;
  syncRunId: string;
  provenance: ObservationProvenance;
  isBaseline: boolean;
  becameLeadDate: string | null;
  becameMqlDate: string | null;
}

export type PlannedOperation =
  | { op: 'create_person'; personId: string }
  | { op: 'create_alias'; personId: string; sourceObject: SourceObject; sourceRecordId: string }
  | { op: 'baseline_observation'; observation: ObservationRow }
  | { op: 'changed_observation'; observation: ObservationRow }
  | { op: 'unchanged_noop'; personId: string; sourceRecordId: string }
  | { op: 'lifecycle_event'; personId: string; event: LifecycleEvent }
  | {
      op: 'update_projection';
      personId: string;
      normalizedState: NormalizedLifecycleState;
      sourceModifiedAt: string | null;
      observedAt: string;
    }
  | { op: 'stale_noop'; sourceRecordId: string; reason: string }
  | { op: 'duplicate_noop'; sourceRecordId: string }
  | { op: 'raise_issue'; kind: IssueKind; sourceRecordId?: string; personId?: string; detail: string }
  | { op: 'record_sync_run'; diagnostics: PlannerDiagnostics };

// ---------------------------------------------------------------------------
// Diagnostics (aggregate only: no ids, names, emails, or source rows)
// ---------------------------------------------------------------------------

export interface PlannerDiagnostics {
  writes_attempted: 0;
  rowsDiscovered: number;
  leadRecords: number;
  contactRecords: number;
  baselines: number;
  changes: number;
  unchanged: number;
  leadToMql: number;
  mqlToLead: number;
  requalifications: number;
  outOfScopeObservations: number;
  unknownValues: number;
  staleRows: number;
  exactDuplicates: number;
  conflictingRows: number;
  identityLinksCreated: number;
  identityConflicts: number;
  malformedSupportingDates: number;
  lifecyclePagesExpected: number;
  lifecyclePagesCompleted: number;
  identityPagesExpected: number;
  identityPagesCompleted: number;
  lifecycleExtractionComplete: boolean;
  identityExtractionComplete: boolean;
  runComplete: boolean;
  watermarkAdvanced: boolean;
  proposedWatermarkSystemModstamp: string | null;
  incompleteReasons: string[];
}

export interface LifecyclePlan {
  operations: PlannedOperation[];
  diagnostics: PlannerDiagnostics;
  // False when the run may not apply state changes (incomplete extraction
  // or a hard pagination failure).
  applyPermitted: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidSupportingDate(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value.trim() === '') return true; // absent is fine
  if (!ISO_DATE.test(value.slice(0, 10))) return false;
  const d = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value.slice(0, 10);
}

// Canonical fingerprint over the lifecycle-bearing content of a row.
// Same timestamp + same fingerprint is an idempotent no-op; same timestamp
// + different fingerprint is a conflict that must never be auto-resolved.
export function observationFingerprint(row: ExtractedLifecycleRow): string {
  const canonical = JSON.stringify([
    row.sourceObject,
    row.sourceRecordId,
    (row.rawLifecycleValue ?? '').trim(),
    normalizeLifecycleValue(row.rawLifecycleValue),
    row.sourceModifiedAt ?? null,
    row.becameLeadDate ?? null,
    row.becameMqlDate ?? null,
  ]);
  return `sha256:${sha256Hex(canonical)}`;
}

function parseInstant(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// A 4A StageKey only exists for lead/mql. Out-of-scope and unknown states
// are stored as observations but never enter the transition calculator,
// because 4A has no vocabulary for them and inventing one would be a
// competing lifecycle calculation.
function asStageKey(state: NormalizedLifecycleState): 'lead' | 'mql' | null {
  return state === 'lead' || state === 'mql' ? state : null;
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export function planLifecycleObservations(input: PlannerInput): LifecyclePlan {
  const { rows, identityPairs, prior, config } = input;
  const operations: PlannedOperation[] = [];

  const diagnostics: PlannerDiagnostics = {
    writes_attempted: 0,
    rowsDiscovered: rows.length,
    leadRecords: rows.filter((r) => r.sourceObject === 'Lead').length,
    contactRecords: rows.filter((r) => r.sourceObject === 'Contact').length,
    baselines: 0,
    changes: 0,
    unchanged: 0,
    leadToMql: 0,
    mqlToLead: 0,
    requalifications: 0,
    outOfScopeObservations: 0,
    unknownValues: 0,
    staleRows: 0,
    exactDuplicates: 0,
    conflictingRows: 0,
    identityLinksCreated: 0,
    identityConflicts: 0,
    malformedSupportingDates: 0,
    lifecyclePagesExpected: config.lifecyclePages.pagesExpected,
    lifecyclePagesCompleted: config.lifecyclePages.pagesCompleted,
    identityPagesExpected: config.identityPages.pagesExpected,
    identityPagesCompleted: config.identityPages.pagesCompleted,
    lifecycleExtractionComplete: false,
    identityExtractionComplete: false,
    runComplete: false,
    watermarkAdvanced: false,
    proposedWatermarkSystemModstamp: config.proposedWatermarkSystemModstamp,
    incompleteReasons: [],
  };

  // --- Completeness, evaluated on two INDEPENDENT axes.
  const lifecycleComplete =
    !config.lifecyclePages.failed &&
    config.lifecyclePages.pagesExpected > 0 &&
    config.lifecyclePages.pagesCompleted >= config.lifecyclePages.pagesExpected;
  const identityComplete =
    !config.identityPages.failed &&
    config.identityPages.pagesExpected > 0 &&
    config.identityPages.pagesCompleted >= config.identityPages.pagesExpected;
  diagnostics.lifecycleExtractionComplete = lifecycleComplete;
  diagnostics.identityExtractionComplete = identityComplete;
  if (!lifecycleComplete) {
    diagnostics.incompleteReasons.push(
      `Lifecycle extraction incomplete: ${config.lifecyclePages.pagesCompleted}/${config.lifecyclePages.pagesExpected} pages${config.lifecyclePages.failed ? ' (a page failed)' : ''}.`,
    );
  }
  if (!identityComplete) {
    diagnostics.incompleteReasons.push(
      `Converted-identity extraction incomplete: ${config.identityPages.pagesCompleted}/${config.identityPages.pagesExpected} pages${config.identityPages.failed ? ' (a page failed)' : ''}.`,
    );
  }

  // --- Duplicate source ids across pages are a HARD failure: a repeat
  // means the pagination key is wrong, and silently deduplicating would
  // hide that while risking dropped records elsewhere.
  const seenSourceIds = new Set<string>();
  let duplicateSourceIds = false;
  for (const row of rows) {
    const key = `${row.sourceObject}:${row.sourceRecordId}`;
    if (seenSourceIds.has(key)) {
      duplicateSourceIds = true;
      operations.push({
        op: 'raise_issue',
        kind: 'duplicate_source_id_across_pages',
        detail:
          'The same source record appeared on more than one page. The pagination key is unsafe; re-run with a deterministic SystemModstamp + Id order.',
      });
    }
    seenSourceIds.add(key);
  }
  if (duplicateSourceIds) {
    diagnostics.incompleteReasons.push(
      'A source record appeared on more than one page; pagination is not deterministic.',
    );
  }

  const applyPermitted = lifecycleComplete && identityComplete && !duplicateSourceIds;

  // --- Identity resolution. Exact Salesforce relationships only.
  const aliasToPerson: Record<string, string> = { ...prior.aliasToPerson };
  let syntheticPersonSeq = 0;
  const newPersonId = (): string => {
    syntheticPersonSeq += 1;
    // Deterministic, content-free placeholder: the database assigns the
    // real UUID. Nothing downstream depends on this value's shape.
    return `new-person-${config.syncRunId}-${syntheticPersonSeq}`;
  };

  for (const pair of identityPairs) {
    const leadPerson = aliasToPerson[pair.leadId];
    const contactPerson = aliasToPerson[pair.convertedContactId];
    if (leadPerson && contactPerson && leadPerson !== contactPerson) {
      // Two canonical people already exist for one converted person.
      // Merging automatically would rewrite append-only history and could
      // conflate two real humans, so a person decides.
      diagnostics.identityConflicts += 1;
      operations.push({
        op: 'raise_issue',
        kind: 'identity_conflict',
        detail:
          'A converted Lead and its Contact already resolve to different canonical persons. Automatic merge is refused: append-only history must not be rewritten.',
      });
      continue;
    }
    if (leadPerson && !contactPerson) {
      aliasToPerson[pair.convertedContactId] = leadPerson;
      diagnostics.identityLinksCreated += 1;
      operations.push({
        op: 'create_alias',
        personId: leadPerson,
        sourceObject: 'Contact',
        sourceRecordId: pair.convertedContactId,
      });
    } else if (!leadPerson && contactPerson) {
      aliasToPerson[pair.leadId] = contactPerson;
      diagnostics.identityLinksCreated += 1;
      operations.push({
        op: 'create_alias',
        personId: contactPerson,
        sourceObject: 'Lead',
        sourceRecordId: pair.leadId,
      });
    }
    // Both already the same person: nothing to do. Neither present: the
    // rows below create the person and both aliases.
  }

  // --- Row pass, in deterministic order (source timestamp, then id).
  const ordered = [...rows].sort((a, b) => {
    const ai = parseInstant(a.sourceModifiedAt) ?? 0;
    const bi = parseInstant(b.sourceModifiedAt) ?? 0;
    if (ai !== bi) return ai - bi;
    return a.sourceRecordId.localeCompare(b.sourceRecordId);
  });

  // Working copy of person state so a batch containing several rows for one
  // person threads correctly within the run.
  const working: Record<string, PriorPersonState> = {};
  for (const [id, state] of Object.entries(prior.persons)) working[id] = { ...state };

  const processed = new Set<string>();

  for (const row of ordered) {
    const dedupeKey = `${row.sourceObject}:${row.sourceRecordId}`;
    if (processed.has(dedupeKey)) continue; // already reported as a duplicate
    processed.add(dedupeKey);

    const normalized = normalizeLifecycleValue(row.rawLifecycleValue);
    const fingerprint = observationFingerprint(row);
    const rawTrimmed = (row.rawLifecycleValue ?? '').trim();

    // Unknown and blank values are preserved as evidence and reviewed,
    // never guessed into a stage.
    if (normalized === 'unknown') {
      if (rawTrimmed === '') {
        diagnostics.unknownValues += 1;
        operations.push({
          op: 'raise_issue',
          kind: 'blank_lifecycle_value',
          sourceRecordId: row.sourceRecordId,
          detail: 'Blank lifecycle value observed; preserved as evidence and routed to review.',
        });
      } else {
        diagnostics.unknownValues += 1;
        operations.push({
          op: 'raise_issue',
          kind: 'unknown_lifecycle_value',
          sourceRecordId: row.sourceRecordId,
          detail:
            'Lifecycle value is absent from the approved map; preserved as evidence and routed to review. Never fuzzy-matched.',
        });
      }
    }
    if (normalized === 'out_of_scope') diagnostics.outOfScopeObservations += 1;

    // Supporting dates: validated, flagged, never repaired.
    const leadDateValid = isValidSupportingDate(row.becameLeadDate);
    const mqlDateValid = isValidSupportingDate(row.becameMqlDate);
    if (!leadDateValid || !mqlDateValid) {
      diagnostics.malformedSupportingDates += 1;
      operations.push({
        op: 'raise_issue',
        kind: 'malformed_supporting_date',
        sourceRecordId: row.sourceRecordId,
        detail: 'A supporting date is malformed; stored exactly as received and flagged, never corrected.',
      });
    } else if (
      row.becameLeadDate &&
      row.becameMqlDate &&
      row.becameMqlDate.slice(0, 10) < row.becameLeadDate.slice(0, 10)
    ) {
      diagnostics.malformedSupportingDates += 1;
      operations.push({
        op: 'raise_issue',
        kind: 'reversed_supporting_dates',
        sourceRecordId: row.sourceRecordId,
        detail:
          'Became MQL date precedes Became Lead date; flagged for review and never swapped.',
      });
    }

    // Resolve or create the canonical person.
    let personId = aliasToPerson[row.sourceRecordId];
    const isNewPerson = personId === undefined;
    if (isNewPerson) {
      personId = newPersonId();
      aliasToPerson[row.sourceRecordId] = personId;
      operations.push({ op: 'create_person', personId });
      operations.push({
        op: 'create_alias',
        personId,
        sourceObject: row.sourceObject,
        sourceRecordId: row.sourceRecordId,
      });
    }

    const priorPerson = working[personId];
    const observation: ObservationRow = {
      personId,
      sourceObject: row.sourceObject,
      sourceRecordId: row.sourceRecordId,
      rawLifecycleValue: row.rawLifecycleValue,
      normalizedState: normalized,
      sourceModifiedAt: row.sourceModifiedAt,
      observedAt: row.observedAt,
      contentFingerprint: fingerprint,
      syncRunId: config.syncRunId,
      // Salesforce supplied no lifecycle history, so every observation is
      // n8n-observed. See the contract doc.
      provenance: 'n8n_observed',
      isBaseline: priorPerson === undefined,
      becameLeadDate: row.becameLeadDate ?? null,
      becameMqlDate: row.becameMqlDate ?? null,
    };

    // --- First observation: BASELINE ONLY.
    if (priorPerson === undefined) {
      diagnostics.baselines += 1;
      operations.push({ op: 'baseline_observation', observation });

      const stage = asStageKey(normalized);
      if (stage !== null) {
        // Reuse 4A for the baseline event, then apply the 4G2 narrowing:
        // keep ONLY the baseline. On a first sighting already at mql, 4A
        // would also emit null->mql, which would assert a transition this
        // org cannot evidence (zero lifecycle history, Bite 4G1).
        const result = eventsFromObservation({
          leadId: personId,
          currentStage: stage,
          confirmedLeadDate: null,
          confirmedMqlDate: null,
          observedAt: row.observedAt,
          priorKnownStage: null,
        });
        const baselineEvent = result.events.find((e) => e.fromStage === null);
        if (baselineEvent) {
          operations.push({ op: 'lifecycle_event', personId, event: baselineEvent });
        }
        if (result.events.length > 1) {
          // Recorded for transparency: the discarded event is visible in
          // diagnostics as an out-of-scope-of-4G2 first sighting, not
          // silently dropped.
          operations.push({
            op: 'raise_issue',
            kind: 'ambiguous_transition_sequence',
            personId,
            detail:
              'First observation was already MQL. Baseline recorded; no historical Lead-to-MQL transition is asserted because the org holds no lifecycle history.',
          });
        }
      }

      operations.push({
        op: 'update_projection',
        personId,
        normalizedState: normalized,
        sourceModifiedAt: row.sourceModifiedAt,
        observedAt: row.observedAt,
      });
      working[personId] = {
        personId,
        normalizedState: normalized,
        mqlSeenBefore: normalized === 'mql',
        lastSourceModifiedAt: row.sourceModifiedAt,
        lastContentFingerprint: fingerprint,
      };
      continue;
    }

    // --- Stale protection: an older source timestamp can never overwrite
    // a newer recorded state.
    const priorMs = parseInstant(priorPerson.lastSourceModifiedAt);
    const incomingMs = parseInstant(row.sourceModifiedAt);
    if (priorMs !== null && incomingMs !== null && incomingMs < priorMs) {
      diagnostics.staleRows += 1;
      operations.push({
        op: 'stale_noop',
        sourceRecordId: row.sourceRecordId,
        reason: 'Source timestamp is older than the recorded state; stale data never overwrites newer.',
      });
      continue;
    }

    // --- Same source timestamp: identical content is idempotent, differing
    // content is a conflict that must never be silently resolved.
    if (priorMs !== null && incomingMs !== null && incomingMs === priorMs) {
      if (priorPerson.lastContentFingerprint === fingerprint) {
        diagnostics.exactDuplicates += 1;
        operations.push({ op: 'duplicate_noop', sourceRecordId: row.sourceRecordId });
        continue;
      }
      diagnostics.conflictingRows += 1;
      operations.push({
        op: 'raise_issue',
        kind: 'same_timestamp_content_conflict',
        sourceRecordId: row.sourceRecordId,
        personId,
        detail:
          'Two different lifecycle contents share one source timestamp. No version is selected automatically.',
      });
      continue;
    }

    // --- Unchanged: counted, not stored (see the contract's storage note).
    if (priorPerson.normalizedState === normalized) {
      diagnostics.unchanged += 1;
      operations.push({ op: 'unchanged_noop', personId, sourceRecordId: row.sourceRecordId });
      working[personId] = {
        ...priorPerson,
        lastSourceModifiedAt: row.sourceModifiedAt ?? priorPerson.lastSourceModifiedAt,
        lastContentFingerprint: fingerprint,
      };
      continue;
    }

    // --- Materially changed observation.
    diagnostics.changes += 1;
    operations.push({ op: 'changed_observation', observation });

    const priorStage = asStageKey(priorPerson.normalizedState);
    const currentStage = asStageKey(normalized);

    if (priorStage !== null && currentStage !== null) {
      // Both endpoints are funnel states: 4A owns the transition.
      const result = eventsFromObservation({
        leadId: personId,
        currentStage,
        confirmedLeadDate: null,
        confirmedMqlDate: null,
        observedAt: row.observedAt,
        priorKnownStage: priorStage,
        mqlSeenBefore: priorPerson.mqlSeenBefore,
      });
      for (const event of result.events) {
        operations.push({ op: 'lifecycle_event', personId, event });
        if (event.fromStage === 'lead' && event.toStage === 'mql') {
          diagnostics.leadToMql += 1;
          // A Lead->MQL after MQL was already seen is a requalification.
          if (priorPerson.mqlSeenBefore) diagnostics.requalifications += 1;
        } else if (event.fromStage === 'mql' && event.toStage === 'lead') {
          diagnostics.mqlToLead += 1;
        }
      }
    } else {
      // At least one endpoint is out_of_scope or unknown. The sequence is
      // preserved as an observation, but no transition is inferred ACROSS
      // it: collapsing lead -> out_of_scope -> mql into one transition
      // would be a guess, not a calculation.
      operations.push({
        op: 'raise_issue',
        kind: 'ambiguous_transition_sequence',
        personId,
        sourceRecordId: row.sourceRecordId,
        detail:
          'State moved through an out-of-scope or unknown value. The sequence is preserved; no transition is inferred across the gap.',
      });
    }

    operations.push({
      op: 'update_projection',
      personId,
      normalizedState: normalized,
      sourceModifiedAt: row.sourceModifiedAt,
      observedAt: row.observedAt,
    });
    working[personId] = {
      personId,
      normalizedState: normalized,
      mqlSeenBefore: priorPerson.mqlSeenBefore || normalized === 'mql',
      lastSourceModifiedAt: row.sourceModifiedAt,
      lastContentFingerprint: fingerprint,
    };
  }

  // --- Watermark: advances ONLY on a fully complete run.
  diagnostics.runComplete = applyPermitted;
  diagnostics.watermarkAdvanced =
    applyPermitted && config.proposedWatermarkSystemModstamp !== null;

  operations.push({ op: 'record_sync_run', diagnostics });

  return { operations, diagnostics, applyPermitted };
}
