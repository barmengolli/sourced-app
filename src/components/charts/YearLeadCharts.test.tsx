// @vitest-environment jsdom
//
// Step 10: the channel selection is a derived value (memoized default +
// dataset-keyed override), not effect-driven state. These tests assert:
//   1. initial default selection is applied,
//   2. a user override persists across an unrelated rerender,
//   3. the default updates (and a stale override drops) when the channel
//      dataset identity changes.
//
// Recharts' ResponsiveContainer needs layout dimensions jsdom doesn't provide,
// so it's stubbed to a plain box. We assert on the selector UI + the visible
// count of selected channels, which is what the derived logic drives.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import YearLeadCharts from './YearLeadCharts';
import type { MonthlyChannelLeads, MonthlyLeadsForYear } from '../../lib/compute';

vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 800, height: 320 }}>{children}</div>
    ),
  };
});

afterEach(cleanup);

function ch(name: string, total: number): MonthlyChannelLeads {
  const perMonth = new Array<number>(12).fill(0);
  perMonth[0] = total;
  return { channelId: name, channelName: name, perMonth };
}

// The component derives "current" via isCurrent on the merged set, which it
// builds from data.byChannel (current) + priorYearByChannel (prior). We drive
// the current-year set through `data`.
function makeData(channels: MonthlyChannelLeads[]): MonthlyLeadsForYear {
  return {
    byChannel: channels,
    monthTotals: new Array<number>(12).fill(0),
    quarterlyFallback: [],
  };
}

function ensureOpen() {
  const trigger = screen.getByRole('button', { name: /Channels \(/i });
  if (trigger.getAttribute('aria-expanded') !== 'true') {
    fireEvent.click(trigger);
  }
  return screen.getByRole('listbox');
}

describe('YearLeadCharts — derived channel selection', () => {
  it('applies the computed default on first render (top 2 current channels)', () => {
    const data = makeData([
      ch('2026 - Alpha', 100),
      ch('2026 - Beta', 50),
      ch('2026 - Gamma', 10),
    ]);
    render(<YearLeadCharts data={data} year={2026} />);
    const listbox = ensureOpen();
    const checked = within(listbox)
      .getAllByRole('option')
      .filter((o) => o.getAttribute('aria-selected') === 'true');
    // Default with no prior year = top 2 current channels.
    expect(checked).toHaveLength(2);
    const labels = checked.map((c) => c.textContent);
    expect(labels.some((l) => l?.includes('Alpha'))).toBe(true);
    expect(labels.some((l) => l?.includes('Beta'))).toBe(true);
  });

  it('persists a user override across an unrelated rerender', () => {
    const data = makeData([ch('2026 - Alpha', 100), ch('2026 - Beta', 50), ch('2026 - Gamma', 10)]);
    const { rerender } = render(<YearLeadCharts data={data} year={2026} />);
    // User clears all, then selects only Gamma.
    let listbox = ensureOpen();
    fireEvent.click(within(listbox).getByRole('button', { name: /clear/i }));
    listbox = screen.getByRole('listbox');
    fireEvent.click(within(listbox).getByText(/Gamma/));

    // Unrelated rerender: same data identity, different loading flag.
    rerender(<YearLeadCharts data={data} year={2026} loading={false} />);
    listbox = ensureOpen();
    const checked = within(listbox)
      .getAllByRole('option')
      .filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0].textContent).toContain('Gamma');
  });

  it('drops a stale override and re-derives the default when the dataset changes', () => {
    const first = makeData([ch('2026 - Alpha', 100), ch('2026 - Beta', 50)]);
    const { rerender } = render(<YearLeadCharts data={first} year={2026} />);
    // Override to just Alpha.
    let listbox = ensureOpen();
    fireEvent.click(within(listbox).getByRole('button', { name: /clear/i }));
    listbox = screen.getByRole('listbox');
    fireEvent.click(within(listbox).getByText(/Alpha/));

    // Switch to a completely different channel dataset (year change).
    const second = makeData([ch('2027 - Delta', 80), ch('2027 - Echo', 40)]);
    rerender(<YearLeadCharts data={second} year={2027} />);
    listbox = ensureOpen();
    const checked = within(listbox)
      .getAllByRole('option')
      .filter((o) => o.getAttribute('aria-selected') === 'true');
    // Stale override (Alpha) no longer applies; default of the new set applies.
    const labels = checked.map((c) => c.textContent);
    expect(labels.some((l) => l?.includes('Delta'))).toBe(true);
    expect(labels.some((l) => l?.includes('Alpha'))).toBe(false);
  });
});
