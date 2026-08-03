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
  LifecycleValueMapping,
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

// A measured count, or an explicit statement that it was never measured.
// `null` here means UNKNOWN, never zero: reporting an unmeasured volume as 0
// would understate scope and could size the rebuild wrongly.
export type MeasuredCount = number | null;

export interface CampaignMemberVolume {
  // Rows the CURRENT nightly window (rolling CreatedDate, 2 days) returns.
  incrementalWindowRows: MeasuredCount;
  // Rows a FUTURE changed-or-created strategy would return
  // (LastModifiedDate/SystemModstamp based), when the field discovery makes
  // it determinable. null means the org did not expose what is needed.
  changedOrCreatedWindowRows: number | null;
  // Rows a full reconciliation returns.
  fullReconciliationRows: MeasuredCount;
  // Scope of each number above. The current queries are organization-wide;
  // labeling them otherwise would overstate what was measured.
  incrementalScope: VolumeScope;
  fullReconciliationScope: VolumeScope;
  // The ceiling the current production workflow assumes.
  currentRowLimit: number;
  // Rows whose parent is a Lead vs a Contact.
  leadMemberRows: MeasuredCount;
  contactMemberRows: MeasuredCount;
  // Converted leads whose ConvertedContactId is populated, and those where
  // it is missing (the linkage gap that would orphan a membership).
  convertedLeadsWithContactLink: MeasuredCount;
  convertedLeadsMissingContactLink: MeasuredCount;
  // Touch-identity completeness, in the Bite 4D vocabulary.
  missingCampaignMemberId: MeasuredCount;
  missingCampaignId: MeasuredCount;
  missingPersonIdentity: MeasuredCount;
  missingTouchDate: MeasuredCount;
  // Rows whose campaign cannot be mapped to a Sourced channel.
  missingCampaignChannelMapping: MeasuredCount;
}

// Where an observed lifecycle label was seen. Historical labels matter
// because Salesforce history can contain values the org no longer uses
// today, and an unmapped historical value would silently misclassify a
// transition.
export type ValueSeenIn = 'current' | 'history_old' | 'history_new' | 'history_both';

// One observed lifecycle label for ONE object. Labels are Salesforce
// picklist vocabulary (schema, not customer data) and are safe to share;
// record identifiers never accompany them.
export interface ObservedLifecycleValue {
  object: 'Lead' | 'Contact';
  value: string;
  count: number;
  seenIn: ValueSeenIn;
}

