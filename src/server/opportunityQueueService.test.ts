// Tests for the Bite 5C2B2A framework-neutral Opportunity Queue service
// layer: authorization, internal review identity, scoped idempotency,
// optimistic concurrency, server-side exact-link verification, sanitized
// errors, pagination bounds, allowlisted responses, health/readiness, and
// the static server boundary rules. Synthetic in-memory data only.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  approveReview,
  blockReview,
  getReview,
  health,
  ignoreReview,
  linkExactReview,
  listReviews,
  ready,
  reconsiderReview,
} from './opportunityQueueService';
import * as serviceModule from './opportunityQueueService';
import { computeReviewVersion } from './opportunityQueueServerRepository';
import { MAX_PAGE_SIZE, isValidReviewId } from './opportunityQueueApiContract';
import { makeServiceDeps, testPrincipal } from '../test/opportunityQueueServerTestKit';
import { queueItem, synthReviewUuid } from '../test/fixtures/opportunityQueueFixtures';

const REVIEWER = testPrincipal(['opportunity_queue:read', 'opportunity_queue:review', 'opportunity_queue:link']);
const ADMIN = testPrincipal(['opportunity_queue:admin'], 'SYNTH-IDP-ADMIN-1');

// Synthetic internal review UUIDs (sf_opportunity_reviews.id shaped).
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const R_MISSING = '99999999-9999-4999-8999-999999999999';

function pendingItem(reviewId = R1, over: Parameters<typeof queueItem>[0] = {}) {
  return queueItem({ reviewId, ...over });
}

async function versionOf(deps: ReturnType<typeof makeServiceDeps>, reviewId: string): Promise<string> {
  const item = await deps.repository.getQueueItem(reviewId);
  return computeReviewVersion(item!);
}

function envelope(version: string, key = 'SYNTH-IDEM-1') {
  return { idempotencyKey: key, expectedVersion: version };
}

describe('internal review identity', () => {
  it('reviewId is an opaque internal UUID, never a Salesforce ID', async () => {
    const deps = makeServiceDeps([pendingItem()]);
    expect(isValidReviewId(R1)).toBe(true);
    // A Salesforce-Opportunity-ID-shaped value is rejected before lookup.
    for (const bad of ['SYNTH-OPP-API-1', '006000000000ABCDEF', 'Synthetic Deal 1', '']) {
      expect(isValidReviewId(bad)).toBe(false);
      const read = await getReview(deps, REVIEWER, bad);
      expect(!read.ok && read.body.error.code).toBe('validation_failed');
      const mutate = await ignoreReview(deps, REVIEWER, bad, envelope('v1:any'));
      expect(!mutate.ok && mutate.body.error.code).toBe('validation_failed');
    }
  });

  it('fixtures produce UUID-shaped synthetic review ids', () => {
    const item = queueItem();
    expect(item.reviewId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(synthReviewUuid(7)).toBe('00000000-0000-4000-8000-000000000007');
  });
});

describe('authentication and authorization at the service boundary', () => {
  it('no principal returns unauthenticated on every endpoint', async () => {
    const deps = makeServiceDeps([pendingItem()]);
    const version = await versionOf(deps, R1);
    const responses = [
      await listReviews(deps, null),
      await getReview(deps, null, R1),
      await approveReview(deps, null, R1, { ...envelope(version), channelId: 'SYNTH-CHANNEL-1' }),
      await ignoreReview(deps, null, R1, envelope(version)),
      await blockReview(deps, null, R1, { ...envelope(version), reason: 'r' }),
      await reconsiderReview(deps, null, R1, { ...envelope(version), reason: 'r' }),
      await linkExactReview(deps, null, R1, { ...envelope(version), dealId: 'SYNTH-DEAL-1' }),
    ];
    for (const response of responses) {
      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe('unauthenticated');
      }
    }
  });

  it('a missing capability returns forbidden and performs nothing', async () => {
    const deps = makeServiceDeps([pendingItem()]);
    const readOnly = testPrincipal(['opportunity_queue:read']);
    const version = await versionOf(deps, R1);
    const denied = await approveReview(deps, readOnly, R1, {
      ...envelope(version),
      channelId: 'SYNTH-CHANNEL-1',
    });
    expect(!denied.ok && denied.status).toBe(403);
    expect(!denied.ok && denied.body.error.code).toBe('forbidden');
    expect(deps.memoryRepository.auditLog).toHaveLength(0);
    // Link capability is separate from review capability.
    const reviewer = testPrincipal(['opportunity_queue:review']);
    const linkDenied = await linkExactReview(deps, reviewer, R1, {
      ...envelope(version),
      dealId: 'SYNTH-DEAL-1',
    });
    expect(!linkDenied.ok && linkDenied.body.error.code).toBe('forbidden');
  });

  it('admin cannot bypass channel or blocking-issue domain validation', async () => {
    const deps = makeServiceDeps([
      pendingItem(R1),
      pendingItem(R2, {
        review: {
          reviewState: 'pending',
          issueCodes: ['missing_channel', 'conflicting_history_id'],
          channelId: null,
          leadId: null,
        },
      }),
    ]);
    const v1 = await versionOf(deps, R1);
    const noChannel = await approveReview(deps, ADMIN, R1, { ...envelope(v1), channelId: '' });
    expect(!noChannel.ok && noChannel.body.error.code).toBe('validation_failed');
    const v2 = await versionOf(deps, R2);
    const blockedIssue = await approveReview(deps, ADMIN, R2, {
      ...envelope(v2, 'SYNTH-IDEM-2'),
      channelId: 'SYNTH-CHANNEL-1',
    });
    expect(!blockedIssue.ok && blockedIssue.body.error.code).toBe('validation_failed');
    expect(deps.memoryRepository.auditLog).toHaveLength(0);
  });

  it('actor identity comes from the session principal, never the request body', async () => {
    const deps = makeServiceDeps([pendingItem()]);
    const version = await versionOf(deps, R1);
    const smuggled = await approveReview(deps, REVIEWER, R1, {
      ...envelope(version),
      channelId: 'SYNTH-CHANNEL-1',
      actorId: 'SYNTH-FORGED-ACTOR',
    } as never);
    expect(!smuggled.ok && smuggled.body.error.code).toBe('validation_failed');
    if (!smuggled.ok) {
      expect(smuggled.body.error.reasons?.join(' ')).toContain('unexpected field: actorId');
    }
    const approved = await approveReview(deps, REVIEWER, R1, {
      ...envelope(version, 'SYNTH-IDEM-3'),
      channelId: 'SYNTH-CHANNEL-1',
    });
    expect(approved.ok).toBe(true);
    const audit = deps.memoryRepository.auditLog[0] as { actor_id: string };
    expect(audit.actor_id).toBe('SYNTH-IDP-SUBJECT-1');
  });
});

