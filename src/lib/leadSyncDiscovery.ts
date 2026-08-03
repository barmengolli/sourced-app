// leadSyncDiscovery.ts: Bite 4G1 pure discovery/summary module.
//
// Takes SYNTHETIC (or, at run time, live-but-private) Salesforce discovery
// results and emits the aggregate-only 4G1 summary. Discovery only: this
// module never writes anywhere, never reads the clock or network, and
// contains no scheduling, apply, or backfill logic.
//
// Two hard output rules:
//   1. dry_run is always true and writes_attempted is always 0.
//   2. The summary is AGGREGATE ONLY. No person names, emails, account
//      names, campaign names, Salesforce record ids, or source rows may
//      appear in it. Callers may hold private detail; it must never be
//      folded into this object. `assertNoIdentifierLeakage` is the
//      enforcement point.
//
// Lifecycle classification is NOT reimplemented here. Transition counting
// delegates to adaptLifecycleHistory (Bite 4B), which owns value mapping,
// duplicate/conflict handling, timestamp validation, and the closed
// lead/mql/out_of_scope union. Touch-identity gaps are expressed with the
// Bite 4D vocabulary (CampaignMember Id preferred, then the
// lead+campaign+date natural key).

import { adaptLifecycleHistory } from './salesforceLifecycleHistory';
import type {
  LifecycleHistoryConfig,
  PersonIdentityMap,
  SalesforceHistoryRow,
} from './salesforceLifecycleHistory';

// ---------------------------------------------------------------------------
// Inputs (synthetic in tests; private live values at run time)
// ---------------------------------------------------------------------------

// One row from a FieldDefinition query. Only metadata, never data.
export interface DiscoveredField {
  // The field's API name, e.g. a custom lifecycle field. API names are
  // schema metadata, not customer data, and are safe to report.
  apiName: string;
  label: string;
  dataType: string;
  // Salesforce reports whether field history tracking is enabled.
  isHistoryTracked: boolean;
}

export interface ObjectFieldDiscovery {
  object: 'Lead' | 'Contact' | 'CampaignMember';
  fields: DiscoveredField[];
}

// Lifecycle-history coverage for ONE object, measured against the CONFIRMED
// lifecycle field only. Whole-object history is a different (larger) number
// and must never be reported as lifecycle coverage.
//
// The three outcomes are deliberately distinct: a successful query that
// returned zero lifecycle rows is NOT the same as an inaccessible object,
// and neither is the same as rows being present. Salesforce nodes running
// with alwaysOutputData emit an empty {} sentinel on a zero-row result, so
// 'succeeded_zero_rows' is what an honest empty looks like.
export type HistoryAccess =
  | {
      outcome: 'succeeded_with_rows';
      lifecycleField: string;
      rowCount: number;
      earliest: string | null;
      latest: string | null;
    }
  | { outcome: 'succeeded_zero_rows'; lifecycleField: string }
  | { outcome: 'query_failed'; reason: 'permission_denied' | 'not_attempted' | 'query_error' };

// Whether a count covers the WHOLE Salesforce org or only an explicitly
// approved campaign scope. A number is never labeled "in scope" unless a
// campaign filter was actually applied to the query that produced it.
export type VolumeScope = 'organization_wide' | 'approved_campaign_scope';

export interface CampaignMemberVolume {
  // Rows the CURRENT nightly window (rolling CreatedDate, 2 days) returns.
  incrementalWindowRows: number;
  // Rows a FUTURE changed-or-created strategy would return
  // (LastModifiedDate/SystemModstamp based), when the field discovery makes
  // it determinable. null means the org did not expose what is needed.
  changedOrCreatedWindowRows: number | null;
  // Rows a full reconciliation returns.
  fullReconciliationRows: number;
  // Scope of each number above. The current queries are organization-wide;
  // labeling them otherwise would overstate what was measured.
  incrementalScope: VolumeScope;
  fullReconciliationScope: VolumeScope;
  // The ceiling the current production workflow assumes.
  currentRowLimit: number;
  // Rows whose parent is a Lead vs a Contact.
  leadMemberRows: number;
  contactMemberRows: number;
  // Converted leads whose ConvertedContactId is populated, and those where
  // it is missing (the linkage gap that would orphan a membership).
  convertedLeadsWithContactLink: number;
  convertedLeadsMissingContactLink: number;
  // Touch-identity completeness, in the Bite 4D vocabulary.
  missingCampaignMemberId: number;
  missingCampaignId: number;
  missingPersonIdentity: number;
  missingTouchDate: number;
  // Rows whose campaign cannot be mapped to a Sourced channel.
  missingCampaignChannelMapping: number;
}

