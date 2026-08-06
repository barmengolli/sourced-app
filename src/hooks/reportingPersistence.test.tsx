// @vitest-environment jsdom
//
// reportingPersistence.test.tsx
//
// Cross-page persistence: an explicit period and comparison chosen on one
// reporting tab must survive navigation to another.
//
// Before this work, each dashboard owned its own useState, so moving from
// Leads & MQLs to Opportunities silently discarded the selection and every
// page re-derived its own default. These tests drive the owner through a
// simulated navigation, not through a single component's lifetime.

import { describe, it, expect } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { useState } from 'react';
import {
  useReportingSelection,
  resolvePeriod,
} from './useReportingSelection';
import type { ReportingPeriod } from '../types/reporting';

// A minimal two-page app: one selection owner above, pages swapped below.
// This is the real shape of App.tsx, where PageBody re-renders with a
// different page while the owner stays mounted.
function Harness({
  pageADefault,
  pageBDefault,
}: {
  pageADefault: ReportingPeriod | null;
  pageBDefault: ReportingPeriod | null;
}) {
  const reporting = useReportingSelection();
  const [page, setPage] = useState<'a' | 'b'>('a');
  const pageDefault = page === 'a' ? pageADefault : pageBDefault;
  const effective = resolvePeriod(reporting.explicitPeriod, pageDefault);

  return (
    <div>
      <span data-testid="page">{page}</span>
      <span data-testid="period">
        {effective ? JSON.stringify(effective) : 'none'}
      </span>
      <span data-testid="comparison">{reporting.comparison}</span>
      <span data-testid="explicit">
        {reporting.explicitPeriod ? 'set' : 'unset'}
      </span>
      <button type="button" onClick={() => setPage(page === 'a' ? 'b' : 'a')}>
        navigate
      </button>
      <button
        type="button"
        onClick={() =>
          reporting.setPeriod({ grain: 'quarter', year: 2026, quarter: 2 })
        }
      >
        pick Q2
      </button>
      <button type="button" onClick={() => reporting.setComparison('previous_year')}>
        compare year
      </button>
      <button type="button" onClick={() => reporting.setComparison('off')}>
        compare off
      </button>
    </div>
  );
}

const MAY: ReportingPeriod = { grain: 'month', year: 2026, month: 5 };
const JUL: ReportingPeriod = { grain: 'month', year: 2026, month: 7 };
const Q2 = JSON.stringify({ grain: 'quarter', year: 2026, quarter: 2 });

const click = (name: string) => act(() => screen.getByText(name).click());
const period = () => screen.getByTestId('period').textContent;
const comparison = () => screen.getByTestId('comparison').textContent;

describe('explicit selection persists across reporting tabs', () => {
  it('carries an explicit period from one page to another', () => {
    render(<Harness pageADefault={JUL} pageBDefault={MAY} />);
    // Page A starts on its own data default.
    expect(period()).toBe(JSON.stringify(JUL));

    click('pick Q2');
    expect(period()).toBe(Q2);

    // Navigating must NOT reset the choice, and page B must not fall back to
    // its own default now that an explicit choice exists.
    click('navigate');
    expect(screen.getByTestId('page').textContent).toBe('b');
    expect(period()).toBe(Q2);

    // And back again.
    click('navigate');
    expect(period()).toBe(Q2);
    cleanup();
  });

  it('carries the comparison mode across navigation', () => {
    render(<Harness pageADefault={JUL} pageBDefault={MAY} />);
    expect(comparison()).toBe('previous_period');
    click('compare year');
    click('navigate');
    expect(comparison()).toBe('previous_year');
    cleanup();
  });

  it('keeps comparison Off sticky across navigation', () => {
    // Off is a real choice, not a transient state. Silently restoring a
    // comparison on the next page would show a delta the user turned off.
    render(<Harness pageADefault={JUL} pageBDefault={MAY} />);
    click('compare off');
    click('navigate');
    expect(comparison()).toBe('off');
    cleanup();
  });

  it('lets each page keep its OWN default until the user chooses', () => {
    // Deliberate: the latest month with LinkedIn data is not the latest month
    // with 6sense data. A shared default would show an empty period on some
    // pages, which reads as a real zero.
    render(<Harness pageADefault={JUL} pageBDefault={MAY} />);
    expect(period()).toBe(JSON.stringify(JUL));
    click('navigate');
    expect(period()).toBe(JSON.stringify(MAY));
    expect(screen.getByTestId('explicit').textContent).toBe('unset');
    cleanup();
  });

  it('overrides a page default even when that page has no data for the period', () => {
    // The user asked for this period everywhere. A page with no rows must show
    // "no data", never silently retarget to a period that does have data.
    render(<Harness pageADefault={JUL} pageBDefault={null} />);
    click('pick Q2');
    click('navigate');
    expect(period()).toBe(Q2);
    cleanup();
  });

  it('shows no period when neither an explicit choice nor a default exists', () => {
    // Honest while data loads. A period is never invented.
    render(<Harness pageADefault={null} pageBDefault={null} />);
    expect(period()).toBe('none');
    cleanup();
  });

  it('survives repeated navigation, not just one hop', () => {
    render(<Harness pageADefault={JUL} pageBDefault={MAY} />);
    click('pick Q2');
    for (let i = 0; i < 6; i += 1) click('navigate');
    expect(period()).toBe(Q2);
    cleanup();
  });
});
