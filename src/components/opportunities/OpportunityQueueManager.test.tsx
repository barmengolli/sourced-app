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
import { attribution } from '../../test/fixtures/factories';
import type { Attribution } from '../../types/db';

afterEach(cleanup);

const CHANNELS = [
  { id: 'SYNTH-CHANNEL-1', name: 'Synthetic LinkedIn Ads' },
  { id: 'SYNTH-CHANNEL-2', name: 'Synthetic Events' },
];

function renderQueue(
  repository: OpportunityQueueRepository,
  live = false,
  attributions: Attribution[] = [],
) {
  return render(
    <OpportunityQueueManager
      repository={repository}
      channels={CHANNELS}
      attributions={attributions}
      actorId="SYNTH-REVIEWER"
      getNow={() => FIXED_NOW}
      live={live}
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
    expect(screen.getAllByText('Dave Cummins').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('SYNTH-CAMPAIGN-EV')).toBeTruthy();
    // Raw Salesforce and user IDs never render in the reviewer UI.
    expect(screen.queryByText(/SYNTH-USER-BDR/)).toBeNull();
    expect(screen.queryByText(/SYNTH-OPP-DIAG/)).toBeNull();
    expect(screen.getByText('Diagnostics')).toBeTruthy();
  });

  it('links live opportunity names to the exact Salesforce record in a new tab', async () => {
    renderQueue(
      createMemoryQueueRepository([
        queueItem({
          opportunityName: 'Synthetic Salesforce Deal',
          salesforceUrl: 'https://eisgroup.lightning.force.com/lightning/r/Opportunity/006PZ00000VXQczYAH/view',
        }),
      ]),
      true,
    );
    const link = await screen.findByRole('link', { name: /open synthetic salesforce deal in salesforce/i });
    expect(link.getAttribute('href')).toBe(
      'https://eisgroup.lightning.force.com/lightning/r/Opportunity/006PZ00000VXQczYAH/view',
    );
    expect(link.getAttribute('target')).toBe('_blank');
  });
});