export interface LifecycleValueObservation {
  // A raw picklist value as it appears in the org. Picklist values are
  // schema-level vocabulary, not person data.
  value: string;
  count: number;
}

// The confirmed lifecycle field API names, entered by a human after Pass A
// and validated in Pass B. Lead and Contact are INDEPENDENT: nothing here
// assumes they share an API name, and neither may be guessed.
export interface LifecycleFieldConfig {
  leadLifecycleField: string;
  contactLifecycleField: string;
}

// Why a configured lifecycle field is unusable. Every one of these must
// fail the run loudly rather than letting Pass B "succeed" on a guess.
export type LifecycleFieldRejection =
  | 'placeholder_not_replaced'
  | 'blank'
  | 'not_returned_by_field_definition'
  | 'not_history_queryable';

export interface LifecycleFieldValidation {
  object: 'Lead' | 'Contact';
  configured: string;
  valid: boolean;
  rejection: LifecycleFieldRejection | null;
}

// Values that mean "the user never filled this in".
const PLACEHOLDERS: ReadonlySet<string> = new Set([
  'FIELD_API_NAME',
  'LEAD_LIFECYCLE_FIELD',
  'CONTACT_LIFECYCLE_FIELD',
  'REPLACE_ME',
  'TODO',
]);

export interface DiscoveryInput {
  // Pass B only. Omit during Pass A, when field names are not yet known.
  lifecycleFieldConfig?: LifecycleFieldConfig;
  leadFields: ObjectFieldDiscovery;
  contactFields: ObjectFieldDiscovery;
  campaignMemberFields: ObjectFieldDiscovery;
  leadHistory: HistoryAccess;
  contactHistory: HistoryAccess;
  // Observed lifecycle picklist values with counts, from an aggregate query.
  lifecycleValues: LifecycleValueObservation[];
  // Sampled history rows for transition classification. Synthetic in tests.
  historyRows: SalesforceHistoryRow[];
  historyConfig: LifecycleHistoryConfig;
  identity: PersonIdentityMap;
  campaignMembers: CampaignMemberVolume;
  // Field-name candidates the discovery could not resolve without a human
  // decision, e.g. which API field backs the "Member First Associated
  // Date" report label.
  unresolvedDecisions: string[];
  // Batch size the future workflow would page with.
  plannedBatchSize: number;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface FieldFinding {
  found: boolean;
  // Empty when not found. API names only; never values.
  apiNames: string[];
  historyTrackedApiNames: string[];
  notHistoryTrackedApiNames: string[];
}

export interface HistoryFinding {
  // True only when the query itself succeeded, whether or not it found rows.
  querySucceeded: boolean;
  // True when the query succeeded AND returned at least one lifecycle row.
  hasLifecycleRows: boolean;
  failureReason: 'permission_denied' | 'not_attempted' | 'query_error' | null;
  // The confirmed lifecycle field this coverage was measured against; null
  // when the query never ran.
  lifecycleField: string | null;
  lifecycleRowCount: number;
  earliestLifecycleTimestamp: string | null;
  latestLifecycleTimestamp: string | null;
}

export interface TransitionCounts {
  leadToMql: number;
  mqlToLead: number;
  unchanged: number;
  blank: number;
  unknown: number;
  outOfScope: number;
  // Rows the 4B adapter rejected or routed to review, by kind.
  duplicatesIgnored: number;
  conflictingDuplicateHistoryIds: number;
  invalidSourceRows: number;
  invalidTimestamps: number;
}

export interface VolumeFinding extends CampaignMemberVolume {
  // Two DIFFERENT risks, never conflated into one flag:
  //  - the nightly incremental query silently truncating at the current
  //    5,000-row limit (a correctness bug today), and
  //  - a full reconciliation needing pagination (a design requirement for
  //    the rebuild, not a bug).
  incrementalCanExceedRowLimit: boolean;
  reconciliationRequiresPagination: boolean;
  estimatedIncrementalBatches: number;
  estimatedReconciliationBatches: number;
  // True when a future changed-or-created window could not be sized.
  changedOrCreatedStrategyUndetermined: boolean;
}

export interface DiscoverySummary {
  dry_run: true;
  writes_attempted: 0;
  lifecycleField: {
    lead: FieldFinding;
    contact: FieldFinding;
    // True when both objects expose a lifecycle field under the SAME api
    // name; false when they differ (which the current workflow's code
    // assumes away). Informational only: nothing downstream may rely on
    // them matching.
    apiNamesMatch: boolean;
    // Pass B validation of the human-entered names, per object. Empty
    // during Pass A, when no names have been confirmed yet.
    validation: LifecycleFieldValidation[];
    // True only when BOTH configured names passed validation. A run with
    // this false must not be treated as a completed discovery.
    configurationValid: boolean;
  };
  candidateDateFields: {
    becameLead: string[];
    becameMql: string[];
    campaignMemberDateFields: string[];
  };
  history: {
    lead: HistoryFinding;
    contact: HistoryFinding;
  };
  lifecycleValues: LifecycleValueObservation[];
  distinctLifecycleValueCount: number;
  transitions: TransitionCounts;
  volume: VolumeFinding;
  unresolvedDecisions: string[];
  // Which pass produced this summary, and whether it is complete enough to
  // design Bite 4G2 against. Pass A is field/scope discovery only and is
  // NEVER complete; Pass B is complete only with valid field configuration
  // and queryable lifecycle history for both objects.
  pass: 'A' | 'B';
  complete: boolean;
  // Human-readable reasons the run is not complete. Empty when complete.
  incompleteReasons: string[];
}

// ---------------------------------------------------------------------------
// Field classification helpers (name-based candidacy, never fuzzy mapping)
// ---------------------------------------------------------------------------

// Candidate detection is a NAME heuristic used only to surface fields for a
// human to confirm. It never maps a value to a lifecycle stage; that
// remains the explicit configuration the 4B adapter validates.
const LIFECYCLE_HINTS = ['lifecycle', 'lifecyclestage'];
const BECAME_LEAD_HINTS = ['becamelead', 'becomealead', 'leaddate', 'sourceddate'];
const BECAME_MQL_HINTS = ['becamemql', 'mqldate', 'marketingqualified'];
const CM_DATE_HINTS = ['firstassociat', 'firstrespondeddate', 'createddate', 'lastmodifieddate', 'systemmodstamp'];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matches(field: DiscoveredField, hints: string[]): boolean {
  const name = normalize(field.apiName);
  const label = normalize(field.label);
  return hints.some((h) => name.includes(h) || label.includes(h));
}

function fieldFinding(discovery: ObjectFieldDiscovery, hints: string[]): FieldFinding {
  const hits = discovery.fields.filter((f) => matches(f, hints));
  return {
    found: hits.length > 0,
    apiNames: hits.map((f) => f.apiName),
    historyTrackedApiNames: hits.filter((f) => f.isHistoryTracked).map((f) => f.apiName),
    notHistoryTrackedApiNames: hits.filter((f) => !f.isHistoryTracked).map((f) => f.apiName),
  };
}

// Validate ONE object's configured lifecycle field against what
// FieldDefinition actually returned and whether its history is queryable.
// Never guesses, never falls back to the other object's name.
export function validateLifecycleField(
  object: 'Lead' | 'Contact',
  configured: string,
  discovery: ObjectFieldDiscovery,
  history: HistoryAccess,
): LifecycleFieldValidation {
  const trimmed = (configured ?? '').trim();
  const reject = (rejection: LifecycleFieldRejection): LifecycleFieldValidation => ({
    object,
    configured: trimmed,
    valid: false,
    rejection,
  });
  if (trimmed === '') return reject('blank');
  if (PLACEHOLDERS.has(trimmed.toUpperCase())) return reject('placeholder_not_replaced');
  const known = discovery.fields.some((f) => f.apiName === trimmed);
  if (!known) return reject('not_returned_by_field_definition');
  // History must be QUERYABLE. A successful zero-row result still proves
  // access; only an outright query failure disqualifies the field.
  if (history.outcome === 'query_failed') return reject('not_history_queryable');
  return { object, configured: trimmed, valid: true, rejection: null };
}

function historyFinding(access: HistoryAccess): HistoryFinding {
  if (access.outcome === 'query_failed') {
    return {
      querySucceeded: false,
      hasLifecycleRows: false,
      failureReason: access.reason,
      lifecycleField: null,
      lifecycleRowCount: 0,
      earliestLifecycleTimestamp: null,
      latestLifecycleTimestamp: null,
    };
  }
  if (access.outcome === 'succeeded_zero_rows') {
    return {
      querySucceeded: true,
      hasLifecycleRows: false,
      failureReason: null,
      lifecycleField: access.lifecycleField,
      lifecycleRowCount: 0,
      earliestLifecycleTimestamp: null,
      latestLifecycleTimestamp: null,
    };
  }
  return {
    querySucceeded: true,
    hasLifecycleRows: access.rowCount > 0,
    failureReason: null,
    lifecycleField: access.lifecycleField,
    lifecycleRowCount: access.rowCount,
    earliestLifecycleTimestamp: access.earliest,
    latestLifecycleTimestamp: access.latest,
  };
}

// ---------------------------------------------------------------------------
// Transition counting (delegates to the Bite 4B adapter)
// ---------------------------------------------------------------------------

function countTransitions(
  rows: SalesforceHistoryRow[],
  config: LifecycleHistoryConfig,
  identity: PersonIdentityMap,
): TransitionCounts {
  const result = adaptLifecycleHistory(rows, config, identity);
  const counts: TransitionCounts = {
    leadToMql: 0,
    mqlToLead: 0,
    unchanged: result.unchangedRowsIgnored,
    blank: 0,
    unknown: 0,
    outOfScope: result.outOfScopeRowsIgnored,
    duplicatesIgnored: result.duplicatesIgnored,
    conflictingDuplicateHistoryIds: 0,
    invalidSourceRows: 0,
    invalidTimestamps: 0,
  };

  for (const issue of result.issues) {
    if (issue.kind === 'blank_lifecycle_value') counts.blank += issue.count;
    if (issue.kind === 'unknown_lifecycle_value') counts.unknown += issue.count;
    if (issue.kind === 'conflicting_duplicate_history_id') {
      counts.conflictingDuplicateHistoryIds += issue.count;
    }
    if (issue.kind === 'invalid_source_row') counts.invalidSourceRows += issue.count;
    if (issue.kind === 'invalid_history_timestamp') counts.invalidTimestamps += issue.count;
  }

  // Direction comes from each event's own fromStage/toStage pair, which the
  // 4B adapter already resolved; nothing is re-inferred from ordering here.
  // A requalification after a demotion is simply another lead->mql event,
  // so it counts again, matching the program's append-only event model.
  // A baseline observation (fromStage null) is not a transition.
  for (const person of result.persons) {
    for (const event of person.events) {
      if (event.fromStage === 'lead' && event.toStage === 'mql') counts.leadToMql += 1;
      else if (event.fromStage === 'mql' && event.toStage === 'lead') counts.mqlToLead += 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function summarizeDiscovery(input: DiscoveryInput): DiscoverySummary {
  const lead = fieldFinding(input.leadFields, LIFECYCLE_HINTS);
  const contact = fieldFinding(input.contactFields, LIFECYCLE_HINTS);

  // Pass A has no confirmed field names yet; Pass B must validate both.
  const config = input.lifecycleFieldConfig;
  const pass: 'A' | 'B' = config ? 'B' : 'A';
  const validation: LifecycleFieldValidation[] = config
    ? [
        validateLifecycleField('Lead', config.leadLifecycleField, input.leadFields, input.leadHistory),
        validateLifecycleField('Contact', config.contactLifecycleField, input.contactFields, input.contactHistory),
      ]
    : [];
  const configurationValid = validation.length === 2 && validation.every((v) => v.valid);

  const incompleteReasons: string[] = [];
  if (pass === 'A') {
    incompleteReasons.push('Pass A discovers field names and scope only; Pass B is required for transition evidence.');
  } else {
    for (const v of validation) {
      if (!v.valid) incompleteReasons.push(`${v.object} lifecycle field rejected: ${v.rejection}`);
    }
    if (input.leadHistory.outcome === 'query_failed') {
      incompleteReasons.push(`LeadHistory not queryable: ${input.leadHistory.reason}`);
    }
    if (input.contactHistory.outcome === 'query_failed') {
      incompleteReasons.push(`ContactHistory not queryable: ${input.contactHistory.reason}`);
    }
  }

  const batches = (rows: number, size: number): number =>
    size > 0 ? Math.ceil(rows / size) : 0;

  const cm = input.campaignMembers;
  const volume: VolumeFinding = {
    ...cm,
    // The nightly query carries a hard LIMIT, so exceeding it means silent
    // truncation. The changed-or-created window, when known, is the same
    // risk for the future strategy and is folded in here.
    incrementalCanExceedRowLimit:
      cm.incrementalWindowRows > cm.currentRowLimit ||
      (cm.changedOrCreatedWindowRows !== null &&
        cm.changedOrCreatedWindowRows > cm.currentRowLimit),
    // Reconciliation is expected to be large; the question is only whether
    // it must page, which it must whenever it exceeds one batch.
    reconciliationRequiresPagination:
      input.plannedBatchSize > 0 && cm.fullReconciliationRows > input.plannedBatchSize,
    estimatedIncrementalBatches: batches(cm.incrementalWindowRows, input.plannedBatchSize),
    estimatedReconciliationBatches: batches(cm.fullReconciliationRows, input.plannedBatchSize),
    changedOrCreatedStrategyUndetermined: cm.changedOrCreatedWindowRows === null,
  };

  return {
    dry_run: true,
    writes_attempted: 0,
    lifecycleField: {
      lead,
      contact,
      validation,
      configurationValid,
      apiNamesMatch:
        lead.found &&
        contact.found &&
        lead.apiNames.length === contact.apiNames.length &&
        lead.apiNames.every((n) => contact.apiNames.includes(n)),
    },
    candidateDateFields: {
      becameLead: [
        ...fieldFinding(input.leadFields, BECAME_LEAD_HINTS).apiNames,
        ...fieldFinding(input.contactFields, BECAME_LEAD_HINTS).apiNames,
      ],
      becameMql: [
        ...fieldFinding(input.leadFields, BECAME_MQL_HINTS).apiNames,
        ...fieldFinding(input.contactFields, BECAME_MQL_HINTS).apiNames,
      ],
      campaignMemberDateFields: fieldFinding(input.campaignMemberFields, CM_DATE_HINTS).apiNames,
    },
    history: {
      lead: historyFinding(input.leadHistory),
      contact: historyFinding(input.contactHistory),
    },
    lifecycleValues: input.lifecycleValues.map((v) => ({ ...v })),
    distinctLifecycleValueCount: input.lifecycleValues.length,
    transitions: countTransitions(input.historyRows, input.historyConfig, input.identity),
    volume,
    unresolvedDecisions: [...input.unresolvedDecisions],
    pass,
    complete: pass === 'B' && incompleteReasons.length === 0,
    incompleteReasons,
  };
}

// ---------------------------------------------------------------------------
// Leakage guard
// ---------------------------------------------------------------------------

// Salesforce record ids are 15 or 18 characters on a known key prefix.
const SF_ID = /\b(001|003|00Q|00v|701|005|006)[A-Za-z0-9]{12}([A-Za-z0-9]{3})?\b/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// Throws when the summary carries anything that must never be shared.
// Called by the workflow guard before the summary leaves n8n, and asserted
// in tests. API names and picklist values are schema vocabulary and are
// deliberately allowed; record ids, emails, and free-text names are not.
export function assertNoIdentifierLeakage(summary: DiscoverySummary): void {
  const serialized = JSON.stringify(summary);
  if (SF_ID.test(serialized)) {
    throw new Error('discovery summary contains a Salesforce-record-id-shaped value');
  }
  if (EMAIL.test(serialized)) {
    throw new Error('discovery summary contains an email-shaped value');
  }
}