describe('mutation safeguards', () => {
  it('channel stays explicit and lead stays optional on approval', async () => {
    const deps = makeServiceDeps([pendingItem()]);
    const version = await versionOf(deps, R1);
    const approved = await approveReview(deps, REVIEWER, R1, {
      ...envelope(version),
      channelId: 'SYNTH-CHANNEL-1',
    });
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.body.item.reviewState).toBe('approved');
      expect(approved.body.item.channelId).toBe('SYNTH-CHANNEL-1');
      expect(approved.body.item.leadId).toBeNull();
      expect(approved.body.auditEventType).toBe('approval_recorded');
    }
  });

  it('reconsider requires a reason and follows ignored -> pending', async () => {
    const deps = makeServiceDeps([
      pendingItem(R1, {
        review: { reviewState: 'ignored', issueCodes: ['missing_channel'], channelId: null, leadId: null },
      }),
    ]);
    const version = await versionOf(deps, R1);
    const noReason = await reconsiderReview(deps, REVIEWER, R1, { ...envelope(version), reason: ' ' });
    expect(!noReason.ok && noReason.body.error.code).toBe('validation_failed');
    const recovered = await reconsiderReview(deps, REVIEWER, R1, {
      ...envelope(version, 'SYNTH-IDEM-2'),
      reason: 'leadership revisit',
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.body.item.reviewState).toBe('pending');
      expect(recovered.body.auditEventType).toBe('reopened');
    }
  });

  it('idempotency key and expected version are required', async () => {
    const deps = makeServiceDeps([pendingItem()]);
    const version = await versionOf(deps, R1);
    const missingKey = await approveReview(deps, REVIEWER, R1, {
      idempotencyKey: '',
      expectedVersion: version,
      channelId: 'SYNTH-CHANNEL-1',
    });
    expect(!missingKey.ok && missingKey.body.error.reasons?.join(' ')).toContain('idempotencyKey is required');
    const missingVersion = await approveReview(deps, REVIEWER, R1, {
      idempotencyKey: 'SYNTH-IDEM-1',
      expectedVersion: '',
      channelId: 'SYNTH-CHANNEL-1',
    });
    expect(!missingVersion.ok && missingVersion.body.error.reasons?.join(' ')).toContain('expectedVersion is required');
  });

  it('a stale expected version produces a version conflict and changes nothing', async () => {
    const deps = makeServiceDeps([pendingItem()]);
    const staleVersion = await versionOf(deps, R1);
    const first = await ignoreReview(deps, REVIEWER, R1, envelope(staleVersion, 'SYNTH-IDEM-A'));
    expect(first.ok).toBe(true);
    const stale = await reconsiderReview(deps, REVIEWER, R1, {
      ...envelope(staleVersion, 'SYNTH-IDEM-B'),
      reason: 'stale attempt',
    });
    expect(!stale.ok && stale.status).toBe(409);
    expect(!stale.ok && stale.body.error.code).toBe('version_conflict');
    expect(deps.memoryRepository.auditLog).toHaveLength(1);
  });

  it('acting on a blocked review returns the stable review_blocked code', async () => {
    const deps = makeServiceDeps([
      pendingItem(R1, {
        review: { reviewState: 'blocked', issueCodes: ['invalid_source_row'], channelId: null, leadId: null },
      }),
    ]);
    const version = await versionOf(deps, R1);
    const response = await approveReview(deps, REVIEWER, R1, {
      ...envelope(version),
      channelId: 'SYNTH-CHANNEL-1',
    });
    expect(!response.ok && response.status).toBe(409);
    expect(!response.ok && response.body.error.code).toBe('review_blocked');
  });

  it('an unknown review id returns not_found', async () => {
    const deps = makeServiceDeps([]);
    const response = await getReview(deps, REVIEWER, R_MISSING);
    expect(!response.ok && response.status).toBe(404);
    expect(!response.ok && response.body.error.code).toBe('not_found');
  });

  it('no bulk mutation surface exists', () => {
    expect(Object.keys(serviceModule).some((name) => /bulk|batch/i.test(name))).toBe(false);
    const source = readFileSync(resolve(process.cwd(), 'src/server/opportunityQueueService.ts'), 'utf8');
    expect(source).not.toMatch(/reviewIds\s*:/);
  });
});

