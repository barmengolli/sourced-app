// @vitest-environment jsdom
//
// Component tests for ReportingFilterBar's Year-comparison normalization: when
// grain switches to Year and comparison is previous_period, the parent
// comparison state is normalized to previous_year (not merely display-mapped).
// Switching between grains that keep both options must not emit a comparison
// change.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import ReportingFilterBar from './ReportingFilterBar';
import type { ComparisonMode, ReportingPeriod } from '../../types/reporting';

afterEach(cleanup);

const quarter = (year: number, q: number): ReportingPeriod => ({
  grain: 'quarter',
  year,
  quarter: q as 1 | 2 | 3 | 4,
});

function setup(period: ReportingPeriod, comparison: ComparisonMode) {
  const onPeriodChange = vi.fn();
  const onComparisonChange = vi.fn();
  render(
    <ReportingFilterBar
      period={period}
      comparison={comparison}
      years={[2025, 2026]}
      onPeriodChange={onPeriodChange}
      onComparisonChange={onComparisonChange}
    />,
  );
  const timeframe = screen.getByRole('radiogroup', { name: 'Timeframe' });
  return { onPeriodChange, onComparisonChange, timeframe };
}

describe('ReportingFilterBar — Year comparison normalization', () => {
  it('normalizes previous_period to previous_year when switching to Year', () => {
    const { onPeriodChange, onComparisonChange, timeframe } = setup(quarter(2026, 2), 'previous_period');
    within(timeframe).getByRole('radio', { name: 'Year' }).click();
    expect(onPeriodChange).toHaveBeenCalledWith({ grain: 'year', year: 2026 });
    expect(onComparisonChange).toHaveBeenCalledWith('previous_year');
  });

  it('preserves off when switching to Year', () => {
    const { onComparisonChange, timeframe } = setup(quarter(2026, 2), 'off');
    within(timeframe).getByRole('radio', { name: 'Year' }).click();
    expect(onComparisonChange).not.toHaveBeenCalled();
  });

  it('preserves an existing previous_year when switching to Year', () => {
    const { onComparisonChange, timeframe } = setup(quarter(2026, 2), 'previous_year');
    within(timeframe).getByRole('radio', { name: 'Year' }).click();
    expect(onComparisonChange).not.toHaveBeenCalled();
  });

  it('does not emit a comparison change when switching Quarter -> Month', () => {
    const { onPeriodChange, onComparisonChange, timeframe } = setup(quarter(2026, 2), 'previous_period');
    within(timeframe).getByRole('radio', { name: 'Month' }).click();
    expect(onPeriodChange).toHaveBeenCalledWith({ grain: 'month', year: 2026, month: 1 });
    expect(onComparisonChange).not.toHaveBeenCalled();
  });

  it('after normalization the visible control and intended state agree on previous_year', () => {
    // Render in the post-normalization state (year grain + previous_year) and
    // confirm the collapsed control shows previous_year selected.
    render(
      <ReportingFilterBar
        period={{ grain: 'year', year: 2026 }}
        comparison="previous_year"
        years={[2025, 2026]}
        onPeriodChange={() => {}}
        onComparisonChange={() => {}}
      />,
    );
    const compare = screen.getByRole('radiogroup', { name: 'Compare to' });
    expect(within(compare).getByRole('radio', { checked: true }).getAttribute('aria-label')).toBe('Previous year');
    expect(within(compare).queryByRole('radio', { name: 'Previous period' })).toBeNull();
  });
});
