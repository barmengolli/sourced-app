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

export type HistoryAccess =
  | { queryable: true; rowsSampled: number; oldest: string | null; newest: string | null }
  | { queryable: false; reason: 'permission_denied' | 'not_attempted' };

export interface CampaignMemberVolume {
  // Rows the CURRENT nightly window (rolling CreatedDate) would return.
  incrementalWindowRows: number;
  // Rows a full reconciliation over the in-scope campaigns would return.
  fullReconciliationRows: number;
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

export interface DiscoveryInput {
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
  queryable: boolean;
  deniedReason: 'permission_denied' | 'not_attempted' | null;
  rowsSampled: number;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
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
  // True when either scope exceeds the current workflow's assumption.
  exceedsCurrentRowLimit: boolean;
  estimatedIncrementalBatches: number;
  estimatedReconciliationBatches: number;
}

export interface DiscoverySummary {
  dry_run: true;
  writes_attempted: 0;
  lifecycleField: {
    lead: FieldFinding;
    contact: FieldFinding;
    // True when both objects expose a lifecycle field under the SAME api
    // name; false when they differ (which the current workflow's code
    // assumes away).
    apiNamesMatch: boolean;
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

function historyFinding(access: HistoryAccess): HistoryFinding {
  if (!access.queryable) {
    return {
      queryable: false,
      deniedReason: access.reason,
      rowsSampled: 0,
      oldestTimestamp: null,
      newestTimestamp: null,
    };
  }
  return {
    queryable: true,
    deniedReason: null,
    rowsSampled: access.rowsSampled,
    oldestTimestamp: access.oldest,
    newestTimestamp: access.newest,
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

  const batches = (rows: number, size: number): number =>
    size > 0 ? Math.ceil(rows / size) : 0;

  const volume: VolumeFinding = {
    ...input.campaignMembers,
    exceedsCurrentRowLimit:
      input.campaignMembers.incrementalWindowRows > input.campaignMembers.currentRowLimit ||
      input.campaignMembers.fullReconciliationRows > input.campaignMembers.currentRowLimit,
    estimatedIncrementalBatches: batches(
      input.campaignMembers.incrementalWindowRows,
      input.plannedBatchSize,
    ),
    estimatedReconciliationBatches: batches(
      input.campaignMembers.fullReconciliationRows,
      input.plannedBatchSize,
    ),
  };

  return {
    dry_run: true,
    writes_attempted: 0,
    lifecycleField: {
      lead,
      contact,
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