describe('exact-link server-side verification', () => {
  const linkSeed = () =>
    pendingItem(R1, { diagnostics: { sfOpportunityId: 'SYNTH-OPP-LINKED' } });

  it('links only when server-loaded evidence matches exactly', async () => {
    const deps = makeServiceDeps([linkSeed()], {
      deals: {
        'SYNTH-DEAL-MATCH': { sfOpportunityId: 'SYNTH-OPP-LINKED' },
        'SYNTH-DEAL-OTHER': { sfOpportunityId: 'SYNTH-OPP-OTHER' },
        'SYNTH-DEAL-BLANK': { sfOpportunityId: null },
      },
    });
    const version = await versionOf(deps, R1);
    // Mismatched stored evidence never links.
    const mismatch = await linkExactReview(deps, REVIEWER, R1, {
      ...envelope(version, 'SYNTH-IDEM-M'),
      dealId: 'SYNTH-DEAL-OTHER',
    });
    expect(!mismatch.ok && mismatch.body.error.code).toBe('validation_failed');
    // Blank stored evidence never links.
    const blank = await linkExactReview(deps, REVIEWER, R1, {
      ...envelope(version, 'SYNTH-IDEM-N'),
      dealId: 'SYNTH-DEAL-BLANK',
    });
    expect(!blank.ok && blank.body.error.code).toBe('validation_failed');
    // Exact stored equality links.
    const linked = await linkExactReview(deps, REVIEWER, R1, {
      ...envelope(version, 'SYNTH-IDEM-L'),
      dealId: 'SYNTH-DEAL-MATCH',
    });
    expect(linked.ok).toBe(true);
    if (linked.ok) expect(linked.body.auditEventType).toBe('link_recorded');
  });

  it('the client cannot submit Salesforce IDs and claim they match', async () => {
    const deps = makeServiceDeps([linkSeed()], {
      deals: { 'SYNTH-DEAL-MATCH': { sfOpportunityId: 'SYNTH-OPP-LINKED' } },
    });
    const version = await versionOf(deps, R1);
    const forged = await linkExactReview(deps, REVIEWER, R1, {
      ...envelope(version),
      dealId: 'SYNTH-DEAL-MATCH',
      candidateSfOpportunityId: 'SYNTH-OPP-LINKED',
    } as never);
    expect(!forged.ok && forged.body.error.code).toBe('validation_failed');
    if (!forged.ok) {
      expect(forged.body.error.reasons?.join(' ')).toContain('unexpected field: candidateSfOpportunityId');
    }
    // An unknown deal id is refused by the server-side resolution.
    const unknownDeal = await linkExactReview(deps, REVIEWER, R1, {
      ...envelope(version, 'SYNTH-IDEM-U'),
      dealId: 'SYNTH-DEAL-MISSING',
    });
    expect(!unknownDeal.ok && unknownDeal.body.error.code).toBe('validation_failed');
    // No similarity-based mutation exists anywhere in the service surface.
    expect(Object.keys(serviceModule).some((name) => /similar|suggest/i.test(name))).toBe(false);
  });
});

