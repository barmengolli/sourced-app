// Bite 4G2B2A: scope, extraction, pagination, and dry-run workflow safety.
// Synthetic identifiers only: no real Salesforce ids, names, or emails.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveIngestionScope,
  isWellFormedSalesforceId,
  newPaginationState,
  acceptPage,
  paginationComplete,
  proposedWatermark,
  compareCursor,
  unresolvedRequiredFields,
  unresolvedOptionalFields,
  LEAD_EXTRACTION_FIELDS,
  CONTACT_EXTRACTION_FIELDS,
  CONFIRMED_LIFECYCLE_FIELD,
  planAnchorExtraction,
  batchIds,
  buildIdInLiteral,
  tupleCursorPredicate,
  resolveDualIdentity,
  summarizeResolutions,
  idLookupKeys,
  buildIdIndex,
  lookupById,
  sameSalesforceId,
  IdCollisionError,
} from './lifecycleIngestionScope';
import type { ScopeInput, SourcedIdentityAnchor, FetchedLead } from './lifecycleIngestionScope';
import { planLifecycleObservations } from './lifecycleObservationPlanner';
import type { ExtractedLifecycleRow, PriorState } from './lifecycleObservationPlanner';

// ---------------------------------------------------------------------------
// Local-only artifacts
// ---------------------------------------------------------------------------
// The production workflow export and the authoritative evaluator live
// OUTSIDE the repository by design: the export carries an RPC endpoint
// and credential references, and the evaluator is pointed at files
// containing real Salesforce records. Neither may ever be committed.
//
// Tests that inspect them are therefore environment-dependent. They run
// at full strength wherever the artifacts exist and SKIP where they do
// not, which is the honest outcome for CI: a green run that never
// claims to have verified a file it could not see. `npm run verify`
// stays network-free and artifact-free.
function readLocalArtifact(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
const LOCAL_PROD_WORKFLOW =
  `${process.env.HOME ?? ''}/Downloads/[Sourced] - SFDC Leads Automated Sync.json`;
const LOCAL_EVALUATOR =
  `${process.env.HOME ?? ''}/Downloads/4g2b2a-local-evaluator.mjs`;
const prodWorkflowSrc = readLocalArtifact(LOCAL_PROD_WORKFLOW);
const evaluatorSrc = readLocalArtifact(LOCAL_EVALUATOR);
// describe.skipIf keeps the intent visible in the report rather than
// silently passing an assertion against an empty string.
const describeWithProdWorkflow = prodWorkflowSrc === null ? describe.skip : describe;
const describeWithEvaluator = evaluatorSrc === null ? describe.skip : describe;

// --- synthetic fixtures ----------------------------------------------------
// Salesforce ids are 15 or 18 chars of [A-Za-z0-9]. These are well-formed
// in SHAPE but deliberately carry no real prefix or org data.
const L1 = 'SYNTHLEAD00001A';
const L2 = 'SYNTHLEAD00002A';
const C1 = 'SYNTHCONT00001A';
const C2 = 'SYNTHCONT00002A';

function anchor(over: Partial<SourcedIdentityAnchor> = {}): SourcedIdentityAnchor {
  return { sourcedLeadId: 'sourced-1', sfdcLeadId: L1, sfdcContactId: null, ...over };
}

function scopeInput(over: Partial<ScopeInput> = {}): ScopeInput {
  return {
    sourcedAnchors: [],
    workflowCandidates: [],
    convertedPairs: [],
    orgWideLeadRecords: null,
    orgWideContactRecords: null,
    ...over,
  };
}

// --- population classification ---------------------------------------------

describe('scope: population classification', () => {
  it('counts an existing Sourced person with an exact Lead identity', () => {
    const r = resolveIngestionScope(scopeInput({ sourcedAnchors: [anchor()] }));
    expect(r.populations.existingWithLeadIdentity).toBe(1);
    expect(r.populations.existingWithContactIdentity).toBe(0);
    expect(r.proposedObservationTargets.Lead).toBe(1);
  });

  it('counts an existing Sourced person with an exact Contact identity', () => {
    const r = resolveIngestionScope(
      scopeInput({ sourcedAnchors: [anchor({ sfdcLeadId: null, sfdcContactId: C1 })] }),
    );
    expect(r.populations.existingWithContactIdentity).toBe(1);
    expect(r.proposedObservationTargets.Contact).toBe(1);
  });

  it('counts a confirmed converted pair only when both sides are one person', () => {
    const r = resolveIngestionScope(
      scopeInput({
        sourcedAnchors: [anchor({ sfdcLeadId: L1, sfdcContactId: C1 })],
        convertedPairs: [{ leadId: L1, convertedContactId: C1 }],
      }),
    );
    expect(r.populations.existingWithConfirmedConvertedPair).toBe(1);
    expect(r.populations.conflictingIdentities).toBe(0);
  });

  it('refuses to merge when a converted pair spans two Sourced people', () => {
    const r = resolveIngestionScope(
      scopeInput({
        sourcedAnchors: [
          anchor({ sourcedLeadId: 'sourced-1', sfdcLeadId: L1, sfdcContactId: null }),
          anchor({ sourcedLeadId: 'sourced-2', sfdcLeadId: null, sfdcContactId: C1 }),
        ],
        convertedPairs: [{ leadId: L1, convertedContactId: C1 }],
      }),
    );
    expect(r.populations.existingWithConfirmedConvertedPair).toBe(0);
    expect(r.issues.some((i) => i.kind === 'converted_pair_spans_two_people')).toBe(true);
    expect(r.populations.conflictingIdentities).toBe(1);
  });

  it('flags a Sourced person with no exact Salesforce identity', () => {
    const r = resolveIngestionScope(
      scopeInput({ sourcedAnchors: [anchor({ sfdcLeadId: null, sfdcContactId: null })] }),
    );
    expect(r.populations.anchorsWithNoIdentity).toBe(1);
    // They cannot be observed: no fuzzy fallback to email exists.
    expect(r.proposedObservationTargets.Lead).toBe(0);
    expect(r.proposedObservationTargets.Contact).toBe(0);
  });

  it('flags a malformed Salesforce id rather than coercing it', () => {
    const r = resolveIngestionScope(
      scopeInput({ sourcedAnchors: [anchor({ sfdcLeadId: 'nope' })] }),
    );
    expect(r.populations.malformedIdentities).toBe(1);
    expect(r.proposedObservationTargets.Lead).toBe(0);
  });

  it('flags one Salesforce identity claimed by two Sourced people', () => {
    const r = resolveIngestionScope(
      scopeInput({
        sourcedAnchors: [
          anchor({ sourcedLeadId: 'sourced-1', sfdcLeadId: L1 }),
          anchor({ sourcedLeadId: 'sourced-2', sfdcLeadId: L1 }),
        ],
      }),
    );
    expect(r.issues.some((i) => i.kind === 'identity_claimed_by_two_people')).toBe(true);
  });

  it('separates candidates already represented from new ones', () => {
    const r = resolveIngestionScope(
      scopeInput({
        sourcedAnchors: [anchor({ sfdcLeadId: L1 })],
        workflowCandidates: [
          { sfdcLeadId: L1, sfdcContactId: null },
          { sfdcLeadId: L2, sfdcContactId: null },
        ],
      }),
    );
    expect(r.populations.workflowCandidates).toBe(2);
    expect(r.populations.candidatesAlreadyRepresented).toBe(1);
    expect(r.populations.candidatesNew).toBe(1);
  });

  it('never lets a Lead id and a Contact id collide across objects', () => {
    // Same STRING used as both a Lead id and a Contact id, on two people.
    const shared = 'SYNTHSHARED0001';
    const r = resolveIngestionScope(
      scopeInput({
        sourcedAnchors: [
          anchor({ sourcedLeadId: 'sourced-1', sfdcLeadId: shared, sfdcContactId: null }),
          anchor({ sourcedLeadId: 'sourced-2', sfdcLeadId: null, sfdcContactId: shared }),
        ],
      }),
    );
    // Two DISTINCT observation targets, and no conflict raised: the
    // indexes are per source object.
    expect(r.proposedObservationTargets.Lead).toBe(1);
    expect(r.proposedObservationTargets.Contact).toBe(1);
    expect(r.issues.some((i) => i.kind === 'identity_claimed_by_two_people')).toBe(false);
  });

  it('excludes organization-wide records from the proposed scope', () => {
    const r = resolveIngestionScope(
      scopeInput({
        sourcedAnchors: [anchor({ sfdcLeadId: L1 })],
        orgWideLeadRecords: 50_000,
        orgWideContactRecords: 53_070,
      }),
    );
    // One anchored identity; the rest of the org is explicitly excluded.
    expect(r.proposedObservationTargets.Lead).toBe(1);
    expect(r.populations.orgWideOutOfScope).toBe(103_069);
  });

  it('reports unmeasured org-wide totals as null, never zero', () => {
    const r = resolveIngestionScope(scopeInput({ sourcedAnchors: [anchor()] }));
    expect(r.populations.orgWideOutOfScope).toBeNull();
  });

  it('reports dry_run and attempts no writes', () => {
    const r = resolveIngestionScope(scopeInput({ sourcedAnchors: [anchor()] }));
    expect(r.dry_run).toBe(true);
    expect(r.writes_attempted).toBe(0);
  });

  it('leaks no identifiers in aggregate output', () => {
    const r = resolveIngestionScope(
      scopeInput({
        sourcedAnchors: [anchor({ sfdcLeadId: L1, sfdcContactId: C1 })],
        workflowCandidates: [{ sfdcLeadId: L2, sfdcContactId: C2 }],
      }),
    );
    const s = JSON.stringify(r);
    for (const id of [L1, L2, C1, C2, 'sourced-1']) {
      expect(s, `${id} leaked`).not.toContain(id);
    }
    expect(s).not.toMatch(/@/);
  });
});

describe('scope: Salesforce id validation', () => {
  it('accepts 15 and 18 character ids, rejects everything else', () => {
    expect(isWellFormedSalesforceId('SYNTHLEAD00001A')).toBe(true);
    expect(isWellFormedSalesforceId('SYNTHLEAD00001AAA')).toBe(false); // 17
    expect(isWellFormedSalesforceId('SYNTHLEAD00001ABCD')).toBe(true); // 18
    expect(isWellFormedSalesforceId('short')).toBe(false);
    expect(isWellFormedSalesforceId('has-a-dash-here')).toBe(false);
    expect(isWellFormedSalesforceId(null)).toBe(false);
    expect(isWellFormedSalesforceId(undefined)).toBe(false);
  });
});

// --- extraction contract ---------------------------------------------------

describe('extraction contract', () => {
  it('uses the 4G1-confirmed lifecycle field on both objects', () => {
    expect(CONFIRMED_LIFECYCLE_FIELD).toBe('Hubspot_lead_lifecycle__c');
    expect(LEAD_EXTRACTION_FIELDS.some((f) => f.apiName === CONFIRMED_LIFECYCLE_FIELD)).toBe(true);
    expect(CONTACT_EXTRACTION_FIELDS.some((f) => f.apiName === CONFIRMED_LIFECYCLE_FIELD)).toBe(true);
  });

  it('has no unresolved REQUIRED field on either object', () => {
    expect(unresolvedRequiredFields(LEAD_EXTRACTION_FIELDS)).toEqual([]);
    expect(unresolvedRequiredFields(CONTACT_EXTRACTION_FIELDS)).toEqual([]);
  });

  it('treats both Became dates as CONFIRMED supporting evidence', () => {
    // Confirmed as Date on both objects by the production FieldDefinition
    // check. Nothing is unresolved now.
    expect(unresolvedOptionalFields(LEAD_EXTRACTION_FIELDS)).toEqual([]);
    expect(unresolvedOptionalFields(CONTACT_EXTRACTION_FIELDS)).toEqual([]);
    for (const fields of [LEAD_EXTRACTION_FIELDS, CONTACT_EXTRACTION_FIELDS]) {
      expect(fields.some((f) => f.apiName === 'Became_a_Lead_Date__c' && f.confirmed)).toBe(true);
      expect(fields.some(
        (f) => f.apiName === 'Became_a_Marketing_Qualified_Lead_Date__c' && f.confirmed,
      )).toBe(true);
      // Supporting evidence: never required, so absence can never block.
      for (const f of fields) {
        if (/Became/.test(f.apiName)) expect(f.required).toBe(false);
      }
    }
  });

  it('requires the conversion link only on Lead', () => {
    expect(LEAD_EXTRACTION_FIELDS.some((f) => f.apiName === 'ConvertedContactId')).toBe(true);
    expect(CONTACT_EXTRACTION_FIELDS.some((f) => f.apiName === 'ConvertedContactId')).toBe(false);
  });
});

// --- pagination ------------------------------------------------------------

describe('pagination', () => {
  const row = (id: string, ts: string) =>
    ({ sourceObject: 'Lead' as const, id, systemModstamp: ts });

  it('orders by SystemModstamp then Id', () => {
    expect(compareCursor({ systemModstamp: 'T1', id: 'A' }, { systemModstamp: 'T2', id: 'A' })).toBeLessThan(0);
    // Shared timestamp: the Id breaks the tie.
    expect(compareCursor({ systemModstamp: 'T1', id: 'A' }, { systemModstamp: 'T1', id: 'B' })).toBeLessThan(0);
    expect(compareCursor({ systemModstamp: 'T1', id: 'A' }, { systemModstamp: 'T1', id: 'A' })).toBe(0);
  });

  it('paginates stably across a page boundary with a SHARED timestamp', () => {
    // The exact case timestamp-only ordering gets wrong.
    let s = newPaginationState(2);
    s = acceptPage(s, [row('A', 'T1'), row('B', 'T1')]);
    s = acceptPage(s, [row('C', 'T1'), row('D', 'T2')]);
    expect(s.duplicateIds).toBe(0);
    expect(s.outOfOrderRows).toBe(0);
    expect(paginationComplete(s)).toBe(true);
  });

  it('treats a duplicate id across pages as a hard failure', () => {
    let s = newPaginationState(2);
    s = acceptPage(s, [row('A', 'T1')]);
    s = acceptPage(s, [row('A', 'T1')]);
    expect(s.duplicateIds).toBe(1);
    expect(paginationComplete(s)).toBe(false);
  });

  it('detects out-of-order rows', () => {
    let s = newPaginationState(1);
    s = acceptPage(s, [row('B', 'T2'), row('A', 'T1')]);
    expect(s.outOfOrderRows).toBe(1);
    expect(paginationComplete(s)).toBe(false);
  });

  it('is incomplete when pages are missing', () => {
    let s = newPaginationState(3);
    s = acceptPage(s, [row('A', 'T1')]);
    expect(paginationComplete(s)).toBe(false);
  });

  it('is incomplete when a page failed', () => {
    let s = newPaginationState(1);
    s = acceptPage(s, [row('A', 'T1')]);
    s = { ...s, failed: true };
    expect(paginationComplete(s)).toBe(false);
  });

  it('proposes a watermark only when BOTH axes completed', () => {
    let lc = newPaginationState(1);
    lc = acceptPage(lc, [row('A', 'T1'), row('B', 'T2')]);
    let id = newPaginationState(1);
    id = acceptPage(id, [row('C', 'T1')]);
    expect(proposedWatermark(lc, id)).toBe('T2');

    // Incomplete LIFECYCLE blocks it.
    const lcBad = newPaginationState(3);
    expect(proposedWatermark(lcBad, id)).toBeNull();
    // Incomplete IDENTITY blocks it independently.
    const idBad = newPaginationState(5);
    expect(proposedWatermark(lc, idBad)).toBeNull();
  });
});

// --- first-run baseline semantics, through the REAL planner ----------------

describe('first-run baseline semantics (real planner)', () => {
  const RUN_AT = '2026-08-05T03:00:00.000Z';
  const EMPTY: PriorState = { aliasToPerson: {}, persons: {} };
  const complete = { pagesExpected: 1, pagesCompleted: 1, failed: false };

  function planFor(rows: ExtractedLifecycleRow[]) {
    return planLifecycleObservations({
      rows,
      identityPairs: [],
      prior: EMPTY,
      config: {
        syncRunId: 'SYNTH-DRYRUN-1',
        runStartedAt: RUN_AT,
        lifecyclePages: complete,
        identityPages: complete,
        proposedWatermarkSystemModstamp: 'T1',
      },
    });
  }

  const extracted = (raw: string, over: Partial<ExtractedLifecycleRow> = {}): ExtractedLifecycleRow => ({
    sourceObject: 'Lead',
    sourceRecordId: L1,
    rawLifecycleValue: raw,
    sourceModifiedAt: 'T1',
    observedAt: RUN_AT,
    ...over,
  });

  it('first Lead is a baseline landing on lead', () => {
    const p = planFor([extracted('Lead')]);
    const events = p.operations.filter((o) => o.op === 'lifecycle_event');
    expect(events).toHaveLength(1);
    expect(events[0].op === 'lifecycle_event' && events[0].event.toStage).toBe('lead');
    expect(events[0].op === 'lifecycle_event' && events[0].eventKind).toBe('baseline');
  });

  it('first MQL is a baseline landing on mql, not an invented conversion', () => {
    const p = planFor([extracted('Marketing Qualified Lead')]);
    const events = p.operations.filter((o) => o.op === 'lifecycle_event');
    expect(events).toHaveLength(1);
    expect(events[0].op === 'lifecycle_event' && events[0].event.toStage).toBe('mql');
    expect(events[0].op === 'lifecycle_event' && events[0].eventKind).toBe('baseline');
    expect(p.diagnostics.leadToMql).toBe(0);
  });

  it('first out-of-scope value stores evidence with no funnel event', () => {
    const p = planFor([extracted('Customer')]);
    expect(p.diagnostics.outOfScopeObservations).toBe(1);
    expect(p.operations.filter((o) => o.op === 'lifecycle_event')).toHaveLength(0);
  });

  it('routes an unknown lifecycle value to review', () => {
    const p = planFor([extracted('Newly Added Stage')]);
    expect(p.diagnostics.unknownValues).toBe(1);
    expect(
      p.operations.some((o) => o.op === 'raise_issue' && o.kind === 'unknown_lifecycle_value'),
    ).toBe(true);
  });

  it('invents NO transition, return, or requalification on a first run', () => {
    const p = planFor([
      extracted('Lead', { sourceRecordId: L1 }),
      extracted('Marketing Qualified Lead', { sourceRecordId: L2 }),
      extracted('Customer', { sourceRecordId: C1, sourceObject: 'Contact' }),
    ]);
    expect(p.diagnostics.leadToMql).toBe(0);
    expect(p.diagnostics.mqlToLead).toBe(0);
    expect(p.diagnostics.requalifications).toBe(0);
  });

  it('supporting dates never create an event', () => {
    const p = planFor([
      extracted('Lead', { becameLeadDate: '2026-01-05', becameMqlDate: '2026-03-01' }),
    ]);
    const events = p.operations.filter((o) => o.op === 'lifecycle_event');
    expect(events).toHaveLength(1);
    expect(events[0].op === 'lifecycle_event' && events[0].eventKind).toBe('baseline');
    expect(p.diagnostics.leadToMql).toBe(0);
  });
});

// --- production workflow must be untouched ---------------------------------

describeWithProdWorkflow('production workflow safety', () => {
  it('is byte-identical to the audited baseline', () => {
    // Recorded before any inspection in this bite. If this fails, the
    // live workflow export was modified, which this bite must never do.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const hash = createHash('sha256').update(prodWorkflowSrc as string).digest('hex');
    expect(hash).toBe('57ef079b214d0b8ba92f981cac9511960994471c179befa090e0ea389c77a9d5');
  });

  it('is not committed to the repository', () => {
    // The live export carries an RPC endpoint, credential references, and
    // a Google document reference. It must never enter git.
    const files = readFileSync(resolve(process.cwd(), '.gitignore'), 'utf8');
    void files;
    let present = true;
    try {
      readFileSync(resolve(process.cwd(), '[Sourced] - SFDC Leads Automated Sync.json'));
    } catch {
      present = false;
    }
    expect(present).toBe(false);
  });
});

// --- sanitized dry-run workflow safety -------------------------------------

// --- locked business rule: identity governs observation --------------------

describe('locked rule: campaigns govern admission, identity governs observation', () => {
  it('observes an anchored person regardless of campaign membership', () => {
    // The scope resolver takes NO campaign input at all, so campaign
    // membership cannot reduce the observable population by construction.
    const src = readFileSync(resolve(process.cwd(), 'src/lib/lifecycleIngestionScope.ts'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(src.toLowerCase()).not.toContain('campaign');

    const r = resolveIngestionScope(scopeInput({ sourcedAnchors: [anchor({ sfdcLeadId: L1 })] }));
    expect(r.proposedObservationTargets.Lead).toBe(1);
  });

  it('keeps the scope resolver campaign-blind by construction', () => {
    // The locked rule holds because the resolver cannot see campaigns,
    // not because a comment says so.
    const code = readFileSync(resolve(process.cwd(), 'src/lib/lifecycleIngestionScope.ts'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code.toLowerCase()).not.toContain('campaign');
  });

  it('routes conflicting identity evidence to review and changes nothing', () => {
    const r = resolveIngestionScope(
      scopeInput({
        sourcedAnchors: [
          anchor({ sourcedLeadId: 'sourced-1', sfdcLeadId: L1 }),
          anchor({ sourcedLeadId: 'sourced-2', sfdcLeadId: L1 }),
        ],
      }),
    );
    expect(r.issues.some((i) => i.kind === 'identity_claimed_by_two_people')).toBe(true);
    // The first claimant is retained; nothing is merged or rewritten.
    expect(r.proposedObservationTargets.Lead).toBe(1);
  });

  it('counts unobservable people separately, never as zero', () => {
    const r = resolveIngestionScope(
      scopeInput({
        sourcedAnchors: [
          anchor({ sfdcLeadId: L1 }),
          anchor({ sourcedLeadId: 'sourced-2', sfdcLeadId: null, sfdcContactId: null }),
        ],
      }),
    );
    expect(r.populations.anchorsWithNoIdentity).toBe(1);
    expect(r.proposedObservationTargets.Lead).toBe(1);
  });
});

// --- coverage SQL safety ---------------------------------------------------

describe('aggregate coverage SQL', () => {
  const SQL = readFileSync(resolve(process.cwd(), 'docs/lifecycle-identity-coverage.sql'), 'utf8');
  const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('is read-only', () => {
    for (const w of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE', 'ALTER', 'GRANT', 'CREATE']) {
      expect(code.toUpperCase(), w).not.toContain(w + ' ');
    }
  });

  it('selects no row-level identifier into the result', () => {
    // The final projection is (metric, value) only. Identifier columns
    // appear solely inside aggregate predicates, never as output.
    expect(code).toMatch(/SELECT metric, value FROM/);
    expect(code).not.toMatch(/SELECT[^;]*\bemail\b/i);
    expect(code).not.toMatch(/SELECT[^;]*first_name|last_name/i);
  });

  it('separates blank strings from NULL', () => {
    expect(code).toContain('lead_id_blank');
    expect(code).toContain('contact_id_blank');
    expect(code).toMatch(/12_lead_id_blank_string/);
  });

  it('reports eligible and unobservable as distinct decision numbers', () => {
    expect(code).toContain('16_eligible_identity_anchored');
    expect(code).toContain('17_unobservable_no_exact_identity');
  });

  it('validates Salesforce id shape rather than coercing it', () => {
    expect(code).toContain("~ '^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$'");
    expect(code).toContain('14_lead_id_malformed');
  });
});

// --- real multi-page pagination in the workflow ----------------------------

// --- hardened GUARD --------------------------------------------------------

// --- supporting date fields ------------------------------------------------

// --- paired anchors, batching, and safe literals ---------------------------

describe('paired anchors drive a finite Id IN extraction', () => {
  it('preserves the pair relationship and classifies each shape', () => {
    const plan = planAnchorExtraction([
      { sfdcLeadId: L1, sfdcContactId: null },
      { sfdcLeadId: null, sfdcContactId: C1 },
      { sfdcLeadId: L2, sfdcContactId: C2 },
      { sfdcLeadId: null, sfdcContactId: null },
    ]);
    expect(plan.anchorsReceived).toBe(4);
    expect(plan.leadOnly).toBe(1);
    expect(plan.contactOnly).toBe(1);
    expect(plan.dual).toBe(1);
    expect(plan.invalid).toBe(1);
    // A dual anchor contributes to BOTH id lists, keeping the person whole.
    expect(plan.uniqueLeadIds).toEqual([L1, L2].sort());
    expect(plan.uniqueContactIds).toEqual([C1, C2].sort());
  });

  it('deduplicates ids shared across anchors', () => {
    const plan = planAnchorExtraction([
      { sfdcLeadId: L1, sfdcContactId: null },
      { sfdcLeadId: L1, sfdcContactId: null },
    ]);
    expect(plan.uniqueLeadIds).toEqual([L1]);
  });

  it('batches into finite groups of at most 200', () => {
    const ids = Array.from({ length: 451 }, (_, i) =>
      'SYNTHBULK' + String(i).padStart(6, '0'));
    const batches = batchIds(ids);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(200);
    expect(batches[2]).toHaveLength(51);
    expect(batches.flat()).toHaveLength(451);
  });

  it('matches the verified production shape (131 Lead / 3,061 Contact)', () => {
    expect(batchIds(new Array(131).fill(L1).map((_, i) => 'SYNTHLEADX' + String(i).padStart(5, '0')))).toHaveLength(1);
    expect(batchIds(new Array(3061).fill(C1).map((_, i) => 'SYNTHCONTX' + String(i).padStart(5, '0')))).toHaveLength(16);
  });

  it('builds a SOQL literal only from validated ids', () => {
    expect(buildIdInLiteral([L1, L2])).toBe(`Id IN ('${L1}','${L2}')`);
    // The last line of defence refuses rather than escaping or dropping.
    expect(() => buildIdInLiteral(['bad'])).toThrow(/malformed Salesforce id/);
    expect(() => buildIdInLiteral(["' OR 1=1 --"])).toThrow(/malformed Salesforce id/);
  });

  it('uses the TUPLE cursor predicate, never the naive AND form', () => {
    const p = tupleCursorPredicate({ lastSystemModstamp: '2026-08-01T10:00:00Z', lastId: L1 });
    expect(p).toContain('SystemModstamp > 2026-08-01T10:00:00Z OR');
    expect(p).toContain(`SystemModstamp = 2026-08-01T10:00:00Z AND Id > '${L1}'`);
    // The naive form drops later-timestamp records whose Id sorts lower.
    expect(p).not.toMatch(/SystemModstamp > [^ ]+ AND Id >/);
    expect(tupleCursorPredicate(null)).toBe('');
    expect(() => tupleCursorPredicate({ lastSystemModstamp: 'x', lastId: L1 })).toThrow();
    expect(() => tupleCursorPredicate({ lastSystemModstamp: '2026-08-01T10:00:00Z', lastId: 'bad' })).toThrow();
  });
});

// --- dual identity: Contact precedence -------------------------------------

describe('dual identity resolves to ONE person with Contact precedence', () => {
  const leads = (over: Partial<FetchedLead> = {}) =>
    new Map([[L1, { id: L1, convertedContactId: C1, ...over }]]);
  const contacts = new Set([C1]);

  it('uses Contact when the conversion link matches exactly', () => {
    const r = resolveDualIdentity({ sfdcLeadId: L1, sfdcContactId: C1 }, leads(), contacts);
    expect(r).toEqual({ kind: 'use_contact', contactId: C1 });
  });

  it('routes a conversion-link mismatch to review and changes nothing', () => {
    const r = resolveDualIdentity(
      { sfdcLeadId: L1, sfdcContactId: C1 },
      new Map([[L1, { id: L1, convertedContactId: C2 }]]),
      contacts,
    );
    expect(r).toEqual({ kind: 'review', reason: 'conversion_link_mismatch' });
  });

  it('routes an absent conversion link to review', () => {
    const r = resolveDualIdentity(
      { sfdcLeadId: L1, sfdcContactId: C1 },
      new Map([[L1, { id: L1, convertedContactId: null }]]),
      contacts,
    );
    expect(r).toEqual({ kind: 'review', reason: 'conversion_link_absent' });
  });

  it('routes a missing record to review', () => {
    expect(resolveDualIdentity({ sfdcLeadId: L1, sfdcContactId: C1 }, new Map(), contacts))
      .toEqual({ kind: 'review', reason: 'lead_record_missing' });
    expect(resolveDualIdentity({ sfdcLeadId: L1, sfdcContactId: C1 }, leads(), new Set()))
      .toEqual({ kind: 'review', reason: 'contact_record_missing' });
  });

  it('uses Contact for contact-only and Lead for lead-only anchors', () => {
    expect(resolveDualIdentity({ sfdcLeadId: null, sfdcContactId: C1 }, new Map(), contacts))
      .toEqual({ kind: 'use_contact', contactId: C1 });
    expect(resolveDualIdentity({ sfdcLeadId: L1, sfdcContactId: null }, leads(), new Set()))
      .toEqual({ kind: 'use_lead', leadId: L1 });
  });

  it('produces exactly ONE observation per dual person, never two', () => {
    const resolutions = [
      resolveDualIdentity({ sfdcLeadId: L1, sfdcContactId: C1 }, leads(), contacts),
      resolveDualIdentity({ sfdcLeadId: null, sfdcContactId: C2 }, new Map(), new Set([C2])),
    ];
    const sum = summarizeResolutions(resolutions);
    // Two anchors, two observations. The dual person is ONE person.
    expect(sum.observationsPlanned).toBe(2);
    expect(sum.usedContact).toBe(2);
    expect(sum.usedLead).toBe(0);
  });

  it('summarizes review reasons without merging anything', () => {
    const sum = summarizeResolutions([
      resolveDualIdentity({ sfdcLeadId: L1, sfdcContactId: C1 },
        new Map([[L1, { id: L1, convertedContactId: C2 }]]), contacts),
    ]);
    expect(sum.review).toBe(1);
    expect(sum.reviewByReason.conversion_link_mismatch).toBe(1);
    expect(sum.observationsPlanned).toBe(0);
  });
});

// --- corrected workflow ----------------------------------------------------

describe('corrected dry-run workflow', () => {
  const DOC = readFileSync(
    resolve(process.cwd(), 'docs/lead-lifecycle-ingestion-dry-run.md'), 'utf8');
  const wf = JSON.parse(DOC.split('```json\n')[1].split('\n```')[0]) as {
    active: boolean;
    nodes: Array<Record<string, unknown>>;
    connections: Record<string, { main: Array<Array<{ node: string }>> }>;
    pinData?: unknown;
  };
  const raw = JSON.stringify(wf);
  const byName = new Map(wf.nodes.map((n) => [String(n.name), n]));
  const js = (name: string) =>
    String((byName.get(name)!.parameters as Record<string, unknown>).jsCode ?? '');

  it('is disabled, manual, read-only, credential-free, and unpinned', () => {
    expect(wf.active).toBe(false);
    const types = wf.nodes.map((n) => String(n.type));
    expect(types.filter((t) => t.endsWith('.manualTrigger'))).toHaveLength(1);
    for (const forbidden of ['scheduleTrigger', 'webhook', 'googleSheets', 'postgres',
      'supabase', 'httpRequest', 'emailSend', 'executeCommand']) {
      expect(types.some((t) => t.includes(forbidden)), forbidden).toBe(false);
    }
    for (const n of wf.nodes.filter((x) => String(x.type).includes('salesforce'))) {
      expect((n.parameters as Record<string, unknown>).resource).toBe('search');
    }
    expect(wf.nodes.some((n) => 'credentials' in n)).toBe(false);
    expect(wf.pinData).toBeUndefined();
    expect(raw).not.toMatch(/"pinData"/);
  });

  it('DEFECT 1: filters by Id IN and never scans the org from epoch', () => {
    for (const n of wf.nodes.filter((x) => String(x.name).startsWith('Query:'))) {
      expect(String((n.parameters as Record<string, unknown>).query)).toContain('$json.soql');
    }
    // The emitted SOQL must be a well-formed SELECT ... WHERE Id IN (...)
    // built from the validated literal. Asserting only that the substring
    // "Id IN (" appears somewhere would survive a broken SELECT.
    for (const n of ['Build SOQL: Lead batch', 'Build SOQL: Contact batch']) {
      const code = js(n);
      expect(code, n).toMatch(/soql:\s*'SELECT [^']*FROM \w+ WHERE Id IN \(' \+ literal \+ '\)'/);
      expect(code, n).toContain("ids.map((id) => \"'\" + id + \"'\").join(',')");
    }
    // No cursor and no epoch floor anywhere.
    expect(raw).not.toContain('cursor_ts');
    expect(raw).not.toContain('1970-01-01');
  });

  it('DEFECT 2: contains no naive AND cursor boundary', () => {
    expect(raw).not.toMatch(/SystemModstamp > [^ ]*cursor_ts[^ ]* AND Id >/);
    // The correct tuple form is documented where it would be needed.
    expect(js('Build SOQL: Lead batch')).toContain('SystemModstamp = ts AND Id >');
  });

  it('DEFECTS 3+4: uses a finite loop with an explicit done output', () => {
    const loops = wf.nodes.filter((n) => String(n.type).includes('splitInBatches'));
    expect(loops).toHaveLength(2);
    for (const l of loops) {
      const outs = wf.connections[String(l.name)].main;
      // Output 0 = done, output 1 = next batch. Two distinct branches.
      expect(outs).toHaveLength(2);
      expect(outs[0][0].node).not.toBe(outs[1][0].node);
    }
    // Collectors feed the loop back, not GUARD directly.
    for (const c of ['Collect: Lead batch', 'Collect: Contact batch']) {
      const t = wf.connections[c].main[0].map((x) => x.node);
      expect(t.some((x) => x.startsWith('Loop:'))).toBe(true);
      expect(t).not.toContain('GUARD: extraction summary');
    }
    // DEFECT 3: each collector must read the CURRENT loop item. It now
    // does so by EXPLICIT run index rather than the implicit latest-run
    // default, which is what let the package see 1 of 16 Contact batches.
    // Branch index matters as much as run index: output 0 is Done and
    // output 1 is Loop, so the batch item lives on output 1. Reading
    // output 0 mid-iteration is the live "0 item(s)" defect.
    expect(js('Collect: Lead batch'))
      .toContain("const reqItems = $('Loop: Lead batches').all(LOOP_OUTPUT, runIndex);");
    expect(js('Collect: Contact batch'))
      .toContain("const reqItems = $('Loop: Contact batches').all(LOOP_OUTPUT, runIndex);");
    for (const c of ['Collect: Lead batch', 'Collect: Contact batch']) {
      expect(js(c), c).toContain('req.batch_index');
      expect(js(c), c).toContain('(req.ids || []).length');
    }
  });

  it('DEFECT 5: GUARD has exactly one predecessor and no race', () => {
    const into = Object.entries(wf.connections)
      .filter(([, v]) => v.main.some((m) => m.some((c) => c.node.startsWith('GUARD'))))
      .map(([k]) => k);
    // GUARD's sole predecessor is the private package, which is itself
    // reached only from the Contact loop's DONE output.
    expect(into).toEqual(['PRIVATE: evaluator extraction package - DO NOT SHARE']);
    expect(wf.connections['Loop: Contact batches'].main[0][0].node)
      .toBe('PRIVATE: evaluator extraction package - DO NOT SHARE');
    // And the Lead loop's done output serializes into the Contact path.
    expect(wf.connections['Loop: Lead batches'].main[0][0].node)
      .toBe('Fan out: Contact batches');
  });

  it('DEFECT 5: static graph proof, GUARD deps are executed ancestors', () => {
    const adj = new Map(Object.entries(wf.connections).map(
      ([k, v]) => [k, v.main.flat().map((c) => c.node)]));
    const seen = new Set<string>(['Manual Trigger (no schedule)']);
    const q = ['Manual Trigger (no schedule)'];
    while (q.length) {
      for (const t of adj.get(q.shift()!) ?? []) {
        if (!seen.has(t)) { seen.add(t); q.push(t); }
      }
    }
    // Every node is reachable, GUARD included.
    expect(seen.size).toBe(wf.nodes.length);
    expect(seen.has('GUARD: extraction summary')).toBe(true);
    // Every node GUARD reads from is an ancestor that must have run.
    // GUARD now reads the private package rather than the collectors
    // directly, so no raw row can reach it.
    for (const dep of ['PRIVATE: exact Sourced identity anchors',
      'PRIVATE: evaluator extraction package - DO NOT SHARE']) {
      expect(js('GUARD: extraction summary'), dep).toContain(`$('${dep}')`);
      expect(seen.has(dep), dep).toBe(true);
    }
    for (const c of ['Collect: Lead batch', 'Collect: Contact batch']) {
      expect(seen.has(c), c).toBe(true);
    }
    // The successful path terminates: GUARD has no outgoing edge.
    expect(adj.get('GUARD: extraction summary')).toBeUndefined();
  });

  it('DEFECT 6: provides an editable private node that fails on placeholders', () => {
    const node = byName.get('PRIVATE: exact Sourced identity anchors');
    expect(node).toBeTruthy();
    const code = js('PRIVATE: exact Sourced identity anchors');
    expect(code).toContain('PASTE_ANCHORS_HERE');
    expect(code).toContain('PRIVATE INPUT MISSING');
    expect(code).toContain('never');
    expect(code).toContain('organization-wide scan');
  });

  it('DEFECT 7: keeps the Lead/Contact pair together', () => {
    const code = js('PRIVATE: exact Sourced identity anchors');
    expect(code).toContain('a.lead');
    expect(code).toContain('a.contact');
    expect(code).toContain('anchors_dual_identity');
    // A dual anchor MUST contribute to BOTH id lists. Dropping either
    // side silently stops fetching half the pair, which is exactly how
    // the conversion-link check would go unvalidated.
    expect(code).toContain('if (lOk && cOk) { dual += 1; leadIds.add(l); contactIds.add(c); }');
    // GUARD validates the link using the paired ids.
    expect(js('GUARD: extraction summary')).toContain('lead.ConvertedContactId');
    expect(js('GUARD: extraction summary')).toContain('dual_identity_links_conflicting');
  });

  it('DEFECT 8: selects both confirmed Became date fields on both objects', () => {
    for (const n of ['Build SOQL: Lead batch', 'Build SOQL: Contact batch']) {
      expect(js(n), n).toContain('Became_a_Lead_Date__c');
      expect(js(n), n).toContain('Became_a_Marketing_Qualified_Lead_Date__c');
    }
    // Lead-only fields stay on Lead.
    expect(js('Build SOQL: Lead batch')).toContain('ConvertedContactId');
    expect(js('Build SOQL: Contact batch')).not.toContain('ConvertedContactId');
  });

  it('DEFECT 10: GUARD makes no planner claim', () => {
    const code = js('GUARD: extraction summary')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const banned of ['planned_events', 'planned_projections', 'planned_issues',
      'planned_observations', 'transitions:', 'returns:', 'requalifications:']) {
      expect(code, banned).not.toContain(banned);
    }
    expect(code).toContain('transport_and_completeness_only');
    expect(code).toContain('authoritative_counts_source');
  });

  it('emits only transport aggregates, with no identifiers', () => {
    const code = js('GUARD: extraction summary');
    for (const f of ['anchors_supplied', 'lead_batches_expected', 'contact_batches_completed',
      'lead_records_found', 'contact_records_missing', 'dual_identity_links_matched',
      'extraction_complete', 'dry_run', 'writes_attempted', 'apply_payload_created']) {
      expect(code, f).toContain(f);
    }
    expect(raw).not.toMatch(/\b(001|003|00Q|005|006)[A-Za-z0-9]{12}\b/);
    expect(raw).not.toMatch(/https?:\/\//);
    expect(code).not.toMatch(/campaign_name/i);
  });

  it('fails loudly on incomplete extraction and zero matches', () => {
    const code = js('GUARD: extraction summary');
    expect(code).toContain('GUARD FAILED: incomplete extraction');
    expect(code).toContain('ids were requested but ZERO Salesforce');
    expect(code).toContain('lifecycle field is absent from every row');
  });
});

// --- DEFECT 9: the authoritative evaluator exists ---------------------------

describeWithEvaluator('authoritative evaluator', () => {
  const src = evaluatorSrc as string;

  it('exists outside the repository', () => {
    expect(src, 'the local evaluator was never generated').not.toBe('');
  });

  it('invokes the REAL planner and serializer, not a copy', () => {
    expect(src).toContain('planLifecycleObservations');
    expect(src).toContain('serializeLifecycleApply');
    expect(src).toContain('src/lib/lifecycleObservationPlanner.ts');
    expect(src).toContain('src/lib/lifecycleApplyPayload.ts');
  });

  it('applies Contact precedence with exact link validation', () => {
    expect(src).toContain('ConvertedContactId');
    // Raw-string comparison replaced by form-tolerant equivalence.
    expect(src).toContain('!sameSalesforceId(link, contact)');
    expect(src).toContain('conversion_links_conflicting');
  });

  it('makes no network call, no write, and carries no credential', () => {
    expect(src).not.toMatch(/fetch\(|axios|https?:\/\/|createClient/);
    expect(src).not.toMatch(/writeFileSync|appendFileSync/);
    expect(src).not.toMatch(/api[_-]?key|bearer|password|service_role/i);
  });

  it('emits aggregates only and refuses to print identifiers', () => {
    expect(src).toContain('REFUSING to print');
    expect(src).toMatch(/\\b\(001\|003\|00Q\|005\|006\)/);
    for (const f of ['anchors_received', 'baselines_by_destination', 'observations_planned',
      'events_planned', 'projections_planned', 'issues_planned', 'transitions',
      'returns', 'requalifications', 'proposed_watermark', 'first_run_criteria_met']) {
      expect(src, f).toContain(f);
    }
  });

  it('checks the first-run success criteria', () => {
    expect(src).toContain('transitions must be 0 on a first run');
    expect(src).toContain('duplicate baselines');
    expect(src).toContain('proposed watermark is null');
  });
});

// --- execution readiness ---------------------------------------------------

describeWithEvaluator('execution readiness', () => {
  const DOC = readFileSync(
    resolve(process.cwd(), 'docs/lead-lifecycle-ingestion-dry-run.md'), 'utf8');
  const wf = JSON.parse(DOC.split('```json\n')[1].split('\n```')[0]) as {
    nodes: Array<Record<string, unknown>>;
    connections: Record<string, { main: Array<Array<{ node: string }>> }>;
  };
  const byName = new Map(wf.nodes.map((n) => [String(n.name), n]));
  const js = (name: string) =>
    String((byName.get(name)!.parameters as Record<string, unknown>).jsCode ?? '');
  const PKG = 'PRIVATE: evaluator extraction package - DO NOT SHARE';
  const evalSrc = evaluatorSrc ?? '';

  // ISSUE 1 -----------------------------------------------------------
  it('documents npx tsx, never plain node, for the evaluator', () => {
    // Plain `node` fails with ERR_MODULE_NOT_FOUND on the extensionless
    // TypeScript imports. Verified under Node v24.12.0.
    expect(DOC).toContain('npx tsx ~/Downloads/4g2b2a-local-evaluator.mjs');
    expect(DOC).not.toMatch(/^\s*node ~\/Downloads\/4g2b2a-local-evaluator\.mjs/m);
    expect(DOC).toContain('ERR_MODULE_NOT_FOUND');
    expect(evalSrc).toContain('npx tsx ~/Downloads/4g2b2a-local-evaluator.mjs');
  });

  // ISSUE 2 -----------------------------------------------------------
  it('provides a single private extraction package node', () => {
    expect(byName.has(PKG), 'the private package node is missing').toBe(true);
    const code = js(PKG);
    expect(code).toContain('DO NOT SHARE');
    expect(code).toContain('executedAt');
    expect(code).toContain('leads: leads');
    expect(code).toContain('contacts: contacts');
    // Carries the real batch counts for the evaluator's completeness gate.
    for (const f of ['leadBatchesExpected', 'leadBatchesCompleted',
      'contactBatchesExpected', 'contactBatchesCompleted']) {
      expect(code, f).toContain(f);
    }
  });

  it('static graph: the package is downstream of BOTH loops, upstream of GUARD', () => {
    const adj = new Map(Object.entries(wf.connections).map(
      ([k, v]) => [k, v.main.flat().map((c) => c.node)]));

    // Reached only from the Contact loop's DONE output, which is itself
    // reached only from the Lead loop's DONE output. Both loops must
    // therefore have finished.
    const preds = [...adj.entries()].filter(([, t]) => t.includes(PKG)).map(([k]) => k);
    expect(preds).toEqual(['Loop: Contact batches']);
    expect(wf.connections['Loop: Contact batches'].main[0][0].node).toBe(PKG);
    expect(wf.connections['Loop: Lead batches'].main[0][0].node)
      .toBe('Fan out: Contact batches');

    // Upstream of GUARD, and GUARD's ONLY predecessor.
    expect(adj.get(PKG)).toEqual(['GUARD: extraction summary']);
    const guardPreds = [...adj.entries()]
      .filter(([, t]) => t.includes('GUARD: extraction summary')).map(([k]) => k);
    expect(guardPreds).toEqual([PKG]);

    // Both collectors are executed ancestors of the package.
    const ancestors = new Set<string>();
    const walk = (n: string) => {
      for (const [k, t] of adj.entries()) {
        if (t.includes(n) && !ancestors.has(k)) { ancestors.add(k); walk(k); }
      }
    };
    walk(PKG);
    expect(ancestors.has('Collect: Lead batch')).toBe(true);
    expect(ancestors.has('Collect: Contact batch')).toBe(true);

    // GUARD is still the only terminal.
    expect(adj.get('GUARD: extraction summary')).toBeUndefined();
  });

  it('collects every Lead and Contact result exactly once', () => {
    const code = js(PKG);
    // Run-indexed access ONLY. A bare .all() would return just the
    // latest run and silently drop 15 of 16 Contact batches.
    expect(code).toContain("$(nodeName).all(0, runIndex)");
    expect(code).not.toMatch(/\$\('Collect: (Lead|Contact) batch'\)\.all\(\)/);
    expect(code).toContain("collectRuns('Collect: Lead batch'");
    expect(code).toContain("collectRuns('Collect: Contact batch'");
    // Deduplicated by Id, and a within-batch duplicate fails loudly.
    expect(code).toContain('byId.set(id, r)');
    expect(code).toContain('PACKAGE FAILED');
    // Refuses to package an incomplete extraction.
    expect(code).toContain('Refusing to package an incomplete extraction');
  });

  it('keeps every raw row and identifier out of GUARD output', () => {
    const guard = js('GUARD: extraction summary');
    const returned = guard.slice(guard.lastIndexOf('return [{ json:'));
    // GUARD reads the package but returns only counts.
    expect(guard).toContain(`$('${PKG}')`);
    expect(returned).not.toMatch(/leads:|contacts:|rows:/);
    expect(returned).not.toMatch(/\bId\b/);
    expect(returned).not.toContain('_private_');
  });

  // ISSUE 3 -----------------------------------------------------------
  it('never uses the Unix epoch as the observation time', () => {
    const code = evalSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toContain('new Date(0)');
    expect(code).toContain('const observedAt = new Date(executedAtMs).toISOString()');
  });

  it('requires a real executedAt and never falls back to the clock', () => {
    expect(evalSrc).toContain('const executedAt = extraction.executedAt;');
    expect(evalSrc).toContain('has no executedAt timestamp');
    expect(evalSrc).toContain('is not a valid ISO timestamp');
    expect(evalSrc).toContain('never taken from the current clock');
    // The only Date.now-style call would be a silent fallback.
    const code = evalSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/new Date\(\)\.toISOString\(\)/);
  });

  it('passes truthful batch completeness to the planner', () => {
    expect(evalSrc).not.toContain('pagesExpected: 1, pagesCompleted: 1');
    expect(evalSrc).toContain('pagesExpected: leadExpected + contactExpected');
    expect(evalSrc).toContain('pagesCompleted: leadCompleted + contactCompleted');
    // Disagreement fails BEFORE planning.
    expect(evalSrc).toContain('An incomplete run must never be planned');
  });

  it('keeps SystemModstamp as the watermark, not the execution time', () => {
    expect(evalSrc).toContain('.map((r) => r.sourceModifiedAt)');
    expect(evalSrc).toContain('proposed_watermark');
    // observedAt is the observation instant, never an effective date.
    expect(evalSrc).not.toMatch(/effectiveDate:\s*observedAt/);
  });
});

// --- run-index aggregation: EXECUTES the real package code -----------------

describe('package node run-index aggregation (behavioral)', () => {
  const DOC = readFileSync(
    resolve(process.cwd(), 'docs/lead-lifecycle-ingestion-dry-run.md'), 'utf8');
  const wf = JSON.parse(DOC.split('```json\n')[1].split('\n```')[0]) as {
    nodes: Array<Record<string, unknown>>;
  };
  const PKG = 'PRIVATE: evaluator extraction package - DO NOT SHARE';
  const pkgCode = String(
    (wf.nodes.find((n) => String(n.name) === PKG)!.parameters as Record<string, unknown>).jsCode,
  );

  type Item = { json: Record<string, unknown> };
  interface StubOpts {
    leadRuns?: Array<Item[] | 'MISSING'>;
    contactRuns?: Array<Item[] | 'MISSING'>;
    leadExpected?: number;
    contactExpected?: number;
    // When true, the stub throws if a Collect node is read WITHOUT a run
    // index, proving the package never falls back to a bare .all().
    forbidBareAll?: boolean;
  }

  const collection = (batchIndex: number, rows: Array<Record<string, unknown>>): Item[] => [
    { json: { object: 'x', batch_index: batchIndex, run_index: batchIndex,
              requested: rows.length, returned: rows.length, rows } },
  ];

  // Executes the REAL package source against a stubbed n8n $ interface.
  function runPackage(opts: StubOpts): Record<string, unknown> {
    const leadExpected = opts.leadExpected ?? 1;
    const contactExpected = opts.contactExpected ?? 16;
    const leadRuns = opts.leadRuns
      ?? [collection(0, [{ Id: 'SYNTHLEAD00001A' }])];
    const contactRuns = opts.contactRuns
      ?? Array.from({ length: contactExpected }, (_, i) =>
        collection(i, [{ Id: `SYNTHCONT${String(i).padStart(6, '0')}` }]));

    const anchors = {
      lead_batches_expected: leadExpected,
      contact_batches_expected: contactExpected,
      unique_lead_ids: 131,
      unique_contact_ids: 3061,
      _private_anchors: [],
    };

    const $ = (name: string) => ({
      first: () => {
        if (name === 'PRIVATE: exact Sourced identity anchors') return { json: anchors };
        throw new Error(`unexpected first() on ${name}`);
      },
      all: (_branch?: number, runIndex?: number) => {
        if (name.startsWith('Collect:')) {
          if (runIndex === undefined) {
            if (opts.forbidBareAll) {
              throw new Error('BARE_ALL_FORBIDDEN: ' + name);
            }
            // n8n semantics: no runIndex returns the LATEST run only.
            const runs = name.includes('Lead') ? leadRuns : contactRuns;
            const last = runs[runs.length - 1];
            return last === 'MISSING' ? [] : last;
          }
          const runs = name.includes('Lead') ? leadRuns : contactRuns;
          const r = runs[runIndex];
          if (r === undefined || r === 'MISSING') {
            throw new Error(`no run ${runIndex} for ${name}`);
          }
          return r;
        }
        throw new Error(`unexpected all() on ${name}`);
      },
    });

    const fn = new Function('$', `${pkgCode}`) as (d: typeof $) => Item[];
    return fn($)[0].json;
  }

  it('packages all 1 Lead and all 16 Contact runs', () => {
    const out = runPackage({ forbidBareAll: true });
    expect(out.leadBatchesExpected).toBe(1);
    expect(out.leadBatchesCompleted).toBe(1);
    expect(out.contactBatchesExpected).toBe(16);
    expect(out.contactBatchesCompleted).toBe(16);
    expect((out.leads as unknown[]).length).toBe(1);
    // Every one of the 16 Contact runs contributed exactly one row.
    expect((out.contacts as unknown[]).length).toBe(16);
    expect(typeof out.executedAt).toBe('string');
  });

  it('never reads a Collect node with a bare .all()', () => {
    // The stub throws on any bare access; a clean run proves every read
    // was run-indexed. This is the exact defect that produced "1/16".
    expect(() => runPackage({ forbidBareAll: true })).not.toThrow();
    expect(pkgCode).not.toMatch(/\$\('Collect: (Lead|Contact) batch'\)\.all\(\)/);
    expect(pkgCode).toContain('.all(0, runIndex)');
  });

  it('reproduces the live 1/16 failure under bare .all() semantics', () => {
    // Simulate the OLD behavior: only the latest run is visible.
    const latestOnly = pkgCode.replace('$(nodeName).all(0, runIndex)', '$(nodeName).all()');
    const runs = Array.from({ length: 16 }, (_, i) => collection(i, [{ Id: 'X' }]));
    const $ = (name: string) => ({
      first: () => ({ json: { lead_batches_expected: 1, contact_batches_expected: 16,
                              unique_lead_ids: 131, unique_contact_ids: 3061, _private_anchors: [] } }),
      all: (_b?: number, r?: number) => {
        void r;
        return name.includes('Lead') ? collection(0, [{ Id: 'Y' }]) : runs[runs.length - 1];
      },
    });
    const fn = new Function('$', latestOnly) as (d: typeof $) => Item[];
    // Under the old semantics every run resolves to batch 15, so the
    // duplicate guard fires: the extraction is correctly refused.
    expect(() => fn($)).toThrow(/PACKAGE FAILED/);
  });

  it('fails when an expected run is missing (throws)', () => {
    const contactRuns: Array<Item[] | 'MISSING'> =
      Array.from({ length: 16 }, (_, i) => collection(i, [{ Id: 'C' }]));
    contactRuns[7] = 'MISSING';
    expect(() => runPackage({ contactRuns })).toThrow(/Contact run 7 is missing|Refusing to package/);
  });

  it('fails when a run returns an EMPTY array rather than throwing', () => {
    // n8n may hand back an empty array instead of raising. Skipping such
    // a run would let an incomplete extraction look complete.
    const contactRuns: Array<Item[]> =
      Array.from({ length: 16 }, (_, i) => (i === 4 ? [] : collection(i, [{ Id: 'C' }])));
    expect(() => runPackage({ contactRuns })).toThrow(/run 4 returned no collection item/);
  });

  it('fails when the collected set omits an expected index', () => {
    // 16 runs, all present and unique, but index 15 never appears: the
    // set {0..15} is incomplete even though the COUNT looks right.
    const contactRuns = Array.from({ length: 16 }, (_, i) =>
      collection(i === 15 ? 14 : i, [{ Id: 'C' }]));
    // Caught either as a duplicate or as a never-collected index; both
    // refuse to package.
    expect(() => runPackage({ contactRuns })).toThrow(/PACKAGE FAILED/);
  });

  it('fails on a duplicated batch index', () => {
    const contactRuns = Array.from({ length: 16 }, (_, i) =>
      collection(i === 9 ? 8 : i, [{ Id: 'C' }]));
    expect(() => runPackage({ contactRuns })).toThrow(/appears more than once/);
  });

  it('fails on an out-of-range batch index', () => {
    const contactRuns = Array.from({ length: 16 }, (_, i) =>
      collection(i === 3 ? 99 : i, [{ Id: 'C' }]));
    expect(() => runPackage({ contactRuns })).toThrow(/outside the expected range/);
  });

  it('fails when two runs return the same batch', () => {
    const contactRuns = Array.from({ length: 16 }, (_, i) =>
      collection(i === 15 ? 0 : i, [{ Id: 'C' }]));
    // A duplicate must never satisfy the expected count.
    expect(() => runPackage({ contactRuns })).toThrow(/appears more than once/);
  });

  it('fails when a Collect run returns more than one item', () => {
    const contactRuns: Array<Item[]> = Array.from({ length: 16 }, (_, i) =>
      collection(i, [{ Id: 'C' }]));
    contactRuns[2] = [...collection(2, [{ Id: 'C' }]), ...collection(2, [{ Id: 'D' }])];
    expect(() => runPackage({ contactRuns })).toThrow(/returned 2 items; expected exactly 1/);
  });

  it('fails on a non-integer batch index', () => {
    const contactRuns = Array.from({ length: 16 }, (_, i) =>
      i === 5
        ? [{ json: { batch_index: 'five', rows: [] } }] as Item[]
        : collection(i, [{ Id: 'C' }]));
    expect(() => runPackage({ contactRuns })).toThrow(/non-integer batch_index/);
  });

  it('validates Lead and Contact independently', () => {
    // Complete Contact sweep, broken Lead sweep.
    const leadRuns: Array<Item[] | 'MISSING'> = ['MISSING'];
    expect(() => runPackage({ leadRuns })).toThrow(/Lead run 0/);
  });

  // The earlier version of this test named the branch parameter `_b` and
  // IGNORED it, returning the same data for output 0 and output 1. That
  // stub could not tell Done from Loop, so it certified the wrong-branch
  // code as correct and the defect reached production. The stub below
  // models the real two-output graph.
  interface LoopStubOpts {
    loopBatchIndex: number;
    loopItems?: number;
    runIndex: number;
    // What the DONE branch yields mid-iteration: nothing, as in n8n.
    doneBranchItems?: Array<{ json: Record<string, unknown> }>;
  }

  function execCollector(nodeName: string, o: LoopStubOpts, transform?: (c: string) => string) {
    const raw = String((wf.nodes.find((n) => String(n.name) === nodeName)!
      .parameters as Record<string, unknown>).jsCode);
    const collectCode = transform ? transform(raw) : raw;
    const $ = (name: string) => ({
      all: (branchIndex?: number, runIndex?: number) => {
        expect(runIndex, `${name} was read without a run index`).toBeDefined();
        if (name.startsWith('Query:')) return [{ json: { Id: 'SYNTHCONT00001A' } }];
        if (name.startsWith('Loop:')) {
          expect(branchIndex, `${name} was read without a branch index`).toBeDefined();
          // OUTPUT 0 = Done. During a loop iteration it has emitted
          // NOTHING. Reading it is the live defect.
          if (branchIndex === 0) return o.doneBranchItems ?? [];
          // OUTPUT 1 = Loop. Carries this iteration's batch item.
          if (branchIndex === 1) {
            return Array.from({ length: o.loopItems ?? 1 }, () =>
              ({ json: { batch_index: o.loopBatchIndex, ids: ['SYNTHCONT00001A'] } }));
          }
          throw new Error(`unexpected branch ${branchIndex} on ${name}`);
        }
        throw new Error(`unexpected all() on ${name}`);
      },
    });
    const fn = new Function('$', '$runIndex', collectCode) as (
      d: typeof $, r: number) => Array<{ json: Record<string, unknown> }>;
    return fn($, o.runIndex)[0].json;
  }

  it.each(['Collect: Lead batch', 'Collect: Contact batch'])(
    '%s reads the LOOP output and collects its own batch', (nodeName) => {
    const out = execCollector(nodeName, { runIndex: 0, loopBatchIndex: 0 });
    expect(out.batch_index).toBe(0);
    expect(out.run_index).toBe(0);
    // A later iteration works the same way.
    const later = execCollector(nodeName, { runIndex: 7, loopBatchIndex: 7 });
    expect(later.batch_index).toBe(7);
    expect(later.run_index).toBe(7);
  });

  it.each(['Collect: Lead batch', 'Collect: Contact batch'])(
    '%s reproduces the live failure when reading the DONE output', (nodeName) => {
    // Uses the SHARED stub deliberately. An inline stub here could
    // model branches loosely and hide exactly the defect this test
    // exists to catch, which is how the original bug survived review.
    expect(() => execCollector(
      nodeName,
      { runIndex: 0, loopBatchIndex: 0 },
      (c) => c.replace('const LOOP_OUTPUT = 1;', 'const LOOP_OUTPUT = 0;'),
    )).toThrow(/loop run 0 produced 0 item\(s\); expected exactly 1/);
  });

  it.each(['Collect: Lead batch', 'Collect: Contact batch'])(
    '%s fails closed on missing, multiple, or mismatched loop items', (nodeName) => {
    // Zero items on the loop branch.
    expect(() => execCollector(nodeName, { runIndex: 0, loopBatchIndex: 0, loopItems: 0 }))
      .toThrow(/produced 0 item\(s\); expected exactly 1/);
    // More than one item: the run-to-batch mapping would be ambiguous.
    expect(() => execCollector(nodeName, { runIndex: 0, loopBatchIndex: 0, loopItems: 2 }))
      .toThrow(/produced 2 item\(s\); expected exactly 1/);
    // The loop and the collector disagree about position.
    expect(() => execCollector(nodeName, { runIndex: 7, loopBatchIndex: 3 }))
      .toThrow(/loop and the collector disagree about position/);
  });

  it('the stub itself distinguishes the Done and Loop branches', () => {
    // Self-check. The previous stub named the branch parameter `_b` and
    // ignored it, returning identical data for outputs 0 and 1, so it
    // certified wrong-branch code as correct. If this ever holds again,
    // every branch test above becomes meaningless.
    const captured: Array<number | undefined> = [];
    const collectCode = String((wf.nodes.find(
      (n) => String(n.name) === 'Collect: Lead batch')!
      .parameters as Record<string, unknown>).jsCode);
    const $ = (name: string) => ({
      all: (branchIndex?: number, runIndex?: number) => {
        if (name.startsWith('Loop:')) captured.push(branchIndex);
        void runIndex;
        if (name.startsWith('Query:')) return [{ json: { Id: 'X' } }];
        return branchIndex === 0 ? [] : [{ json: { batch_index: 0, ids: ['X'] } }];
      },
    });
    const fn = new Function('$', '$runIndex', collectCode) as (d: typeof $, r: number) => unknown;
    fn($, 0);
    // The collector asked for the LOOP branch, not Done.
    expect(captured).toContain(1);
    expect(captured).not.toContain(0);
  });

  it('STATIC GRAPH: each collector uses the branch that feeds its Build SOQL', () => {
    // Derived from the real connections, never hardcoded. If the graph is
    // ever rewired, this assertion follows it.
    const conns = (JSON.parse(DOC.split('```json\n')[1].split('\n```')[0]) as {
      connections: Record<string, { main: Array<Array<{ node: string }>> }>;
    }).connections;

    for (const [loop, collector, builder] of [
      ['Loop: Lead batches', 'Collect: Lead batch', 'Build SOQL: Lead batch'],
      ['Loop: Contact batches', 'Collect: Contact batch', 'Build SOQL: Contact batch'],
    ]) {
      const branches = conns[loop].main;
      const loopBranch = branches.findIndex((b) => b.some((c) => c.node === builder));
      expect(loopBranch, `${loop} does not feed ${builder}`).toBeGreaterThan(-1);

      const code = String((wf.nodes.find((n) => String(n.name) === collector)!
        .parameters as Record<string, unknown>).jsCode);
      const declared = /const LOOP_OUTPUT = (\d+);/.exec(code);
      expect(declared, `${collector} declares no LOOP_OUTPUT`).not.toBeNull();
      // The branch the collector reads MUST be the branch that feeds its
      // Build SOQL node.
      expect(Number(declared![1]), `${collector} reads the wrong loop output`)
        .toBe(loopBranch);
      expect(code).toContain(`.all(LOOP_OUTPUT, runIndex)`);
    }
  });


  it('collectors read their own run index and cross-check position', () => {
    const collectCode = (name: string) =>
      String((wf.nodes.find((n) => String(n.name) === name)!
        .parameters as Record<string, unknown>).jsCode);
    for (const n of ['Collect: Lead batch', 'Collect: Contact batch']) {
      const code = collectCode(n);
      expect(code, n).toContain('const runIndex = $runIndex;');
      expect(code, n).toContain(".all(0, runIndex)");
      // No bare .first() on the loop node.
      expect(code, n).not.toMatch(/\$\('Loop: (Lead|Contact) batches'\)\.first\(\)/);
      // The loop and the collector must agree about position.
      expect(code, n).toContain('req.batch_index !== runIndex');
    }
  });
});

// --- Salesforce 15/18-character Id equivalence -----------------------------

describe('Salesforce 15/18 Id equivalence', () => {
  // 18-character ids and their exact case-sensitive 15-character prefixes.
  const L18 = 'SYNTHLEAD00001AAAA';
  const L15 = L18.slice(0, 15);
  const C18 = 'SYNTHCONT00001BBBB';
  const C15 = C18.slice(0, 15);
  const D18 = 'SYNTHCONT00002CCCC';
  const D15 = D18.slice(0, 15);

  const leadRow = (id: string, converted: string | null = null): FetchedLead =>
    ({ id, convertedContactId: converted });

  it('indexes an 18-character id under both forms', () => {
    expect(idLookupKeys(L18)).toEqual([L18, L15]);
    // A 15-character id indexes only under itself: no checksum is invented.
    expect(idLookupKeys(L15)).toEqual([L15]);
    expect(idLookupKeys('bad')).toEqual([]);
  });

  it('resolves a 15-character anchor against an 18-character row', () => {
    const idx = buildIdIndex([leadRow(L18)], (r) => r.id);
    expect(lookupById(idx, L15)).toEqual(leadRow(L18));
    // And the 18-character anchor resolves the same row.
    expect(lookupById(idx, L18)).toEqual(leadRow(L18));
  });

  it('resolves a 15-character Contact anchor against an 18-character row', () => {
    const idx = buildIdIndex([{ id: C18 }], (r) => r.id);
    expect(lookupById(idx, C15)).toEqual({ id: C18 });
  });

  it('preserves case: 15-character ids are case-SENSITIVE', () => {
    const idx = buildIdIndex([leadRow(L18)], (r) => r.id);
    expect(lookupById(idx, L15.toLowerCase())).toBeUndefined();
    // Lowercasing would merge genuinely distinct records.
    expect(sameSalesforceId(L15, L15.toLowerCase())).toBe(false);
  });

  it('fails closed when two records claim one 15-character key', () => {
    // Same 15-character prefix, different 18-character ids.
    const a = 'SYNTHDUPE000001XXX';
    const b = 'SYNTHDUPE000001YYY';
    expect(a.slice(0, 15)).toBe(b.slice(0, 15));
    expect(() => buildIdIndex([{ id: a }, { id: b }], (r) => r.id))
      .toThrow(IdCollisionError);
  });

  it('matches ConvertedContactId across either form', () => {
    expect(sameSalesforceId(D15, D18)).toBe(true);   // 15 link vs 18 anchor
    expect(sameSalesforceId(D18, D15)).toBe(true);   // 18 link vs 15 anchor
    expect(sameSalesforceId(D18, D18)).toBe(true);
    // A genuinely different id stays different.
    expect(sameSalesforceId(D18, C18)).toBe(false);
    expect(sameSalesforceId(null, D18)).toBe(false);
    expect(sameSalesforceId('bad', D18)).toBe(false);
  });

  it('resolves dual identity across mixed forms', () => {
    const leads = buildIdIndex([leadRow(L18, D18)], (r) => r.id);
    // Lead anchored 15, Contact anchored 15, link returned 18.
    expect(resolveDualIdentity(
      { sfdcLeadId: L15, sfdcContactId: D15 }, leads, new Set([D18]),
    )).toEqual({ kind: 'use_contact', contactId: D15 });
  });

  it('keeps a genuinely conflicting conversion link as a conflict', () => {
    const leads = buildIdIndex([leadRow(L18, C18)], (r) => r.id);
    expect(resolveDualIdentity(
      { sfdcLeadId: L15, sfdcContactId: D15 }, leads, new Set([D18]),
    )).toEqual({ kind: 'review', reason: 'conversion_link_mismatch' });
  });

  it('keeps an absent conversion link as absent', () => {
    const leads = buildIdIndex([leadRow(L18, null)], (r) => r.id);
    expect(resolveDualIdentity(
      { sfdcLeadId: L15, sfdcContactId: D15 }, leads, new Set([D18]),
    )).toEqual({ kind: 'review', reason: 'conversion_link_absent' });
  });

  it('keeps a genuinely missing Contact missing', () => {
    const leads = buildIdIndex([leadRow(L18, D18)], (r) => r.id);
    expect(resolveDualIdentity(
      { sfdcLeadId: L15, sfdcContactId: D15 }, leads, new Set(),
    )).toEqual({ kind: 'review', reason: 'contact_record_missing' });
  });
});

// --- the live 709 / 2,437 regression, at aggregate shape -------------------

describe('live representation-mismatch regression', () => {
  // Reproduces the production ID-form split. NOTE the units: the 15/18
  // split is over UNIQUE SALESFORCE IDS (131 Lead, 3,061 Contact), not
  // over the 3,146 anchors, because the 46 dual anchors contribute one
  // id to each list.
  const LEAD15 = 114, LEAD18 = 17;      // 131 unique Lead ids
  const CON15 = 2369, CON18 = 692;      // 3,061 unique Contact ids

  const pad = (prefix: string, n: number) =>
    `${prefix}${String(n).padStart(15 - prefix.length, '0')}`;

  // Salesforce returned EVERY id in 18-character form.
  const leadIds18 = Array.from({ length: LEAD15 + LEAD18 }, (_, i) => `${pad('SL', i)}XYZ`);
  const contactIds18 = Array.from({ length: CON15 + CON18 }, (_, i) => `${pad('SC', i)}XYZ`);
  // Sourced stored them in MIXED form.
  const leadAnchorIds = leadIds18.map((id, i) => (i < LEAD15 ? id.slice(0, 15) : id));
  const contactAnchorIds = contactIds18.map((id, i) => (i < CON15 ? id.slice(0, 15) : id));

  it('is a faithful reproduction of the live ID-form split', () => {
    expect(leadIds18).toHaveLength(131);
    expect(contactIds18).toHaveLength(3061);
    expect(leadAnchorIds.filter((id) => id.length === 15)).toHaveLength(LEAD15);
    expect(contactAnchorIds.filter((id) => id.length === 15)).toHaveLength(CON15);
  });

  it('OLD raw-string matching reproduces the live 709 figure', () => {
    // Exactly what the first evaluator did: key only on the returned id.
    const leadRaw = new Map(leadIds18.map((id) => [id, { id }]));
    const contactRaw = new Map(contactIds18.map((id) => [id, { id }]));
    const matchedLead = leadAnchorIds.filter((id) => leadRaw.has(id)).length;
    const matchedContact = contactAnchorIds.filter((id) => contactRaw.has(id)).length;
    // Only the ids already stored in 18-character form matched.
    expect(matchedLead).toBe(LEAD18);
    expect(matchedContact).toBe(CON18);
    expect(matchedLead + matchedContact).toBe(709);
    // And the false-missing counts match the live report exactly.
    expect(leadAnchorIds.length - matchedLead).toBe(114);
    expect(contactAnchorIds.length - matchedContact).toBe(2369);
  });

  it('CORRECTED resolver resolves every id in either form', () => {
    const leadIdx = buildIdIndex(leadIds18.map((id) => ({ id })), (r) => r.id);
    const contactIdx = buildIdIndex(contactIds18.map((id) => ({ id })), (r) => r.id);
    const matchedLead = leadAnchorIds.filter((id) => lookupById(leadIdx, id) !== undefined).length;
    const matchedContact = contactAnchorIds.filter(
      (id) => lookupById(contactIdx, id) !== undefined).length;
    // Zero false misses: 2,483 fifteen-character ids now resolve against
    // the records that were actually returned.
    expect(matchedLead).toBe(131);
    expect(matchedContact).toBe(3061);
    expect(leadAnchorIds.length - matchedLead).toBe(0);
    expect(contactAnchorIds.length - matchedContact).toBe(0);
  });
});

// --- evaluator readiness cannot mask a representation mismatch -------------

describeWithEvaluator('evaluator readiness gate', () => {
  const src = evaluatorSrc as string;

  it('uses the shared helper rather than a second implementation', () => {
    expect(src).toContain("await load('src/lib/lifecycleIngestionScope.ts')");
    expect(src).toContain('buildIdIndex');
    expect(src).toContain('lookupById');
    expect(src).toContain('sameSalesforceId');
    // The raw-string maps that caused the defect are gone.
    expect(src).not.toContain('new Map(leadRows.map((r) => [String(r.Id), r]))');
    expect(src).not.toContain('new Map(contactRows.map((r) => [String(r.Id), r]))');
    expect(src).not.toMatch(/if \(link !== contact\)/);
  });

  it('fails readiness when most anchors land in review', () => {
    // 709 + 2,437 = 3,146 satisfied the old accounting identity while
    // 2,437 people were falsely reported missing, and readiness stayed
    // true. That must be impossible now.
    expect(src).toContain('more than 2% of anchors routed to review');
    expect(src).toMatch(/reviewRatio > 0\.02/);
  });

  it('requires conversion diagnostics to account for every dual anchor', () => {
    // All-zero diagnostics alongside dual anchors means the comparison
    // never ran, which is precisely what the Id-form defect caused.
    expect(src).toContain('conversion-link diagnostics total');
    // Bind the CONDITION, not just the message: an inert guard whose
    // text still reads correctly is exactly how the readiness gate
    // stayed true through a 2,437-person failure.
    expect(src).toMatch(/if \(linkTotal !== summary\.anchors_dual_identity\) \{/);
    expect(src).toMatch(/const linkTotal = summary\.conversion_links_matched\s*\n?\s*\+ summary\.conversion_links_conflicting \+ summary\.conversion_links_missing;/);
  });

  it('fails closed on a 15-character lookup collision', () => {
    expect(src).toContain('IdCollisionError');
    expect(src).toContain('Refusing to choose one');
  });

  it('GUARD applies the same Id equivalence for conversion links', () => {
    // GUARD embeds its own comparison, so it would have reported the
    // same false conflicts on mixed 15/18 forms.
    const DOCX = readFileSync(
      resolve(process.cwd(), 'docs/lead-lifecycle-ingestion-dry-run.md'), 'utf8');
    const g = JSON.parse(DOCX.split('```json\n')[1].split('\n```')[0]) as {
      nodes: Array<Record<string, unknown>>;
    };
    const guard = String((g.nodes.find((n) => String(n.name).startsWith('GUARD'))!
      .parameters as Record<string, unknown>).jsCode);
    expect(guard).toContain('const sameSfId =');
    expect(guard).toContain('.slice(0, 15) === String(b).slice(0, 15)');
    expect(guard).toContain('sameSfId(link, c)');
    // The raw-string comparison is gone.
    expect(guard).not.toMatch(/else if \(link === c\)/);
    // Case is never folded.
    expect(guard).not.toMatch(/toLowerCase\(\)/);
  });

  it('emits no Salesforce identifier in its aggregate output', () => {
    expect(src).toContain('REFUSING to print');
    // Counts come from row totals, never from index size (which would
    // double-count the two keys per record).
    expect(src).toContain('lead_records_found: leadRows.length');
    expect(src).toContain('contact_records_found: contactRows.length');
  });
});

// --- accepted first-run evidence invariants --------------------------------

describe('accepted first-run evidence (2026-08-05)', () => {
  // The ACCEPTED corrected evaluator result. The earlier 709-person
  // output is rejected measurement evidence from the 15/18-Id defect and
  // is deliberately not represented here as a result.
  const EV = {
    anchorsReceived: 3146,
    anchorsLeadOnly: 85,
    anchorsContactOnly: 3015,
    anchorsDual: 46,
    conversionMatched: 45,
    conversionConflicting: 0,
    conversionMissing: 1,
    leadFound: 131,
    leadMissing: 0,
    contactFound: 3060,
    contactMissing: 1,
    reconciled: 3144,
    review: 2,
    baselineLead: 2380,
    baselineMql: 488,
    outOfScope: 275,
    unknownBlank: 1,
    unknownNonblank: 0,
    observationsPlanned: 3144,
    eventsPlanned: 2868,
    projectionsPlanned: 3144,
    issuesPlanned: 268,
    issuesByKind: { reversed_supporting_dates: 267, blank_lifecycle_value: 1 },
    transitions: 0,
    returns: 0,
    requalifications: 0,
  };

  it('every normalized state accounts for every observation', () => {
    // The gap this closes: lead + mql + out_of_scope was 3,143 against
    // 3,144 observations, and the remaining state was invisible because
    // a BLANK value normalizes to unknown without producing a label key.
    const states = EV.baselineLead + EV.baselineMql + EV.outOfScope
      + EV.unknownBlank + EV.unknownNonblank;
    expect(states).toBe(EV.observationsPlanned);
    // Blank and nonblank-unknown are DIFFERENT facts and stay separate.
    expect(EV.unknownBlank).toBe(1);
    expect(EV.unknownNonblank).toBe(0);
  });

  it('issues_by_kind accounts for every planned issue', () => {
    const total = Object.values(EV.issuesByKind).reduce((a, b) => a + b, 0);
    expect(total).toBe(EV.issuesPlanned);
  });

  it('Lead and MQL baselines equal the planned events', () => {
    // Only lead and mql produce a funnel event on this first-run design.
    expect(EV.baselineLead + EV.baselineMql).toBe(EV.eventsPlanned);
    // out_of_scope and unknown are observed but produce NO event.
    expect(EV.observationsPlanned - EV.eventsPlanned)
      .toBe(EV.outOfScope + EV.unknownBlank + EV.unknownNonblank);
  });

  it('conversion diagnostics account for every dual anchor', () => {
    expect(EV.conversionMatched + EV.conversionConflicting + EV.conversionMissing)
      .toBe(EV.anchorsDual);
    expect(EV.anchorsDual).toBe(46);
  });

  it('reconciled plus review equals every anchor', () => {
    expect(EV.reconciled + EV.review).toBe(EV.anchorsReceived);
    expect(EV.anchorsLeadOnly + EV.anchorsContactOnly + EV.anchorsDual)
      .toBe(EV.anchorsReceived);
  });

  it('is a baselines-only first run', () => {
    expect(EV.transitions).toBe(0);
    expect(EV.returns).toBe(0);
    expect(EV.requalifications).toBe(0);
    // One projection per reconciled anchor: no person counted twice.
    expect(EV.projectionsPlanned).toBe(EV.reconciled);
    expect(EV.observationsPlanned).toBe(EV.reconciled);
  });

  it('the rejected 709 result never appears as an accepted result', () => {
    const DOCX = readFileSync(
      resolve(process.cwd(), 'docs/lead-lifecycle-ingestion-dry-run.md'), 'utf8');
    // 709 may be discussed ONLY as a rejected measurement artefact, and
    // the document must SAY SO in the section that mentions it.
    // Match the STANDALONE figure. A naive substring search also hits
    // "2,709" (Became-Lead coverage), which is unrelated evidence.
    // The figure may legitimately appear as arithmetic explaining why the
    // OLD readiness gate passed. What it must never do is appear framed
    // as an accepted result.
    for (const m of DOCX.matchAll(/(?<![\d,])709(?![\d])/g)) {
      const section = DOCX.slice(Math.max(0, m.index - 500), m.index + 500);
      expect(section, 'the 709 figure must never be framed as accepted')
        .not.toMatch(/an accepted result|accepted evidence|business result of/i);
    }
    // At least one mention must state the rejection explicitly.
    expect(DOCX).toMatch(/measurement artefact|measurement artifact/i);
    // And the rejection must be stated in its own section.
    expect(DOCX).toContain('### The rejected run');
    expect(DOCX).toMatch(/not a business result/i);
    // The accepted figures must be present.
    expect(DOCX).toContain('3,144');
    expect(DOCX).toContain('2,868');
  });

  it('the documented evidence carries no identifier or issue detail', () => {
    const DOCX = readFileSync(
      resolve(process.cwd(), 'docs/lead-lifecycle-ingestion-dry-run.md'), 'utf8');
    expect(DOCX).not.toMatch(/\b(001|003|00Q|005|006|00v|701)[A-Za-z0-9]{12}\b/);
    expect(DOCX).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|org|net)\b/);
  });
});

describeWithEvaluator('evaluator aggregate contract', () => {
  const src = evaluatorSrc as string;

  it('reports every normalized state, splitting blank from unmapped', () => {
    // Anchored to the emitted summary FIELD. Asserting the identifier
    // appears anywhere would survive deleting the field while leaving
    // the variable behind.
    expect(src).toMatch(/baselines_by_normalized_state:\s*byState,/);
    expect(src).toContain('unknown_blank_lifecycle_values');
    expect(src).toContain('unknown_nonblank_lifecycle_values');
    // Blank is classified before a label key is ever recorded.
    expect(src).toMatch(/String\(raw\)\.trim\(\) === ''/);
  });

  it('counts issues directly from the planner raise_issue operations', () => {
    expect(src).toContain("plan.operations.filter((o) => o.op === 'raise_issue')");
    expect(src).toMatch(/issues_by_kind:\s*issuesByKind,/);
    expect(src).toContain('records_with_at_least_one_issue');
    // Counted, never emitted.
    expect(src).toContain('recordsWithIssue.size');
    expect(src).not.toMatch(/recordsWithIssue\s*\]|\.\.\.recordsWithIssue/);
    // `detail` can quote a source value and is never read.
    expect(src).not.toMatch(/issuesByKind\[o\.detail\]|o\.detail/);
  });

  it('fails readiness when a breakdown does not account for its total', () => {
    expect(src).toContain('baseline states total');
    expect(src).toMatch(/stateTotal !== summary\.observations_planned/);
    expect(src).toContain('issues_by_kind totals');
    expect(src).toMatch(/issueTotal !== summary\.issues_planned/);
  });
});

// --- fixture hygiene -------------------------------------------------------

describe('fixture hygiene', () => {
  it('uses synthetic identifiers only', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/lifecycleIngestionScope.test.ts'), 'utf8');
    expect(src).not.toMatch(/\b(001|003|00Q|005|006|00v|701)[A-Za-z0-9]{12}\b/);
    expect(src).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|org|net)\b/);
    expect(src).toContain('SYNTH');
  });

  it('the scope module touches no database or network', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/lifecycleIngestionScope.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"].*supabase/i);
    expect(src).not.toMatch(/createClient|fetch\(|axios/);
    expect(src).not.toMatch(/import\.meta\.env|VITE_/);
    expect(src).not.toMatch(/Date\.now\(\)|new Date\(\)/);
  });

  it('cannot match identities by name, email, or company', () => {
    // Code lines only: the comments deliberately NAME the fuzzy paths
    // this module refuses, so scanning prose would flag its own warnings.
    const code = readFileSync(resolve(process.cwd(), 'src/lib/lifecycleIngestionScope.ts'), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
      .toLowerCase();
    for (const forbidden of ['firstname', 'lastname', 'email', 'company', 'similarity', 'fuzzy', 'levenshtein']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });
});
