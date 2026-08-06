// reportingPeriodBridge.test.ts
//
// The bridge between the shared reporting standard and the legacy funnel
// calculator. The behaviour that matters most is a refusal: a month period must
// NOT be widened into its containing quarter, because reporting July as Q3
// would silently roughly triple the number the reader asked for.

import { describe, it, expect } from 'vitest';
import {
  toPeriodFilter,
  fromPeriodFilter,
  legacySupportsPeriod,
  LEGACY_FUNNEL_GRAINS,
  MONTH_DISABLED_REASON,
} from './reportingPeriodBridge';
import type { ReportingPeriod } from '../types/reporting';

describe('toPeriodFilter', () => {
  it('maps each quarter to its legacy filter', () => {
    for (const q of [1, 2, 3, 4] as const) {
      expect(toPeriodFilter({ grain: 'quarter', year: 2026, quarter: q }))
        .toBe(`Q${q}`);
    }
  });

  it('maps a year period to the year filter', () => {
    expect(toPeriodFilter({ grain: 'year', year: 2026 })).toBe('year');
  });

  it('refuses a month rather than widening it to a quarter', () => {
    // THE POINT OF THIS MODULE. Every month of Q3 must return null, not 'Q3'.
    // Silently answering a July question with July-August-September is the
    // exact class of defect the reporting standard exists to prevent.
    for (const m of [7, 8, 9] as const) {
      expect(toPeriodFilter({ grain: 'month', year: 2026, month: m }))
        .toBeNull();
    }
    // And every other month, so no boundary month sneaks through.
    for (let m = 1; m <= 12; m += 1) {
      expect(
        toPeriodFilter({
          grain: 'month',
          year: 2026,
          month: m as 1,
        }),
        `month ${m}`,
      ).toBeNull();
    }
  });
});

describe('fromPeriodFilter', () => {
  it('round-trips every legacy value the calculator can produce', () => {
    for (const f of ['year', 'Q1', 'Q2', 'Q3', 'Q4'] as const) {
      const period = fromPeriodFilter(2026, f);
      expect(toPeriodFilter(period), f).toBe(f);
    }
  });

  it('preserves the year across the conversion', () => {
    expect(fromPeriodFilter(2024, 'Q2')).toEqual({
      grain: 'quarter',
      year: 2024,
      quarter: 2,
    });
    expect(fromPeriodFilter(2025, 'year')).toEqual({
      grain: 'year',
      year: 2025,
    });
  });
});

describe('legacySupportsPeriod', () => {
  it('accepts quarter and year, refuses month', () => {
    expect(legacySupportsPeriod({ grain: 'quarter', year: 2026, quarter: 1 })).toBe(true);
    expect(legacySupportsPeriod({ grain: 'year', year: 2026 })).toBe(true);
    expect(legacySupportsPeriod({ grain: 'month', year: 2026, month: 1 })).toBe(false);
  });

  it('agrees with the declared legacy grain list', () => {
    // The list drives the disabled state in the UI; if the two disagreed, a
    // page could offer a grain its calculator cannot serve.
    const periods: ReportingPeriod[] = [
      { grain: 'month', year: 2026, month: 1 },
      { grain: 'quarter', year: 2026, quarter: 1 },
      { grain: 'year', year: 2026 },
    ];
    for (const p of periods) {
      expect(legacySupportsPeriod(p), p.grain)
        .toBe(LEGACY_FUNNEL_GRAINS.includes(p.grain));
    }
  });

  it('excludes month from the legacy grain list', () => {
    expect(LEGACY_FUNNEL_GRAINS).toEqual(['quarter', 'year']);
    expect(LEGACY_FUNNEL_GRAINS).not.toContain('month');
  });
});

describe('MONTH_DISABLED_REASON', () => {
  it('explains why rather than just stating unavailability', () => {
    // A bare "not available" invites someone to "fix" it by splitting
    // quarters. The copy has to say that splitting would invent data.
    expect(MONTH_DISABLED_REASON).toMatch(/invent/i);
    expect(MONTH_DISABLED_REASON).toMatch(/quarter/i);
  });

  it('follows house copy rules', () => {
    expect(MONTH_DISABLED_REASON).not.toContain('—');
    // Sentence case, not Title Case or ALL CAPS.
    expect(MONTH_DISABLED_REASON).not.toMatch(/\b[A-Z]{4,}\b/);
  });
});
