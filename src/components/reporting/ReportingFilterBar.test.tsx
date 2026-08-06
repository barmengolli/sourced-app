// @vitest-environment jsdom
//
// Component tests for ReportingFilterBar's Year-comparison normalization: when
// grain switches to Year and comparison is previous_period, the parent
// comparison state is normalized to previous_year (not merely display-mapped).
// Switching between grains that keep both options must not emit a comparison
// change.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
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

describe('ReportingFilterBar unsupported grains', () => {
  function setupGated(period: ReportingPeriod) {
    const onPeriodChange = vi.fn();
    render(
      <ReportingFilterBar
        period={period}
        comparison="previous_period"
        years={[2025, 2026]}
        supportedGrains={['quarter', 'year']}
        disabledGrainReason="Month is not available for this source yet."
        onPeriodChange={onPeriodChange}
        onComparisonChange={() => {}}
      />,
    );
    const timeframe = screen.getByRole('radiogroup', { name: 'Timeframe' });
    return { onPeriodChange, timeframe };
  }

  it('disables an unsupported grain instead of hiding it', () => {
    // Hiding Month would leave a reader wondering whether the app forgot it.
    // Disabling it with a reason answers the question in place.
    const { timeframe } = setupGated(quarter(2026, 2));
    const month = within(timeframe).getByRole('radio', { name: 'Month' });
    expect(month.hasAttribute('disabled')).toBe(true);
    expect(month.getAttribute('title')).toMatch(/not available/i);
  });

  it('cannot select an unsupported grain by click', () => {
    // A month selection here would silently be served as its containing
    // quarter, roughly tripling the number the reader asked for.
    const { onPeriodChange, timeframe } = setupGated(quarter(2026, 2));
    within(timeframe).getByRole('radio', { name: 'Month' }).click();
    expect(onPeriodChange).not.toHaveBeenCalled();
  });

  it('skips an unsupported grain in the keyboard roving order', () => {
    // Arrow keys must step Quarter -> Year -> Quarter, never landing on the
    // disabled Month. Otherwise a keyboard user could select it even though a
    // mouse user cannot.
    const { onPeriodChange, timeframe } = setupGated(quarter(2026, 2));
    const quarterRadio = within(timeframe).getByRole('radio', { name: 'Quarter' });

    fireEvent.keyDown(quarterRadio, { key: 'ArrowLeft' });
    // Wrapping left from Quarter reaches Year, skipping the disabled Month.
    expect(onPeriodChange).toHaveBeenCalledWith({ grain: 'year', year: 2026 });
    for (const call of onPeriodChange.mock.calls) {
      expect(call[0].grain).not.toBe('month');
    }
  });

  it('leaves supported grains fully selectable', () => {
    const { onPeriodChange, timeframe } = setupGated(quarter(2026, 2));
    within(timeframe).getByRole('radio', { name: 'Year' }).click();
    expect(onPeriodChange).toHaveBeenCalledWith({ grain: 'year', year: 2026 });
  });

  it('keeps every grain enabled when no restriction is given', () => {
    const { timeframe } = setup(quarter(2026, 2), 'previous_period');
    const month = within(timeframe).getByRole('radio', { name: 'Month' });
    expect(month.hasAttribute('disabled')).toBe(false);
  });
});
