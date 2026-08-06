// useReportingSelection.ts
//
// The single owner of the reporting period and comparison mode shared by every
// in-scope reporting page (CLAUDE.md sections 4 and 5).
//
// WHY THIS EXISTS
//   Each dashboard previously owned its own `useState<ReportingPeriod | null>`,
//   so navigating from Leads & MQLs to Opportunities silently discarded the
//   selection and every page re-derived its own default. The standard requires
//   an explicit selection to persist while moving between reporting tabs.
//
// THE ONE INVARIANT THAT MATTERS
//   `explicitPeriod` holds ONLY a real user choice, and stays null until the
//   user picks. It is never written by an effect and never seeded from data.
//   Each page derives its own effective period as:
//
//       explicitPeriod ?? <that page's own data-driven default>
//
//   That split is what makes sharing safe across sources with different
//   coverage. A shared *default* would be wrong: the latest month with
//   LinkedIn data is not necessarily the latest month with 6sense data, so
//   forcing one page's default onto another would show an empty period and
//   look like a real zero. A shared *explicit choice* is exactly right,
//   because the user asked for that period everywhere.
//
//   Consequence, stated plainly: before the user touches anything, pages may
//   legitimately show different default periods. After any explicit choice,
//   every page shows the same period. This is deliberate.
//
// CLOCK
//   This hook never reads the clock. Defaults come from data, chosen by each
//   page, so tests are deterministic and a browser timezone can never select a
//   period.

import { useCallback, useState } from 'react';
import type { ComparisonMode, ReportingPeriod } from '../types/reporting';
import { isValidReportingPeriod } from '../lib/reportingPeriods';

export interface ReportingSelection {
  // The user's explicit period choice, or null when they have not chosen. Pages
  // MUST fall back to their own data-driven default rather than inventing one.
  explicitPeriod: ReportingPeriod | null;
  comparison: ComparisonMode;
  setPeriod: (period: ReportingPeriod) => void;
  setComparison: (mode: ComparisonMode) => void;
  // Test and reset affordance: forget the explicit choice and return every page
  // to its own data-driven default.
  clearPeriod: () => void;
}

// `previous_period` is the standard default: it is the comparison a reader
// expects, and it is well defined for every grain.
export const DEFAULT_COMPARISON: ComparisonMode = 'previous_period';

export function useReportingSelection(): ReportingSelection {
  const [explicitPeriod, setExplicitPeriod] = useState<ReportingPeriod | null>(
    null,
  );
  const [comparison, setComparisonState] =
    useState<ComparisonMode>(DEFAULT_COMPARISON);

  const setPeriod = useCallback((period: ReportingPeriod) => {
    // A structurally invalid period (month 13, quarter 5, a non-integer year)
    // is refused rather than stored. Storing it would poison every page at
    // once, since this selection is shared.
    if (!isValidReportingPeriod(period)) return;
    setExplicitPeriod(period);
  }, []);

  const setComparison = useCallback((mode: ComparisonMode) => {
    setComparisonState(mode);
  }, []);

  const clearPeriod = useCallback(() => {
    setExplicitPeriod(null);
  }, []);

  return {
    explicitPeriod,
    comparison,
    setPeriod,
    setComparison,
    clearPeriod,
  };
}

// Resolve the period a page should actually render: the user's explicit choice
// when there is one, otherwise that page's own data-driven default.
//
// Kept as a named pure function rather than inlined `??` at each call site so
// the precedence rule is stated once and can be tested directly.
export function resolvePeriod(
  explicitPeriod: ReportingPeriod | null,
  pageDefault: ReportingPeriod | null,
): ReportingPeriod | null {
  return explicitPeriod ?? pageDefault;
}
