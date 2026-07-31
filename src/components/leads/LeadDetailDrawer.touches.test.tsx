// @vitest-environment jsdom
//
// Bite 4F: the lead drawer's Campaign touches section. Synthetic data only.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import LeadDetailDrawer from './LeadDetailDrawer';
import { channel, lead, touchRow } from '../../test/fixtures/factories';

afterEach(cleanup);

const CHANNELS = [
  channel({ id: 'c-primary', name: 'Content Syndication' }),
  channel({ id: 'c-other', name: 'Events' }),
];

const LEAD = lead({
  id: 'L1',
  email: 'synth.contact@example.test',
  source_channel_id: 'c-primary',
});

const noop = async () => {};

function renderDrawer(
  touches: ReturnType<typeof touchRow>[],
  status: { loading?: boolean; error?: Error | null } = {},
) {
  return render(
    <LeadDetailDrawer
      lead={LEAD}
      channels={CHANNELS}
      touches={touches}
      touchesLoading={status.loading ?? false}
      touchesError={status.error ?? null}
      onClose={() => {}}
      onEditField={noop}
      onToggleLock={noop}
      onRevertField={noop}
      onSetStageHistory={noop}
      onDelete={noop}
    />,
  );
}

describe('LeadDetailDrawer campaign touches', () => {
  it('renders every touch with channel, date, provenance, and source badge', () => {
    renderDrawer([
      touchRow({
        id: 't1',
        lead_id: 'L1',
        channel_id: 'c-primary',
        touch_date: '2026-01-10',
        parent_campaign: '2026 - Content Syndication',
        sub_campaign: '2026 - Pet Global',
        source: 'import',
      }),
      touchRow({
        id: 't2',
        lead_id: 'L1',
        channel_id: 'c-other',
        touch_date: '2026-05-02',
        source: 'backfill',
      }),
    ]);
    const section = screen.getByText('Campaign touches').closest('section')!;
    const list = within(section);
    expect(list.getByText('Content Syndication')).toBeTruthy();
    expect(list.getByText('Events')).toBeTruthy();
    expect(screen.getByText('2026-01-10')).toBeTruthy();
    expect(screen.getByText('2026-05-02')).toBeTruthy();
    expect(screen.getByText('2026 - Content Syndication / 2026 - Pet Global')).toBeTruthy();
    expect(screen.getByText('import')).toBeTruthy();
    expect(screen.getByText('seed')).toBeTruthy();
  });

  it('marks the primary-source channel and only that one', () => {
    renderDrawer([
      touchRow({ id: 't1', lead_id: 'L1', channel_id: 'c-primary', touch_date: '2026-01-10' }),
      touchRow({ id: 't2', lead_id: 'L1', channel_id: 'c-other', touch_date: '2026-02-10' }),
    ]);
    const primaryMarkers = screen.getAllByText('primary');
    expect(primaryMarkers).toHaveLength(1);
    // The marker sits in the row whose channel is the primary one.
    const row = primaryMarkers[0].closest('li')!;
    expect(within(row).getByText('Content Syndication')).toBeTruthy();
    expect(within(row).queryByText('Events')).toBeNull();
  });

  it('shows the corrected-date indicator with the raw SFDC date in its tooltip', () => {
    renderDrawer([
      touchRow({
        id: 't1',
        lead_id: 'L1',
        channel_id: 'c-primary',
        touch_date: '2026-01-05',
        raw: { sfdc_touch_date: '2026-04-02' },
      }),
    ]);
    const marker = screen.getByText('(corrected)');
    expect(marker.getAttribute('title')).toContain('2026-04-02');
  });

  it('shows an explicit empty state and the memberships basis note', () => {
    renderDrawer([]);
    expect(screen.getByText(/No campaign touches recorded/i)).toBeTruthy();
    expect(screen.getByText(/memberships, overlapping/i)).toBeTruthy();
  });

  it('never renders another lead’s touches', () => {
    renderDrawer([
      touchRow({ id: 't1', lead_id: 'OTHER', channel_id: 'c-other', touch_date: '2026-05-02' }),
    ]);
    expect(screen.getByText(/No campaign touches recorded/i)).toBeTruthy();
    expect(screen.queryByText('2026-05-02')).toBeNull();
  });
});

describe('LeadDetailDrawer touch-history query states', () => {
  it('shows a neutral loading message while touches are loading', () => {
    renderDrawer([], { loading: true });
    expect(screen.getByText(/Loading campaign touches/i)).toBeTruthy();
    // Must NOT claim the contact has no memberships while still loading.
    expect(screen.queryByText(/No campaign touches recorded/i)).toBeNull();
    // The rest of the drawer stays intact.
    expect(screen.getByText('Campaign touches')).toBeTruthy();
    expect(screen.getByText('Stage history')).toBeTruthy();
    expect(screen.getByText('Bookkeeping')).toBeTruthy();
  });

  it('shows a non-destructive error message and never reports an empty history', () => {
    renderDrawer([], { error: new Error('network unreachable') });
    expect(
      screen.getByText(/Campaign touches could not be loaded\. Try refreshing the page\./i),
    ).toBeTruthy();
    expect(screen.queryByText(/No campaign touches recorded/i)).toBeNull();
    expect(screen.queryByText(/Loading campaign touches/i)).toBeNull();
    // Raw error detail never reaches the UI.
    expect(screen.queryByText(/network unreachable/i)).toBeNull();
    // The drawer is not hidden or closed by the failure.
    expect(screen.getByText('Stage history')).toBeTruthy();
    expect(screen.getByText('Bookkeeping')).toBeTruthy();
  });

  it('shows the empty state only after a successful load with zero touches', () => {
    renderDrawer([], { loading: false, error: null });
    expect(screen.getByText(/No campaign touches recorded/i)).toBeTruthy();
    expect(screen.queryByText(/Loading campaign touches/i)).toBeNull();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });

  it('renders the history normally once loaded, with all existing affordances', () => {
    renderDrawer(
      [
        touchRow({
          id: 't1',
          lead_id: 'L1',
          channel_id: 'c-primary',
          touch_date: '2026-01-05',
          parent_campaign: '2026 - Content Syndication',
          sub_campaign: '2026 - Pet Global',
          source: 'import',
          raw: { sfdc_touch_date: '2026-04-02' },
        }),
        touchRow({ id: 't2', lead_id: 'L1', channel_id: 'c-other', touch_date: null, source: 'backfill' }),
      ],
      { loading: false, error: null },
    );
    expect(screen.queryByText(/Loading campaign touches/i)).toBeNull();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
    expect(screen.queryByText(/No campaign touches recorded/i)).toBeNull();
    // Ordering (dated first), primary marker, provenance, seed badge,
    // corrected-date tooltip, and the basis explanation all survive.
    const section = screen.getByText('Campaign touches').closest('section')!;
    const rows = within(section).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Content Syndication')).toBeTruthy();
    expect(within(rows[0]).getByText('primary')).toBeTruthy();
    expect(within(rows[1]).getByText('undated')).toBeTruthy();
    expect(screen.getByText('2026 - Content Syndication / 2026 - Pet Global')).toBeTruthy();
    expect(screen.getByText('seed')).toBeTruthy();
    expect(screen.getByText('(corrected)').getAttribute('title')).toContain('2026-04-02');
    expect(screen.getByText(/memberships, overlapping/i)).toBeTruthy();
  });
});
