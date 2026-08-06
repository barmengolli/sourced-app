// @vitest-environment jsdom
//
// useReportingSelection.test.ts
//
// The shared selection owner. The behaviour under test is the one the standard
// actually requires: an explicit choice survives navigation between reporting
// pages, while each page keeps its own data-driven default until then.

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useReportingSelection,
  resolvePeriod,
  DEFAULT_COMPARISON,
} from './useReportingSelection';
import type { ReportingPeriod } from '../types/reporting';

const JUL_2026: ReportingPeriod = { grain: 'month', year: 2026, month: 7 };
const Q3_2026: ReportingPeriod = { grain: 'quarter', year: 2026, quarter: 3 };

describe('useReportingSelection', () => {
  it('starts with no explicit period so pages use their own defaults', () => {
    const { result } = renderHook(() => useReportingSelection());
    // Null is meaningful: it means "the user has not chosen", which is what
    // lets each source default to the latest period IT actually has.
    expect(result.current.explicitPeriod).toBeNull();
    expect(result.current.comparison).toBe(DEFAULT_COMPARISON);
    expect(result.current.comparison).toBe('previous_period');
  });

  it('retains an explicit choice across re-renders, which is what survives navigation', () => {
    const { result, rerender } = renderHook(() => useReportingSelection());
    act(() => result.current.setPeriod(JUL_2026));
    expect(result.current.explicitPeriod).toEqual(JUL_2026);

    // Switching reporting tabs re-renders the tree without remounting this
    // owner. The selection must not reset.
    rerender();
    rerender();
    expect(result.current.explicitPeriod).toEqual(JUL_2026);
  });

  it('keeps the comparison mode independent of the period', () => {
    const { result } = renderHook(() => useReportingSelection());
    act(() => result.current.setComparison('previous_year'));
    act(() => result.current.setPeriod(Q3_2026));
    expect(result.current.comparison).toBe('previous_year');
    expect(result.current.explicitPeriod).toEqual(Q3_2026);

    // Comparison Off is a real, sticky choice, not a transient state.
    act(() => result.current.setComparison('off'));
    expect(result.current.comparison).toBe('off');
  });

  it('refuses a structurally invalid period instead of poisoning every page', () => {
    const { result } = renderHook(() => useReportingSelection());
    act(() => result.current.setPeriod(JUL_2026));

    // Month 13 and quarter 5 do not exist. Because this selection is SHARED,
    // storing one would corrupt every reporting page at once, so it is refused
    // and the last good value stands.
    act(() =>
      result.current.setPeriod({ grain: 'month', year: 2026, month: 13 } as unknown as ReportingPeriod),
    );
    expect(result.current.explicitPeriod).toEqual(JUL_2026);

    act(() =>
      result.current.setPeriod({ grain: 'quarter', year: 2026, quarter: 5 } as unknown as ReportingPeriod),
    );
    expect(result.current.explicitPeriod).toEqual(JUL_2026);
  });

  it('clears back to per-page defaults', () => {
    const { result } = renderHook(() => useReportingSelection());
    act(() => result.current.setPeriod(JUL_2026));
    act(() => result.current.clearPeriod());
    expect(result.current.explicitPeriod).toBeNull();
  });

  it('never reads the clock to pick a period', () => {
    // A clock-derived default would make every dashboard test time-dependent
    // and would let a browser timezone choose the reported period.
    const { result } = renderHook(() => useReportingSelection());
    expect(result.current.explicitPeriod).toBeNull();
  });
});

describe('resolvePeriod', () => {
  const pageDefault: ReportingPeriod = { grain: 'month', year: 2026, month: 5 };

  it('prefers the explicit choice over the page default', () => {
    expect(resolvePeriod(JUL_2026, pageDefault)).toEqual(JUL_2026);
  });

  it('falls back to the page default when nothing is chosen', () => {
    // Deliberate: the latest month with LinkedIn data is not necessarily the
    // latest month with 6sense data, so a SHARED default would show an empty
    // period on some pages and read as a real zero.
    expect(resolvePeriod(null, pageDefault)).toEqual(pageDefault);
  });

  it('returns null when neither exists, so a page can render a loading state', () => {
    // Never invent a period. Null means "cannot report yet", which is honest
    // while data loads.
    expect(resolvePeriod(null, null)).toBeNull();
  });

  it('lets an explicit choice win even when a page has no data for it', () => {
    // The user asked for this period everywhere. A page with no rows in it
    // must show "no data", not silently retarget to a period with data.
    expect(resolvePeriod(Q3_2026, null)).toEqual(Q3_2026);
  });
});
