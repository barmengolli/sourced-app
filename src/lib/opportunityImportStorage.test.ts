// Tests for the Opportunity ledger storage boundary (Bite 5B): the pure
// validation helpers plus static assertions over the unapplied migration and
// schema snapshot. CI has no Supabase credentials, so SQL guarantees are
// asserted against the committed SQL text; nothing here touches a database,
// the network, or the clock. Synthetic identifiers only.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  REVIEW_STATE_TRANSITIONS,
  canTransitionReviewState,
  assessApprovalReadiness,
  assessLinkProposal,
  classifyIncomingEvent,
  buildRecordTypeEventInsert,
  buildTerminalEventInsert,
  buildReviewSeed,
  createReviewMutation,
  applyReviewTransition,
  applyLinkDecision,
  recordIngestionConflict,
} from './opportunityImportStorage';
import type { ReviewState, ReviewIssueCode } from './opportunityImportStorage';
import { adaptOpportunityHistory, DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP } from './opportunityStageHistory';

const MIGRATION = readFileSync(
  resolve(process.cwd(), 'migrations/2026-07-24_opportunity_ledger_storage.sql'),
  'utf8',
);
const SCHEMA = readFileSync(resolve(process.cwd(), 'SCHEMA.sql'), 'utf8');

describe('migration constraints (static SQL assertions)', () => {
  it('Salesforce Opportunity ID is unique and nonblank', () => {
    expect(MIGRATION).toContain('CONSTRAINT sf_opportunities_sf_id_unique UNIQUE (sf_opportunity_id)');
    expect(MIGRATION).toContain("sf_opportunity_id TEXT NOT NULL CHECK (length(trim(sf_opportunity_id)) > 0)");
  });

  it('Salesforce History ID is unique on the event ledger', () => {
    expect(MIGRATION).toContain('CONSTRAINT sf_opportunity_events_history_id_unique UNIQUE (sf_history_id)');
  });

  it('the event ledger is append-only by trigger and has the required indexes', () => {
    expect(MIGRATION).toContain('BEFORE UPDATE OR DELETE ON sf_opportunity_events');
    expect(MIGRATION).toContain('is append-only: % is not allowed');
    expect(MIGRATION).toContain('ON sf_opportunity_events (sf_opportunity_uuid, changed_at)');
    expect(MIGRATION).toContain('ON sf_opportunity_events (event_kind)');
  });

  it('the review audit trail is append-only, indexed, deduped, and excluded from realtime', () => {
    // UPDATE and DELETE are blocked by the same SQL trigger pattern.
    expect(MIGRATION).toContain('BEFORE UPDATE OR DELETE ON sf_opportunity_review_events');
    // Required indexes: review + time, opportunity + time, event type.
    expect(MIGRATION).toContain('ON sf_opportunity_review_events (review_id, occurred_at)');
    expect(MIGRATION).toContain('ON sf_opportunity_review_events (sf_opportunity_uuid, occurred_at)');
    expect(MIGRATION).toContain('ON sf_opportunity_review_events (event_type)');
    // Optional idempotency key is unique when present.
    expect(MIGRATION).toContain('ON sf_opportunity_review_events (dedupe_key) WHERE dedupe_key IS NOT NULL');
    // timestamptz on the audit timestamps.
    expect(MIGRATION).toContain('occurred_at TIMESTAMPTZ NOT NULL');
    // Not in realtime (asserted globally below) and RLS enabled with no
    // policies (asserted in the RLS test, which iterates all six tables).
  });

  it('links are 1:1 while active in both directions', () => {
    expect(MIGRATION).toContain('ON sf_opportunity_deal_links (sf_opportunity_uuid) WHERE link_state = \'active\'');
    expect(MIGRATION).toContain('ON sf_opportunity_deal_links (deal_id) WHERE link_state = \'active\'');
  });

  it('event timestamps are timestamptz (timezone retained)', () => {
    const eventsTable = MIGRATION.slice(
      MIGRATION.indexOf('CREATE TABLE IF NOT EXISTS sf_opportunity_events'),
      MIGRATION.indexOf('CREATE INDEX IF NOT EXISTS idx_sf_opportunity_events_opp_changed'),
    );
    expect(eventsTable).toContain('changed_at TIMESTAMPTZ NOT NULL');
  });

  it('no derived milestone dates are persisted as canonical event history', () => {
    const eventsTable = MIGRATION.slice(
      MIGRATION.indexOf('CREATE TABLE IF NOT EXISTS sf_opportunity_events'),
      MIGRATION.indexOf('sf_opportunity_deal_links'),
    );
    for (const forbidden of ['hpp_date', 'opp_date', 'pursuit_date', 'hpp_entered', 'milestone']) {
      expect(eventsTable.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('RLS is enabled on all five tables with no anonymous policies', () => {
    for (const t of [
      'sf_opportunity_sync_runs',
      'sf_opportunities',
      'sf_opportunity_events',
      'sf_opportunity_deal_links',
      'sf_opportunity_reviews',
      'sf_opportunity_review_events',
    ]) {
      expect(MIGRATION).toContain(`ALTER TABLE ${t}`);
      expect(MIGRATION).toMatch(new RegExp(`ALTER TABLE ${t}\\s+ENABLE ROW LEVEL SECURITY`));
    }
    // No policies of any kind are created by this migration, and the new
    // tables are not added to the schema's permissive anon-policy loop or
    // the realtime publication.
    expect(MIGRATION).not.toContain('CREATE POLICY');
    expect(MIGRATION).not.toContain('supabase_realtime');
    const anonLoop = SCHEMA.slice(SCHEMA.indexOf('Allow anon insert') - 2000, SCHEMA.indexOf('Allow anon delete') + 200);
    expect(anonLoop).not.toContain('sf_opportun');
  });

  it('contains no destructive statements, production writes, or attribution backfill', () => {
    expect(MIGRATION).not.toMatch(/DROP TABLE/i);
    expect(MIGRATION).not.toMatch(/TRUNCATE/i);
    expect(MIGRATION).not.toMatch(/\bINSERT INTO\b/i);
    expect(MIGRATION).not.toMatch(/\bUPDATE\s+(?!ON\b)[a-z_]+\s+SET\b/i);
    expect(MIGRATION).not.toMatch(/\bDELETE FROM\b/i);
    expect(MIGRATION).not.toMatch(/ALTER TABLE attributions/i);
    expect(MIGRATION.toLowerCase()).not.toContain('sf_link');
    // DROP is used only for idempotent trigger recreation.
    const drops = MIGRATION.match(/DROP [A-Z ]+/g) ?? [];
    for (const d of drops) expect(d.startsWith('DROP TRIGGER')).toBe(true);
  });

  it('contains no credentials or environment values', () => {
    for (const needle of ['service_role', 'supabase.co', 'VITE_', 'Bearer', 'apikey']) {
      expect(MIGRATION).not.toContain(needle);
    }
  });

  it('SCHEMA.sql carries the same tables per repository convention', () => {
    for (const t of ['sf_opportunity_sync_runs', 'sf_opportunities', 'sf_opportunity_events', 'sf_opportunity_deal_links', 'sf_opportunity_reviews', 'sf_opportunity_review_events']) {
      expect(SCHEMA).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    }
  });
});

describe('review-state machine', () => {
  it('allows the valid transitions', () => {
    expect(canTransitionReviewState('pending', 'approved')).toBe(true);
    expect(canTransitionReviewState('pending', 'blocked')).toBe(true);
    expect(canTransitionReviewState('blocked', 'pending')).toBe(true);
    expect(canTransitionReviewState('approved', 'linked')).toBe(true);
    expect(canTransitionReviewState('linked', 'resolved')).toBe(true);
    expect(canTransitionReviewState('ignored', 'pending')).toBe(true);
  });

  it('rejects invalid transitions, including any exit from resolved', () => {
    expect(canTransitionReviewState('resolved', 'pending')).toBe(false);
    expect(canTransitionReviewState('ignored', 'approved')).toBe(false);
    expect(canTransitionReviewState('approved', 'pending')).toBe(false);
    expect(canTransitionReviewState('linked', 'approved')).toBe(false);
    for (const to of Object.keys(REVIEW_STATE_TRANSITIONS) as ReviewState[]) {
      expect(canTransitionReviewState('resolved', to)).toBe(false);
    }
  });
});

describe('approval readiness', () => {
  it('rejects approval without a channel; there is no default', () => {
    const a = assessApprovalReadiness({ reviewState: 'pending', issueCodes: ['missing_channel'], channelId: null });
    expect(a.ready).toBe(false);
    expect(a.reasons.join(' ')).toContain('mandatory');
  });

  it('allows approval with a channel and no lead', () => {
    const a = assessApprovalReadiness({
      reviewState: 'pending',
      issueCodes: ['missing_channel', 'missing_region'],
      channelId: 'syn-channel-uuid-1',
      leadId: null,
    });
    expect(a.ready).toBe(true);
  });

  it('an unknown Record Type stays reviewable but cannot be approved', () => {
    const a = assessApprovalReadiness({
      reviewState: 'pending',
      issueCodes: ['unknown_record_type'],
      channelId: 'syn-channel-uuid-1',
    });
    expect(a.ready).toBe(false);
    expect(a.reasons.join(' ')).toContain('unknown_record_type');
  });
});

describe('link safety', () => {
  it('allows an exact Salesforce Opportunity ID link', () => {
    const a = assessLinkProposal({
      sfOpportunityId: 'syn-sf-opp-1',
      candidateSfOpportunityId: 'syn-sf-opp-1',
      method: 'exact_sf_opportunity_id',
    });
    expect(a.allowed).toBe(true);
  });

  it('fuzzy name or account similarity can never create a link, only a suggestion', () => {
    for (const method of ['name_similarity', 'account_similarity'] as const) {
      const a = assessLinkProposal({
        sfOpportunityId: 'syn-sf-opp-1',
        candidateSfOpportunityId: 'syn-sf-opp-1',
        method,
      });
      expect(a.allowed).toBe(false);
      expect(a.suggestionOnly).toBe(true);
    }
    // Even the exact method fails on a non-identical or blank id.
    expect(
      assessLinkProposal({ sfOpportunityId: 'syn-sf-opp-1', candidateSfOpportunityId: 'syn-sf-opp-2', method: 'exact_sf_opportunity_id' }).allowed,
    ).toBe(false);
    expect(
      assessLinkProposal({ sfOpportunityId: 'syn-sf-opp-1', candidateSfOpportunityId: null, method: 'exact_sf_opportunity_id' }).allowed,
    ).toBe(false);
  });
});

describe('incoming event classification', () => {
  const stored = {
    sfOpportunityId: 'syn-sf-opp-1',
    sourceField: 'Opportunity Record Type',
    oldValue: 'High Potential Prospect',
    newValue: 'Opportunity',
    changedAt: '2026-02-01T09:00:00+00:00',
  };

  it('an exact duplicate is informational and idempotent', () => {
    expect(classifyIncomingEvent(stored, { ...stored })).toBe('exact_duplicate');
    expect(classifyIncomingEvent(undefined, stored)).toBe('new');
  });

  it('treats equivalent timestamp representations as the same immutable event', () => {
    expect(
      classifyIncomingEvent(
        { ...stored, changedAt: '2026-06-24T21:37:43+00:00' },
        { ...stored, changedAt: '2026-06-24T21:37:43.000+0000' },
      ),
    ).toBe('exact_duplicate');
  });

  it('a same-ID row with different content is a conflict that cannot overwrite', () => {
    expect(classifyIncomingEvent(stored, { ...stored, newValue: 'Pursuit' })).toBe('conflict');
    expect(classifyIncomingEvent(stored, { ...stored, changedAt: '2026-02-02T09:00:00+00:00' })).toBe('conflict');
  });
});

describe('insert builders from Bite 5A results', () => {
  const config = {
    recordTypeFieldName: 'Opportunity Record Type',
    recordTypeMap: DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP,
  };
  const rows = [
    {
      historyId: 'oh-b1',
      opportunityId: 'syn-sf-opp-1',
      field: 'Opportunity Record Type',
      oldValue: null,
      newValue: 'High Potential Prospect',
      changedAt: '2026-01-01T09:00:00+02:00',
    },
  ];

  it('preserves the full timezone-carrying timestamp on event inserts', () => {
    const r = adaptOpportunityHistory(rows, config);
    const insert = buildRecordTypeEventInsert(r.ledger[0], 'Opportunity Record Type');
    expect(insert.changed_at).toBe('2026-01-01T09:00:00+02:00');
    expect(insert.event_kind).toBe('record_type');
    expect(insert.to_record_type_state).toBe('hpp');
    expect(insert.sf_history_id).toBe('oh-b1');
  });

  it('emits no derived milestone dates on any insert', () => {
    const r = adaptOpportunityHistory(rows, config);
    const insert = buildRecordTypeEventInsert(r.ledger[0], 'Opportunity Record Type');
    expect(Object.keys(insert).some((k) => k.includes('milestone') || k.endsWith('_date'))).toBe(false);
    const terminal = buildTerminalEventInsert(
      {
        sourceHistoryId: 'oh-t1',
        salesforceOpportunityId: 'syn-sf-opp-1',
        fromStatus: 'open',
        toStatus: 'won',
        changedAt: '2026-03-01T09:00:00Z',
        rawStage: { oldValue: '7) Proposal', newValue: '100) Closed-Won' },
      },
      'Stage',
    );
    expect(terminal.event_kind).toBe('stage');
    expect(terminal.to_terminal_state).toBe('won');
    expect(Object.keys(terminal).some((k) => k.includes('milestone'))).toBe(false);
  });

  it('seeds a pending review with mapped issue codes; ambiguity routes to review', () => {
    const ambiguous = adaptOpportunityHistory(
      [
        { historyId: 'oh-s0', opportunityId: 'syn-sf-opp-2', field: 'Opportunity Record Type', oldValue: null, newValue: 'Opportunity', changedAt: '2026-01-01T09:00:00Z' },
        { historyId: 'oh-s1', opportunityId: 'syn-sf-opp-2', field: 'Opportunity Record Type', oldValue: 'Opportunity', newValue: 'High Potential Prospect', changedAt: '2026-02-01T09:00:00Z' },
        { historyId: 'oh-s2', opportunityId: 'syn-sf-opp-2', field: 'Opportunity Record Type', oldValue: 'Opportunity', newValue: 'Pursuit', changedAt: '2026-02-01T09:00:00Z' },
      ],
      config,
    );
    const seed = buildReviewSeed(ambiguous.opportunities[0], { primaryCampaignSource: 'Synthetic Campaign', commercialRegion: null }, ambiguous.review);
    expect(seed.review_state).toBe('pending');
    // Primary Campaign Source never removes missing_channel; region blank is
    // flagged; the ambiguity reaches the inbox.
    expect(seed.issue_codes).toContain('missing_channel');
    expect(seed.issue_codes).toContain('missing_region');
    expect(seed.issue_codes).toContain('ambiguous_same_timestamp');
    expect(seed.channel_id).toBeNull();
    expect(seed.lead_id).toBeNull();
  });

  it('existing manual deals are untouched: no builder produces attribution writes', () => {
    // The module's entire surface produces sf_opportunity_* shapes only.
    const src = readFileSync(resolve(process.cwd(), 'src/lib/opportunityImportStorage.ts'), 'utf8');
    expect(src).not.toContain("from('attributions')");
    expect(src).not.toContain('supabase');
    expect(MIGRATION).not.toMatch(/attributions\s*\(/i);
  });
});

describe('review audit trail (projection + event as one result)', () => {
  const ctx = { actorType: 'reviewer' as const, actorId: 'syn-reviewer-1', occurredAt: '2026-07-24T10:00:00Z' };
  const pending = {
    reviewState: 'pending' as const,
    issueCodes: ['missing_channel'] as ReviewIssueCode[],
    channelId: null,
    leadId: null,
  };

  it('review creation produces the pending projection and a birth event together', () => {
    const m = createReviewMutation(
      { sf_opportunity_id: 'syn-sf-opp-1', review_state: 'pending', issue_codes: ['missing_channel'], channel_id: null, lead_id: null },
      { ...ctx, actorType: 'system' },
    );
    expect(m.projection.reviewState).toBe('pending');
    expect(m.auditEvent.event_type).toBe('review_created');
    expect(m.auditEvent.previous_state).toBeNull();
    expect(m.auditEvent.new_state).toBe('pending');
    expect(m.auditEvent.issue_codes_snapshot).toEqual(['missing_channel']);
    expect(m.auditEvent.occurred_at).toBe('2026-07-24T10:00:00Z');
  });

  it('walks pending > blocked > reopened > approved > linked > resolved with one event each', () => {
    const blocked = applyReviewTransition(pending, 'blocked', ctx);
    expect(blocked.ok && blocked.mutation.auditEvent.event_type).toBe('state_transition');

    const reopened = applyReviewTransition(
      blocked.ok ? blocked.mutation.projection : pending, 'pending', ctx,
    );
    expect(reopened.ok && reopened.mutation.auditEvent.event_type).toBe('reopened');
    expect(reopened.ok && reopened.mutation.auditEvent.previous_state).toBe('blocked');

    const withChannel = { ...(reopened.ok ? reopened.mutation.projection : pending), channelId: 'syn-channel-uuid-1' };
    const approved = applyReviewTransition(withChannel, 'approved', ctx);
    expect(approved.ok && approved.mutation.auditEvent.event_type).toBe('approval_recorded');

    const linked = applyReviewTransition(approved.ok ? approved.mutation.projection : withChannel, 'linked', ctx);
    expect(linked.ok && linked.mutation.projection.reviewState).toBe('linked');

    const resolved = applyReviewTransition(linked.ok ? linked.mutation.projection : withChannel, 'resolved', ctx);
    expect(resolved.ok && resolved.mutation.auditEvent.new_state).toBe('resolved');
  });

  it('earlier audit events are values that later transitions cannot change', () => {
    const first = applyReviewTransition(pending, 'blocked', ctx);
    const firstEvent = first.ok ? { ...first.mutation.auditEvent } : null;
    const second = applyReviewTransition(first.ok ? first.mutation.projection : pending, 'pending', ctx);
    expect(second.ok).toBe(true);
    // The first event object is untouched by the later mutation.
    expect(first.ok && first.mutation.auditEvent).toEqual(firstEvent);
    expect(firstEvent?.new_state).toBe('blocked');
  });

  it('an invalid transition produces neither a row update nor an event', () => {
    const r = applyReviewTransition({ ...pending, reviewState: 'resolved' }, 'pending', ctx);
    expect(r.ok).toBe(false);
    expect('mutation' in r).toBe(false);
  });

  it('approval without a channel fails before either operation is produced', () => {
    const r = applyReviewTransition(pending, 'approved', ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(' ')).toContain('mandatory');
  });

  it('an exact-link decision creates an auditable link event; fuzzy cannot', () => {
    const ok = applyLinkDecision(
      pending,
      { sfOpportunityId: 'syn-sf-opp-1', candidateSfOpportunityId: 'syn-sf-opp-1', method: 'exact_sf_opportunity_id' },
      ctx,
    );
    expect(ok.ok && ok.mutation.auditEvent.event_type).toBe('link_recorded');
    expect(ok.ok && ok.mutation.projection.reviewState).toBe('linked');
    const fuzzy = applyLinkDecision(
      pending,
      { sfOpportunityId: 'syn-sf-opp-1', candidateSfOpportunityId: 'syn-sf-opp-1', method: 'name_similarity' },
      ctx,
    );
    expect(fuzzy.ok).toBe(false);
  });

  it('the same ingestion conflict yields the same dedupe key; a different hash stays separate', () => {
    const evidence = { sfHistoryId: 'oh-c9', acceptedContentHash: 'hash-accepted-1', conflictingContentHash: 'hash-conflict-1' };
    const a = recordIngestionConflict(pending, evidence, { ...ctx, actorType: 'ingestion' });
    const b = recordIngestionConflict(pending, evidence, { ...ctx, actorType: 'ingestion' });
    expect(a.auditEvent.dedupe_key).toBe(b.auditEvent.dedupe_key);
    expect(a.auditEvent.dedupe_key).toBe('conflict:oh-c9:hash-conflict-1');
    const c = recordIngestionConflict(pending, { ...evidence, conflictingContentHash: 'hash-conflict-2' }, { ...ctx, actorType: 'ingestion' });
    expect(c.auditEvent.dedupe_key).not.toBe(a.auditEvent.dedupe_key);
    // Evidence travels as hashes and the History ID, never raw payloads.
    expect(a.auditEvent.accepted_content_hash).toBe('hash-accepted-1');
    expect(a.auditEvent.sf_history_id).toBe('oh-c9');
    expect(a.projection.issueCodes).toContain('conflicting_history_id');
  });
});

describe('fixture hygiene', () => {
  it('no fixture resembles a real Salesforce ID', () => {
    for (const id of ['syn-sf-opp-1', 'syn-sf-opp-2', 'oh-b1', 'oh-t1', 'syn-channel-uuid-1']) {
      expect(/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(id)).toBe(false);
      expect(id.startsWith('006')).toBe(false);
    }
  });
});