describe('idempotency namespace', () => {
  const OTHER = testPrincipal(
    ['opportunity_queue:read', 'opportunity_queue:review'],
    'SYNTH-IDP-SUBJECT-2',
  );

  it('an identical retry replays the original result even after the version advanced', async () => {
    const deps = makeServiceDeps([pendingItem()]);
    const version = await versionOf(deps, R1);
    const body = { ...envelope(version), channelId: 'SYNTH-CHANNEL-1' };
    const first = await approveReview(deps, REVIEWER, R1, body);
    // The approval advanced the review version, so this identical retry
    // would fail the version check; the replay happens FIRST.
    const retry = await approveReview(deps, REVIEWER, R1, body);
    expect(first.ok && retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.body.item).toEqual(first.body.item);
      expect(first.body.replayed).toBe(false);
      expect(retry.body.replayed).toBe(true);
    }
    expect(deps.memoryRepository.auditLog).toHaveLength(1);
  });

  it('the same scope with a different payload conflicts', async () => {
    const deps = makeServiceDeps([pendingItem()]);
    const version = await versionOf(deps, R1);
    const first = await approveReview(deps, REVIEWER, R1, {
      ...envelope(version, 'SYNTH-IDEM-SAME'),
      channelId: 'SYNTH-CHANNEL-1',
    });
    expect(first.ok).toBe(true);
    const conflicting = await approveReview(deps, REVIEWER, R1, {
      ...envelope(version, 'SYNTH-IDEM-SAME'),
      channelId: 'SYNTH-CHANNEL-2',
    });
    expect(!conflicting.ok && conflicting.status).toBe(409);
    expect(!conflicting.ok && conflicting.body.error.code).toBe('idempotency_conflict');
  });

  it('different principals are isolated: no cross-principal replay or leak', async () => {
    const deps = makeServiceDeps([pendingItem()]);
    const version = await versionOf(deps, R1);
    const body = envelope(version, 'SYNTH-IDEM-SHARED');
    const first = await ignoreReview(deps, REVIEWER, R1, body);
    expect(first.ok).toBe(true);
    // The second principal reuses the SAME caller key with the SAME payload:
    // it must NOT receive the first principal's stored response. It reaches
    // the version check and conflicts, proving no replay occurred.
    const second = await ignoreReview(deps, OTHER, R1, body);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.body.error.code).toBe('version_conflict');
      expect(JSON.stringify(second.body)).not.toContain('replayed');
    }
  });

  it('the same principal may reuse a caller key across reviews and actions', async () => {
    const deps = makeServiceDeps([
      pendingItem(R1),
      pendingItem(R2, {
        review: { reviewState: 'ignored', issueCodes: [], channelId: null, leadId: null },
      }),
    ]);
    const v1 = await versionOf(deps, R1);
    const ignored = await ignoreReview(deps, REVIEWER, R1, envelope(v1, 'SYNTH-IDEM-REUSE'));
    expect(ignored.ok).toBe(true);
    // Same key, different review: allowed.
    const v2 = await versionOf(deps, R2);
    const otherReview = await reconsiderReview(deps, REVIEWER, R2, {
      ...envelope(v2, 'SYNTH-IDEM-REUSE'),
      reason: 'different review',
    });
    expect(otherReview.ok).toBe(true);
    // Same key, same review, different action: allowed.
    const v1b = await versionOf(deps, R1);
    const differentAction = await reconsiderReview(deps, REVIEWER, R1, {
      ...envelope(v1b, 'SYNTH-IDEM-REUSE'),
      reason: 'different action',
    });
    expect(differentAction.ok).toBe(true);
  });

  it('blank namespace components fail validation', async () => {
    const deps = makeServiceDeps([pendingItem()]);
    const version = await versionOf(deps, R1);
    const blankKey = await ignoreReview(deps, REVIEWER, R1, envelope(version, '   '));
    expect(!blankKey.ok && blankKey.body.error.code).toBe('validation_failed');
    const blankReview = await ignoreReview(deps, REVIEWER, '', envelope(version));
    expect(!blankReview.ok && blankReview.body.error.code).toBe('validation_failed');
    // A blank subject is rejected earlier as unauthenticated.
    const blankSubject = await ignoreReview(
      deps,
      testPrincipal(['opportunity_queue:review'], '   '),
      R1,
      envelope(version),
    );
    expect(!blankSubject.ok && blankSubject.body.error.code).toBe('unauthenticated');
  });
});

