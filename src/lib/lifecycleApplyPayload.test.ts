// Bite 4G2B1: serializer and atomic-apply migration safety.
// Synthetic identifiers only: no real Salesforce ids, names, or emails.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serializeLifecycleApply, observationKeyFor, personRefFor } from './lifecycleApplyPayload';
import type { RunIdentity } from './lifecycleApplyPayload';
import { planLifecycleObservations } from './lifecycleObservationPlanner';
import type {
  ExtractedLifecycleRow,
  LifecyclePlan,
  PlannerInput,
  PriorState,
} from './lifecycleObservationPlanner';

const RUN_AT = '2026-08-05T03:00:00.000Z';
const RUN: RunIdentity = { syncRunId: 'SYNTH-RUN-1', runStartedAt: RUN_AT };

function row(over: Partial<ExtractedLifecycleRow> = {}): ExtractedLifecycleRow {
  return {
    sourceObject: 'Lead',
    sourceRecordId: 'SYNTH-LEAD-1',
    rawLifecycleValue: 'Lead',
    sourceModifiedAt: '2026-08-01T10:00:00.000Z',
    observedAt: RUN_AT,
    ...over,
  };
}

const EMPTY_PRIOR: PriorState = { aliasToPerson: {}, persons: {} };
const complete = (n = 1) => ({ pagesExpected: n, pagesCompleted: n, failed: false });

function plan(over: Partial<PlannerInput> = {}): LifecyclePlan {
  return planLifecycleObservations({
    rows: [],
    identityPairs: [],
    prior: EMPTY_PRIOR,
    config: {
      syncRunId: 'SYNTH-RUN-1',
      runStartedAt: RUN_AT,
      lifecyclePages: complete(),
      identityPages: complete(),
      proposedWatermarkSystemModstamp: '2026-08-01T10:00:00.000Z',
    },
    ...over,
  });
}

function ok(p: LifecyclePlan, run: RunIdentity = RUN) {
  const r = serializeLifecycleApply(p, run);
  if (!r.ok) throw new Error(`expected success, got refusals: ${r.refusals.join('; ')}`);
  return r.payload;
}

function priorFrom(p: LifecyclePlan): PriorState {
  const aliasToPerson: Record<string, string> = {};
  const persons: PriorState['persons'] = {};
  for (const op of p.operations) {
    if (op.op === 'create_alias') aliasToPerson[op.sourceRecordId] = op.personId;
    if (op.op === 'baseline_observation' || op.op === 'changed_observation') {
      persons[op.observation.personId] = {
        personId: op.observation.personId,
        normalizedState: op.observation.normalizedState,
        mqlSeenBefore:
          op.observation.normalizedState === 'mql' ||
          persons[op.observation.personId]?.mqlSeenBefore === true,
        lastSourceModifiedAt: op.observation.sourceModifiedAt,
        lastContentFingerprint: op.observation.contentFingerprint,
      };
    }
  }
  return { aliasToPerson, persons };
}

// --- serialization and refusal ---------------------------------------------

