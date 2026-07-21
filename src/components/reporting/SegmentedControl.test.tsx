// @vitest-environment jsdom
//
// Component tests for the shared SegmentedControl: controlled behavior,
// keyboard interaction (radio-group), and accessible labels / selected state.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SegmentedControl, { type SegmentedOption } from './SegmentedControl';

afterEach(cleanup);

type Grain = 'month' | 'quarter' | 'year';
const options: SegmentedOption<Grain>[] = [
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
];

describe('SegmentedControl', () => {
  it('exposes a radiogroup with an accessible name and one checked option', () => {
    render(<SegmentedControl label="Timeframe" options={options} value="quarter" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Timeframe' });
    expect(group).toBeTruthy();
    const checked = screen.getByRole('radio', { checked: true });
    expect(checked.getAttribute('aria-label')).toBe('Quarter');
  });

  it('is controlled: clicking an option reports onChange but does not self-update', () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Timeframe" options={options} value="month" onChange={onChange} />);
    screen.getByRole('radio', { name: 'Year' }).click();
    expect(onChange).toHaveBeenCalledWith('year');
    // Still shows the parent-controlled value until the parent re-renders.
    expect(screen.getByRole('radio', { checked: true }).getAttribute('aria-label')).toBe('Month');
  });

  it('supports keyboard arrow navigation and wraps', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SegmentedControl label="Timeframe" options={options} value="month" onChange={onChange} />);
    const first = screen.getByRole('radio', { name: 'Month' });
    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('quarter');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    // From month (index 0), ArrowLeft wraps to the last option (year).
    expect(onChange).toHaveBeenLastCalledWith('year');
  });

  it('Home and End jump to the first and last enabled option', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SegmentedControl label="Timeframe" options={options} value="quarter" onChange={onChange} />);
    screen.getByRole('radio', { name: 'Quarter' }).focus();
    await user.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('year');
    await user.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith('month');
  });

  it('skips disabled options during keyboard navigation', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const opts: SegmentedOption<Grain>[] = [
      { value: 'month', label: 'Month' },
      { value: 'quarter', label: 'Quarter', disabled: true },
      { value: 'year', label: 'Year' },
    ];
    render(<SegmentedControl label="Timeframe" options={opts} value="month" onChange={onChange} />);
    screen.getByRole('radio', { name: 'Month' }).focus();
    await user.keyboard('{ArrowRight}');
    // Quarter is disabled, so the next enabled option is Year.
    expect(onChange).toHaveBeenLastCalledWith('year');
  });
});
