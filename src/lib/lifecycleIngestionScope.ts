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

// Confirmed present as Date on BOTH Lead and Contact by the production
// FieldDefinition check. They are SUPPORTING EVIDENCE ONLY: they cannot
// create an event, change a baseline destination, replace
// SystemModstamp, or invent a historical transition. Contradictory dates
// are diagnostic evidence, never a correction.
export const CONFIRMED_BECAME_LEAD_DATE_FIELD = 'Became_a_Lead_Date__c';
export const CONFIRMED_BECAME_MQL_DATE_FIELD =
  'Became_a_Marketing_Qualified_Lead_Date__c';

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
  { apiName: CONFIRMED_BECAME_LEAD_DATE_FIELD, purpose: 'Became Lead date (supporting evidence)', required: false, confirmed: true },
  { apiName: CONFIRMED_BECAME_MQL_DATE_FIELD, purpose: 'Became MQL date (supporting evidence)', required: false, confirmed: true },
];

export const CONTACT_EXTRACTION_FIELDS: readonly ExtractionField[] = [
  { apiName: 'Id', purpose: 'exact source identity', required: true, confirmed: true },
  { apiName: CONFIRMED_LIFECYCLE_FIELD, purpose: 'lifecycle value', required: true, confirmed: true },
  { apiName: 'SystemModstamp', purpose: 'pagination key and staleness guard', required: true, confirmed: true },
  { apiName: 'LastModifiedDate', purpose: 'secondary change evidence', required: false, confirmed: true },
  { apiName: CONFIRMED_BECAME_LEAD_DATE_FIELD, purpose: 'Became Lead date (supporting evidence)', required: false, confirmed: true },
  { apiName: CONFIRMED_BECAME_MQL_DATE_FIELD, purpose: 'Became MQL date (supporting evidence)', required: false, confirmed: true },
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
// Paired anchors and Id-batched extraction
// ---------------------------------------------------------------------------

// ONE Sourced person, carrying BOTH exact Salesforce ids together. The
// pair relationship is the point: two unrelated id lists cannot express
// that a Lead and a Contact are the same person, and so cannot enforce
// Contact precedence or validate a conversion link.
export interface IdentityAnchorPair {
  sfdcLeadId: string | null;
  sfdcContactId: string | null;
}

export type AnchorShape = 'lead_only' | 'contact_only' | 'dual' | 'invalid';

export function classifyAnchor(a: IdentityAnchorPair): AnchorShape {
  const lead = a.sfdcLeadId !== null && isWellFormedSalesforceId(a.sfdcLeadId);
  const contact = a.sfdcContactId !== null && isWellFormedSalesforceId(a.sfdcContactId);
  if (lead && contact) return 'dual';
  if (lead) return 'lead_only';
  if (contact) return 'contact_only';
  return 'invalid';
}

export interface AnchorPlan {
  anchorsReceived: number;
  leadOnly: number;
  contactOnly: number;
  dual: number;
  invalid: number;
  // Deduplicated, validated ids to query, per source object.
  uniqueLeadIds: string[];
  uniqueContactIds: string[];
}

// Derives the exact query population from paired anchors. Ids are
// deduplicated and validated; a malformed id NEVER reaches a SOQL
// literal, which is what makes `Id IN (...)` construction safe.
export function planAnchorExtraction(anchors: readonly IdentityAnchorPair[]): AnchorPlan {
  const leadIds = new Set<string>();
  const contactIds = new Set<string>();
  let leadOnly = 0, contactOnly = 0, dual = 0, invalid = 0;

  for (const a of anchors) {
    switch (classifyAnchor(a)) {
      case 'dual':
        dual += 1;
        leadIds.add(a.sfdcLeadId as string);
        contactIds.add(a.sfdcContactId as string);
        break;
      case 'lead_only':
        leadOnly += 1;
        leadIds.add(a.sfdcLeadId as string);
        break;
      case 'contact_only':
        contactOnly += 1;
        contactIds.add(a.sfdcContactId as string);
        break;
      default:
        invalid += 1;
    }
  }

  return {
    anchorsReceived: anchors.length,
    leadOnly,
    contactOnly,
    dual,
    invalid,
    uniqueLeadIds: [...leadIds].sort(),
    uniqueContactIds: [...contactIds].sort(),
  };
}

// Salesforce `Id IN (...)` batches. Finite and bounded: with at most 200
// ids per batch there is no cursor, no epoch scan, and no unbounded loop.
export const ID_BATCH_SIZE = 200;

export function batchIds(ids: readonly string[], size: number = ID_BATCH_SIZE): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
  return batches;
}

// Builds a SOQL `Id IN ('a','b')` literal list. Every id is re-validated
// here even though callers validate too: this is the last line before a
// value becomes SQL text, so it refuses rather than trusting an earlier
// check. A malformed id throws instead of being escaped or dropped.
export function buildIdInLiteral(ids: readonly string[]): string {
  for (const id of ids) {
    if (!isWellFormedSalesforceId(id)) {
      throw new Error('Refusing to build a SOQL literal from a malformed Salesforce id.');
    }
  }
  return `Id IN (${ids.map((id) => `'${id}'`).join(',')})`;
}

