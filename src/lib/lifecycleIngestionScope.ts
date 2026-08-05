// lifecycleIngestionScope.ts: Bite 4G2B2A pure scope and extraction helpers
// (docs/lead-lifecycle-ingestion-dry-run.md).
//
// Answers ONE question: which Salesforce records is the lifecycle ledger
// legitimately allowed to observe? Pure: no Supabase, no Salesforce, no
// network, no clock. Attempts zero writes and reports so.
//
// THE SCOPE RULE, and why it is not "every Lead and Contact".
//
// Bite 4G1's live run measured 103,070 CampaignMember rows and 12,986
// converted Lead-to-Contact links ORGANIZATION-WIDE. Those are discovery
// measurements, not an approved ingestion population. Observing all of
// them would import tens of thousands of people Sourced has never tracked,
// inventing a population rather than mirroring one.
//
// Sourced anchors a person by EXACT Salesforce identity in two nullable
// columns on `leads`: sfdc_lead_id and sfdc_contact_id. Both the CSV
// importer (src/lib/csv.ts) and the typed sync path (src/lib/leadSync.ts)
// populate them, and leadSync only fills a blank id, never overwrites one.
// That is the anchor this module uses, and the only one it will use.
//
// Matching is by exact Salesforce Id string, per source object. Never by
// name, email, company, or similarity of any kind: those are the fuzzy
// paths the whole program has refused since Bite 4G2A.

import type { SourceObject } from './lifecycleObservationPlanner';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

// One Sourced person's Salesforce identity anchors. Deliberately carries
// NO name, email, company, or campaign: this module cannot leak what it
// never receives.
export interface SourcedIdentityAnchor {
  // Sourced's internal lead row id (a UUID), used only to count people.
  sourcedLeadId: string;
  sfdcLeadId: string | null;
  sfdcContactId: string | null;
}

// One candidate the existing production sync path would admit. The
// production workflow retains ContactId and LeadId on each CampaignMember
// row (verified by reading the export), so a candidate carries the same
// two exact anchors and nothing else.
export interface WorkflowCandidate {
  sfdcLeadId: string | null;
  sfdcContactId: string | null;
}

// A confirmed Lead-to-Contact conversion, from Salesforce's own
// ConvertedContactId. The ONLY automatic cross-object identity rule.
export interface ConvertedPair {
  leadId: string;
  convertedContactId: string;
}

export interface ScopeInput {
  sourcedAnchors: SourcedIdentityAnchor[];
  workflowCandidates: WorkflowCandidate[];
  convertedPairs: ConvertedPair[];
  // Organization-wide totals measured by 4G1. Carried ONLY so the summary
  // can state how much of the org is deliberately excluded; never used to
  // widen scope.
  orgWideLeadRecords: number | null;
  orgWideContactRecords: number | null;
}

// ---------------------------------------------------------------------------
// Populations (kept separate: never summed into one "in scope" number)
// ---------------------------------------------------------------------------

export interface ScopePopulations {
  // 1. Existing Sourced people with an exact Salesforce Lead identity.
  existingWithLeadIdentity: number;
  // 2. Existing Sourced people with an exact Salesforce Contact identity.
  existingWithContactIdentity: number;
  // 3. Existing Sourced people whose Lead and Contact identities are
  //    connected by a CONFIRMED ConvertedContactId pair.
  existingWithConfirmedConvertedPair: number;
  // 4. Current production-workflow candidates that would be admitted.
  workflowCandidates: number;
  // 5. Candidates already represented in Sourced.
  candidatesAlreadyRepresented: number;
  // 6. New candidates not yet represented.
  candidatesNew: number;
  // 7. Organization-wide records belonging to none of the above. Null when
  //    the org-wide totals were never measured (unknown is not zero).
  orgWideOutOfScope: number | null;
  // 8. Missing, malformed, conflicting, or ambiguous identities.
  anchorsWithNoIdentity: number;
  malformedIdentities: number;
  conflictingIdentities: number;
}

export type ScopeIssueKind =
  | 'anchor_without_identity'
  | 'malformed_salesforce_id'
  | 'identity_claimed_by_two_people'
  | 'converted_pair_spans_two_people';

