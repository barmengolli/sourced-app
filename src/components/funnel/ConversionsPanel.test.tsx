// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { FunnelConversionCohorts } from '../../lib/funnelConversionCohorts';
import ConversionsPanel from './ConversionsPanel';

afterEach(cleanup);

const conversions: FunnelConversionCohorts = {
  leadToMql: {
    numerator: 20,
    denominator: 100,
    percent: 20,
    status: 'ready',
    basis: 'Follow the selected Lead memberships forward to MQL.',
  },
  mqlAccountToHpp: {
    numerator: 2,
    denominator: 10,
    percent: 20,
    status: 'partial',
    basis: 'Follow distinct measurable MQL accounts to an approved HPP.',
    coverage: { measured: 10, total: 12 },
  },
  hppToOpp: {
    numerator: 2,
    denominator: 4,
    percent: 50,
    status: 'ready',
    basis: 'Follow the selected HPP cohort forward to Opp.',
  },
  oppToPursuit: {
    numerator: 1,
    denominator: 2,
    percent: 50,
    status: 'ready',
    basis: 'Follow the qualifying Opp cohort forward to Pursuit.',
  },
  pursuitToWon: {
    numerator: 0,
    denominator: 1,
    percent: 0,
    status: 'ready',
    basis: 'Follow the qualifying Pursuit cohort forward to Closed Won.',
  },
  outcomes: { hppCohort: 4, won: 0, lost: 1, inFlight: 3 },
};

describe('ConversionsPanel calculation disclosure', () => {
  it('keeps the panel compact and exposes each calculation through an info tooltip', () => {
    render(<ConversionsPanel conversions={conversions} />);

    expect(screen.getByRole('img', { name: 'How cohort conversion is calculated' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'How Lead to MQL is calculated' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'How MQL account to HPP is calculated' })).toBeTruthy();
    const tooltipText = screen.getAllByRole('tooltip').map((tip) => tip.textContent);
    expect(tooltipText.some((text) => text?.includes('same people'))).toBe(true);
    expect(tooltipText).toContain(
      conversions.leadToMql.basis,
    );
  });

  it('does not change the source-provided metric values', () => {
    render(<ConversionsPanel conversions={conversions} />);

    expect(screen.getAllByText('20.0%')).toHaveLength(2);
    expect(screen.getAllByText('50.0%')).toHaveLength(2);
    expect(screen.getAllByText('0.0%')).toHaveLength(2);
    expect(screen.getByText('Partial account coverage: 10 of 12 MQL memberships have an exact Salesforce Account ID.')).toBeTruthy();
  });
});