describe('list contract', () => {
  it('separates the attention queue from the not-selected view', async () => {
    const deps = makeServiceDeps([
      pendingItem(R1),
      pendingItem(R2, {
        review: { reviewState: 'ignored', issueCodes: [], channelId: null, leadId: null },
      }),
    ]);
    const attention = await listReviews(deps, REVIEWER, {});
    const notSelected = await listReviews(deps, REVIEWER, { view: 'not_selected' });
    expect(attention.ok && attention.body.items.map((i) => i.reviewId)).toEqual([R1]);
    expect(notSelected.ok && notSelected.body.items.map((i) => i.reviewId)).toEqual([R2]);
    if (notSelected.ok) {
      expect(notSelected.body.items[0].reviewStateLabel).toBe('Not selected');
    }
  });

  it('enforces the bounded maximum page size', async () => {
    const deps = makeServiceDeps([pendingItem()]);
    const tooBig = await listReviews(deps, REVIEWER, { pageSize: MAX_PAGE_SIZE + 1 });
    expect(!tooBig.ok && tooBig.body.error.code).toBe('validation_failed');
    if (!tooBig.ok) {
      expect(tooBig.body.error.reasons?.join(' ')).toContain(`must not exceed ${MAX_PAGE_SIZE}`);
    }
  });

  it('paginates deterministically with totals', async () => {
    const items = Array.from({ length: 7 }, (_, i) => pendingItem(synthReviewUuid(i + 1)));
    const deps = makeServiceDeps(items);
    const page2 = await listReviews(deps, REVIEWER, { page: 2, pageSize: 3 });
    expect(page2.ok).toBe(true);
    if (page2.ok) {
      expect(page2.body.items).toHaveLength(3);
      expect(page2.body.page).toBe(2);
      expect(page2.body.totalItems).toBe(7);
      expect(page2.body.totalPages).toBe(3);
    }
  });

  it('response fields are allowlisted: extra domain fields never leak', async () => {
    const item = pendingItem();
    (item as unknown as Record<string, unknown>).internalScratchpad = 'SYNTH-SECRET-FIELD';
    const deps = makeServiceDeps([item]);
    const response = await listReviews(deps, REVIEWER, {});
    expect(response.ok).toBe(true);
    if (response.ok) {
      const keys = Object.keys(response.body.items[0]).sort();
      expect(keys).toEqual(
        [
          'reviewId',
          'opportunityName',
          'accountName',
          'recordType',
          'stageName',
          'isClosed',
          'amount',
          'amountCurrency',
          'saasRevenue',
          'saasRevenueUsd',
          'createdAt',
          'lastModifiedAt',
          'owner',
          'reviewState',
          'reviewStateLabel',
          'issueCodes',
          'channelId',
          'leadId',
          'evidence',
          'linkStatus',
          'version',
        ].sort(),
      );
      expect(JSON.stringify(response.body)).not.toContain('SYNTH-SECRET-FIELD');
    }
  });

  it('ordinary responses expose no Salesforce, User, or History identifiers', async () => {
    const deps = makeServiceDeps([
      pendingItem(R1, {
        diagnostics: { sfOpportunityId: 'SYNTH-OPP-HIDDEN' },
        evidence: {
          bdrUserId: 'SYNTH-USER-BDR-HIDDEN',
          creatorUserId: 'SYNTH-USER-CREATOR-HIDDEN',
          suggestedBdrName: 'Dave Cummins',
          primaryCampaignSource: 'SYNTH-CAMPAIGN-HIDDEN',
          customerExpansionRaw: 'Synthetic expansion label',
        },
      }),
    ]);
    const list = await listReviews(deps, REVIEWER, {});
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const serialized = JSON.stringify(list.body);
    // No staged Salesforce Opportunity ID, no User IDs, no campaign ID.
    expect(serialized).not.toContain('SYNTH-OPP-HIDDEN');
    expect(serialized).not.toContain('SYNTH-USER');
    expect(serialized).not.toContain('SYNTH-CAMPAIGN-HIDDEN');
    // No real-Salesforce-ID-shaped values of any kind.
    expect(serialized).not.toMatch(/\b(006|005|008|017|012|00Q|003|001)[A-Za-z0-9]{12}\b/);
    // Evidence is reduced to presence flags, the approved normalized BDR
    // suggestion, and the non-identifying label.
    expect(list.body.items[0].evidence).toEqual({
      bdrEvidencePresent: true,
      creatorEvidencePresent: true,
      suggestedBdrName: 'Dave Cummins',
      campaignEvidencePresent: true,
      customerExpansionRaw: 'Synthetic expansion label',
    });
  });
});

