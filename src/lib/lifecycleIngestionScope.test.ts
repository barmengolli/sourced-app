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
} from './lifecycleIngestionScope';
import type { ScopeInput, SourcedIdentityAnchor } from './lifecycleIngestionScope';
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

  it('reports the Became dates as unresolved OPTIONAL evidence', () => {
    // 4G1 deliberately left these for human confirmation. Absence is
    // reported, never guessed.
    const lead = unresolvedOptionalFields(LEAD_EXTRACTION_FIELDS);
    expect(lead).toHaveLength(2);
    expect(lead.every((f) => /Became/.test(f.purpose))).toBe(true);
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

describe('dry-run workflow safety', () => {
  const DOC = readFileSync(
    resolve(process.cwd(), 'docs/lead-lifecycle-ingestion-dry-run.md'),
    'utf8',
  );
  const template = (() => {
    const body = DOC.split('```json\n')[1]?.split('\n```')[0];
    expect(body, 'workflow template missing from the documentation').toBeTruthy();
    return JSON.parse(body!) as {
      active: boolean;
      nodes: Array<Record<string, unknown>>;
      connections: Record<string, unknown>;
      pinData?: unknown;
    };
  })();
  const raw = JSON.stringify(template);
  const nodeTypes = template.nodes.map((n) => String(n.type));

  it('is disabled and manually triggered only', () => {
    expect(template.active).toBe(false);
    expect(nodeTypes.filter((t) => t.endsWith('.manualTrigger'))).toHaveLength(1);
    expect(nodeTypes.some((t) => t.endsWith('.scheduleTrigger'))).toBe(false);
    expect(nodeTypes.some((t) => t.endsWith('.webhook'))).toBe(false);
  });

  it('contains no write-capable node of any kind', () => {
    for (const forbidden of [
      'googleSheets', 'postgres', 'supabase', 'httpRequest',
      'emailSend', 'executeCommand', 'ftp', 's3', 'webhook',
    ]) {
      expect(nodeTypes.some((t) => t.includes(forbidden)), forbidden).toBe(false);
    }
  });

  it('uses only read-only Salesforce search operations', () => {
    const sf = template.nodes.filter((n) => String(n.type).includes('salesforce'));
    expect(sf.length).toBeGreaterThan(0);
    for (const n of sf) {
      const p = n.parameters as Record<string, unknown>;
      expect(p.resource).toBe('search');
    }
    // Query amplification guard applies to SINGLE-SHOT nodes only. The
    // paged query nodes must NOT be executeOnce, or the loop would be
    // pinned to page 1. Covered precisely in the pagination suite.
    const singleShot = sf.filter((n) => String(n.name).startsWith('Describe'));
    for (const n of singleShot) expect(n.executeOnce, String(n.name)).toBe(true);
    expect(raw).not.toMatch(/"operation"\s*:\s*"(create|update|upsert|delete)"/i);
  });

  it('carries no credentials, credential ids, or pinned data', () => {
    expect(template.nodes.some((n) => 'credentials' in n)).toBe(false);
    expect(template.pinData).toBeUndefined();
    expect(raw).not.toMatch(/"credentials"/);
    expect(raw).not.toMatch(/"pinData"/);
  });

  it('carries no real record ids, urls, or secrets', () => {
    expect(raw).not.toMatch(/\b(001|003|00Q|005|006|00v|701)[A-Za-z0-9]{12}\b/);
    expect(raw).not.toMatch(/https?:\/\//);
    expect(raw).not.toMatch(/api[_-]?key|bearer |password|secret|service_role/i);
    expect(raw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  it('declares dry_run and zero writes, and creates no apply payload', () => {
    expect(raw).toContain('dry_run');
    expect(raw).toContain('writes_attempted');
    expect(raw).toContain('apply_payload_created: false');
  });

  it('makes GUARD the only successful terminal', () => {
    const guard = template.nodes.find((n) => String(n.name).startsWith('GUARD'));
    expect(guard).toBeTruthy();
    // GUARD has no outgoing connection: nothing succeeds after it.
    expect(Object.keys(template.connections)).not.toContain(String(guard!.name));
    // It fails loudly on each required condition. Duplicate-id and
    // ordering failures are raised per axis in the Accumulate nodes, so
    // a bad page throws before GUARD ever runs.
    const js = String((guard!.parameters as Record<string, unknown>).jsCode);
    expect(js).toContain('GUARD FAILED');
    const accJs = template.nodes
      .filter((n) => String(n.name).startsWith('Accumulate'))
      .map((n) => String((n.parameters as Record<string, unknown>).jsCode));
    expect(accJs.length).toBe(3);
    for (const a of accJs) {
      expect(a).toContain('PAGINATION FAILED');
      expect(a).toContain('duplicate Salesforce Id');
    }
  });

  it('fails loudly on placeholder configuration before querying', () => {
    const pre = template.nodes.find((n) => String(n.name).startsWith('Preflight'));
    expect(pre).toBeTruthy();
    const js = String((pre!.parameters as Record<string, unknown>).jsCode);
    expect(js).toContain('PREFLIGHT FAILED');
    expect(js).toContain('Never guess a field name');
  });

  it('orders every extraction query by SystemModstamp then Id', () => {
    // Paged EXTRACTION queries only. The FieldDefinition describe is
    // metadata, has no SystemModstamp, and is not paginated.
    const sf = template.nodes.filter(
      (n) => String(n.type).includes('salesforce') && String(n.name).startsWith('Query:'),
    );
    expect(sf.length).toBe(3);
    for (const n of sf) {
      const q = String((n.parameters as Record<string, unknown>).query);
      expect(q, String(n.name)).toContain('ORDER BY SystemModstamp ASC, Id ASC');
    }
  });

  it('records the intended timezone without adding a schedule', () => {
    expect(raw).toContain('America/Denver');
    expect(nodeTypes.some((t) => t.endsWith('.scheduleTrigger'))).toBe(false);
  });

  it('keeps campaign names confined to the PRIVATE decision node', () => {
    const priv = template.nodes.find((n) => String(n.name).startsWith('PRIVATE'));
    expect(priv).toBeTruthy();
    const js = String((priv!.parameters as Record<string, unknown>).jsCode);
    // Currently empty: no campaign scope is approved.
    expect(js).toContain('APPROVED_CAMPAIGN_SCOPE = []');
    // It emits a COUNT, never the names.
    expect(js).toContain('approved_campaign_scope_count');
    // GUARD never reads campaign names.
    const guard = template.nodes.find((n) => String(n.name).startsWith('GUARD'));
    const gjs = String((guard!.parameters as Record<string, unknown>).jsCode);
    expect(gjs).not.toMatch(/campaign_name|Campaign\.Name/i);
  });

  it('asserts zero transitions, returns, and requalifications', () => {
    const guard = template.nodes.find((n) => String(n.name).startsWith('GUARD'));
    const js = String((guard!.parameters as Record<string, unknown>).jsCode);
    expect(js).toMatch(/transitions\s*=\s*0/);
    expect(js).toMatch(/returns\s*=\s*0/);
    expect(js).toMatch(/requalifications\s*=\s*0/);
  });

  it('tracks lifecycle and identity truncation independently', () => {
    const guard = template.nodes.find((n) => String(n.name).startsWith('GUARD'));
    const js = String((guard!.parameters as Record<string, unknown>).jsCode);
    expect(js).toContain('lifecycle_extraction_complete');
    expect(js).toContain('identity_extraction_complete');
    // An incomplete run proposes no watermark.
    expect(js).toMatch(/proposed_watermark: complete && allRows\.length \?/);
  });
});

// --- locked business rule: identity governs observation --------------------

describe('locked rule: campaigns govern admission, identity governs observation', () => {
  const DOC = readFileSync(
    resolve(process.cwd(), 'docs/lead-lifecycle-ingestion-dry-run.md'),
    'utf8',
  );
  const template = JSON.parse(DOC.split('```json\n')[1].split('\n```')[0]) as {
    nodes: Array<Record<string, unknown>>;
  };
  const nodeJs = (prefix: string) => {
    const n = template.nodes.find((x) => String(x.name).startsWith(prefix));
    expect(n, `${prefix} node missing`).toBeTruthy();
    return String((n!.parameters as Record<string, unknown>).jsCode ?? '');
  };

  it('observes an anchored person regardless of campaign membership', () => {
    // The scope resolver takes NO campaign input at all, so campaign
    // membership cannot reduce the observable population by construction.
    const src = readFileSync(resolve(process.cwd(), 'src/lib/lifecycleIngestionScope.ts'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(src.toLowerCase()).not.toContain('campaign');

    const r = resolveIngestionScope(scopeInput({ sourcedAnchors: [anchor({ sfdcLeadId: L1 })] }));
    expect(r.proposedObservationTargets.Lead).toBe(1);
  });

  it('states in the workflow that campaign scope is admission-only', () => {
    const js = nodeJs('PRIVATE');
    expect(js).toContain('campaign_scope_governs');
    expect(js).toContain('admission_only');
    expect(js).toContain('scope_basis');
    // No campaign scope approved yet.
    expect(js).toContain('APPROVED_CAMPAIGN_SCOPE = []');
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

describe('workflow pagination is genuinely multi-page', () => {
  const DOC = readFileSync(
    resolve(process.cwd(), 'docs/lead-lifecycle-ingestion-dry-run.md'),
    'utf8',
  );
  const template = JSON.parse(DOC.split('```json\n')[1].split('\n```')[0]) as {
    nodes: Array<Record<string, unknown>>;
    connections: Record<string, { main: Array<Array<{ node: string }>> }>;
  };
  const queryNodes = template.nodes.filter((n) => String(n.name).startsWith('Query:'));
  const accNodes = template.nodes.filter((n) => String(n.name).startsWith('Accumulate:'));

  it('loops each axis back to its own query node', () => {
    expect(accNodes.length).toBe(3);
    for (const acc of accNodes) {
      const targets = template.connections[String(acc.name)].main[0].map((c) => c.node);
      // Back to the query (another page) AND forward to GUARD (done).
      expect(targets.some((t) => t.startsWith('Query:')), String(acc.name)).toBe(true);
      expect(targets).toContain('GUARD: dry-run summary');
    }
  });

  it('does NOT set executeOnce on paged queries', () => {
    // executeOnce here would pin the loop to page 1 and silently
    // truncate, which is the exact defect this rebuild removed.
    expect(queryNodes.length).toBe(3);
    for (const q of queryNodes) {
      expect(q.executeOnce, String(q.name)).toBe(false);
    }
  });

  it('keeps executeOnce on genuinely single-shot nodes', () => {
    for (const name of ['Preflight', 'PRIVATE', 'Cursor init', 'Describe']) {
      const n = template.nodes.filter((x) => String(x.name).startsWith(name));
      expect(n.length, name).toBeGreaterThan(0);
      for (const x of n) expect(x.executeOnce, String(x.name)).toBe(true);
    }
  });

  it('bounds every page query by the composite cursor', () => {
    for (const q of queryNodes) {
      const sql = String((q.parameters as Record<string, unknown>).query);
      expect(sql, String(q.name)).toContain('SystemModstamp > {{ $json.cursor_ts }}');
      expect(sql).toContain('Id > {{ $json.cursor_id }}');
      expect(sql).toContain('ORDER BY SystemModstamp ASC, Id ASC');
      expect(sql).toMatch(/LIMIT 200/);
    }
  });

  it('never attempts the epoch scan as one unbounded operation', () => {
    const pre = template.nodes.find((n) => String(n.name).startsWith('Preflight'));
    const js = String((pre!.parameters as Record<string, unknown>).jsCode);
    expect(js).toContain('page_size: 200');
    expect(js).toContain('NEVER as one unbounded');
    // No query requests everything at once.
    for (const q of queryNodes) {
      const sql = String((q.parameters as Record<string, unknown>).query);
      expect(sql).not.toMatch(/returnAll/i);
    }
  });

  it('fails loudly on duplicate ids and broken ordering across pages', () => {
    for (const acc of accNodes) {
      const js = String((acc.parameters as Record<string, unknown>).jsCode);
      expect(js, String(acc.name)).toContain('PAGINATION FAILED');
      expect(js).toContain('duplicate Salesforce Id');
      expect(js).toContain('out of (SystemModstamp, Id) order');
      // Duplicates are never silently deduplicated.
      expect(js).toContain('deduplicating would hide it');
    }
  });

  it('continues paging until a short page proves exhaustion', () => {
    for (const acc of accNodes) {
      const js = String((acc.parameters as Record<string, unknown>).jsCode);
      expect(js).toContain('page.length < state.page_size');
      expect(js).toContain('has_more');
    }
  });
});

// --- hardened GUARD --------------------------------------------------------

describe('GUARD fail-fast checks', () => {
  const DOC = readFileSync(
    resolve(process.cwd(), 'docs/lead-lifecycle-ingestion-dry-run.md'),
    'utf8',
  );
  const template = JSON.parse(DOC.split('```json\n')[1].split('\n```')[0]) as {
    nodes: Array<Record<string, unknown>>;
  };
  const guardJs = String(
    (template.nodes.find((n) => String(n.name).startsWith('GUARD'))!.parameters as Record<string, unknown>).jsCode,
  );
  const preJs = String(
    (template.nodes.find((n) => String(n.name).startsWith('Preflight'))!.parameters as Record<string, unknown>).jsCode,
  );

  it('fails when no identity population is supplied', () => {
    expect(preJs).toContain('no identity population supplied');
    expect(preJs).toContain('never falls back to an org-wide scan');
  });

  it('fails on an empty population or a malformed private input', () => {
    expect(preJs).toContain('identity population is empty');
    expect(preJs).toContain('malformed Salesforce id');
    expect(preJs).toContain('No id is coerced into shape');
  });

  it('fails on zero matches when eligible identities were supplied', () => {
    expect(guardJs).toContain('ZERO Salesforce records matched');
  });

  it('fails when the confirmed lifecycle field is absent from every row', () => {
    expect(guardJs).toContain('lifecycle field is absent from every row');
    expect(guardJs).toContain('default every person to Lead');
  });

  it('fails on any non-baseline event in a first run', () => {
    expect(guardJs).toContain('a first run produced a non-baseline event');
    expect(guardJs).toMatch(/transitions !== 0 \|\| returns !== 0 \|\| requalifications !== 0/);
  });

  it('reports lifecycle and identity completeness independently', () => {
    expect(guardJs).toContain('lifecycle_extraction_complete');
    expect(guardJs).toContain('identity_extraction_complete');
    expect(guardJs).toMatch(/const complete = lifecycleComplete && identityComplete/);
    // An incomplete run proposes no watermark.
    expect(guardJs).toMatch(/proposed_watermark: complete && allRows\.length \?/);
  });

  it('emits the required aggregate fields and nothing identifying', () => {
    for (const f of [
      'dry_run', 'writes_attempted', 'apply_payload_created',
      'baseline_observations_by_state', 'planned_observations', 'planned_events',
      'planned_projections', 'planned_issues', 'transitions', 'returns',
      'requalifications', 'salesforce_records_found', 'salesforce_records_not_found',
      'exact_converted_identity_pairs', 'proposed_watermark',
    ]) {
      expect(guardJs, f).toContain(f);
    }
    // No identifier or campaign name ever reaches GUARD output.
    expect(guardJs).not.toMatch(/\b(001|003|00Q|005|006)[A-Za-z0-9]{12}\b/);
    expect(guardJs).not.toMatch(/campaign_name|Campaign\.Name/i);
    expect(guardJs).not.toMatch(/\bemail\b/i);
  });
});

// --- supporting date fields ------------------------------------------------

describe('supporting date fields are candidates, never assumptions', () => {
  const DOC = readFileSync(
    resolve(process.cwd(), 'docs/lead-lifecycle-ingestion-dry-run.md'),
    'utf8',
  );
  const template = JSON.parse(DOC.split('```json\n')[1].split('\n```')[0]) as {
    nodes: Array<Record<string, unknown>>;
  };

  it('checks both candidate names on BOTH objects, read-only', () => {
    const describe_ = template.nodes.find((n) => String(n.name).startsWith('Describe'));
    expect(describe_).toBeTruthy();
    const p = describe_!.parameters as Record<string, unknown>;
    expect(p.resource).toBe('search');
    const q = String(p.query);
    expect(q).toContain('FieldDefinition');
    expect(q).toContain('Became_a_Lead_Date__c');
    expect(q).toContain('Became_a_Marketing_Qualified_Lead_Date__c');
    expect(q).toContain("IN ('Lead','Contact')");
  });

  it('reports absence explicitly and continues', () => {
    const cls = template.nodes.find((n) => String(n.name).startsWith('Classify'));
    const js = String((cls!.parameters as Record<string, unknown>).jsCode);
    expect(js).toContain('supporting_date_fields_absent');
    expect(js).toContain('Never creates a transition and never blocks the run');
    // No alternative name is guessed.
    expect(js).toContain('CANDIDATES');
  });

  it('cannot create a transition even when both dates are present', () => {
    // Proven through the REAL planner, not by inspecting the workflow.
    const RUN_AT = '2026-08-05T03:00:00.000Z';
    const p = planLifecycleObservations({
      rows: [{
        sourceObject: 'Lead', sourceRecordId: L1, rawLifecycleValue: 'Lead',
        sourceModifiedAt: 'T1', observedAt: RUN_AT,
        becameLeadDate: '2026-01-05', becameMqlDate: '2026-03-01',
      }],
      identityPairs: [],
      prior: { aliasToPerson: {}, persons: {} },
      config: {
        syncRunId: 'SYNTH-DATES', runStartedAt: RUN_AT,
        lifecyclePages: { pagesExpected: 1, pagesCompleted: 1, failed: false },
        identityPages: { pagesExpected: 1, pagesCompleted: 1, failed: false },
        proposedWatermarkSystemModstamp: 'T1',
      },
    });
    expect(p.diagnostics.leadToMql).toBe(0);
    const events = p.operations.filter((o) => o.op === 'lifecycle_event');
    expect(events).toHaveLength(1);
    expect(events[0].op === 'lifecycle_event' && events[0].eventKind).toBe('baseline');
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
