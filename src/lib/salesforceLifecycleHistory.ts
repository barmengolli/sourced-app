// salesforceLifecycleHistory.ts: pure adapter from Salesforce field-history
// rows (LeadHistory / ContactHistory shape) to the Bite 4A lifecycle-event
// contract (Bite 4B).
//
// This is the read-only ingestion foundation, not the production import: no
// database table, no n8n change, no dashboard wiring. It translates source
// records only and reuses the Bite 4A calculator (assessLeadLifecycle,
// acquisitionCohortReport) for every cohort, uniqueness, and requalification
// question; nothing here recomputes those.
//
// Design constraints (docs/salesforce-lifecycle-history-mapping.md):
// - The Salesforce history-record Id is the idempotency key. Reprocessing the
//   same row can never produce a second lifecycle event. Email is never an
//   identity.
// - Field API names are configuration, not constants: the exact lifecycle
//   field name is still awaiting Salesforce-admin confirmation, so nothing
//   here hardcodes an invented name.
// - Rows are processed in stable source event-time order (CreatedDate, then
//   history Id as the deterministic same-timestamp tie-break). The adapter is
//   a full recompute over everything collected so far, so a late-arriving
//   older row lands in its correct logical position instead of becoming a
//   new current-day transition.
// - Unknown values, blanked values, unmapped identities, and contradictory
//   supporting dates are routed to explicit review results, never guessed.
// - Absence of an older history row is never treated as proof that no older
//   transition occurred: persons whose lifecycle predates the available
//   history window are marked with an incomplete historical baseline.

import type { StageKey } from '../types/db';
import type { LifecycleEvent, LeadLifecycleInput } from './funnelCohorts';
import { isValidIsoDate } from './reportingPeriods';

// ---------------------------------------------------------------------------
// Source row and configuration
// ---------------------------------------------------------------------------

// One Salesforce field-history row in source-neutral shape. LeadHistory and
// ContactHistory share this structure (Id, parent Id, Field, OldValue,
// NewValue, CreatedDate).
export interface SalesforceHistoryRow {
  // The history record's own Id: the source event identity and idempotency
  // key. Never a person identity.
  historyId: string;
  // LeadId or ContactId the row belongs to.
  parentId: string;
  parentObject: 'Lead' | 'Contact';
  // API name of the changed field as reported by the history object.
  field: string;
  oldValue: string | null;
  newValue: string | null;
  // The history row's CreatedDate: when Salesforce recorded the change. This
  // is the source event time used for ordering and for the transition date.
  changedAt: string;
  raw?: Record<string, unknown>;
}

// How one Salesforce picklist value maps into the funnel's lifecycle space.
// 'out_of_scope' marks real org values beyond Lead/MQL (deal-side stages);
// rows moving INTO them are counted but produce no lifecycle event, because
// HPP and later stages are tracked in attributions, not lead lifecycle.
export type LifecycleValueMapping = StageKey | 'out_of_scope';

export interface LifecycleHistoryConfig {
  // Verified API name of the lifecycle field. Rows for any other field are
  // ignored (counted, not errors). Must be confirmed by the Salesforce
  // administrator before production use; tests use a synthetic name.
  lifecycleFieldApiName: string;
  // Exact picklist value -> lifecycle mapping. Values absent from this map
  // are unknown and route the row to review.
  stageValueMap: Record<string, LifecycleValueMapping>;
  // Earliest date (YYYY-MM-DD) from which history is known to be available
  // for this org, once verified (tracking start or retention floor). null
  // means coverage is not yet verified.
  historyAvailableSince: string | null;
}

// Verified person identity: which Lead Ids and Contact Ids are the same
// person, keyed to a stable application person key. Built by the caller from
// verified Lead.ConvertedContactId data. The adapter never merges records
// heuristically; a row whose parent is not in this map goes to review.
export interface PersonIdentityMap {
  byLeadId: Record<string, string>;
  byContactId: Record<string, string>;
}

