// Tests for the Bite 5C2B1 Opportunity Queue domain logic. Synthetic data
// only. Also carries the static browser-safety assertions: the queue
// implementation must never import Supabase, reference a service-role key,
// or gain a production route while the authenticated review API is pending.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BLOCKING_ISSUE_CODES,
  QUEUE_ATTENTION_STATES,
  REVIEW_STATE_LABELS,
  assessQueueApproval,
  assessSimilaritySuggestion,
  classifyQueueMembership,
  filterQueueItems,
  findPossibleExistingManualDeal,
  isApprovable,
  proposeApproval,
  proposeBlock,
  classifyNotSelectedMembership,
  proposeExactLink,
  proposeIgnore,
  proposeReconsider,
  proposeReopen,
} from './opportunityQueue';
import * as queueModule from './opportunityQueue';
import type { ReviewActionContext, ReviewState } from './opportunityImportStorage';
import { queueItem } from '../test/fixtures/opportunityQueueFixtures';
import { createMemoryQueueRepository } from '../test/opportunityQueueMemoryAdapter';
import { attribution } from '../test/fixtures/factories';

const CTX: ReviewActionContext = {
  actorType: 'reviewer',
  actorId: 'SYNTH-REVIEWER',
  occurredAt: '2026-07-28T12:00:00.000Z',
};

describe('legacy duplicate guard', () => {
  const candidate = queueItem({
    opportunityName: 'Synthetic Renewal Program',
    accountName: 'Synthetic Account',
  });

  it('pauses only on an exact normalized manual deal name and account', () => {
    const match = findPossibleExistingManualDeal(candidate, [
      attribution({
        deal_id: 'SYNTH-LEGACY-DEAL',
        label: '  synthetic   renewal program ',
        account: 'SYNTHETIC ACCOUNT',
      }),
    ]);
    expect(match).toEqual({
      dealId: 'SYNTH-LEGACY-DEAL',
      label: 'synthetic   renewal program',
      account: 'SYNTHETIC ACCOUNT',
    });
  });

  it('never treats name-only, account-only, or Salesforce-managed rows as a legacy match', () => {
    expect(
      findPossibleExistingManualDeal(candidate, [
        attribution({ label: candidate.opportunityName, account: 'Different Account' }),
        attribution({ label: 'Different Deal', account: candidate.accountName }),
        attribution({
          source_system: 'salesforce',
          sf_opportunity_id: 'SYNTH-SF-OPP',
          label: candidate.opportunityName,
          account: candidate.accountName,
        }),
      ]),
    ).toBeNull();
  });
});

