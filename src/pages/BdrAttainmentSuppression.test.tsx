// @vitest-environment jsdom
//
// BdrAttainmentSuppression.test.tsx
//
// Quotas are stored ANNUALLY. A month or quarter therefore has partial actuals
// against a full-year target: a rep with a 40 annual quota who hit 10 in Q2,
// exactly on pace, rendered 10/40 = 25% in danger red.
//
// Prorating the annual quota would assume flat seasonality that BDR ramp and
// holiday quarters violate, and CLAUDE.md records that period quota
// interpretation needs business approval. So attainment is SUPPRESSED for
// sub-year grains and the raw count stays visible.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import GaugeChart from '../components/charts/GaugeChart';

afterEach(cleanup);

describe('gauge behaviour under suppression', () => {
  it('shows attainment against the annual quota for the Year grain', () => {
    render(<GaugeChart label="HPP" actual={10} quota={40} />);
    // The full-year view is the one grain where the comparison is honest.
    expect(screen.getByText('/ 40')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();
  });

  it('hides the percentage and the quota when the quota is withheld', () => {
    // Suppression is expressed by withholding the annual quota, NEVER by
    // inventing a smaller prorated one.
    render(<GaugeChart label="HPP" actual={10} quota={null} />);
    expect(screen.queryByText('25%')).toBeNull();
    expect(screen.queryByText(/\/ 40/)).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('keeps the raw actual count visible when suppressed', () => {
    // The count is a real fact about the selected period and must survive.
    render(<GaugeChart label="HPP" actual={10} quota={null} />);
    expect(screen.getByText('10')).toBeTruthy();
  });

  it('renders a genuine zero as zero, not as missing', () => {
    render(<GaugeChart label="HPP" actual={0} quota={null} />);
    expect(screen.getByText('0')).toBeTruthy();
  });

  it('does not colour an on-pace rep as failing when suppressed', () => {
    // The specific defect: 10 of an annual 40 in Q2 is on pace, but
    // pct < 0.5 painted the percentage label danger red. With the quota
    // withheld the tone is neutral, so no performance judgement is implied.
    //
    // Asserted on the label element's inline colour, which is where the
    // judgement is actually expressed. The arc is Recharts SVG that jsdom
    // does not paint, so scanning raw HTML would prove nothing.
    render(<GaugeChart label="HPP" actual={10} quota={null} />);
    const dash = screen.getByText('—');
    expect(dash.getAttribute('style')).not.toMatch(/239,\s*68,\s*68|#EF4444/i);
  });

  it('still colours a real annual attainment', () => {
    // 100% of the annual quota is a success state, and Year is the grain
    // where that judgement is valid.
    render(<GaugeChart label="HPP" actual={40} quota={40} />);
    const pct = screen.getByText('100%');
    expect(pct.getAttribute('style')).toMatch(/16,\s*185,\s*129|#10B981/i);
  });

  it('colours genuine underperformance against an annual quota', () => {
    // Suppression must not become a blanket mute: a real Year-grain miss is
    // still shown as one.
    render(<GaugeChart label="HPP" actual={10} quota={40} />);
    const pct = screen.getByText('25%');
    expect(pct.getAttribute('style')).toMatch(/239,\s*68,\s*68|#EF4444/i);
  });
});