export interface ScopeIssue {
  kind: ScopeIssueKind;
  // Aggregate only: how many, never which.
  count: number;
}

export interface ScopeResult {
  populations: ScopePopulations;
  issues: ScopeIssue[];
  // The exact set of source records the first run may observe, expressed
  // as counts per object. Never a list of ids in shared output.
  proposedObservationTargets: { Lead: number; Contact: number };
  dry_run: true;
  writes_attempted: 0;
}

// ---------------------------------------------------------------------------
// Salesforce Id validation
// ---------------------------------------------------------------------------

// Salesforce Ids are 15 or 18 characters of [A-Za-z0-9]. Anything else is
// malformed and is REPORTED, never coerced, trimmed into shape, or
// guessed at.
const SFDC_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

export function isWellFormedSalesforceId(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return SFDC_ID.test(value);
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

export function resolveIngestionScope(input: ScopeInput): ScopeResult {
  const issueCounts = new Map<ScopeIssueKind, number>();
  const bump = (k: ScopeIssueKind) => issueCounts.set(k, (issueCounts.get(k) ?? 0) + 1);

  // Exact identity indexes, kept SEPARATE per source object so a Lead id
  // and a Contact id that happen to share a string can never collide.
  const leadIdToPerson = new Map<string, string>();
  const contactIdToPerson = new Map<string, string>();

  let existingWithLeadIdentity = 0;
  let existingWithContactIdentity = 0;
  let anchorsWithNoIdentity = 0;
  let malformedIdentities = 0;

  for (const a of input.sourcedAnchors) {
    let hasAny = false;

    if (a.sfdcLeadId !== null) {
      if (!isWellFormedSalesforceId(a.sfdcLeadId)) {
        malformedIdentities += 1;
        bump('malformed_salesforce_id');
      } else {
        hasAny = true;
        existingWithLeadIdentity += 1;
        const claimed = leadIdToPerson.get(a.sfdcLeadId);
        if (claimed !== undefined && claimed !== a.sourcedLeadId) {
          // Two Sourced people claim one Salesforce Lead id. That is a
          // real data conflict; a human resolves it, nothing is merged.
          bump('identity_claimed_by_two_people');
        } else {
          leadIdToPerson.set(a.sfdcLeadId, a.sourcedLeadId);
        }
      }
    }

    if (a.sfdcContactId !== null) {
      if (!isWellFormedSalesforceId(a.sfdcContactId)) {
        malformedIdentities += 1;
        bump('malformed_salesforce_id');
      } else {
        hasAny = true;
        existingWithContactIdentity += 1;
        const claimed = contactIdToPerson.get(a.sfdcContactId);
        if (claimed !== undefined && claimed !== a.sourcedLeadId) {
          bump('identity_claimed_by_two_people');
        } else {
          contactIdToPerson.set(a.sfdcContactId, a.sourcedLeadId);
        }
      }
    }

    if (!hasAny) {
      // A Sourced person with no exact Salesforce identity CANNOT be
      // observed. Email is Sourced's unique key, but email matching is
      // exactly the fuzzy path this program refuses.
      anchorsWithNoIdentity += 1;
      bump('anchor_without_identity');
    }
  }

  // Confirmed converted pairs, counted only where BOTH sides are already
  // anchored to the SAME Sourced person.
  let existingWithConfirmedConvertedPair = 0;
  for (const pair of input.convertedPairs) {
    if (!isWellFormedSalesforceId(pair.leadId) || !isWellFormedSalesforceId(pair.convertedContactId)) {
      bump('malformed_salesforce_id');
      continue;
    }
    const leadPerson = leadIdToPerson.get(pair.leadId);
    const contactPerson = contactIdToPerson.get(pair.convertedContactId);
    if (leadPerson === undefined || contactPerson === undefined) continue;
    if (leadPerson !== contactPerson) {
      // Salesforce says one person; Sourced has two. Never merged here.
      bump('converted_pair_spans_two_people');
      continue;
    }
    existingWithConfirmedConvertedPair += 1;
  }

  // Workflow candidates: already represented, or new.
  let candidatesAlreadyRepresented = 0;
  let candidatesNew = 0;
  for (const c of input.workflowCandidates) {
    const leadKnown = c.sfdcLeadId !== null && leadIdToPerson.has(c.sfdcLeadId);
    const contactKnown = c.sfdcContactId !== null && contactIdToPerson.has(c.sfdcContactId);
    if (leadKnown || contactKnown) candidatesAlreadyRepresented += 1;
    else candidatesNew += 1;
  }

  // Organization-wide remainder. Unknown stays unknown: a null measurement
  // is never reported as zero.
  const orgWideTotal =
    input.orgWideLeadRecords === null || input.orgWideContactRecords === null
      ? null
      : input.orgWideLeadRecords + input.orgWideContactRecords;
  const orgWideOutOfScope =
    orgWideTotal === null
      ? null
      : Math.max(0, orgWideTotal - (leadIdToPerson.size + contactIdToPerson.size));

  const issues: ScopeIssue[] = [...issueCounts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => a.kind.localeCompare(b.kind));

  return {
    populations: {
      existingWithLeadIdentity,
      existingWithContactIdentity,
      existingWithConfirmedConvertedPair,
      workflowCandidates: input.workflowCandidates.length,
      candidatesAlreadyRepresented,
      candidatesNew,
      orgWideOutOfScope,
      anchorsWithNoIdentity,
      malformedIdentities,
      conflictingIdentities:
        (issueCounts.get('identity_claimed_by_two_people') ?? 0) +
        (issueCounts.get('converted_pair_spans_two_people') ?? 0),
    },
    issues,
    // The observable population is exactly the anchored identities. It is
    // NOT the org-wide total and NOT the candidate list.
    proposedObservationTargets: {
      Lead: leadIdToPerson.size,
      Contact: contactIdToPerson.size,
    },
    dry_run: true,
    writes_attempted: 0,
  };
}

// ---------------------------------------------------------------------------
// Extraction contract
// ---------------------------------------------------------------------------

// Confirmed by the Bite 4G1 live run. Same API name on both objects.
export const CONFIRMED_LIFECYCLE_FIELD = 'Hubspot_lead_lifecycle__c';

// API names that are NOT confirmed. 4G1 surfaced candidates for the
// Became Lead / Became MQL dates and deliberately left them unresolved
// pending human confirmation. A placeholder must FAIL the dry run rather
// than be guessed: a wrong date field silently corroborates the wrong
// thing.
export const UNRESOLVED_FIELD_PLACEHOLDER = 'UNRESOLVED';

export interface ExtractionField {
  apiName: string;
  purpose: string;
  required: boolean;
  confirmed: boolean;
}

export const LEAD_EXTRACTION_FIELDS: readonly ExtractionField[] = [
  { apiName: 'Id', purpose: 'exact source identity', required: true, confirmed: true },
  { apiName: CONFIRMED_LIFECYCLE_FIELD, purpose: 'lifecycle value', required: true, confirmed: true },
  { apiName: 'SystemModstamp', purpose: 'pagination key and staleness guard', required: true, confirmed: true },
  { apiName: 'LastModifiedDate', purpose: 'secondary change evidence', required: false, confirmed: true },
  { apiName: 'IsConverted', purpose: 'conversion state', required: true, confirmed: true },
  { apiName: 'ConvertedContactId', purpose: 'exact cross-object identity', required: true, confirmed: true },
  { apiName: UNRESOLVED_FIELD_PLACEHOLDER, purpose: 'Became Lead date (supporting evidence)', required: false, confirmed: false },
  { apiName: UNRESOLVED_FIELD_PLACEHOLDER, purpose: 'Became MQL date (supporting evidence)', required: false, confirmed: false },
];

export const CONTACT_EXTRACTION_FIELDS: readonly ExtractionField[] = [
  { apiName: 'Id', purpose: 'exact source identity', required: true, confirmed: true },
  { apiName: CONFIRMED_LIFECYCLE_FIELD, purpose: 'lifecycle value', required: true, confirmed: true },
  { apiName: 'SystemModstamp', purpose: 'pagination key and staleness guard', required: true, confirmed: true },
  { apiName: 'LastModifiedDate', purpose: 'secondary change evidence', required: false, confirmed: true },
  { apiName: UNRESOLVED_FIELD_PLACEHOLDER, purpose: 'Became Lead date (supporting evidence)', required: false, confirmed: false },
  { apiName: UNRESOLVED_FIELD_PLACEHOLDER, purpose: 'Became MQL date (supporting evidence)', required: false, confirmed: false },
];

// Any REQUIRED field left unresolved blocks the run. Optional unresolved
// fields are reported so the omission is visible rather than silent.
export function unresolvedRequiredFields(
  fields: readonly ExtractionField[],
): ExtractionField[] {
  return fields.filter((f) => f.required && (!f.confirmed || f.apiName === UNRESOLVED_FIELD_PLACEHOLDER));
}

export function unresolvedOptionalFields(
  fields: readonly ExtractionField[],
): ExtractionField[] {
  return fields.filter((f) => !f.required && (!f.confirmed || f.apiName === UNRESOLVED_FIELD_PLACEHOLDER));
}

// ---------------------------------------------------------------------------
// Deterministic pagination
// ---------------------------------------------------------------------------

// A page cursor ordered by (SystemModstamp, Id). Ordering by timestamp
// alone is unsafe: records sharing one SystemModstamp straddle a page
// boundary and are silently skipped or repeated. The Id tie-break makes
// the ordering total.
export interface PageCursor {
  lastSystemModstamp: string;
  lastId: string;
}

export interface ExtractedPageRow {
  sourceObject: SourceObject;
  id: string;
  systemModstamp: string;
}

export interface PaginationState {
  pagesCompleted: number;
  pagesExpected: number;
  failed: boolean;
  cursor: PageCursor | null;
  seenIds: Set<string>;
  duplicateIds: number;
  outOfOrderRows: number;
}

export function newPaginationState(pagesExpected: number): PaginationState {
  return {
    pagesCompleted: 0,
    pagesExpected,
    failed: false,
    cursor: null,
    seenIds: new Set<string>(),
    duplicateIds: 0,
    outOfOrderRows: 0,
  };
}

// Compare on the composite key. Returns <0, 0, or >0.
export function compareCursor(
  a: { systemModstamp: string; id: string },
  b: { systemModstamp: string; id: string },
): number {
  if (a.systemModstamp !== b.systemModstamp) {
    return a.systemModstamp < b.systemModstamp ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

// Accept one page, enforcing strict composite ordering and detecting any
// id seen twice ACROSS pages. A duplicate means the pagination key is
// wrong, which is a hard failure rather than something to deduplicate.
export function acceptPage(
  state: PaginationState,
  rows: readonly ExtractedPageRow[],
): PaginationState {
  let { duplicateIds, outOfOrderRows } = state;
  let cursor = state.cursor;
  const seenIds = new Set(state.seenIds);

  for (const row of rows) {
    if (seenIds.has(row.id)) {
      duplicateIds += 1;
      continue;
    }
    seenIds.add(row.id);
    const here = { systemModstamp: row.systemModstamp, id: row.id };
    if (cursor !== null) {
      const prior = { systemModstamp: cursor.lastSystemModstamp, id: cursor.lastId };
      if (compareCursor(here, prior) <= 0) outOfOrderRows += 1;
    }
    cursor = { lastSystemModstamp: row.systemModstamp, lastId: row.id };
  }

  return {
    ...state,
    pagesCompleted: state.pagesCompleted + 1,
    cursor,
    seenIds,
    duplicateIds,
    outOfOrderRows,
  };
}

export function paginationComplete(state: PaginationState): boolean {
  return (
    !state.failed &&
    state.pagesExpected > 0 &&
    state.pagesCompleted === state.pagesExpected &&
    state.duplicateIds === 0 &&
    state.outOfOrderRows === 0
  );
}

// The watermark a completed run would propose: the highest SystemModstamp
// actually observed. Null when the run is incomplete, because an
// incomplete run must never advance a watermark.
export function proposedWatermark(
  lifecycle: PaginationState,
  identity: PaginationState,
): string | null {
  if (!paginationComplete(lifecycle) || !paginationComplete(identity)) return null;
  return lifecycle.cursor?.lastSystemModstamp ?? null;
}
