// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComputedGrid } from '../../lib/compute';
import FunnelStageSummary from './FunnelStageSummary';

afterEach(cleanup);

const totals: ComputedGrid['totals'] = {
  lead: { actual: 1_234, projection: 1_400 },
  mql: { actual: 456, projection: 500 },
  hpp: { actual: 37, projection: 42 },
  opp: { actual: 21, projection: 24 },
  pursuit: { actual: 9, projection: 12 },
  closeWon: { actual: 3, projection: 4 },
  closeLost: { actual: 2, projection: null },
};

describe('FunnelStageSummary', () => {
  it('renders the exact supplied table totals without recomputing them', () => {
    render(<FunnelStageSummary totals={totals} />);

    const summary = screen.getByRole('region', { name: 'Funnel snapshot' });
    expect(within(summary).getByText('1,234')).toBeTruthy();
    expect(within(summary).getByText('456')).toBeTruthy();
    expect(within(summary).getByText('37')).toBeTruthy();
    expect(within(summary).getByText('21')).toBeTruthy();
    expect(within(summary).getByText('9')).toBeTruthy();
    expect(within(summary).getByText('3')).toBeTruthy();
    expect(within(summary).getByText('Plan 1,400')).toBeTruthy();
    expect(within(summary).getByText('Plan 500')).toBeTruthy();
  });

  it('keeps missing source-backed values visibly missing instead of showing zero', () => {
    render(
      <FunnelStageSummary
        totals={{
          ...totals,
          hpp: { actual: null, projection: null },
        }}
      />,
    );

    const hppCard = screen.getByText('HPP (SQL)').closest('article');
    expect(hppCard).toBeTruthy();
    expect(within(hppCard as HTMLElement).getByText('—')).toBeTruthy();
    expect(within(hppCard as HTMLElement).getByText('Plan —')).toBeTruthy();
    expect(within(hppCard as HTMLElement).queryByText('0')).toBeNull();
  });

  it('contains the executive heading and note inside one named section', () => {
    render(
      <FunnelStageSummary
        totals={totals}
        note="Same totals as Operations"
      />,
    );

    const summary = screen.getByRole('region', { name: 'Funnel snapshot' });
    expect(within(summary).getByText('Executive scorecard')).toBeTruthy();
    expect(within(summary).getByText('Same totals as Operations')).toBeTruthy();
  });
});