// The sanitized union GUARD B emits and the evaluator consumes. Both read
// the SAME inventory so the mapping the user is asked to build always
// matches the evidence they were shown.
export interface ObservedValueInventory {
  currentLead: ObservedLifecycleValue[];
  historicalLead: ObservedLifecycleValue[];
  currentContact: ObservedLifecycleValue[];
  historicalContact: ObservedLifecycleValue[];
  // Distinct labels across all four lists: exactly what STAGE_VALUE_MAP
  // must cover deliberately.
  distinctValuesRequiringMapping: string[];
  // True when a truncated history export means the historical inventory
  // for that object may be missing labels.
  leadHistoryInventoryPartial: boolean;
  contactHistoryInventoryPartial: boolean;
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

// Whether a paged history export may have been cut short. This is a TYPED
// signal, never inferred from prose: a full page strongly suggests more rows
// exist, and totals computed from a truncated export are partial.
export interface HistoryTruncation {
  leadPossiblyTruncated: boolean;
  contactPossiblyTruncated: boolean;
  // Converted Lead-to-Contact identity pagination, tracked SEPARATELY from
  // lifecycle history. The live 4G1 run returned exactly one full page of
  // 2,000 identity pairs against 12,986 known converted links: history was
  // untruncated (it was empty), so a shared flag reported nothing wrong.
  // Incomplete identity mapping invalidates person-level conclusions even
  // when history itself is complete.
  identityPossiblyTruncated?: boolean;
}

export interface DiscoveryInput {
  // Pass B only. Omit during Pass A, when field names are not yet known.
  lifecycleFieldConfig?: LifecycleFieldConfig;
  // Pass B only. Omitted means "no paged export was involved".
  historyTruncation?: HistoryTruncation;
  // Observed nonblank lifecycle values per object, for mapping validation.
  observedLeadLifecycleValues?: string[];
  observedContactLifecycleValues?: string[];
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
  // null when the underlying volume was never measured.
  estimatedIncrementalBatches: MeasuredCount;
  estimatedReconciliationBatches: MeasuredCount;
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
    // Full metadata for human review: API name, label, data type, and
    // history-tracking flag, plus the explicit unresolved list. No winner
    // is chosen here.
    detail: DateFieldCandidates;
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
  // Typed truncation state. When either object may be truncated the
  // transition totals are PARTIAL and must not be quoted as authoritative.
  truncation: HistoryTruncation & {
    transitionTotalsArePartial: boolean;
    // True when the identity map is incomplete: person-level conclusions
    // (distinct persons, cross-conversion chronology) cannot be trusted.
    personLevelConclusionsUnavailable: boolean;
  };
  // Metrics the run did NOT measure, by name. Distinct from a measured
  // zero: this list is how a reader knows a null is "never queried" rather
  // than "queried and found nothing".
  unmeasuredMetrics: string[];
  // True when neither object yields lifecycle-history rows, so no
  // transition can be reconstructed from this dataset at all.
  transitionDiscoveryAvailable: boolean;
  // Observed lifecycle values that the stage map does not deliberately
  // cover. Aggregate labels only; never record identifiers. A nonempty
  // list makes the run incomplete: an unmapped value cannot be classified,
  // and guessing it is forbidden.
  unmappedLifecycleValues: string[];
}

// ---------------------------------------------------------------------------
// Field classification helpers (name-based candidacy, never fuzzy mapping)
// ---------------------------------------------------------------------------

// Candidate detection is a NAME heuristic used only to surface fields for a
// human to confirm. It never maps a value to a lifecycle stage; that
// remains the explicit configuration the 4B adapter validates.
export const LIFECYCLE_HINTS = ['lifecycle', 'lifecyclestage'];
export const BECAME_LEAD_HINTS = ['becamelead', 'becomealead', 'leaddate', 'sourceddate'];
export const BECAME_MQL_HINTS = ['becamemql', 'mqldate', 'marketingqualified'];
export const CM_DATE_HINTS = [
  'firstassociat',
  'firstrespondeddate',
  'createddate',
  'lastmodifieddate',
  'systemmodstamp',
];

// The candidate sets Pass A surfaces for HUMAN review. Discovery only: no
// winner is selected, a single candidate is never treated as confirmed, and
// nothing here feeds a lifecycle calculation.
export interface DateFieldCandidates {
  becameLead: DiscoveredField[];
  becameMql: DiscoveredField[];
  campaignMemberDate: DiscoveredField[];
  // Every group with more than one candidate stays explicitly unresolved:
  // a human must choose. Groups with exactly one candidate are ALSO
  // unresolved, because one match is not confirmation.
  unresolved: string[];
}

// Shared matcher. The n8n mirror of this logic is verified against these
// exported hint lists by test, so the workflow and the module cannot drift.
export function findDateFieldCandidates(
  lead: ObjectFieldDiscovery,
  contact: ObjectFieldDiscovery,
  campaignMember: ObjectFieldDiscovery,
): DateFieldCandidates {
  const pick = (discovery: ObjectFieldDiscovery, hints: string[]): DiscoveredField[] =>
    discovery.fields.filter((f) => matches(f, hints));
  const becameLead = [...pick(lead, BECAME_LEAD_HINTS), ...pick(contact, BECAME_LEAD_HINTS)];
  const becameMql = [...pick(lead, BECAME_MQL_HINTS), ...pick(contact, BECAME_MQL_HINTS)];
  const campaignMemberDate = pick(campaignMember, CM_DATE_HINTS);
  const unresolved: string[] = [];
  const note = (label: string, list: DiscoveredField[]): void => {
    if (list.length === 0) unresolved.push(`${label}: no candidate found`);
    else unresolved.push(`${label}: ${list.length} candidate(s), human confirmation required`);
  };
  note('Became Lead date', becameLead);
  note('Became MQL date', becameMql);
  note('Member First Associated Date (CampaignMember)', campaignMemberDate);
  return { becameLead, becameMql, campaignMemberDate, unresolved };
}

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
// Approved lifecycle mapping (Bite 4G1 closeout, live evidence 2026-08-03)
// ---------------------------------------------------------------------------

// The exact deliberate mapping approved after the live discovery run, over
// the ten current lifecycle values observed in the org. Only lead, mql, and
// out_of_scope are legal: HPP and later stages are deal-side and tracked in
// attributions, never as lead lifecycle. Nothing here is fuzzy-matched, and
// any value NOT in this map must be routed to human review rather than
// guessed (see assertLifecycleValuesMapped).
export const APPROVED_LIFECYCLE_VALUE_MAP: Readonly<Record<string, LifecycleValueMapping>> = {
  Lead: 'lead',
  'Marketing Qualified Lead': 'mql',
  Customer: 'out_of_scope',
  Internal: 'out_of_scope',
  Opportunity: 'out_of_scope',
  Other: 'out_of_scope',
  Partner: 'out_of_scope',
  Prospect: 'out_of_scope',
  'Sales Qualified Lead': 'out_of_scope',
  Subscriber: 'out_of_scope',
};

// Values observed against the approved map that require review. A future
// org value (a new picklist entry) surfaces here rather than defaulting to
// any stage.
export function unmappedAgainstApprovedMap(observed: string[]): string[] {
  return [
    ...new Set(
      observed
        .map((v) => (v ?? '').trim())
        .filter((v) => v !== '' && !(v in APPROVED_LIFECYCLE_VALUE_MAP)),
    ),
  ].sort();
}

// ---------------------------------------------------------------------------
// Observed lifecycle value inventory (Bite 4G1 final correction)
// ---------------------------------------------------------------------------

export interface HistoryValueRow {
  parentObject: 'Lead' | 'Contact';
  oldValue: string | null;
  newValue: string | null;
}

export interface InventoryInput {
  // Current nonblank values per object, from the Pass B GROUP BY queries.
  currentLead: Array<{ value: string; count: number }>;
  currentContact: Array<{ value: string; count: number }>;
  // The lifecycle-filtered history rows already fetched in Pass B.
  historyRows: HistoryValueRow[];
  leadHistoryTruncated: boolean;
  contactHistoryTruncated: boolean;
}

// Aggregate historical labels per object, tracking whether each was seen as
// an old value, a new value, or both. Blank values are NOT labels: they are
// counted by the adapter as blank transitions and must never enter the
// mapping inventory.
function historicalValues(
  rows: HistoryValueRow[],
  object: 'Lead' | 'Contact',
): ObservedLifecycleValue[] {
  const seen = new Map<string, { count: number; asOld: boolean; asNew: boolean }>();
  const note = (raw: string | null, side: 'old' | 'new'): void => {
    const value = (raw ?? '').trim();
    if (value === '') return;
    const entry = seen.get(value) ?? { count: 0, asOld: false, asNew: false };
    entry.count += 1;
    if (side === 'old') entry.asOld = true;
    else entry.asNew = true;
    seen.set(value, entry);
  };
  for (const row of rows) {
    if (row.parentObject !== object) continue;
    note(row.oldValue, 'old');
    note(row.newValue, 'new');
  }
  return [...seen.entries()]
    .map(([value, e]) => ({
      object,
      value,
      count: e.count,
      seenIn: (e.asOld && e.asNew ? 'history_both' : e.asOld ? 'history_old' : 'history_new') as ValueSeenIn,
    }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

// Build the single sanitized inventory. Labels only; nothing here can carry
// a record identifier because only picklist values are read.
export function buildObservedValueInventory(input: InventoryInput): ObservedValueInventory {
  const current = (
    rows: Array<{ value: string; count: number }>,
    object: 'Lead' | 'Contact',
  ): ObservedLifecycleValue[] =>
    rows
      .map((r) => ({ object, value: (r.value ?? '').trim(), count: Number(r.count) || 0, seenIn: 'current' as ValueSeenIn }))
      .filter((r) => r.value !== '')
      .sort((a, b) => a.value.localeCompare(b.value));

  const currentLead = current(input.currentLead, 'Lead');
  const currentContact = current(input.currentContact, 'Contact');
  const historicalLead = historicalValues(input.historyRows, 'Lead');
  const historicalContact = historicalValues(input.historyRows, 'Contact');

  const distinct = [
    ...new Set(
      [...currentLead, ...currentContact, ...historicalLead, ...historicalContact].map((v) => v.value),
    ),
  ].sort();

  return {
    currentLead,
    currentContact,
    historicalLead,
    historicalContact,
    distinctValuesRequiringMapping: distinct,
    leadHistoryInventoryPartial: input.leadHistoryTruncated,
    contactHistoryInventoryPartial: input.contactHistoryTruncated,
  };
}

// ---------------------------------------------------------------------------
// Lead/Contact field normalization (Bite 4G1 hardening)
// ---------------------------------------------------------------------------

// The one internal field token the adapter sees after normalization. Lead and
// Contact may use DIFFERENT API names in the org; the adapter takes a single
// lifecycleFieldApiName, so both source fields are normalized to this token
// before ONE chronological run. Using the Lead name for Contact rows (or vice
// versa) would silently drop every row from the other object.
export const CANONICAL_LIFECYCLE_FIELD = '__sourced_canonical_lifecycle__';

export interface NormalizationInput {
  rows: SalesforceHistoryRow[];
  leadLifecycleField: string;
  contactLifecycleField: string;
}

export interface NormalizationResult {
  // Rows retained, with `field` rewritten to the canonical token and every
  // OTHER property (including the original values) preserved untouched.
  rows: SalesforceHistoryRow[];
  keptLeadRows: number;
  keptContactRows: number;
  // Rows dropped because their field is not the confirmed lifecycle field
  // for their own object (e.g. Status, Owner, or the OTHER object's
  // lifecycle field appearing on this object).
  ignoredOtherFieldRows: number;
}

// Keep only rows whose field matches the confirmed lifecycle field FOR THEIR
// OWN OBJECT, then rewrite that field to the canonical token so a single
// adapter run sees one coherent chronology per person. The original field
// name is not mutated in the caller's array, and exported evidence keeps the
// real value: normalization is an in-memory view for calculation only.
export function normalizeLifecycleHistoryRows(
  input: NormalizationInput,
): NormalizationResult {
  const lead = input.leadLifecycleField.trim();
  const contact = input.contactLifecycleField.trim();
  const rows: SalesforceHistoryRow[] = [];
  let keptLeadRows = 0;
  let keptContactRows = 0;
  let ignoredOtherFieldRows = 0;

  for (const row of input.rows) {
    const expected = row.parentObject === 'Lead' ? lead : contact;
    if (expected === '' || row.field !== expected) {
      ignoredOtherFieldRows += 1;
      continue;
    }
    if (row.parentObject === 'Lead') keptLeadRows += 1;
    else keptContactRows += 1;
    // Copy, never mutate: the caller's evidence keeps the original field.
    rows.push({ ...row, field: CANONICAL_LIFECYCLE_FIELD });
  }
  return { rows, keptLeadRows, keptContactRows, ignoredOtherFieldRows };
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
    // A successful query returning ZERO lifecycle-history rows is a valid
    // answer to "is history available", and a definitive NO to "can we
    // reconstruct transitions". The live 4G1 run hit exactly this: both
    // objects queryable, both zero rows, so no transition can be derived.
    // Current-value snapshots remain valid evidence, but they are a
    // photograph of today, never a record of movement.
    const noLeadHistory = input.leadHistory.outcome === 'succeeded_zero_rows';
    const noContactHistory = input.contactHistory.outcome === 'succeeded_zero_rows';
    if (noLeadHistory && noContactHistory) {
      incompleteReasons.push(
        'No lifecycle transition history is available: LeadHistory and ContactHistory both returned zero rows for the confirmed lifecycle field. Transition discovery is UNAVAILABLE; current-value counts are snapshot evidence only and must never be described as transitions.',
      );
    } else if (noLeadHistory) {
      incompleteReasons.push('No Lead lifecycle transition history is available (zero rows).');
    } else if (noContactHistory) {
      incompleteReasons.push('No Contact lifecycle transition history is available (zero rows).');
    }
  }

  // Unknown in, unknown out: an unmeasured volume can never be reported as
  // zero batches, which would read as "nothing to page".
  const batches = (rows: MeasuredCount, size: number): MeasuredCount =>
    rows === null ? null : size > 0 ? Math.ceil(rows / size) : 0;
  const exceeds = (value: MeasuredCount, limit: number): boolean =>
    value !== null && value > limit;

  const cm = input.campaignMembers;
  const volume: VolumeFinding = {
    ...cm,
    // The nightly query carries a hard LIMIT, so exceeding it means silent
    // truncation. The changed-or-created window, when known, is the same
    // risk for the future strategy and is folded in here.
    incrementalCanExceedRowLimit:
      exceeds(cm.incrementalWindowRows, cm.currentRowLimit) ||
      exceeds(cm.changedOrCreatedWindowRows, cm.currentRowLimit),
    // Reconciliation is expected to be large; the question is only whether
    // it must page, which it must whenever it exceeds one batch.
    reconciliationRequiresPagination:
      input.plannedBatchSize > 0 && exceeds(cm.fullReconciliationRows, input.plannedBatchSize),
    estimatedIncrementalBatches: batches(cm.incrementalWindowRows, input.plannedBatchSize),
    estimatedReconciliationBatches: batches(cm.fullReconciliationRows, input.plannedBatchSize),
    changedOrCreatedStrategyUndetermined: cm.changedOrCreatedWindowRows === null,
  };

  // ISSUE 6: every observed nonblank value must be deliberately mapped or
  // explicitly reported unknown. Never fuzzy-matched, and only lead / mql /
  // out_of_scope are legal targets (the adapter rejects anything else).
  const mapped = new Set(Object.keys(input.historyConfig.stageValueMap ?? {}));
  const observed = [
    ...(input.observedLeadLifecycleValues ?? []),
    ...(input.observedContactLifecycleValues ?? []),
  ];
  const unmappedLifecycleValues = [
    ...new Set(
      observed
        .map((v) => (v ?? '').trim())
        .filter((v) => v !== '' && !mapped.has(v)),
    ),
  ].sort();
  if (unmappedLifecycleValues.length > 0) {
    incompleteReasons.push(
      `${unmappedLifecycleValues.length} observed lifecycle value(s) are not mapped: ${unmappedLifecycleValues.join(', ')}. Map each to lead, mql, or out_of_scope; never guess.`,
    );
  }

  // ISSUE 4: truncation makes the run incomplete and the totals partial.
  const truncation = {
    leadPossiblyTruncated: input.historyTruncation?.leadPossiblyTruncated === true,
    contactPossiblyTruncated: input.historyTruncation?.contactPossiblyTruncated === true,
    identityPossiblyTruncated: input.historyTruncation?.identityPossiblyTruncated === true,
    transitionTotalsArePartial: false,
    personLevelConclusionsUnavailable: false,
  };
  truncation.transitionTotalsArePartial =
    truncation.leadPossiblyTruncated || truncation.contactPossiblyTruncated;
  truncation.personLevelConclusionsUnavailable = truncation.identityPossiblyTruncated;
  if (truncation.identityPossiblyTruncated) {
    incompleteReasons.push(
      'Converted-identity export may be truncated; person-level conclusions are NOT authoritative. Page further before trusting distinct-person counts or cross-conversion chronology.',
    );
  }
  if (truncation.leadPossiblyTruncated) {
    incompleteReasons.push('LeadHistory export may be truncated; transition totals are PARTIAL.');
  }
  if (truncation.contactPossiblyTruncated) {
    incompleteReasons.push('ContactHistory export may be truncated; transition totals are PARTIAL.');
  }

  // ISSUE 6: name every unmeasured metric explicitly. A null MeasuredCount
  // is honest, but silence about WHY would let a reader assume it was zero.
  const cmVolume = input.campaignMembers;
  const unmeasuredMetrics: string[] = [];
  const measuredCheck: Array<[string, MeasuredCount]> = [
    ['campaignMember.incrementalWindowRows', cmVolume.incrementalWindowRows],
    ['campaignMember.changedOrCreatedWindowRows', cmVolume.changedOrCreatedWindowRows],
    ['campaignMember.fullReconciliationRows', cmVolume.fullReconciliationRows],
    ['campaignMember.leadMemberRows', cmVolume.leadMemberRows],
    ['campaignMember.contactMemberRows', cmVolume.contactMemberRows],
    ['campaignMember.convertedLeadsWithContactLink', cmVolume.convertedLeadsWithContactLink],
    ['campaignMember.convertedLeadsMissingContactLink', cmVolume.convertedLeadsMissingContactLink],
    ['campaignMember.missingCampaignMemberId', cmVolume.missingCampaignMemberId],
    ['campaignMember.missingCampaignId', cmVolume.missingCampaignId],
    ['campaignMember.missingPersonIdentity', cmVolume.missingPersonIdentity],
    ['campaignMember.missingTouchDate', cmVolume.missingTouchDate],
    ['campaignMember.missingCampaignChannelMapping', cmVolume.missingCampaignChannelMapping],
  ];
  for (const [name, value] of measuredCheck) {
    if (value === null) unmeasuredMetrics.push(name);
  }

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
      detail: findDateFieldCandidates(
        input.leadFields,
        input.contactFields,
        input.campaignMemberFields,
      ),
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
    truncation,
    unmappedLifecycleValues,
    unmeasuredMetrics,
    transitionDiscoveryAvailable:
      input.leadHistory.outcome === 'succeeded_with_rows' ||
      input.contactHistory.outcome === 'succeeded_with_rows',
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
