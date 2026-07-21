// @vitest-environment jsdom
//
// Component tests for the migrated LinkedIn Ads dashboard: shared Month /
// Quarter / Year controls, no Week control, the Activity reporting-basis
// disclosure, the data-through copy, partial-period delta suppression, and the
// empty / loading states. Synthetic data only.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LinkedinDashboardPage from './LinkedinDashboardPage';
import type { LinkedinAdSnapshot } from '../types/db';

afterEach(cleanup);

let idc = 0;
function snap(over: Partial<LinkedinAdSnapshot> = {}): LinkedinAdSnapshot {
  idc += 1;
  return {
    id: `s${idc}`,
    snapshot_date: '2026-07-19',
    year: 2026,
    week_number: 29,
    campaign_id: null,
    campaign_name: null,
    product: 'Product A',
    region: 'NA',
    adset_id: 'Ad Set 1',
    adset_name: 'Ad Set 1',
    spend: 100,
    impressions: 5000,
    clicks: 50,
    created_at: '2026-07-20T00:00:00Z',
    ...over,
  };
}

// A complete July: data through the final Sunday (Jul 26) so deltas are not
// suppressed. Includes a June week for previous-period comparison.
function completeJulyData(): LinkedinAdSnapshot[] {
  return [
    snap({ snapshot_date: '2026-06-28', spend: 80, impressions: 4000, clicks: 40 }),
    snap({ snapshot_date: '2026-07-12', spend: 100, impressions: 5000, clicks: 50 }),
    snap({ snapshot_date: '2026-07-19', spend: 120, impressions: 6000, clicks: 66 }),
    snap({ snapshot_date: '2026-07-26', spend: 100, impressions: 5000, clicks: 50 }),
  ];
}

describe('LinkedinDashboardPage — shared timeframe controls', () => {
  it('shows Month / Quarter / Year timeframe and a comparison control', () => {
    render(<LinkedinDashboardPage snapshots={completeJulyData()} loading={false} />);
    const timeframe = screen.getByRole('radiogroup', { name: 'Timeframe' });
    expect(within(timeframe).getByRole('radio', { name: 'Month' })).toBeTruthy();
    expect(within(timeframe).getByRole('radio', { name: 'Quarter' })).toBeTruthy();
    expect(within(timeframe).getByRole('radio', { name: 'Year' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Compare to' })).toBeTruthy();
  });

  it('has NO Week control and no W-number buttons', () => {
    render(<LinkedinDashboardPage snapshots={completeJulyData()} loading={false} />);
    const timeframe = screen.getByRole('radiogroup', { name: 'Timeframe' });
    expect(within(timeframe).queryByRole('radio', { name: 'Week' })).toBeNull();
    // No W27/W28/... week pills anywhere on the page.
    expect(screen.queryByText(/^W\d+$/)).toBeNull();
  });

  it('switches to Quarter grain showing Q1..Q4', async () => {
    const user = userEvent.setup();
    render(<LinkedinDashboardPage snapshots={completeJulyData()} loading={false} />);
    await user.click(screen.getByRole('radio', { name: 'Quarter' }));
    const q = screen.getByRole('radiogroup', { name: 'Quarter' });
    for (const label of ['Q1', 'Q2', 'Q3', 'Q4']) {
      expect(within(q).getByRole('radio', { name: label })).toBeTruthy();
    }
  });
});

describe('LinkedinDashboardPage — disclosure and completeness', () => {
  it('shows the Activity reporting-basis disclosure with the week-ending explanation', () => {
    render(<LinkedinDashboardPage snapshots={completeJulyData()} loading={false} />);
    const note = screen.getByRole('note', { name: 'Reporting basis: Activity' });
    expect(note.textContent).toBe('Activity');
    expect(screen.getByTestId('reporting-basis-disclosure').textContent).toContain(
      'Weekly LinkedIn Ads activity assigned by week-ending Sunday.',
    );
  });

  it('shows "Data through week ending <date>" using the latest imported Sunday', () => {
    render(<LinkedinDashboardPage snapshots={completeJulyData()} loading={false} />);
    expect(screen.getByTestId('linkedin-data-through').textContent).toContain(
      'Data through week ending Jul 26, 2026',
    );
  });

  it('marks a partial period and suppresses deltas', () => {
    // Data only through Jul 19; July final Sunday is Jul 26 -> partial.
    const partial = [
      snap({ snapshot_date: '2026-06-28' }),
      snap({ snapshot_date: '2026-07-19' }),
    ];
    render(<LinkedinDashboardPage snapshots={partial} loading={false} />);
    expect(screen.getByText('Partial period')).toBeTruthy();
    // No delta chips render while partial.
    expect(screen.queryByTestId('delta-display')).toBeNull();
  });

  it('renders deltas for a complete period', () => {
    render(<LinkedinDashboardPage snapshots={completeJulyData()} loading={false} />);
    // Complete July -> deltas shown (at least the KPI tiles have delta chips).
    expect(screen.getAllByTestId('delta-display').length).toBeGreaterThan(0);
  });
});

describe('LinkedinDashboardPage — states and breakdowns', () => {
  it('shows the empty state when there is no data', () => {
    render(<LinkedinDashboardPage snapshots={[]} loading={false} />);
    expect(screen.getByText(/No LinkedIn Ads data yet/)).toBeTruthy();
  });

  it('shows the loading state while loading with no data', () => {
    render(<LinkedinDashboardPage snapshots={[]} loading={true} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('renders the Product, Region, and Ad Set breakdown tables', () => {
    render(<LinkedinDashboardPage snapshots={completeJulyData()} loading={false} />);
    expect(screen.getByText('By Product')).toBeTruthy();
    expect(screen.getByText('By Region')).toBeTruthy();
    expect(screen.getByText('By Ad Set')).toBeTruthy();
  });
});
