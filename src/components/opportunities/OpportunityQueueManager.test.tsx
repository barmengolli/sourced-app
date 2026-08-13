// @vitest-environment jsdom
//
// Component tests for the Bite 5C2B1 Opportunity Queue Manager UI. The
// component runs exclusively against the synthetic in-memory adapter; no
// Supabase, no network, no production data. Fixed clock throughout.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OpportunityQueueManager from './OpportunityQueueManager';
import { createMemoryQueueRepository } from '../../test/opportunityQueueMemoryAdapter';
import { queueItem, FIXED_NOW } from '../../test/fixtures/opportunityQueueFixtures';
import type { OpportunityQueueRepository } from '../../lib/opportunityQueueRepository';

afterEach(cleanup);

const CHANNELS = [
  { id: 'SYNTH-CHANNEL-1', name: 'Synthetic LinkedIn Ads' },
  { id: 'SYNTH-CHANNEL-2', name: 'Synthetic Events' },
];

function renderQueue(repository: OpportunityQueueRepository) {
  return render(
    <OpportunityQueueManager
      repository={repository}
      channels={CHANNELS}
      actorId="SYNTH-REVIEWER"
      getNow={() => FIXED_NOW}
    />,
  );
}

describe('load states', () => {
  it('shows the loading state while the queue resolves', () => {
    const never = new Promise<never>(() => {});
    const repository = {
      ...createMemoryQueueRepository([]),
      listQueue: () => never,
    } as unknown as OpportunityQueueRepository;
    renderQueue(repository);
    expect(screen.getByText(/loading queue/i)).toBeTruthy();
  });

  it('shows the empty state when nothing requires review', async () => {
    renderQueue(createMemoryQueueRepository([]));
    await waitFor(() => {
      expect(screen.getByText(/no opportunities currently require review/i)).toBeTruthy();
    });
  });

  it('shows the error state with a retry control when loading fails', async () => {
    renderQueue(createMemoryQueueRepository([], { failListWith: 'synthetic backend unavailable' }));
    await waitFor(() => {
      expect(screen.getByText(/queue could not be loaded/i)).toBeTruthy();
    });
    expect(screen.getByText(/synthetic backend unavailable/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});

describe('queue table and disclosures', () => {
  it('renders the review fields and marks the preview as not live', async () => {
    renderQueue(
      createMemoryQueueRepository([
        queueItem({
          opportunityName: 'Synthetic Alpha Deal',
          accountName: 'Synthetic Alpha Account',
          amount: 42000,
          amountCurrency: 'USD',
          saasRevenueUsd: 41000,
          owner: 'Synthetic Owner A',
        }),
      ]),
    );
    await waitFor(() => {
      expect(screen.getByText('Synthetic Alpha Deal')).toBeTruthy();
    });
    expect(screen.getByText('Synthetic Alpha Account')).toBeTruthy();
    expect(screen.getByText('$41,000')).toBeTruthy();
    expect(screen.getByText('SaaS Revenue USD')).toBeTruthy();
    expect(screen.getByText('Synthetic Owner A')).toBeTruthy();
    // Appears as both the filter chip and the issue chip on the row.
    expect(screen.getAllByText('Missing channel').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/not connected to production data/i)).toBeTruthy();
    expect(screen.getByText(/requires\s+the authenticated review API/i)).toBeTruthy();
  });

  it('shows evidence disclosures and diagnostics behind a detail section', async () => {
    const user = userEvent.setup();
    renderQueue(
      createMemoryQueueRepository([
        queueItem({
          opportunityName: 'Synthetic Evidence Deal',
          evidence: {
            bdrUserId: 'SYNTH-USER-BDR',
            creatorUserId: 'SYNTH-USER-CREATOR',
            suggestedBdrName: 'Dave Cummins',
            primaryCampaignSource: 'SYNTH-CAMPAIGN-EV',
            customerExpansionRaw: 'Synthetic expansion value',
          },
          diagnostics: { sfOpportunityId: 'SYNTH-OPP-DIAG' },
        }),
      ]),
    );
    await waitFor(() => screen.getByText('Synthetic Evidence Deal'));
    await user.click(screen.getByRole('button', { name: 'Review / edit' }));
    expect(screen.getByRole('dialog', { name: 'Synthetic Evidence Deal' })).toBeTruthy();
    expect(screen.getByText(/informational only, never a decision/i)).toBeTruthy();
    expect(screen.getByText(/SYNTH-USER-BDR/)).toBeTruthy();
    expect(screen.getByText(/Suggested BDR: Dave Cummins/)).toBeTruthy();
    expect(screen.getByText(/SYNTH-CAMPAIGN-EV/)).toBeTruthy();
    // The raw Salesforce ID lives only inside the diagnostics disclosure.
    expect(screen.getByText('Diagnostics')).toBeTruthy();
    expect(screen.getByText(/SYNTH-OPP-DIAG/)).toBeTruthy();
  });
});

describe('approval form', () => {
  it('missing channel selection blocks approval with a visible validation reason', async () => {
    const user = userEvent.setup();
    renderQueue(createMemoryQueueRepository([queueItem({ opportunityName: 'Synthetic Pending Deal' })]));
    await waitFor(() => screen.getByText('Synthetic Pending Deal'));
    await user.click(screen.getByText('Synthetic Pending Deal'));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('channel selection is mandatory');
    });
  });

  it('approving with a channel records the action locally and removes the item', async () => {
    const user = userEvent.setup();
    const repo = createMemoryQueueRepository([queueItem({ opportunityName: 'Synthetic Pending Deal' })]);
    renderQueue(repo);
    await waitFor(() => screen.getByText('Synthetic Pending Deal'));
    await user.click(screen.getByText('Synthetic Pending Deal'));
    await user.selectOptions(screen.getByLabelText(/channel \(required\)/i), 'SYNTH-CHANNEL-1');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('no production write');
    });
    expect(screen.getByText(/no opportunities currently require review/i)).toBeTruthy();
    expect(repo.auditLog).toHaveLength(1);
  });

  it('non-approvable blocking issues hide the approval form and explain why', async () => {
    const user = userEvent.setup();
    renderQueue(
      createMemoryQueueRepository([
        queueItem({
          opportunityName: 'Synthetic Conflicted Deal',
          review: {
            reviewState: 'pending',
            issueCodes: ['missing_channel', 'conflicting_history_id'],
            channelId: null,
            leadId: null,
          },
        }),
      ]),
    );
    await waitFor(() => screen.getByText('Synthetic Conflicted Deal'));
    await user.click(screen.getByText('Synthetic Conflicted Deal'));
    expect(screen.getByText(/cannot be approved until its blocking issues are resolved/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('block requires a reason and shows the domain error otherwise', async () => {
    const user = userEvent.setup();
    renderQueue(createMemoryQueueRepository([queueItem({ opportunityName: 'Synthetic Pending Deal' })]));
    await waitFor(() => screen.getByText('Synthetic Pending Deal'));
    await user.click(screen.getByText('Synthetic Pending Deal'));
    await user.click(screen.getByRole('button', { name: 'Block' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('requires a reason');
    });
  });

  it('a blocked review shows the blocked state and reopens to pending', async () => {
    const user = userEvent.setup();
    const repo = createMemoryQueueRepository([
      queueItem({
        opportunityName: 'Synthetic Blocked Deal',
        review: {
          reviewState: 'blocked',
          issueCodes: ['invalid_source_row'],
          channelId: null,
          leadId: null,
        },
      }),
    ]);
    renderQueue(repo);
    await waitFor(() => screen.getByText('Synthetic Blocked Deal'));
    await user.click(screen.getByText('Synthetic Blocked Deal'));
    expect(screen.getByText(/this review is blocked/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /reopen review/i }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Reopen');
    });
    expect(repo.allItems()[0].review?.reviewState).toBe('pending');
  });
});

describe('not selected recovery view', () => {
  const ignoredItem = (name: string, sfId: string) =>
    queueItem({
      opportunityName: name,
      review: { reviewState: 'ignored', issueCodes: ['missing_channel'], channelId: null, leadId: null },
      diagnostics: { sfOpportunityId: sfId },
    });

  it('shows ignored items under Not selected only, never in the active queue', async () => {
    const user = userEvent.setup();
    renderQueue(
      createMemoryQueueRepository([
        queueItem({ opportunityName: 'Synthetic Active Deal' }),
        ignoredItem('Synthetic Set Aside Deal', 'SYNTH-OPP-NS-UI1'),
      ]),
    );
    await waitFor(() => screen.getByText('Synthetic Active Deal'));
    expect(screen.queryByText('Synthetic Set Aside Deal')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Not selected' }));
    await waitFor(() => screen.getByText('Synthetic Set Aside Deal'));
    expect(screen.queryByText('Synthetic Active Deal')).toBeNull();
    // The user-facing label is "Not selected"; the stored word never renders.
    expect(screen.getAllByText('Not selected').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/ignored/i)).toBeNull();
  });

  it('keeps the evidence and diagnostics disclosures in the recovery view', async () => {
    const user = userEvent.setup();
    renderQueue(
      createMemoryQueueRepository([
        queueItem({
          opportunityName: 'Synthetic Ignored Evidence Deal',
          review: { reviewState: 'ignored', issueCodes: [], channelId: null, leadId: null },
          evidence: {
            bdrUserId: 'SYNTH-USER-BDR-NS',
            creatorUserId: null,
            suggestedBdrName: 'Garrett McNally',
            primaryCampaignSource: 'SYNTH-CAMPAIGN-NS',
            customerExpansionRaw: null,
          },
          diagnostics: { sfOpportunityId: 'SYNTH-OPP-NS-UI2' },
        }),
      ]),
    );
    const user2 = user;
    await user2.click(screen.getByRole('button', { name: 'Not selected' }));
    await waitFor(() => screen.getByText('Synthetic Ignored Evidence Deal'));
    await user2.click(screen.getByText('Synthetic Ignored Evidence Deal'));
    expect(screen.getByText(/informational only, never a decision/i)).toBeTruthy();
    expect(screen.getByText(/SYNTH-USER-BDR-NS/)).toBeTruthy();
    expect(screen.getByText('Diagnostics')).toBeTruthy();
    expect(screen.getByText(/SYNTH-OPP-NS-UI2/)).toBeTruthy();
  });

  it('reconsider requires a reason and shows the domain error', async () => {
    const user = userEvent.setup();
    const repo = createMemoryQueueRepository([ignoredItem('Synthetic Ignored Deal', 'SYNTH-OPP-NS-UI3')]);
    renderQueue(repo);
    await user.click(screen.getByRole('button', { name: 'Not selected' }));
    await waitFor(() => screen.getByText('Synthetic Ignored Deal'));
    await user.click(screen.getByText('Synthetic Ignored Deal'));
    await user.click(screen.getByRole('button', { name: 'Reconsider' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('requires a short reason');
    });
    expect(repo.auditLog).toHaveLength(0);
  });

  it('a reasoned reconsider returns the item to the pending queue without approving it', async () => {
    const user = userEvent.setup();
    const repo = createMemoryQueueRepository([ignoredItem('Synthetic Ignored Deal', 'SYNTH-OPP-NS-UI4')]);
    renderQueue(repo);
    await user.click(screen.getByRole('button', { name: 'Not selected' }));
    await waitFor(() => screen.getByText('Synthetic Ignored Deal'));
    await user.click(screen.getByText('Synthetic Ignored Deal'));
    await user.type(screen.getByLabelText(/reason \(required\)/i), 'leadership revisit');
    await user.click(screen.getByRole('button', { name: 'Reconsider' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('no production write');
    });
    // Gone from Not selected; present and pending (not approved) in the queue.
    expect(screen.getByText(/no not-selected opportunities/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Active queue' }));
    await waitFor(() => screen.getByText('Synthetic Ignored Deal'));
    expect(repo.allItems()[0].review?.reviewState).toBe('pending');
    expect(repo.allItems()[0].review?.channelId).toBeNull();
    expect(repo.auditLog).toHaveLength(1);
  });
});
