// @vitest-environment jsdom
//
// Component tests for the remaining shared reporting controls: FilterChipGroup
// (controlled multi-select + clear), ComparisonControl (Year-grain collapse),
// DeltaDisplay (label + tone without relying on color), and ReportingSelect
// (accessible label + controlled change).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FilterChipGroup, { type FilterChip } from './FilterChipGroup';
import ComparisonControl from './ComparisonControl';
import DeltaDisplay from './DeltaDisplay';
import ReportingSelect from './ReportingSelect';
import { computeDelta, computeRateDelta } from '../../lib/reportingDeltas';

afterEach(cleanup);

describe('FilterChipGroup', () => {
  type Region = 'na' | 'emea';
  const chips: FilterChip<Region>[] = [
    { value: 'na', label: 'NA' },
    { value: 'emea', label: 'EMEA' },
  ];

  it('conveys selection via aria-pressed (not color alone) and is controlled', () => {
    const onToggle = vi.fn();
    render(<FilterChipGroup label="Region" chips={chips} selected={['na']} onToggle={onToggle} />);
    expect(screen.getByRole('button', { name: 'NA', pressed: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'EMEA', pressed: false })).toBeTruthy();
    screen.getByRole('button', { name: 'EMEA' }).click();
    expect(onToggle).toHaveBeenCalledWith('emea');
  });

  it('Clear is disabled with no selection and reports onClear when active', () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <FilterChipGroup label="Region" chips={chips} selected={[]} onToggle={() => {}} onClear={onClear} />,
    );
    expect((screen.getByRole('button', { name: 'Clear Region' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <FilterChipGroup label="Region" chips={chips} selected={['na']} onToggle={() => {}} onClear={onClear} />,
    );
    screen.getByRole('button', { name: 'Clear Region' }).click();
    expect(onClear).toHaveBeenCalled();
  });
});

describe('ComparisonControl', () => {
  it('shows three options for month grain', () => {
    render(<ComparisonControl grain="month" value="previous_period" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Compare to' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
  });

  it('collapses to a single previous-year option for year grain', () => {
    render(<ComparisonControl grain="year" value="previous_year" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Compare to' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(2); // Previous year + Off
    expect(within(group).queryByRole('radio', { name: 'Previous period' })).toBeNull();
    expect(within(group).getByRole('radio', { name: 'Previous year' })).toBeTruthy();
  });

  it('maps a stale previous_period value to previous_year on year grain', () => {
    render(<ComparisonControl grain="year" value="previous_period" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Compare to' });
    expect(within(group).getByRole('radio', { checked: true }).getAttribute('aria-label')).toBe('Previous year');
  });
});

describe('DeltaDisplay', () => {
  it('shows a labeled delta with a non-color tone hook and an arrow', () => {
    render(<DeltaDisplay result={computeDelta({ state: 'present', value: 120 }, { state: 'present', value: 100 }, 'higher_is_better')} />);
    const el = screen.getByTestId('delta-display');
    expect(el.getAttribute('data-kind')).toBe('delta');
    expect(el.getAttribute('data-tone')).toBe('positive');
    expect(el.textContent).toContain('+20 (+20%)');
    expect(el.textContent).toContain('↑');
  });

  it('renders New without a percentage', () => {
    render(<DeltaDisplay result={computeDelta({ state: 'present', value: 5 }, { state: 'present', value: 0 })} />);
    expect(screen.getByTestId('delta-display').textContent).toContain('New');
  });

  it('renders missing/zero states distinctly and neutrally', () => {
    const { rerender } = render(
      <DeltaDisplay result={computeDelta({ state: 'missing' }, { state: 'present', value: 3 })} />,
    );
    expect(screen.getByTestId('delta-display').getAttribute('data-kind')).toBe('no_current_data');
    rerender(<DeltaDisplay result={computeDelta({ state: 'present', value: 0 }, { state: 'present', value: 0 })} />);
    expect(screen.getByTestId('delta-display').getAttribute('data-kind')).toBe('no_change');
  });

  it('appends a pp unit for rate deltas', () => {
    render(<DeltaDisplay unit="pp" result={computeRateDelta({ state: 'present', value: 4 }, { state: 'present', value: 3.2 }, 'higher_is_better')} />);
    expect(screen.getByTestId('delta-display').textContent).toContain('+0.8pp');
  });
});

describe('ReportingSelect', () => {
  it('has an accessible label and reports the chosen value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ReportingSelect
        label="Year"
        options={[{ value: '2025', label: '2025' }, { value: '2026', label: '2026' }]}
        value="2026"
        onChange={onChange}
      />,
    );
    const select = screen.getByLabelText('Year');
    await user.selectOptions(select, '2025');
    expect(onChange).toHaveBeenCalledWith('2025');
  });
});