describe('queue eligibility', () => {
  it('shows only reviews requiring human attention (pending and blocked)', () => {
    expect([...QUEUE_ATTENTION_STATES].sort()).toEqual(['blocked', 'pending']);
    for (const state of ['pending', 'blocked'] as ReviewState[]) {
      const item = queueItem({
        review: { reviewState: state, issueCodes: [], channelId: null, leadId: null },
      });
      expect(classifyQueueMembership(item)).toEqual({ inQueue: true });
    }
  });

  it('service and out-of-scope records never appear in the queue', () => {
    const item = queueItem({ recordTypeState: 'out_of_scope' });
    const membership = classifyQueueMembership(item);
    expect(membership.inQueue).toBe(false);
    if (!membership.inQueue) expect(membership.reason).toContain('never enter the queue');
  });

  it('unknown record types stay visible in the queue but are never approvable', () => {
    const item = queueItem({
      recordTypeState: 'unknown',
      review: {
        reviewState: 'pending',
        issueCodes: ['missing_channel', 'unknown_record_type'],
        channelId: null,
        leadId: null,
      },
    });
    expect(classifyQueueMembership(item)).toEqual({ inQueue: true });
    expect(isApprovable(item)).toBe(false);
    const result = proposeApproval(item, { channelId: 'SYNTH-CHANNEL-1' }, CTX);
    expect(result.ok).toBe(false);
  });

  it('an existing active link does not return to the approval queue', () => {
    const item = queueItem({ linkStatus: 'active' });
    const membership = classifyQueueMembership(item);
    expect(membership.inQueue).toBe(false);
    if (!membership.inQueue) expect(membership.reason).toContain('active link');
  });

  it('ignored, resolved, approved, and linked reviews do not silently reopen', () => {
    for (const state of ['ignored', 'resolved', 'approved', 'linked'] as ReviewState[]) {
      const item = queueItem({
        review: { reviewState: state, issueCodes: [], channelId: 'SYNTH-CHANNEL-1', leadId: null },
      });
      expect(classifyQueueMembership(item).inQueue).toBe(false);
    }
  });

  it('a retired link is never silently re-queued', () => {
    const item = queueItem({ linkStatus: 'retired' });
    const membership = classifyQueueMembership(item);
    expect(membership.inQueue).toBe(false);
    if (!membership.inQueue) expect(membership.reason).toContain('retired');
  });

  it('a linked opportunity moving to Service leaves the funnel but keeps its link', () => {
    const item = queueItem({ linkStatus: 'active', recordTypeState: 'out_of_scope' });
    expect(classifyQueueMembership(item).inQueue).toBe(false);
    // Nothing in the domain removes the link: there is no unlink export.
    expect(Object.keys(queueModule).some((name) => /unlink|retire/i.test(name))).toBe(false);
    expect(item.linkStatus).toBe('active');
  });

  it('returning from Service to the funnel resumes the link without reapproval', () => {
    const item = queueItem({ linkStatus: 'active', recordTypeState: 'hpp' });
    // Still linked: it never re-enters the approval queue.
    const membership = classifyQueueMembership(item);
    expect(membership.inQueue).toBe(false);
    if (!membership.inQueue) expect(membership.reason).toContain('active link');
  });

  it('a record without a review row never appears', () => {
    const item = queueItem({ review: null });
    expect(classifyQueueMembership(item).inQueue).toBe(false);
  });
});

describe('approval rules', () => {
  it('approval requires an explicit channel selection', () => {
    const item = queueItem();
    const result = proposeApproval(item, { channelId: '' }, CTX);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.join(' ')).toContain('channel selection is mandatory');
    }
    const assessment = assessQueueApproval(item, { channelId: '' });
    expect(assessment.ready).toBe(false);
  });

  it('lead association is optional', () => {
    const item = queueItem();
    const result = proposeApproval(item, { channelId: 'SYNTH-CHANNEL-1' }, CTX);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mutation.projection.reviewState).toBe('approved');
      expect(result.mutation.projection.leadId).toBeNull();
      expect(result.mutation.projection.channelId).toBe('SYNTH-CHANNEL-1');
    }
  });

  it('Primary Campaign Source evidence never selects a channel', () => {
    const item = queueItem({
      evidence: {
        bdrUserId: null,
        creatorUserId: null,
        suggestedBdrName: null,
        primaryCampaignSource: 'SYNTH-CAMPAIGN-EVIDENCE',
        customerExpansionRaw: null,
      },
    });
    // With campaign evidence present but no reviewer selection, approval fails.
    const result = proposeApproval(item, { channelId: '' }, CTX);
    expect(result.ok).toBe(false);
    // And a successful approval carries only the reviewer's channel.
    const approved = proposeApproval(item, { channelId: 'SYNTH-CHANNEL-1' }, CTX);
    expect(approved.ok && approved.mutation.projection.channelId).toBe('SYNTH-CHANNEL-1');
  });

  it('BDR and creator evidence never infer inclusion or a channel', () => {
    const item = queueItem({
      evidence: {
        bdrUserId: 'SYNTH-USER-BDR',
        creatorUserId: 'SYNTH-USER-CREATOR',
        suggestedBdrName: 'Dave Cummins',
        primaryCampaignSource: null,
        customerExpansionRaw: null,
      },
    });
    const result = proposeApproval(item, { channelId: '' }, CTX);
    expect(result.ok).toBe(false);
    // Evidence presence does not change queue membership either.
    expect(classifyQueueMembership(item)).toEqual({ inQueue: true });
  });

  it('blocking issues (conflicting history, invalid source rows) prevent approval', () => {
    for (const code of BLOCKING_ISSUE_CODES) {
      const item = queueItem({
        review: {
          reviewState: 'pending',
          issueCodes: [code],
          channelId: null,
          leadId: null,
        },
      });
      expect(isApprovable(item)).toBe(false);
      const result = proposeApproval(item, { channelId: 'SYNTH-CHANNEL-1' }, CTX);
      expect(result.ok).toBe(false);
    }
  });

  it('approval is impossible for out-of-scope records', () => {
    const item = queueItem({ recordTypeState: 'out_of_scope' });
    const result = proposeApproval(item, { channelId: 'SYNTH-CHANNEL-1' }, CTX);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(' ')).toContain('never approvable');
  });
});