// Optional supporting evidence per person: the confirmed became-a-lead and
// became-MQL dates, once their API names are confirmed. Supporting evidence
// can corroborate or contradict history; it never invents a transition.
export interface PersonSupportingDates {
  becameLeadDate?: string | null;
  becameMqlDate?: string | null;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type HistoryIssueKind =
  | 'invalid_config'
  | 'duplicate_history_id'
  | 'unknown_lifecycle_value'
  | 'blank_lifecycle_value'
  | 'out_of_scope_transition'
  | 'unmapped_person_identity'
  | 'history_continuity_gap'
  | 'incomplete_historical_baseline'
  | 'supporting_dates_reversed'
  | 'supporting_mql_date_without_history';

export interface HistoryIssue {
  kind: HistoryIssueKind;
  count: number;
}

// One row or person routed to human review instead of silent correction.
export interface HistoryReviewItem {
  reason: HistoryIssueKind;
  historyId?: string;
  personKey?: string;
}

export interface PersonHistoryResult {
  personKey: string;
  // Canonical Bite 4A events in stable source order, ready for
  // assessLeadLifecycle.
  events: LifecycleEvent[];
  // True when this person's lifecycle is known or likely to predate the
  // available history window: the earliest relevant row shows a pre-existing
  // value, or the confirmed acquisition date is older than
  // historyAvailableSince. The absence of an older row proves nothing.
  incompleteHistoricalBaseline: boolean;
  issues: HistoryIssue[];
}

export interface HistoryAdapterResult {
  state: 'complete' | 'incomplete' | 'missing' | 'invalid';
  persons: PersonHistoryResult[];
  // Convenience view for the Bite 4A cohort calculator.
  lifecycles: LeadLifecycleInput[];
  review: HistoryReviewItem[];
  duplicatesIgnored: number;
  otherFieldRowsIgnored: number;
  outOfScopeRowsIgnored: number;
  unchangedRowsIgnored: number;
  issues: HistoryIssue[];
  historyAvailableSince: string | null;
}

function pushIssue(issues: HistoryIssue[], kind: HistoryIssueKind, count = 1): void {
  const found = issues.find((i) => i.kind === kind);
  if (found) found.count += count;
  else issues.push({ kind, count });
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

type MappedValue = { kind: 'stage'; stage: StageKey } | { kind: 'out_of_scope' } | { kind: 'blank' } | { kind: 'unknown' };

function mapValue(value: string | null, config: LifecycleHistoryConfig): MappedValue {
  if (value === null || value.trim() === '') return { kind: 'blank' };
  const mapped = config.stageValueMap[value.trim()];
  if (mapped === undefined) return { kind: 'unknown' };
  if (mapped === 'out_of_scope') return { kind: 'out_of_scope' };
  return { kind: 'stage', stage: mapped };
}

// Normalize verified Salesforce history rows into per-person lifecycle event
// histories. Pure full recompute: same input, same output, regardless of
// arrival order or repeated processing.
export function adaptLifecycleHistory(
  rows: SalesforceHistoryRow[],
  config: LifecycleHistoryConfig,
  identity: PersonIdentityMap,
  supportingDates: Record<string, PersonSupportingDates> = {},
): HistoryAdapterResult {
  const issues: HistoryIssue[] = [];
  const review: HistoryReviewItem[] = [];

  if (!config.lifecycleFieldApiName.trim()) {
    return {
      state: 'invalid',
      persons: [],
      lifecycles: [],
      review,
      duplicatesIgnored: 0,
      otherFieldRowsIgnored: 0,
      outOfScopeRowsIgnored: 0,
      unchangedRowsIgnored: 0,
      issues: [{ kind: 'invalid_config', count: 1 }],
      historyAvailableSince: config.historyAvailableSince,
    };
  }

  // 1. Idempotency: the history-record Id deduplicates before anything else.
  const seenIds = new Set<string>();
  let duplicatesIgnored = 0;
  const unique: SalesforceHistoryRow[] = [];
  for (const row of rows) {
    if (seenIds.has(row.historyId)) {
      duplicatesIgnored += 1;
      continue;
    }
    seenIds.add(row.historyId);
    unique.push(row);
  }
  if (duplicatesIgnored > 0) pushIssue(issues, 'duplicate_history_id', duplicatesIgnored);

  // 2. Keep only lifecycle-field rows; other tracked fields are not errors.
  let otherFieldRowsIgnored = 0;
  const relevant: SalesforceHistoryRow[] = [];
  for (const row of unique) {
    if (row.field !== config.lifecycleFieldApiName) {
      otherFieldRowsIgnored += 1;
      continue;
    }
    relevant.push(row);
  }

  // 3. Resolve identity through the verified map only. No heuristics.
  const byPerson = new Map<string, SalesforceHistoryRow[]>();
  for (const row of relevant) {
    const personKey =
      row.parentObject === 'Lead'
        ? identity.byLeadId[row.parentId]
        : identity.byContactId[row.parentId];
    if (!personKey) {
      pushIssue(issues, 'unmapped_person_identity');
      review.push({ reason: 'unmapped_person_identity', historyId: row.historyId });
      continue;
    }
    if (!byPerson.has(personKey)) byPerson.set(personKey, []);
    byPerson.get(personKey)!.push(row);
  }

  // 4. Stable source order: CreatedDate ascending, then history Id as the
  // deterministic tie-break for same-timestamp changes. Because this is a
  // full recompute, a late-arriving older row sorts into its correct logical
  // position; it can never masquerade as a current-day transition.
  const ordered = (list: SalesforceHistoryRow[]): SalesforceHistoryRow[] =>
    [...list].sort((a, b) => {
      if (a.changedAt < b.changedAt) return -1;
      if (a.changedAt > b.changedAt) return 1;
      return a.historyId < b.historyId ? -1 : a.historyId > b.historyId ? 1 : 0;
    });

  let outOfScopeRowsIgnored = 0;
  let unchangedRowsIgnored = 0;
  const persons: PersonHistoryResult[] = [];

  for (const [personKey, list] of byPerson) {
    const personIssues: HistoryIssue[] = [];
    const events: LifecycleEvent[] = [];
    let prevKnownStage: StageKey | null = null;
    let firstRelevantRow = true;
    let incompleteBaseline = false;
    let sawMqlEvent = false;

    for (const row of ordered(list)) {
      const oldMapped = mapValue(row.oldValue, config);
      const newMapped = mapValue(row.newValue, config);

      // The earliest row's old value tells us whether lifecycle state existed
      // before history begins: a pre-existing value means the true origin
      // predates what we can see.
      if (firstRelevantRow) {
        firstRelevantRow = false;
        if (oldMapped.kind !== 'blank') incompleteBaseline = true;
      }

      if (newMapped.kind === 'unknown' || oldMapped.kind === 'unknown') {
        pushIssue(personIssues, 'unknown_lifecycle_value');
        review.push({ reason: 'unknown_lifecycle_value', historyId: row.historyId, personKey });
        continue;
      }
      if (newMapped.kind === 'blank') {
        // The lifecycle field was cleared: that is not a canonical
        // transition. Route to review rather than inventing a regression.
        pushIssue(personIssues, 'blank_lifecycle_value');
        review.push({ reason: 'blank_lifecycle_value', historyId: row.historyId, personKey });
        continue;
      }
      if (newMapped.kind === 'out_of_scope') {
        // Progression beyond MQL is deal-side (attributions), not lead
        // lifecycle. Counted, not an error, no event.
        outOfScopeRowsIgnored += 1;
        prevKnownStage = null;
        continue;
      }
      if (oldMapped.kind === 'out_of_scope') {
        // A move from a deal-side value back into Lead/MQL space cannot be
        // expressed safely in the two-stage lifecycle; review it.
        pushIssue(personIssues, 'out_of_scope_transition');
        review.push({ reason: 'out_of_scope_transition', historyId: row.historyId, personKey });
        continue;
      }

      const newStage = newMapped.stage;
      const oldStage = oldMapped.kind === 'stage' ? oldMapped.stage : null;

      if (oldStage !== null && oldStage === newStage) {
        // Two org values mapping to the same lifecycle stage (a relabel) is
        // not a transition.
        unchangedRowsIgnored += 1;
        prevKnownStage = newStage;
        continue;
      }

      // Continuity: the row's own old value should match what we last knew.
      // A mismatch means missing rows or cross-object overlap; flag it but
      // trust the row's own values rather than silently rewriting either.
      if (prevKnownStage !== null && oldStage !== null && oldStage !== prevKnownStage) {
        pushIssue(personIssues, 'history_continuity_gap');
      }

      const day = row.changedAt.slice(0, 10);
      events.push({
        leadId: personKey,
        fromStage: oldStage,
        toStage: newStage,
        // The history row's CreatedDate is Salesforce's own record of when
        // the value changed: a confirmed transition time for the SFDC field.
        effectiveDate: isValidIsoDate(day) ? day : null,
        observedAt: row.changedAt,
        dateSource: 'salesforce_confirmed',
        raw: { historyId: row.historyId, parentObject: row.parentObject },
      });
      if (newStage === 'mql') sawMqlEvent = true;
      prevKnownStage = newStage;
    }

    // Supporting evidence: corroboration and contradiction only, never event
    // creation.
    const support = supportingDates[personKey];
    if (support) {
      const { becameLeadDate, becameMqlDate } = support;
      if (becameLeadDate && becameMqlDate && becameMqlDate < becameLeadDate) {
        pushIssue(personIssues, 'supporting_dates_reversed');
        review.push({ reason: 'supporting_dates_reversed', personKey });
      }
      if (
        becameLeadDate &&
        config.historyAvailableSince &&
        becameLeadDate < config.historyAvailableSince
      ) {
        // The person became a Lead before history coverage begins.
        incompleteBaseline = true;
      }
      if (becameMqlDate && !sawMqlEvent) {
        if (config.historyAvailableSince && becameMqlDate >= config.historyAvailableSince) {
          // History should have covered this conversion and shows no row:
          // a contradiction worth human eyes.
          pushIssue(personIssues, 'supporting_mql_date_without_history');
          review.push({ reason: 'supporting_mql_date_without_history', personKey });
        } else {
          // Coverage unknown or starts after the claimed conversion: absence
          // proves nothing beyond an incomplete baseline.
          incompleteBaseline = true;
        }
      }
    }

    if (incompleteBaseline) pushIssue(personIssues, 'incomplete_historical_baseline');
    for (const i of personIssues) pushIssue(issues, i.kind, i.count);
    persons.push({
      personKey,
      events,
      incompleteHistoricalBaseline: incompleteBaseline,
      issues: personIssues,
    });
  }

  const lifecycles: LeadLifecycleInput[] = persons.map((p) => ({
    leadId: p.personKey,
    events: p.events,
  }));

  let state: HistoryAdapterResult['state'] = 'complete';
  if (persons.length === 0 && review.length === 0) state = 'missing';
  else if (issues.length > 0 || review.length > 0) state = 'incomplete';

  return {
    state,
    persons,
    lifecycles,
    review,
    duplicatesIgnored,
    otherFieldRowsIgnored,
    outOfScopeRowsIgnored,
    unchangedRowsIgnored,
    issues,
    historyAvailableSince: config.historyAvailableSince,
  };
}