// ---------------------------------------------------------------------------
// Dual-identity resolution (Contact precedence)
// ---------------------------------------------------------------------------

export type DualResolution =
  | { kind: 'use_contact'; contactId: string }
  | { kind: 'use_lead'; leadId: string }
  | { kind: 'review'; reason: DualReviewReason };

export type DualReviewReason =
  | 'lead_record_missing'
  | 'contact_record_missing'
  | 'conversion_link_mismatch'
  | 'conversion_link_absent'
  | 'no_valid_identity';

export interface FetchedLead {
  id: string;
  convertedContactId: string | null;
}

// Resolves ONE anchor to the single record that is the lifecycle
// authority for that person.
//
//   contact-only -> Contact.
//   lead-only    -> Lead.
//   dual         -> Contact IS the authority, but ONLY once the fetched
//                   Lead's ConvertedContactId exactly matches the paired
//                   Contact id. The Lead is then retained as conversion
//                   evidence, not as a second person.
//
// A missing record or a mismatched link becomes a review issue and
// changes nothing. Identity is never repaired automatically, and email
// and fuzzy matching do not exist here.
export function resolveDualIdentity(
  anchor: IdentityAnchorPair,
  fetchedLeads: ReadonlyMap<string, FetchedLead>,
  fetchedContactIds: ReadonlySet<string>,
): DualResolution {
  const shape = classifyAnchor(anchor);

  if (shape === 'invalid') return { kind: 'review', reason: 'no_valid_identity' };

  if (shape === 'contact_only') {
    const cid = anchor.sfdcContactId as string;
    return fetchedContactIds.has(cid)
      ? { kind: 'use_contact', contactId: cid }
      : { kind: 'review', reason: 'contact_record_missing' };
  }

  if (shape === 'lead_only') {
    const lid = anchor.sfdcLeadId as string;
    return fetchedLeads.has(lid)
      ? { kind: 'use_lead', leadId: lid }
      : { kind: 'review', reason: 'lead_record_missing' };
  }

  // Dual identity.
  const lid = anchor.sfdcLeadId as string;
  const cid = anchor.sfdcContactId as string;
  const lead = fetchedLeads.get(lid);
  if (lead === undefined) return { kind: 'review', reason: 'lead_record_missing' };
  if (!fetchedContactIds.has(cid)) return { kind: 'review', reason: 'contact_record_missing' };
  if (lead.convertedContactId === null) {
    return { kind: 'review', reason: 'conversion_link_absent' };
  }
  if (lead.convertedContactId !== cid) {
    // Salesforce says this Lead converted to a DIFFERENT Contact than
    // Sourced records. Never reconciled automatically.
    return { kind: 'review', reason: 'conversion_link_mismatch' };
  }
  return { kind: 'use_contact', contactId: cid };
}

export interface DualIdentitySummary {
  usedContact: number;
  usedLead: number;
  review: number;
  reviewByReason: Record<DualReviewReason, number>;
  // Exactly one observation per reconciled anchor: a dual-identity person
  // is ONE person, never two.
  observationsPlanned: number;
}

export function summarizeResolutions(
  resolutions: readonly DualResolution[],
): DualIdentitySummary {
  const reviewByReason: Record<DualReviewReason, number> = {
    lead_record_missing: 0,
    contact_record_missing: 0,
    conversion_link_mismatch: 0,
    conversion_link_absent: 0,
    no_valid_identity: 0,
  };
  let usedContact = 0, usedLead = 0, review = 0;
  for (const r of resolutions) {
    if (r.kind === 'use_contact') usedContact += 1;
    else if (r.kind === 'use_lead') usedLead += 1;
    else {
      review += 1;
      reviewByReason[r.reason] += 1;
    }
  }
  return {
    usedContact,
    usedLead,
    review,
    reviewByReason,
    observationsPlanned: usedContact + usedLead,
  };
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

// Correct TUPLE pagination boundary. The naive form
//   SystemModstamp > ts AND Id > id
// is NOT tuple pagination: it silently drops every later-timestamp
// record whose Id sorts below the previous page's Id. The correct
// boundary is the disjunction below. Ids are validated before becoming
// literals, and the timestamp is emitted as a SOQL datetime literal.
export function tupleCursorPredicate(cursor: PageCursor | null): string {
  if (cursor === null) return '';
  if (!isWellFormedSalesforceId(cursor.lastId)) {
    throw new Error('Refusing to build a cursor predicate from a malformed Salesforce id.');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(cursor.lastSystemModstamp)) {
    throw new Error('Refusing to build a cursor predicate from a malformed timestamp.');
  }
  const ts = cursor.lastSystemModstamp;
  const id = cursor.lastId;
  return `(SystemModstamp > ${ts} OR (SystemModstamp = ${ts} AND Id > '${id}'))`;
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