describe('ignore, block, and reopen', () => {
  it('ignore succeeds with or without a note', () => {
    expect(proposeIgnore(queueItem(), CTX).ok).toBe(true);
    expect(proposeIgnore(queueItem(), { ...CTX, note: 'synthetic reason' }).ok).toBe(true);
  });

  it('block requires a reason', () => {
    const noReason = proposeBlock(queueItem(), CTX);
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.reasons.join(' ')).toContain('requires a reason');
    const withReason = proposeBlock(queueItem(), { ...CTX, note: 'synthetic blocker' });
    expect(withReason.ok).toBe(true);
    if (withReason.ok) expect(withReason.mutation.auditEvent.note).toBe('synthetic blocker');
  });

  it('reopen follows the review-state contract', () => {
    for (const state of ['ignored', 'blocked'] as ReviewState[]) {
      const item = queueItem({
        review: { reviewState: state, issueCodes: [], channelId: null, leadId: null },
      });
      const result = proposeReopen(item, CTX);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.mutation.projection.reviewState).toBe('pending');
        expect(result.mutation.auditEvent.event_type).toBe('reopened');
      }
    }
    // Resolved is terminal; pending cannot "reopen" to itself.
    for (const state of ['resolved', 'pending'] as ReviewState[]) {
      const item = queueItem({
        review: { reviewState: state, issueCodes: [], channelId: null, leadId: null },
      });
      expect(proposeReopen(item, CTX).ok).toBe(false);
    }
  });

  it('every state-changing decision couples its audit event', () => {
    const cases = [
      { result: proposeApproval(queueItem(), { channelId: 'SYNTH-CHANNEL-1' }, CTX), type: 'approval_recorded' },
      { result: proposeIgnore(queueItem(), CTX), type: 'state_transition' },
      { result: proposeBlock(queueItem(), { ...CTX, note: 'synthetic blocker' }), type: 'state_transition' },
      {
        result: proposeReopen(
          queueItem({ review: { reviewState: 'blocked', issueCodes: [], channelId: null, leadId: null } }),
          CTX,
        ),
        type: 'reopened',
      },
      {
        result: proposeExactLink(
          queueItem({ diagnostics: { sfOpportunityId: 'SYNTH-OPP-LINK' } }),
          'SYNTH-OPP-LINK',
          CTX,
        ),
        type: 'link_recorded',
      },
    ] as const;
    for (const c of cases) {
      expect(c.result.ok).toBe(true);
      if (c.result.ok) {
        expect(c.result.mutation.projection).toBeTruthy();
        expect(c.result.mutation.auditEvent.event_type).toBe(c.type);
        expect(c.result.mutation.auditEvent.occurred_at).toBe(CTX.occurredAt);
      }
    }
  });

  it('no bulk approval path exists', () => {
    // Every exported action operates on exactly one item; no export name
    // suggests a bulk or select-all operation.
    expect(Object.keys(queueModule).some((name) => /bulk|all|batch/i.test(name))).toBe(false);
    const source = readFileSync(resolve(process.cwd(), 'src/lib/opportunityQueue.ts'), 'utf8');
    expect(source).not.toMatch(/items\s*:\s*OpportunityQueueItem\[\]\s*,\s*decision/);
  });
});

