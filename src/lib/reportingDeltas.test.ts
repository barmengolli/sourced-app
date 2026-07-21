// Pure, deterministic tests for the reporting delta utilities. Covers the full
// CLAUDE.md zero/missing state table, rate deltas in percentage points,
// direction-aware tone, and the zero-vs-missing distinction.

import { describe, it, expect } from 'vitest';
import {
  computeDelta,
  computeRateDelta,
  roundForDisplay,
  describeDelta,
} from './reportingDeltas';
import type { MetricValue } from '../types/reporting';

const present = (value: number): MetricValue => ({ state: 'present', value });
const missing: MetricValue = { state: 'missing' };

describe('computeDelta — state table', () => {
  it('value vs positive comparison: absolute and relative', () => {
    const r = computeDelta(present(120), present(100), 'higher_is_better');
    expect(r.kind).toBe('delta');
    expect(r.absolute).toBe(20);
    expect(r.relativePercent).toBeCloseTo(20, 10);
    expect(r.tone).toBe('positive');
  });
  it('positive current vs zero comparison: New, no infinite percentage', () => {
    const r = computeDelta(present(15), present(0), 'higher_is_better');
    expect(r.kind).toBe('new');
    expect(r.absolute).toBe(15);
    expect(r.relativePercent).toBeNull();
    expect(r.tone).toBe('positive');
  });
  it('zero current vs positive comparison: absolute and relative (a real drop)', () => {
    const r = computeDelta(present(0), present(40), 'higher_is_better');
    expect(r.kind).toBe('delta');
    expect(r.absolute).toBe(-40);
    expect(r.relativePercent).toBeCloseTo(-100, 10);
    expect(r.tone).toBe('negative');
  });
  it('zero vs zero: No change', () => {
    const r = computeDelta(present(0), present(0));
    expect(r.kind).toBe('no_change');
    expect(r.absolute).toBe(0);
    expect(r.tone).toBe('neutral');
  });
  it('value vs missing comparison: No comparison data', () => {
    const r = computeDelta(present(50), missing);
    expect(r.kind).toBe('no_comparison_data');
    expect(r.absolute).toBeNull();
  });
  it('missing current: No current data (regardless of comparison)', () => {
    expect(computeDelta(missing, present(50)).kind).toBe('no_current_data');
    expect(computeDelta(missing, missing).kind).toBe('no_current_data');
  });
  it('keeps zero and missing distinct', () => {
    expect(computeDelta(present(0), present(10)).kind).toBe('delta'); // real zero
    expect(computeDelta(missing, present(10)).kind).toBe('no_current_data'); // absent
  });
});

describe('computeDelta — direction-aware tone', () => {
  it('lower_is_better: a decrease is positive tone', () => {
    const r = computeDelta(present(80), present(100), 'lower_is_better'); // CPL fell
    expect(r.absolute).toBe(-20);
    expect(r.tone).toBe('positive');
  });
  it('lower_is_better: an increase is negative tone', () => {
    const r = computeDelta(present(120), present(100), 'lower_is_better');
    expect(r.tone).toBe('negative');
  });
  it('neutral metric is always neutral tone regardless of sign', () => {
    expect(computeDelta(present(120), present(100), 'neutral').tone).toBe('neutral');
    expect(computeDelta(present(80), present(100), 'neutral').tone).toBe('neutral');
  });
  it('defaults to neutral direction when unspecified', () => {
    expect(computeDelta(present(120), present(100)).tone).toBe('neutral');
  });
});

describe('computeRateDelta — percentage points', () => {
  it('reports the absolute change in pp, not a ratio of ratios', () => {
    // CTR 3.2% -> 4.0% is +0.8 pp, and +25% relative.
    const r = computeRateDelta(present(4.0), present(3.2), 'higher_is_better');
    expect(r.kind).toBe('delta');
    expect(r.absolute).toBeCloseTo(0.8, 10); // percentage points
    expect(r.relativePercent).toBeCloseTo(25, 10);
    expect(r.tone).toBe('positive');
  });
  it('lower_is_better rate improving (bounce rate down) is positive tone', () => {
    const r = computeRateDelta(present(2.0), present(5.0), 'lower_is_better');
    expect(r.absolute).toBeCloseTo(-3.0, 10);
    expect(r.tone).toBe('positive');
  });
  it('zero comparison rate with a positive current rate is New', () => {
    const r = computeRateDelta(present(3.0), present(0), 'higher_is_better');
    expect(r.kind).toBe('new');
    expect(r.relativePercent).toBeNull();
  });
  it('missing rate states mirror computeDelta', () => {
    expect(computeRateDelta(missing, present(3)).kind).toBe('no_current_data');
    expect(computeRateDelta(present(3), missing).kind).toBe('no_comparison_data');
  });
});

describe('full precision vs display rounding', () => {
  it('keeps full precision in the result and rounds only on demand', () => {
    const r = computeDelta(present(1), present(3), 'higher_is_better');
    expect(r.relativePercent).toBeCloseTo(-66.66666666, 6); // full precision
    expect(roundForDisplay(r.relativePercent ?? 0)).toBe(-66.7); // display only
  });
  it('rounds half away from zero symmetrically', () => {
    expect(roundForDisplay(0.05, 1)).toBe(0.1);
    expect(roundForDisplay(-0.05, 1)).toBe(-0.1);
  });
});

describe('describeDelta — color-free textual summary', () => {
  it('labels each non-numeric state', () => {
    expect(describeDelta(computeDelta(missing, present(1)))).toBe('No current data');
    expect(describeDelta(computeDelta(present(1), missing))).toBe('No comparison data');
    expect(describeDelta(computeDelta(present(0), present(0)))).toBe('No change');
    expect(describeDelta(computeDelta(present(5), present(0)))).toBe('New');
  });
  it('formats a numeric delta with sign, rounding, and unit', () => {
    expect(describeDelta(computeDelta(present(120), present(100), 'higher_is_better'))).toBe('+20 (+20%)');
    const rate = computeRateDelta(present(4.0), present(3.2), 'higher_is_better');
    expect(describeDelta(rate, 'pp')).toBe('+0.8pp (+25%)');
  });
});