describe('approval form', () => {
  it('offers atomic in-place adoption only for a server-proven exact Salesforce ID match', async () => {
    const user = userEvent.setup();
    const item = queueItem({
      opportunityName: 'Synthetic Existing Deal',
      accountName: 'Synthetic Existing Account',
      existingManualDeal: {
        dealId: 'SYNTH-LEGACY-DEAL',
        label: 'Synthetic Existing Deal',
        account: 'Synthetic Existing Account',
        attributionRows: 3,
        attributionTouches: 8,
      },
    });
    const repo = createMemoryQueueRepository([item], {
      deals: { 'SYNTH-LEGACY-DEAL': { sfOpportunityId: item.diagnostics.sfOpportunityId } },
    });
    renderQueue(repo, true);

    await user.click(await screen.findByRole('button', { name: 'Review / edit' }));
    expect(screen.getByRole('alert').textContent).toContain('Existing Sourced deal verified');
    expect(screen.getByRole('alert').textContent).toContain('3 reporting rows');
    expect(screen.getByRole('alert').textContent).toContain('8 attribution touches');
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Use existing Sourced deal' }));
    expect((await screen.findByRole('status')).textContent).toContain('Existing Sourced deal linked saved');
    expect(repo.allItems()[0].review?.reviewState).toBe('linked');
    expect(repo.auditLog).toHaveLength(1);
  });

  it('pauses approval when an exact legacy Sourced deal already exists', async () => {
    const user = userEvent.setup();
    const item = queueItem({
      opportunityName: 'Synthetic Existing Deal',
      accountName: 'Synthetic Existing Account',
    });
    const repo = createMemoryQueueRepository([item]);
    renderQueue(
      repo,
      true,
      [
        attribution({
          deal_id: 'SYNTH-LEGACY-DEAL',
          label: item.opportunityName,
          account: item.accountName,
        }),
      ],
    );

    await user.click(await screen.findByRole('button', { name: 'Review / edit' }));
    expect(screen.getByRole('alert').textContent).toContain('Possible existing Sourced deal');
    expect(screen.getByText(/nothing was merged, deleted, or changed automatically/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect(repo.auditLog).toHaveLength(0);
  });

  it('pauses approval when more than one legacy deal has the same exact name and account', async () => {
    const user = userEvent.setup();
    const item = queueItem({
      opportunityName: 'Synthetic Ambiguous Deal',
      accountName: 'Synthetic Ambiguous Account',
    });
    const repo = createMemoryQueueRepository([item]);
    renderQueue(repo, true, [
      attribution({ deal_id: 'SYNTH-DEAL-A', label: item.opportunityName, account: item.accountName }),
      attribution({ deal_id: 'SYNTH-DEAL-B', label: item.opportunityName, account: item.accountName }),
    ]);

    await user.click(await screen.findByRole('button', { name: 'Review / edit' }));
    expect(screen.getByRole('alert').textContent).toContain('Multiple possible existing Sourced deals');
    expect(screen.getByRole('alert').textContent).toContain('2 legacy Sourced deals');
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect(repo.auditLog).toHaveLength(0);
  });

  it('shows the Salesforce closed outcome and records it through approval', async () => {
    const user = userEvent.setup();
    renderQueue(
      createMemoryQueueRepository([
        queueItem({
          opportunityName: 'Synthetic Closed Deal',
          recordTypeState: 'pursuit',
          stageName: 'Closed-Lost-Competitor',
          isClosed: true,
          isWon: false,
          closeDate: '2026-07-31',
          sourceLostReason: 'Closed-Lost to Competitor',
          editable: {
            sourceMarket: 'Synthetic Market',
            sourceCommercialRegion: 'NA',
            sourceGtmCube: 'Synthetic Cube',
            marketOverride: null,
            commercialRegionOverride: null,
            gtmCubeOverride: null,
            bdrName: null,
            hppEnteredAt: '2026-05-01',
            oppEnteredAt: '2026-06-01',
            pursuitEnteredAt: '2026-07-01',
          },
        }),
      ]),
    );

    await user.click(await screen.findByRole('button', { name: 'Review / edit' }));
    expect(screen.getByText('Closed outcome')).toBeTruthy();
    expect(screen.getAllByText('Closed lost').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('2026-07-31')).toBeTruthy();
    expect(screen.getByText('Closed-Lost to Competitor')).toBeTruthy();
    expect(screen.getByText(/update the Opportunity in Salesforce/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve & record Closed Lost' })).toBeTruthy();
  });

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

  it('preselects only a valid exact campaign-channel suggestion and remains editable', async () => {
    const user = userEvent.setup();
    renderQueue(
      createMemoryQueueRepository([
        queueItem({
          opportunityName: 'Synthetic Suggested Deal',
          evidence: {
            bdrUserId: null,
            creatorUserId: null,
            suggestedBdrName: null,
            primaryCampaignSource: 'Synthetic Events campaign',
            customerExpansionRaw: null,
            suggestedChannelId: 'SYNTH-CHANNEL-2',
            suggestedChannelName: 'Synthetic Events',
          },
        }),
      ]),
    );
    await user.click(await screen.findByRole('button', { name: 'Review / edit' }));
    const channel = screen.getByLabelText(/channel \(required\)/i) as HTMLSelectElement;
    expect(channel.value).toBe('SYNTH-CHANNEL-2');
    await user.selectOptions(channel, 'SYNTH-CHANNEL-1');
    expect(channel.value).toBe('SYNTH-CHANNEL-1');
    expect(screen.getByText(/suggested from exact primary campaign source/i)).toBeTruthy();
  });

  it('selects a Sourced lead only after an exact email match', async () => {
    const user = userEvent.setup();
    const repo = createMemoryQueueRepository(
      [queueItem({ opportunityName: 'Synthetic Lead Match Deal' })],
      {
        leadsByEmail: {
          'person@example.com': {
            id: 'SYNTH-LEAD-1', email: 'person@example.com',
            firstName: 'Synthetic', lastName: 'Person', account: 'Synthetic Account',
          },
        },
      },
    );
    renderQueue(repo);
    await user.click(await screen.findByRole('button', { name: 'Review / edit' }));
    await user.type(screen.getByLabelText(/lead email/i), ' Person@Example.com ');
    await user.click(screen.getByRole('button', { name: /find exact match/i }));
    await waitFor(() => expect(screen.getByText(/exact email match selected/i)).toBeTruthy());
    expect(screen.getByText('Synthetic Person')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText(/channel \(required\)/i), 'SYNTH-CHANNEL-1');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(repo.auditLog).toHaveLength(1));
    expect(repo.allItems()[0].review?.leadId).toBe('SYNTH-LEAD-1');
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
    expect(screen.queryByText(/SYNTH-USER-BDR-NS/)).toBeNull();
    expect(screen.getByText('Diagnostics')).toBeTruthy();
    expect(screen.queryByText(/SYNTH-OPP-NS-UI2/)).toBeNull();
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