describe('linking safeguards', () => {
  it('an exact Salesforce Opportunity ID permits a link proposal', () => {
    const item = queueItem({ diagnostics: { sfOpportunityId: 'SYNTH-OPP-EXACT' } });
    const result = proposeExactLink(item, 'SYNTH-OPP-EXACT', CTX);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mutation.projection.reviewState).toBe('linked');
      expect(result.mutation.auditEvent.dedupe_key).toBe('link:SYNTH-OPP-EXACT');
    }
  });

  it('a mismatched or blank candidate ID never links', () => {
    const item = queueItem({ diagnostics: { sfOpportunityId: 'SYNTH-OPP-EXACT' } });
    expect(proposeExactLink(item, 'SYNTH-OPP-OTHER', CTX).ok).toBe(false);
    expect(proposeExactLink(item, '', CTX).ok).toBe(false);
    expect(proposeExactLink(item, null, CTX).ok).toBe(false);
  });

  it('similar names or accounts can only ever be suggestions', () => {
    const item = queueItem({ diagnostics: { sfOpportunityId: 'SYNTH-OPP-EXACT' } });
    for (const method of ['name_similarity', 'account_similarity'] as const) {
      // Even a perfectly matching ID through a similarity method never links.
      const assessment = assessSimilaritySuggestion(item, 'SYNTH-OPP-EXACT', method);
      expect(assessment.allowed).toBe(false);
      expect(assessment.suggestionOnly).toBe(true);
    }
  });
});