describe('serializer: completeness and refusal', () => {
  it('serializes a complete plan', () => {
    const p = ok(plan({ rows: [row()] }));
    expect(p.observations).toHaveLength(1);
    expect(p.events).toHaveLength(1);
    expect(p.dryRunSummary.writes_attempted).toBe(0);
    expect(p.run.syncRunId).toBe('SYNTH-RUN-1');
  });

  it('refuses when LIFECYCLE extraction is incomplete', () => {
    const r = serializeLifecycleApply(
      plan({
        rows: [row()],
        config: {
          syncRunId: 'SYNTH-RUN-1',
          runStartedAt: RUN_AT,
          lifecyclePages: { pagesExpected: 3, pagesCompleted: 1, failed: false },
          identityPages: complete(),
          proposedWatermarkSystemModstamp: '2026-08-01T10:00:00.000Z',
        },
      }),
      RUN,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.join(' ')).toContain('Lifecycle extraction incomplete');
  });

  it('refuses when IDENTITY extraction is incomplete, independently', () => {
    const r = serializeLifecycleApply(
      plan({
        rows: [row()],
        config: {
          syncRunId: 'SYNTH-RUN-1',
          runStartedAt: RUN_AT,
          lifecyclePages: complete(),
          identityPages: { pagesExpected: 7, pagesCompleted: 2, failed: false },
          proposedWatermarkSystemModstamp: '2026-08-01T10:00:00.000Z',
        },
      }),
      RUN,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.join(' ')).toContain('Identity extraction incomplete');
  });

  it('refuses a plan with duplicate source ids (apply blocked)', () => {
    const r = serializeLifecycleApply(
      plan({ rows: [row({ sourceRecordId: 'SYNTH-LEAD-1' }), row({ sourceRecordId: 'SYNTH-LEAD-1' })] }),
      RUN,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown operation kind instead of skipping it', () => {
    const p = plan({ rows: [row()] });
    const tampered: LifecyclePlan = {
      ...p,
      operations: [...p.operations, { op: 'delete_everything' } as never],
    };
    const r = serializeLifecycleApply(tampered, RUN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.join(' ')).toContain('Unknown operation kind');
  });

  it('refuses a run identity that disagrees with the plan', () => {
    const r = serializeLifecycleApply(plan({ rows: [row()] }), {
      syncRunId: 'SYNTH-RUN-OTHER',
      runStartedAt: RUN_AT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.join(' ')).toContain('different sync run');
  });

  it('only carries a watermark when both axes completed', () => {
    const p = ok(plan({ rows: [row()] }));
    expect(p.run.lifecycleExtractionComplete).toBe(true);
    expect(p.run.identityExtractionComplete).toBe(true);
    expect(p.run.proposedWatermarkSystemModstamp).toBe('2026-08-01T10:00:00.000Z');
    expect(p.dryRunSummary.watermarkWouldAdvance).toBe(true);
  });
});

// --- baseline invariant ----------------------------------------------------

describe('serializer: baseline invariant', () => {
  it('first Lead baseline stays null -> lead, kind baseline', () => {
    const p = ok(plan({ rows: [row({ rawLifecycleValue: 'Lead' })] }));
    expect(p.events).toHaveLength(1);
    expect(p.events[0].fromState).toBeNull();
    expect(p.events[0].toState).toBe('lead');
    expect(p.events[0].eventKind).toBe('baseline');
    expect(p.dryRunSummary.baselineEvents).toBe(1);
    expect(p.dryRunSummary.transitionEvents).toBe(0);
  });

  it('first MQL baseline stays null -> mql, kind baseline', () => {
    const p = ok(plan({ rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead' })] }));
    expect(p.events).toHaveLength(1);
    expect(p.events[0].fromState).toBeNull();
    expect(p.events[0].toState).toBe('mql');
    expect(p.events[0].eventKind).toBe('baseline');
  });

  it('an MQL baseline can never become an invented Lead baseline', () => {
    const p = ok(plan({ rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead' })] }));
    expect(p.events.some((e) => e.toState === 'lead')).toBe(false);
    expect(p.dryRunSummary.transitionEvents).toBe(0);
    expect(p.dryRunSummary.returnEvents).toBe(0);
    expect(p.dryRunSummary.requalificationEvents).toBe(0);
  });

  it('a baseline increments no transition counter', () => {
    const p = ok(plan({ rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead' })] }));
    expect(p.dryRunSummary.baselineEvents).toBe(1);
    expect(
      p.dryRunSummary.transitionEvents +
        p.dryRunSummary.returnEvents +
        p.dryRunSummary.requalificationEvents,
    ).toBe(0);
  });

  it('out-of-scope baseline emits an observation and no funnel event', () => {
    const p = ok(plan({ rows: [row({ rawLifecycleValue: 'Customer' })] }));
    expect(p.observations).toHaveLength(1);
    expect(p.events).toHaveLength(0);
  });
});

// --- binding, handles, idempotency -----------------------------------------

describe('serializer: binding and idempotency', () => {
  it('binds every event explicitly to its evidencing observation', () => {
    const p = ok(plan({ rows: [row()] }));
    const keys = new Set(p.observations.map((o) => o.observationKey));
    for (const e of p.events) {
      expect(e.observationKey).toBeTruthy();
      expect(keys.has(e.observationKey)).toBe(true);
    }
  });

  it('maps one temporary handle consistently across every operation kind', () => {
    const p = ok(plan({ rows: [row({ rawLifecycleValue: 'Newly Added Stage' })] }));
    const handle = p.persons[0].handle;
    expect(p.aliases.every((a) => a.personHandle === handle)).toBe(true);
    expect(p.observations.every((o) => o.personHandle === handle)).toBe(true);
    expect(p.projections.every((x) => x.personHandle === handle)).toBe(true);
    expect(p.issues.every((i) => i.personHandle === null || i.personHandle === handle)).toBe(true);
  });

  it('an exact retry produces identical observation and event keys', () => {
    const a = ok(plan({ rows: [row()] }));
    const b = ok(plan({ rows: [row()] }));
    expect(b.observations.map((o) => o.observationKey)).toEqual(
      a.observations.map((o) => o.observationKey),
    );
    expect(b.events.map((e) => e.eventKey)).toEqual(a.events.map((e) => e.eventKey));
  });

  it('different content yields a different observation key', () => {
    const a = ok(plan({ rows: [row({ rawLifecycleValue: 'Lead' })] }));
    const b = ok(plan({ rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead' })] }));
    expect(a.observations[0].observationKey).not.toBe(b.observations[0].observationKey);
  });

  it('issue keys dedupe on evidence, not on run or wording', () => {
    const a = ok(plan({ rows: [row({ rawLifecycleValue: 'Newly Added Stage' })] }));
    const b = ok(
      plan({ rows: [row({ rawLifecycleValue: 'Newly Added Stage' })] }),
      { syncRunId: 'SYNTH-RUN-1', runStartedAt: '2026-08-06T03:00:00.000Z' },
    );
    expect(a.issues[0].issueKey).toBe(b.issues[0].issueKey);
  });

  it('orders every array deterministically', () => {
    const rows = [
      row({ sourceRecordId: 'SYNTH-LEAD-3' }),
      row({ sourceRecordId: 'SYNTH-LEAD-1' }),
      row({ sourceRecordId: 'SYNTH-LEAD-2' }),
    ];
    const a = ok(plan({ rows }));
    const b = ok(plan({ rows: [rows[2], rows[0], rows[1]] }));
    expect(a.observations.map((o) => o.observationKey)).toEqual(
      b.observations.map((o) => o.observationKey),
    );
    expect(a.aliases.map((x) => x.sourceRecordId)).toEqual(['SYNTH-LEAD-1', 'SYNTH-LEAD-2', 'SYNTH-LEAD-3']);
  });
});

// --- identity --------------------------------------------------------------

describe('serializer: identity', () => {
  it('labels a conversion-linked Contact alias as converted_contact_id', () => {
    const first = plan({ rows: [row({ sourceRecordId: 'SYNTH-LEAD-1' })] });
    const linked = plan({
      rows: [],
      identityPairs: [{ leadId: 'SYNTH-LEAD-1', convertedContactId: 'SYNTH-CONTACT-1' }],
      prior: priorFrom(first),
    });
    const p = ok(linked);
    expect(p.aliases).toHaveLength(1);
    expect(p.aliases[0].sourceObject).toBe('Contact');
    expect(p.aliases[0].linkBasis).toBe('converted_contact_id');
  });

  it('labels an introducing record as source_record', () => {
    const p = ok(plan({ rows: [row()] }));
    expect(p.aliases[0].linkBasis).toBe('source_record');
  });

  it('carries an identity conflict as an issue and merges nothing', () => {
    const prior: PriorState = {
      aliasToPerson: { 'SYNTH-LEAD-1': 'person-a', 'SYNTH-CONTACT-1': 'person-b' },
      persons: {
        'person-a': { personId: 'person-a', normalizedState: 'lead', mqlSeenBefore: false, lastSourceModifiedAt: null, lastContentFingerprint: null },
        'person-b': { personId: 'person-b', normalizedState: 'lead', mqlSeenBefore: false, lastSourceModifiedAt: null, lastContentFingerprint: null },
      },
    };
    const p = ok(
      plan({
        rows: [],
        identityPairs: [{ leadId: 'SYNTH-LEAD-1', convertedContactId: 'SYNTH-CONTACT-1' }],
        prior,
      }),
    );
    expect(p.aliases).toHaveLength(0);
    expect(p.issues.some((i) => i.issueKind === 'identity_conflict')).toBe(true);
  });
});

// --- diagnostics safety ----------------------------------------------------

describe('serializer: diagnostics carry no identifiers', () => {
  it('exposes counts only, with no ids, emails, or source values', () => {
    const p = ok(
      plan({
        rows: [row({ sourceRecordId: 'SYNTH-LEAD-1' }), row({ sourceObject: 'Contact', sourceRecordId: 'SYNTH-CONTACT-1' })],
      }),
    );
    const s = JSON.stringify(p.dryRunSummary);
    expect(s).not.toContain('SYNTH-LEAD-1');
    expect(s).not.toContain('SYNTH-CONTACT-1');
    expect(s).not.toMatch(/@/);
    expect(p.dryRunSummary.writes_attempted).toBe(0);
  });

  it('keeps Salesforce ids only where identity evidence requires them', () => {
    const p = ok(plan({ rows: [row()] }));
    // Present on alias/observation (protected server-side evidence)...
    expect(p.aliases[0].sourceRecordId).toBe('SYNTH-LEAD-1');
    // ...and absent from events, projections, and the summary.
    expect(JSON.stringify(p.events)).not.toContain('SYNTH-LEAD-1');
    expect(JSON.stringify(p.projections)).not.toContain('SYNTH-LEAD-1');
    expect(JSON.stringify(p.dryRunSummary)).not.toContain('SYNTH-LEAD-1');
  });

  it('preserves supporting dates verbatim as evidence only', () => {
    const p = ok(plan({ rows: [row({ becameLeadDate: '2026-01-05', becameMqlDate: '2026-03-01' })] }));
    expect(p.observations[0].becameLeadDate).toBe('2026-01-05');
    expect(p.observations[0].becameMqlDate).toBe('2026-03-01');
    // They created no event.
    expect(p.events).toHaveLength(1);
    expect(p.events[0].eventKind).toBe('baseline');
  });

  it('normalizes instants to UTC ISO-8601', () => {
    const p = ok(plan({ rows: [row({ sourceModifiedAt: '2026-08-01T12:00:00+02:00' })] }));
    expect(p.observations[0].sourceModifiedAt).toBe('2026-08-01T10:00:00.000Z');
  });
});

// --- migration safety (static SQL) -----------------------------------------

describe('atomic-apply migration safety (static SQL)', () => {
  const FILE = resolve(process.cwd(), 'migrations/2026-08-04_lifecycle_observation_apply_fn.sql');
  const SQL = readFileSync(FILE, 'utf8');
  const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  // Applied manually to production on 2026-08-05 and verified through
  // direct catalog inspection. The guard is that every status artifact
  // stays ACCURATE and mutually consistent, not that it stays PENDING.
  // Each assertion is scoped to the 4G2B1 row or section so stale wording
  // from unrelated historical migrations cannot fail it.
  it('records the applied status consistently across every artifact', () => {
    // 1. The migration header.
    expect(SQL).toContain('STATUS: Applied manually to production on 2026-08-05');
    expect(SQL).toContain('imported no');
    expect(SQL).toContain('Bite 4G2B2 ingestion remains unstarted');
    expect(SQL).not.toContain('STATUS: PENDING');
    expect(SQL).not.toContain('NOT YET APPLIED');

    // 2. The ledger row, isolated to this migration's own line.
    const readme = readFileSync(resolve(process.cwd(), 'migrations/README.md'), 'utf8');
    const rowLine = readme
      .split('\n')
      .find((l) => l.includes('2026-08-04_lifecycle_observation_apply_fn.sql'))!;
    expect(rowLine).toBeDefined();
    expect(rowLine).toContain('| APPLIED |');
    expect(rowLine).toContain('Applied manually to production on 2026-08-05');
    expect(rowLine).toContain('structure only and imported no lifecycle data');
    expect(rowLine).toContain('Bite 4G2B2 remains unstarted');
    expect(rowLine).not.toContain('NOT YET APPLIED');

    // 3. The SCHEMA.sql block, sliced to the 4G2B1 section only, because
    //    SCHEMA documents older migrations whose own headers differ.
    const schema = readFileSync(resolve(process.cwd(), 'SCHEMA.sql'), 'utf8');
    const start = schema.indexOf('-- Bite 4G2B1: lifecycle observation ledger, atomic apply boundary');
    expect(start).toBeGreaterThan(-1);
    const end = schema.indexOf('ALTER TABLE sf_lifecycle_events', start);
    expect(end).toBeGreaterThan(start);
    const section = schema.slice(start, end);
    expect(section).toContain('Applied manually to production on 2026-08-05');
    expect(section).toContain('imported no');
    expect(section).not.toContain('PENDING');
    expect(section).not.toContain('NOT YET APPLIED');
  });

  it('is SECURITY DEFINER with a locked search_path', () => {
    expect(code).toContain('SECURITY DEFINER');
    expect(code).toContain('SET search_path = pg_catalog');
  });

  it('schema-qualifies every lifecycle table reference', () => {
    const refs = code.match(/(?<!\.)\bsf_lifecycle_\w+/g) ?? [];
    const qualified = code.match(/public\.sf_lifecycle_\w+/g) ?? [];
    // Every bare reference must be part of a public.-qualified one, a
    // constraint name, or a column name.
    const bareTableRefs = code
      .split('\n')
      .filter((l) => /\b(INSERT INTO|UPDATE|FROM|REFERENCES|ALTER TABLE)\s+sf_lifecycle_/.test(l));
    expect(bareTableRefs).toEqual([]);
    expect(qualified.length).toBeGreaterThan(0);
    expect(refs.length).toBeGreaterThan(0);
  });

  it('revokes PUBLIC, anon, and authenticated; grants only service_role', () => {
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.sf_apply_lifecycle_observations[\s\S]*FROM PUBLIC/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.sf_apply_lifecycle_observations[\s\S]*FROM anon/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.sf_apply_lifecycle_observations[\s\S]*FROM authenticated/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.sf_apply_lifecycle_observations[\s\S]*TO service_role/);
    expect(code).not.toMatch(/GRANT[\s\S]{0,120}TO (anon|authenticated|PUBLIC)/);
  });

  it('never updates or deletes append-only observations or events', () => {
    expect(code).not.toMatch(/UPDATE public\.sf_lifecycle_observations/i);
    expect(code).not.toMatch(/UPDATE public\.sf_lifecycle_events/i);
    expect(code).not.toMatch(/DELETE FROM public\.sf_lifecycle_observations/i);
    expect(code).not.toMatch(/DELETE FROM public\.sf_lifecycle_events/i);
  });

  it('writes to no existing business table', () => {
    for (const t of ['leads', 'lead_campaign_touches', 'attributions', 'attribution_touches', 'channels', 'campaign_costs', 'funnel_actuals', 'funnel_projections', 'sf_opportunities', 'sf_opportunity_events']) {
      expect(code, t).not.toMatch(new RegExp(`INSERT INTO (public\\.)?${t}\\b`, 'i'));
      expect(code, t).not.toMatch(new RegExp(`UPDATE (public\\.)?${t}\\b`, 'i'));
      expect(code, t).not.toMatch(new RegExp(`DELETE FROM (public\\.)?${t}\\b`, 'i'));
    }
  });

  it('is forward-only with no backfill or destructive operation', () => {
    expect(code).not.toMatch(/DROP TABLE/i);
    expect(code).not.toMatch(/TRUNCATE/i);
    expect(code).not.toMatch(/DROP COLUMN/i);
    // The only INSERTs are inside the function body, driven by payload.
    expect(code).not.toMatch(/INSERT INTO public\.sf_lifecycle_\w+\s*\([^)]*\)\s*SELECT/i);
  });

  it('persists the watermark only on a completed run', () => {
    expect(code).toMatch(/SET status = 'completed',[\s\S]{0,200}watermark_system_modstamp = v_watermark/);
    expect(code).toMatch(/watermark_system_modstamp = NULL/);
  });

  it('never persists a raw SQL error message', () => {
    expect(code).not.toContain('SQLERRM');
    expect(code).toContain('SQLSTATE');
    expect(code).toContain('error_summary = v_sqlstate');
  });

  it('refuses an incomplete run and distinguishes the three outcomes', () => {
    expect(code).toContain("'LC001'");
    expect(code).toMatch(/'outcome', 'success'/);
    expect(code).toMatch(/'incomplete'/);
    expect(code).toMatch(/'failure'/);
  });

  it('refuses to merge two existing people', () => {
    expect(code).toContain("'LC003'");
    expect(code).toMatch(/refusing to merge two existing people/);
  });

  it('refuses same-timestamp differing content without choosing a winner', () => {
    expect(code).toContain("'LC002'");
    expect(code).toMatch(/content_fingerprint <> v_rec\.content_fingerprint/);
  });

  it('guards the projection against stale evidence under a row lock', () => {
    expect(code).toMatch(/FROM public\.sf_lifecycle_state[\s\S]{0,120}FOR UPDATE/);
    expect(code).toMatch(/v_rec\.source_modified_at > v_existing_state\.last_source_modified_at/);
  });

  it('enforces the baseline shape inside the function too', () => {
    expect(code).toMatch(/event_kind = 'baseline' AND v_rec\.from_state IS NOT NULL/);
    expect(code).toMatch(/event_kind <> 'baseline' AND v_rec\.from_state IS NULL/);
  });

  it('binds events to observations and refuses unbound ones', () => {
    expect(code).toMatch(/event is not bound to an observation/);
    expect(code).toMatch(/observation_id/);
  });

  it('adds the three idempotency constraints the applied schema lacked', () => {
    expect(code).toContain('sf_lifecycle_event_key_unique');
    expect(code).toContain('sf_lifecycle_issue_key_unique');
    expect(code).toContain('sf_lifecycle_observation_key_unique');
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS event_key/);
  });

  it('actually USES each idempotency constraint on its insert', () => {
    // Declaring the constraint is not the guarantee: the insert must
    // reference it, or an exact retry raises instead of collapsing and the
    // batch fails where it should have been a silent no-op. Each assertion
    // is anchored to its own INSERT so a clause cannot be counted twice.
    const insertBlock = (table: string) => {
      // The column list may start on the next line, so match the table
      // name alone rather than assuming an opening paren follows it.
      const i = code.indexOf(`INSERT INTO public.${table}`);
      expect(i, `${table} insert missing`).toBeGreaterThan(-1);
      // Up to the statement terminator that follows the VALUES clause.
      const end = code.indexOf(';', code.indexOf('VALUES', i));
      return code.slice(i, end + 1);
    };
    expect(insertBlock('sf_lifecycle_observations')).toContain(
      'ON CONFLICT ON CONSTRAINT sf_lifecycle_observation_key_unique DO NOTHING',
    );
    expect(insertBlock('sf_lifecycle_events')).toContain(
      'ON CONFLICT ON CONSTRAINT sf_lifecycle_event_key_unique DO NOTHING',
    );
    expect(insertBlock('sf_lifecycle_issues')).toContain(
      'ON CONFLICT ON CONSTRAINT sf_lifecycle_issue_key_unique DO NOTHING',
    );
    expect(insertBlock('sf_lifecycle_person_aliases')).toContain(
      'ON CONFLICT ON CONSTRAINT sf_lifecycle_alias_source_unique DO NOTHING',
    );
  });

  it('uses deterministic ordering to avoid deadlocks', () => {
    const orderBys = code.match(/ORDER BY/g) ?? [];
    expect(orderBys.length).toBeGreaterThanOrEqual(5);
  });

  it('carries no credential, url, or real Salesforce identifier', () => {
    expect(SQL).not.toMatch(/https?:\/\//);
    expect(SQL).not.toMatch(/api[_-]?key|bearer |password|secret/i);
    expect(SQL).not.toMatch(/\b(001|003|00Q|005|006)[A-Za-z0-9]{12}\b/);
    expect(SQL).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  it('does not modify the already-applied 4G2A migration', () => {
    const applied = readFileSync(
      resolve(process.cwd(), 'migrations/2026-08-04_lifecycle_observation_ledger.sql'),
      'utf8',
    );
    expect(applied).toContain('STATUS: Applied manually to production on 2026-08-04');
    expect(applied).not.toContain('sf_apply_lifecycle_observations');
  });
});

// --- hardening pass --------------------------------------------------------

describe('hardening 1: source is text, never binary', () => {
  const FILES = [
    'src/lib/lifecycleApplyPayload.ts',
    'src/lib/lifecycleApplyPayload.test.ts',
    'src/lib/lifecycleObservationPlanner.ts',
    'migrations/2026-08-04_lifecycle_observation_apply_fn.sql',
  ];

  it('contains zero literal NUL bytes', () => {
    for (const f of FILES) {
      const buf = readFileSync(resolve(process.cwd(), f));
      expect(buf.indexOf(0), `${f} contains a NUL byte`).toBe(-1);
    }
  });

  it('builds keys from explicit ordered JSON arrays, not invisible joins', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/lifecycleApplyPayload.ts'), 'utf8');
    expect(src).toContain("JSON.stringify(['event'");
    expect(src).not.toMatch(/\.join\(['"]\\u0000|\\x00/);
  });

  it('distinguishes null from empty string in a key', () => {
    const a = observationKeyFor({ sourceObject: 'Lead', sourceRecordId: 'SYNTH-1', sourceModifiedAt: null, contentFingerprint: 'fp' });
    const b = observationKeyFor({ sourceObject: 'Lead', sourceRecordId: 'SYNTH-1', sourceModifiedAt: '', contentFingerprint: 'fp' });
    expect(a).not.toBe(b);
  });

  it('cannot be confused by a value containing the delimiter', () => {
    // The classic join-delimiter collision: ["a","b"] vs ["a,b"].
    const a = observationKeyFor({ sourceObject: 'Lead', sourceRecordId: 'A', sourceModifiedAt: 'B', contentFingerprint: 'fp' });
    const b = observationKeyFor({ sourceObject: 'Lead', sourceRecordId: 'A","B', sourceModifiedAt: null, contentFingerprint: 'fp' });
    expect(a).not.toBe(b);
  });

  it('is stable across calls and independent of property order', () => {
    const x = { sourceObject: 'Lead' as const, sourceRecordId: 'SYNTH-1', sourceModifiedAt: 'T', contentFingerprint: 'fp' };
    const y = { contentFingerprint: 'fp', sourceModifiedAt: 'T', sourceRecordId: 'SYNTH-1', sourceObject: 'Lead' as const };
    expect(observationKeyFor(x)).toBe(observationKeyFor(y));
  });
});

describe('hardening 5: typed person references', () => {
  it('classifies a batch handle, a UUID, and neither', () => {
    expect(personRefFor('new-person-SYNTH-RUN-1-1')).toEqual({
      kind: 'new_handle',
      handle: 'new-person-SYNTH-RUN-1-1',
    });
    expect(personRefFor('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toEqual({
      kind: 'person_id',
      personId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    });
    // An arbitrary Salesforce-ish string is NOT a person reference.
    expect(personRefFor('SYNTH-LEAD-1')).toBeNull();
  });

  it('attaches a typed reference to every person-bearing record', () => {
    const p = ok(plan({ rows: [row({ rawLifecycleValue: 'Newly Added Stage' })] }));
    expect(p.aliases[0].personRef.kind).toBe('new_handle');
    expect(p.observations[0].personRef.kind).toBe('new_handle');
    expect(p.projections[0].personRef.kind).toBe('new_handle');
    for (const i of p.issues) {
      if (i.personRef !== null) expect(i.personRef.kind).toBe('new_handle');
    }
  });

  it('resolves an existing person as a validated UUID, not a string', () => {
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const prior: PriorState = {
      aliasToPerson: { 'SYNTH-LEAD-1': uuid },
      persons: {
        [uuid]: { personId: uuid, normalizedState: 'lead', mqlSeenBefore: false, lastSourceModifiedAt: '2026-07-01T00:00:00.000Z', lastContentFingerprint: 'old' },
      },
    };
    const p = ok(plan({ rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead', sourceModifiedAt: '2026-08-02T10:00:00.000Z' })], prior }));
    expect(p.observations[0].personRef).toEqual({ kind: 'person_id', personId: uuid });
  });
});

describe('hardening 2: the run row is genuinely first', () => {
  const FILE = resolve(process.cwd(), 'migrations/2026-08-04_lifecycle_observation_apply_fn.sql');
  const SQL = readFileSync(FILE, 'utf8');
  const body = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.sf_apply_lifecycle_observations'));
  const preamble = body.slice(
    body.indexOf('\nBEGIN\n'),
    body.indexOf('RETURNING id INTO v_run_id;'),
  );

  it('inserts the run row with no caller-controlled value', () => {
    expect(preamble).toContain('INSERT INTO public.sf_lifecycle_sync_runs');
    // Nothing reads p_run before the run row exists.
    expect(preamble).not.toContain('p_run');
    expect(preamble).toContain('pg_catalog.now()');
  });

  it('performs no cast or validation before the run row', () => {
    expect(preamble).not.toMatch(/::TIMESTAMPTZ/);
    expect(preamble).not.toMatch(/::INT/);
    expect(preamble).not.toMatch(/::BOOLEAN/);
    expect(preamble).not.toMatch(/RAISE EXCEPTION/);
  });

  it('validates syncRunId, timestamps, and page counts inside the block', () => {
    const guarded = body.slice(body.indexOf('RETURNING id INTO v_run_id;'));
    expect(guarded).toContain("v_sync_run_id := p_run ->> 'syncRunId'");
    expect(guarded).toContain('payload missing syncRunId');
    expect(guarded).toMatch(/v_started_at := COALESCE\(\(p_run ->> 'runStartedAt'\)::TIMESTAMPTZ/);
    expect(guarded).toMatch(/v_lc_expected := COALESCE\(\(p_run ->> 'lifecyclePagesExpected'\)::INT/);
  });

  it('records exactly one run row per invocation, including on failure', () => {
    const inserts = body.match(/INSERT INTO public\.sf_lifecycle_sync_runs/g) ?? [];
    expect(inserts).toHaveLength(1);
    // The handler updates that row rather than inserting another.
    expect(body).toMatch(/EXCEPTION WHEN OTHERS THEN[\s\S]*UPDATE public\.sf_lifecycle_sync_runs/);
  });
});

describe('hardening 3: projection ordering truth table', () => {
  const SQL = readFileSync(
    resolve(process.cwd(), 'migrations/2026-08-04_lifecycle_observation_apply_fn.sql'),
    'utf8',
  );

  it('never lets undated evidence overwrite a known timestamp', () => {
    // The old bug: "OR v_rec.source_modified_at IS NULL" as an accept.
    expect(SQL).not.toMatch(/OR v_rec\.source_modified_at IS NULL\s*\n\s*OR v_rec\.source_modified_at >/);
    expect(SQL).toMatch(/ELSIF v_rec\.source_modified_at IS NULL THEN\s*\n\s*--[^\n]*\n\s*NULL;/);
  });

  it('treats an indistinguishable order with differing content as a conflict', () => {
    expect(SQL).toMatch(/IS NOT DISTINCT FROM v_existing_state\.last_source_modified_at/);
    expect(SQL).toContain('indistinguishable ordering with differing content');
    expect(SQL).toMatch(/content_fingerprint IS DISTINCT FROM v_existing_state\.last_content_fingerprint/);
  });

  it('accepts only strictly newer dated evidence', () => {
    expect(SQL).toMatch(/v_rec\.source_modified_at > v_existing_state\.last_source_modified_at/);
    expect(SQL).toMatch(/v_existing_state\.last_source_modified_at IS NULL/);
  });

  it('compares parsed instants, not text', () => {
    // The column and the payload cast are both TIMESTAMPTZ, so '+0000'
    // and 'Z' are the same moment by construction.
    expect(SQL).toMatch(/\(value ->> 'sourceModifiedAt'\)::TIMESTAMPTZ/);
  });
});

describe('hardening 4: full canonical identity on key conflict', () => {
  const SQL = readFileSync(
    resolve(process.cwd(), 'migrations/2026-08-04_lifecycle_observation_apply_fn.sql'),
    'utf8',
  );

  it('verifies content for observations, events, and issues', () => {
    expect(SQL).toContain('observation key reused with different canonical content');
    expect(SQL).toContain('event key reused with different canonical content');
    expect(SQL).toContain('issue key reused with different canonical content');
  });

  it('uses null-safe comparisons', () => {
    const distinct = SQL.match(/IS DISTINCT FROM/g) ?? [];
    expect(distinct.length).toBeGreaterThanOrEqual(15);
  });

  it('locks the existing row before comparing', () => {
    expect(SQL).toMatch(/WHERE observation_key = v_rec\.observation_key\s*\n\s*FOR UPDATE/);
    expect(SQL).toMatch(/WHERE event_key = v_rec\.event_key\s*\n\s*FOR UPDATE/);
    expect(SQL).toMatch(/WHERE issue_key = v_rec\.issue_key\s*\n\s*FOR UPDATE/);
  });

  it('still never updates an append-only table', () => {
    expect(SQL).not.toMatch(/UPDATE public\.sf_lifecycle_observations/i);
    expect(SQL).not.toMatch(/UPDATE public\.sf_lifecycle_events/i);
  });

  it('documents the first-observation-wins exclusions', () => {
    expect(SQL).toMatch(/EXCLUDED from canonical identity \(first[\s\S]{0,60}observation wins\)/);
    expect(SQL).toMatch(/sync_run_id and created_at/);
    // Issues additionally exclude human review state and wording.
    expect(SQL).toMatch(/review_state, detail,[\s\S]{0,80}EXCLUDED/);
  });
});

describe('hardening 5: SQL person resolution is typed', () => {
  const SQL = readFileSync(
    resolve(process.cwd(), 'migrations/2026-08-04_lifecycle_observation_apply_fn.sql'),
    'utf8',
  );

  it('has no id-only person lookup anywhere', () => {
    expect(SQL).not.toMatch(/WHERE source_record_id = v_rec\.handle/);
    expect(SQL).not.toMatch(/FROM public\.sf_lifecycle_person_aliases[\s\S]{0,200}LIMIT 1/);
  });

  it('resolves through a typed helper that handles all three kinds', () => {
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION public.sf_lifecycle_resolve_person');
    expect(SQL).toMatch(/v_kind = 'new_handle'/);
    expect(SQL).toMatch(/v_kind = 'person_id'/);
    expect(SQL).toMatch(/v_kind = 'alias'/);
  });

  it('always uses the complete alias identity', () => {
    expect(SQL).toMatch(/WHERE source_object = \(p_ref ->> 'sourceObject'\)\s*\n\s*AND source_record_id = \(p_ref ->> 'sourceRecordId'\)/);
  });

  it('resolves a batch handle only through the batch map', () => {
    expect(SQL).toMatch(/IF v_kind = 'new_handle' THEN[\s\S]{0,200}p_handle_map ->>/);
  });

  it('validates an existing UUID and refuses a bad one', () => {
    expect(SQL).toMatch(/EXCEPTION WHEN OTHERS THEN\s*\n\s*RETURN NULL;/);
    expect(SQL).toMatch(/PERFORM 1 FROM public\.sf_lifecycle_persons WHERE id = v_id/);
  });

  it('fails the batch on an unresolvable reference', () => {
    expect(SQL).toMatch(/unresolvable person reference for observation/);
    expect(SQL).toMatch(/unresolvable person reference for event/);
    expect(SQL).toMatch(/unresolvable person reference for projection/);
    expect(SQL).toContain("'LC005'");
  });

  it('restricts the helper to service_role as well', () => {
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION public\.sf_lifecycle_resolve_person[\s\S]*FROM anon/);
    expect(SQL).toMatch(/GRANT EXECUTE ON FUNCTION public\.sf_lifecycle_resolve_person[\s\S]*TO service_role/);
    expect(SQL).toMatch(/SET search_path = pg_catalog[\s\S]{0,200}\$resolve\$/);
  });
});

describe('hardening 6: defects found by real PostgreSQL 15 execution', () => {
  const SQL = readFileSync(
    resolve(process.cwd(), 'migrations/2026-08-04_lifecycle_observation_apply_fn.sql'),
    'utf8',
  );

  // Found by EXECUTING the function, not by reading it. On an exact retry
  // the payload still contains create_person for a new_handle, so the
  // function minted a fresh person and then compared it against the alias
  // owner. v_existing_person <> v_person_id was true, so it raised LC003
  // and EVERY retry failed as a bogus "identity conflict". Those are not
  // two real people: one is a speculative row the same invocation created.
  // Anchored to the specific IF that guards the merge refusal. Asserting
  // only that the kind-check string appears somewhere would still pass if
  // the guard were removed from THIS branch, which is exactly the bug.
  it('treats an alias-already-bound new_handle as a retry, not a merge', () => {
    const i = SQL.indexOf('refusing to merge two existing people');
    expect(i).toBeGreaterThan(-1);
    // The 400 characters preceding the raise must contain the narrowing
    // condition, so the refusal cannot fire for a speculative person.
    const guard = SQL.slice(Math.max(0, i - 400), i);
    expect(guard).toContain("(v_rec.person_ref ->> 'kind') <> 'new_handle'");
    expect(SQL).toContain('EXACT RETRY');
  });

  it('discards the speculative person so a retry leaves no orphan', () => {
    // Exactly one cleanup DELETE, guarded by both not-exists checks. A
    // duplicated or unguarded DELETE would be a different statement.
    const deletes = SQL.match(/DELETE FROM public\.sf_lifecycle_persons/g) ?? [];
    expect(deletes).toHaveLength(1);
    const i = SQL.indexOf('DELETE FROM public.sf_lifecycle_persons');
    const block = SQL.slice(i, i + 500);
    expect(block).toContain('WHERE id = v_person_id');
    expect(block).toContain('SELECT 1 FROM public.sf_lifecycle_person_aliases a WHERE a.person_id = v_person_id');
    expect(block).toContain('SELECT 1 FROM public.sf_lifecycle_observations o WHERE o.person_id = v_person_id');
    // Guarded by the same new_handle narrowing.
    const before = SQL.slice(Math.max(0, i - 300), i);
    expect(before).toContain("(v_rec.person_ref ->> 'kind') = 'new_handle'");
  });

  it('still refuses to merge two people that existed BEFORE the batch', () => {
    // The guard narrows to new_handle only; person_id and alias references
    // still raise LC003.
    expect(SQL).toContain('refusing to merge two existing people');
    expect(SQL).toContain("'LC003'");
  });

  it('adopts the winner after losing an alias race on a speculative person', () => {
    expect(SQL).toContain('Lost race on a speculative person: adopt the winner');
  });

  // Observed SQLSTATEs from PostgreSQL 15 execution: an unparseable
  // timestamp raises 22007 and a non-integer page count raises 22P02.
  // Both are malformed caller input, not an unexpected internal fault.
  it('categorizes native cast failures as malformed_payload', () => {
    expect(SQL).toContain("WHEN '22007' THEN 'malformed_payload'");
    expect(SQL).toContain("WHEN '22P02' THEN 'malformed_payload'");
    expect(SQL).toContain("WHEN '22008' THEN 'malformed_payload'");
  });
});

// --- fixture hygiene -------------------------------------------------------

describe('fixture hygiene', () => {
  it('uses synthetic identifiers only', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/lifecycleApplyPayload.test.ts'), 'utf8');
    expect(src).not.toMatch(/\b(001|003|00Q|005|006)[A-Za-z0-9]{12}\b/);
    expect(src).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|org|net)\b/);
    expect(src).toContain('SYNTH-');
  });

  it('the serializer touches no database or network', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/lifecycleApplyPayload.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"].*supabase/i);
    expect(src).not.toMatch(/createClient|fetch\(|axios/);
    expect(src).not.toMatch(/import\.meta\.env|VITE_/);
  });

  it('cannot express a write to any non-lifecycle table', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/lifecycleApplyPayload.ts'), 'utf8');
    for (const t of ['leads', 'lead_campaign_touches', 'attributions', 'channels', 'sf_opportunit']) {
      expect(src.toLowerCase()).not.toContain(`'${t}'`);
    }
  });
});
