// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ComputedGrid } from '../../lib/compute';
import FunnelPlanPerformance from './FunnelPlanPerformance';

afterEach(cleanup);

const totals: ComputedGrid['totals'] = {
  lead: { actual: 384, projection: 1344 },
  mql: { actual: 125, projection: 322 },
  hpp: { actual: 1, projection: 36 },
  opp: { actual: 2, projection: 20 },
  pursuit: { actual: null, projection: 8 },
  closeWon: { actual: 0, projection: null },
  closeLost: { actual: 0, projection: null },
};

describe('FunnelPlanPerformance', () => {
  it('renders the supplied authoritative totals without replacing missing values with zero', () => {
    render(<FunnelPlanPerformance totals={totals} />);

    expect(screen.getByText('384 / 1,344')).toBeTruthy();
    expect(screen.getByText('125 / 322')).toBeTruthy();
    expect(screen.getByText('— / 8')).toBeTruthy();
    expect(screen.getByText('0 / —')).toBeTruthy();
  });

  it('uses the same eyebrow and title hierarchy as the conversion card', () => {
    render(<FunnelPlanPerformance totals={totals} />);

    expect(screen.getByText('Plan performance')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Performance against plan', level: 2 })).toBeTruthy();
  });
});