describe('not-selected recovery (reconsider)', () => {
  const ignored = (over: Parameters<typeof queueItem>[0] = {}) =>
    queueItem({
      review: { reviewState: 'ignored', issueCodes: ['missing_channel'], channelId: null, leadId: null },
      ...over,
    });

  it('ignored reviews are labeled "Not selected" without a new stored state', () => {
    expect(REVIEW_STATE_LABELS.ignored).toBe('Not selected');
    // The stored state value itself is unchanged 5B vocabulary.
    expect(ignored().review?.reviewState).toBe('ignored');
  });

  it('ignored opportunities appear under Not Selected, never in the pending queue', () => {
    const item = ignored();
    expect(classifyNotSelectedMembership(item)).toEqual({ inQueue: true });
    expect(classifyQueueMembership(item).inQueue).toBe(false);
    // And pending items never leak into the Not Selected view.
    expect(classifyNotSelectedMembership(queueItem()).inQueue).toBe(false);
  });

  it('reconsider requires a short reason', () => {
    const result = proposeReconsider(ignored(), CTX);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(' ')).toContain('requires a short reason');
  });

  it('reconsider produces ignored -> pending with exactly the reopened audit event', () => {
    const result = proposeReconsider(ignored(), { ...CTX, note: 'leadership review on 2026-07-27' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mutation.projection.reviewState).toBe('pending');
      expect(result.mutation.auditEvent.event_type).toBe('reopened');
      expect(result.mutation.auditEvent.previous_state).toBe('ignored');
      expect(result.mutation.auditEvent.new_state).toBe('pending');
      expect(result.mutation.auditEvent.note).toBe('leadership review on 2026-07-27');
    }
  });

  it('recovery is not approval: the record still needs inspection and a channel', () => {
    const result = proposeReconsider(ignored(), { ...CTX, note: 'synthetic reason' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const recovered = ignored({ review: result.mutation.projection });
    // Back in the pending queue, nothing imported, linked, or attributed.
    expect(classifyQueueMembership(recovered)).toEqual({ inQueue: true });
    expect(recovered.review?.channelId).toBeNull();
    expect(recovered.linkStatus).toBe('none');
    // Approval still demands the explicit channel.
    expect(proposeApproval(recovered, { channelId: '' }, CTX).ok).toBe(false);
    expect(proposeApproval(recovered, { channelId: 'SYNTH-CHANNEL-1' }, CTX).ok).toBe(true);
  });

  it('a not-selected record now in Service cannot be reconsidered and is unavailable', () => {
    const item = ignored({ recordTypeState: 'out_of_scope' });
    expect(classifyNotSelectedMembership(item).inQueue).toBe(false);
    const result = proposeReconsider(item, { ...CTX, note: 'synthetic reason' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(' ')).toContain('Service');
    // History retained: nothing here deletes the review or its events.
    expect(item.review?.reviewState).toBe('ignored');
  });

  it('an unknown record type can be reconsidered but stays non-approvable', () => {
    const item = ignored({
      recordTypeState: 'unknown',
      review: {
        reviewState: 'ignored',
        issueCodes: ['missing_channel', 'unknown_record_type'],
        channelId: null,
        leadId: null,
      },
    });
    const result = proposeReconsider(item, { ...CTX, note: 'synthetic reason' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const recovered = ignored({ recordTypeState: 'unknown', review: result.mutation.projection });
    expect(isApprovable(recovered)).toBe(false);
    expect(proposeApproval(recovered, { channelId: 'SYNTH-CHANNEL-1' }, CTX).ok).toBe(false);
  });

  it('resolved, approved, linked, and pending reviews cannot be recovered', () => {
    for (const state of ['resolved', 'approved', 'linked', 'pending'] as ReviewState[]) {
      const item = queueItem({
        review: { reviewState: state, issueCodes: [], channelId: 'SYNTH-CHANNEL-1', leadId: null },
      });
      const result = proposeReconsider(item, { ...CTX, note: 'synthetic reason' });
      expect(result.ok).toBe(false);
    }
  });

  it('linked and retired-link records are excluded from recovery entirely', () => {
    for (const linkStatus of ['active', 'retired'] as const) {
      const item = ignored({ linkStatus });
      expect(classifyNotSelectedMembership(item).inQueue).toBe(false);
      expect(proposeReconsider(item, { ...CTX, note: 'synthetic reason' }).ok).toBe(false);
    }
  });

  it('Salesforce updates never automatically reopen a not-selected review', () => {
    // The same ignored review with fresh source data (new stage, new
    // modified date, back in an eligible funnel type) stays out of the
    // pending queue until the explicit Reconsider action.
    const updated = ignored({
      recordTypeState: 'hpp',
      stageName: '4) Discovery',
      lastModifiedAt: '2026-07-27T09:00:00.000Z',
    });
    expect(classifyQueueMembership(updated).inQueue).toBe(false);
    expect(classifyNotSelectedMembership(updated)).toEqual({ inQueue: true });
  });

  it('failed recovery mutates nothing and emits no audit event (adapter)', async () => {
    const item = ignored({ diagnostics: { sfOpportunityId: 'SYNTH-OPP-NS1' } });
    const repo = createMemoryQueueRepository([item]);
    const missing = await repo.reconsiderReview(item.reviewId!, {
      actorId: 'SYNTH-REVIEWER',
      occurredAt: CTX.occurredAt,
    });
    expect(missing.ok).toBe(false);
    expect(repo.auditLog).toHaveLength(0);
    expect((await repo.listNotSelected())[0].review?.reviewState).toBe('ignored');
  });

  it('the full recovery cycle preserves the original not-selected audit event', async () => {
    const cycled = queueItem({ diagnostics: { sfOpportunityId: 'SYNTH-OPP-NS2' } });
    const repo = createMemoryQueueRepository([cycled]);
    const ignoredResult = await repo.ignoreReview(cycled.reviewId!, {
      actorId: 'SYNTH-REVIEWER',
      occurredAt: CTX.occurredAt,
      note: 'not selected for import this cycle',
    });
    expect(ignoredResult.ok).toBe(true);
    const originalAudit = repo.auditLog[0];
    expect(await repo.listQueue()).toHaveLength(0);
    expect(await repo.listNotSelected()).toHaveLength(1);

    const recovered = await repo.reconsiderReview(cycled.reviewId!, {
      actorId: 'SYNTH-REVIEWER',
      occurredAt: '2026-07-28T13:00:00.000Z',
      note: 'leadership asked to revisit',
    });
    expect(recovered.ok).toBe(true);
    // Append-only: the original ignored event is untouched, one reopened
    // event was appended, nothing was deleted or rewritten.
    expect(repo.auditLog).toHaveLength(2);
    expect(repo.auditLog[0]).toBe(originalAudit);
    if (recovered.ok) {
      expect(recovered.audit.event_type).toBe('reopened');
      expect(recovered.audit.note).toBe('leadership asked to revisit');
    }
    // Back in the pending queue only; no approval, link, or attribution.
    expect(await repo.listNotSelected()).toHaveLength(0);
    const queue = await repo.listQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].review?.reviewState).toBe('pending');
    expect(queue[0].review?.channelId).toBeNull();
    expect(queue[0].linkStatus).toBe('none');
  });

  it('no bulk recovery path exists', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/opportunityQueue.ts'), 'utf8');
    expect(source).not.toMatch(/reconsiderAll|items\s*:\s*OpportunityQueueItem\[\]\s*,\s*ctx/);
  });
});

describe('queue filters', () => {
  const items = [
    queueItem({ opportunityName: 'Alpha Synthetic', accountName: 'Northwind Synthetic' }),
    queueItem({
      opportunityName: 'Beta Synthetic',
      accountName: 'Contoso Synthetic',
      recordTypeState: 'pursuit',
      isClosed: true,
      review: { reviewState: 'blocked', issueCodes: ['invalid_source_row'], channelId: null, leadId: null },
      evidence: {
        bdrUserId: 'SYNTH-USER-BDR',
        creatorUserId: null,
        suggestedBdrName: 'Garrett McNally',
        primaryCampaignSource: 'SYNTH-CAMPAIGN',
        customerExpansionRaw: null,
      },
    }),
  ];

  it('searches opportunity and account names case-insensitively', () => {
    expect(filterQueueItems(items, { search: 'alpha' })).toHaveLength(1);
    expect(filterQueueItems(items, { search: 'CONTOSO' })).toHaveLength(1);
    expect(filterQueueItems(items, { search: 'nomatch' })).toHaveLength(0);
  });

  it('filters by review status, record type, and open/closed', () => {
    expect(filterQueueItems(items, { reviewStatus: 'blocked' })).toHaveLength(1);
    expect(filterQueueItems(items, { recordType: 'pursuit' })).toHaveLength(1);
    expect(filterQueueItems(items, { openClosed: 'closed' })).toHaveLength(1);
    expect(filterQueueItems(items, { openClosed: 'open' })).toHaveLength(1);
  });

  it('filters by inclusive created-date bounds without timezone conversion', () => {
    const dated = [
      queueItem({ createdAt: '2026-01-15T23:30:00.000Z' }),
      queueItem({ createdAt: '2026-06-30T00:00:00.000Z' }),
    ];
    expect(filterQueueItems(dated, { createdFrom: '2026-06-01' })).toHaveLength(1);
    expect(filterQueueItems(dated, { createdTo: '2026-01-15' })).toHaveLength(1);
    expect(filterQueueItems(dated, { createdFrom: '2026-01-15', createdTo: '2026-06-30' })).toHaveLength(2);
    expect(filterQueueItems(dated, { createdFrom: '2026-07-01' })).toHaveLength(0);
  });

  it('filters by missing channel, blocking issue, and evidence presence', () => {
    expect(filterQueueItems(items, { missingChannelOnly: true })).toHaveLength(1);
    expect(filterQueueItems(items, { blockingIssueOnly: true })).toHaveLength(1);
    expect(filterQueueItems(items, { campaignEvidence: 'present' })).toHaveLength(1);
    expect(filterQueueItems(items, { campaignEvidence: 'missing' })).toHaveLength(1);
    expect(filterQueueItems(items, { bdrEvidence: 'present' })).toHaveLength(1);
    expect(filterQueueItems(items, { bdrEvidence: 'missing' })).toHaveLength(1);
  });
});

describe('in-memory adapter honors the repository contract', () => {
  it('lists only queue-eligible items and applies coupled mutations', async () => {
    const eligible = queueItem({ diagnostics: { sfOpportunityId: 'SYNTH-OPP-Q1' } });
    const repo = createMemoryQueueRepository([
      eligible,
      queueItem({ recordTypeState: 'out_of_scope', diagnostics: { sfOpportunityId: 'SYNTH-OPP-Q2' } }),
      queueItem({ linkStatus: 'active', diagnostics: { sfOpportunityId: 'SYNTH-OPP-Q3' } }),
    ]);
    const queue = await repo.listQueue();
    expect(queue.map((i) => i.diagnostics.sfOpportunityId)).toEqual(['SYNTH-OPP-Q1']);

    // Repository methods key on the opaque internal review UUID.
    const result = await repo.approveReview(
      eligible.reviewId!,
      { channelId: 'SYNTH-CHANNEL-1' },
      { actorId: 'SYNTH-REVIEWER', occurredAt: CTX.occurredAt },
    );
    expect(result.ok).toBe(true);
    expect(repo.auditLog).toHaveLength(1);
    // The approved item leaves the attention queue.
    expect(await repo.listQueue()).toHaveLength(0);
  });

  it('a failed action mutates nothing and records no audit event', async () => {
    const item = queueItem({ diagnostics: { sfOpportunityId: 'SYNTH-OPP-Q1' } });
    const repo = createMemoryQueueRepository([item]);
    const result = await repo.approveReview(
      item.reviewId!,
      { channelId: '' },
      { actorId: 'SYNTH-REVIEWER', occurredAt: CTX.occurredAt },
    );
    expect(result.ok).toBe(false);
    expect(repo.auditLog).toHaveLength(0);
    expect((await repo.listQueue())[0].review?.reviewState).toBe('pending');
  });
});

describe('browser safety (static)', () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
  const QUEUE_SOURCES = [
    'src/lib/opportunityQueue.ts',
    'src/lib/opportunityQueueRepository.ts',
    'src/components/opportunities/OpportunityQueueManager.tsx',
    'src/test/opportunityQueueMemoryAdapter.ts',
    'src/test/fixtures/opportunityQueueFixtures.ts',
  ];

  it('no queue source imports Supabase or references a service-role key', () => {
    for (const path of QUEUE_SOURCES) {
      const source = read(path);
      expect(source, path).not.toMatch(/from ['"].*supabase/i);
      // Prose may explain WHY service_role is server-only; no code may build
      // a client, read a key from the environment, or embed a JWT.
      expect(source, path).not.toMatch(/createClient/);
      expect(source, path).not.toMatch(/import\.meta\.env/);
      expect(source, path).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    }
  });

  it('embeds the queue in Data Entry without creating a separate navigation route', () => {
    expect(read('src/App.tsx')).not.toContain('OpportunityQueueManager');
    expect(read('src/constants/sidebar.ts')).not.toMatch(/queue/i);
    expect(read('src/pages/FunnelDataEntryPage.tsx')).toContain('OpportunityQueuePanel');
    expect(read('src/pages/FunnelDataEntryPage.tsx')).toContain('Review Salesforce opportunities');
  });

  it('synthetic fixtures contain no real Salesforce or customer identifiers', () => {
    for (const path of QUEUE_SOURCES) {
      const source = read(path);
      // Salesforce IDs are 15/18 chars on known key prefixes; none may appear.
      expect(source, path).not.toMatch(/\b(006|005|008|017|012|00Q|003|001)[A-Za-z0-9]{12}\b/);
    }
    expect(read('src/test/fixtures/opportunityQueueFixtures.ts')).toContain('SYNTH-');
  });

  it('the UI renders no bulk-selection affordance', () => {
    const source = read('src/components/opportunities/OpportunityQueueManager.tsx');
    expect(source).not.toMatch(/type="checkbox"/);
    expect(source).not.toMatch(/approve all|bulk/i);
  });
});