describe('errors, health, and readiness', () => {
  it('repository failures become sanitized internal errors', async () => {
    const deps = makeServiceDeps([]);
    deps.repository = {
      ...deps.repository,
      listQueue: async () => {
        throw new Error('connection to db-internal-host-1:5432 failed for user svc_secret');
      },
    };
    const response = await listReviews(deps, REVIEWER, {});
    expect(!response.ok && response.status).toBe(500);
    if (!response.ok) {
      expect(response.body.error.code).toBe('internal_error');
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('db-internal-host');
      expect(serialized).not.toContain('svc_secret');
      expect(serialized).not.toContain('stack');
    }
  });

  it('health reports the process is running and nothing else', () => {
    const response = health();
    expect(response.ok && response.body).toEqual({ status: 'ok' });
  });

  it('readiness never claims ready while adapters are unconfigured', async () => {
    const unconfigured = await ready();
    expect(unconfigured.ok && unconfigured.status).toBe(503);
    if (unconfigured.ok) {
      expect(unconfigured.body.status).toBe('not_ready');
      expect(unconfigured.body.checks).toEqual({
        database: 'unconfigured',
        identityProvider: 'unconfigured',
        configuration: 'unconfigured',
      });
    }
    const failing = await ready({
      database: async () => true,
      identityProvider: async () => {
        throw new Error('idp secret endpoint https://internal.example failed');
      },
      configuration: () => true,
    });
    if (failing.ok) {
      expect(failing.body.status).toBe('not_ready');
      expect(failing.body.checks.identityProvider).toBe('failed');
      expect(JSON.stringify(failing.body)).not.toContain('internal.example');
    }
  });
});

describe('server boundary safety (static)', () => {
  const serverDir = resolve(process.cwd(), 'src/server');
  const serverSources = readdirSync(serverDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ name: `src/server/${f}`, source: readFileSync(resolve(serverDir, f), 'utf8') }));

  it('server code never imports React, Vite env, browser storage, or Supabase', () => {
    expect(serverSources.length).toBeGreaterThanOrEqual(4);
    for (const { name, source } of serverSources) {
      // Doc comments may NAME frameworks to forbid them; code may not use them.
      const codeOnly = source
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      expect(codeOnly, name).not.toMatch(/from ['"]react/);
      expect(codeOnly, name).not.toMatch(/import\.meta\.env|VITE_/);
      expect(codeOnly, name).not.toMatch(/localStorage|sessionStorage/);
      expect(codeOnly, name).not.toMatch(/from ['"].*supabase|createClient/i);
      expect(codeOnly, name).not.toMatch(/express|fastify|hono|next\/|koa/i);
    }
  });

  it('production server code never imports test principals or adapters', () => {
    for (const { name, source } of serverSources) {
      expect(source, name).not.toMatch(/from ['"]\.\.\/test\//);
      expect(source, name).not.toMatch(/testPrincipal|MemoryIdempotencyStore|makeServiceDeps/);
    }
  });

  it('no production authentication bypass exists', () => {
    // Comments may state the rule; CODE may not contain a bypass switch or
    // construct a default principal.
    for (const { name, source } of serverSources) {
      const codeOnly = source
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      expect(codeOnly, name).not.toMatch(/bypass|skipAuth|allowAnonymous|NODE_ENV/i);
      expect(codeOnly, name).not.toMatch(/subject\s*:\s*['"]/);
    }
  });

  it('no production API route or server runtime is wired', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(app).not.toMatch(/opportunityQueueService|server\//);
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const forbidden of ['express', 'fastify', 'hono', 'next', 'koa']) {
      expect(Object.keys(deps), forbidden).not.toContain(forbidden);
    }
  });
});
