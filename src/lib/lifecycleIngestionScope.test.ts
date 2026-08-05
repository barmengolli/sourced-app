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
} from './lifecycleIngestionScope';
import type { ScopeInput, SourcedIdentityAnchor, FetchedLead } from './lifecycleIngestionScope';
import { planLifecycleObservations } from './lifecycleObservationPlanner';
import type { ExtractedLifecycleRow, PriorState } from './lifecycleObservationPlanner';

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

describe('production workflow safety', () => {
  const PROD = '/Users/barmengolli/Downloads/[Sourced] - SFDC Leads Automated Sync.json';

  it('is byte-identical to the audited baseline', () => {
    // Recorded before any inspection in this bite. If this fails, the
    // live workflow export was modified, which this bite must never do.
    const buf = readFileSync(PROD);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const hash = createHash('sha256').update(buf).digest('hex');
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
    // DEFECT 3: each collector must read the CURRENT loop item. A reset
    // or hardcoded request object would silently report batch 0 forever
    // and lose the per-batch requested counts.
    expect(js('Collect: Lead batch'))
      .toContain("const req = $('Loop: Lead batches').first().json;");
    expect(js('Collect: Contact batch'))
      .toContain("const req = $('Loop: Contact batches').first().json;");
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

describe('authoritative evaluator', () => {
  const PATH = '/Users/barmengolli/Downloads/4g2b2a-local-evaluator.mjs';
  let src = '';
  try { src = readFileSync(PATH, 'utf8'); } catch { /* reported below */ }

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
    expect(src).toContain('link !== contact');
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

describe('execution readiness', () => {
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
  const EVAL_PATH = '/Users/barmengolli/Downloads/4g2b2a-local-evaluator.mjs';
  let evalSrc = '';
  try { evalSrc = readFileSync(EVAL_PATH, 'utf8'); } catch { /* asserted below */ }

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
    expect(code).toContain("$('Collect: Lead batch').all()");
    expect(code).toContain("$('Collect: Contact batch').all()");
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
