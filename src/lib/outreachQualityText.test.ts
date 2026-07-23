// Tests for the data-quality reason formatter. Every message must derive from
// the engine's own result, and the causes must read distinctly. Synthetic
// states only.

import { describe, it, expect } from 'vitest';
import {
  metricIssueReasons,
  cadenceIssueReasons,
  sequenceActivityReason,
  incompleteDisclosure,
} from './outreachQualityText';
import type { MetricTotal, OutreachCompleteness, SequenceActivity } from './outreachReporting';

function total(over: Partial<MetricTotal & { issues: Record<string, number> }> = {}): MetricTotal {
  return {
    state: 'present',
    value: 100,
    incomplete: true,
    issues: { resets: 0, ambiguousDuplicates: 0, missingBaselines: 0, missingMeasurements: 0, ...(over as { issues?: Record<string, number> }).issues },
    ...(over as object),
  } as MetricTotal;
}

const completeness: Pick<OutreachCompleteness, 'requiredBaselineThursday' | 'missingBaselineThursday' | 'missingThursdays'> = {
  requiredBaselineThursday: '2026-05-28',
  missingBaselineThursday: true,
  missingThursdays: ['2026-06-11'],
};

describe('metricIssueReasons', () => {
  it('includes the required boundary date for missing baselines', () => {
    const r = metricIssueReasons(total({ issues: { missingBaselines: 3 } }), completeness);
    expect(r.join(' ')).toContain('3 sequences lacked the required May 28 baseline');
  });
  it('distinguishes missing measurements, resets, and ambiguous duplicates', () => {
    expect(metricIssueReasons(total({ issues: { missingMeasurements: 2 } })).join(' ')).toContain('missing measurements');
    expect(metricIssueReasons(total({ issues: { resets: 1 } })).join(' ')).toContain('counter reset');
    expect(metricIssueReasons(total({ issues: { ambiguousDuplicates: 1 } })).join(' ')).toContain('ambiguous duplicate');
  });
  it('returns nothing for a complete total', () => {
    expect(metricIssueReasons(total({ incomplete: false }))).toEqual([]);
  });
});

describe('cadenceIssueReasons', () => {
  const full = (over: Partial<OutreachCompleteness>): OutreachCompleteness => ({
    completeness: 'partial',
    missingThursdays: [],
    requiredBaselineThursday: null,
    missingBaselineThursday: false,
    finalExpectedThursday: null,
    dataThrough: '2026-07-30',
    suppressDelta: true,
    ...over,
  });
  it('names the missing boundary and missing scheduled Thursdays distinctly', () => {
    const r = cadenceIssueReasons(full({ requiredBaselineThursday: '2026-05-28', missingBaselineThursday: true, missingThursdays: ['2026-06-11'] }));
    expect(r.join(' ')).toContain('required May 28 baseline snapshot is missing');
    expect(r.join(' ')).toContain('scheduled Thursday run missing (Jun 11)');
  });
  it('reports missing when no snapshots exist', () => {
    expect(cadenceIssueReasons(full({ completeness: 'missing' }))).toEqual(['no snapshots exist in this period']);
  });
});

describe('sequenceActivityReason', () => {
  it('gives a distinct message per state', () => {
    const present = (o: Partial<Extract<SequenceActivity, { state: 'present' }>>): SequenceActivity => ({ state: 'present', value: 0, baselineIncomplete: false, missingMeasurements: false, ...o });
    expect(sequenceActivityReason(present({ baselineIncomplete: true }))).toContain('debuted without a prior baseline');
    expect(sequenceActivityReason(present({ missingMeasurements: true }))).toContain('did not measure this metric');
    expect(sequenceActivityReason({ state: 'reset' })).toContain('reset or correction');
    expect(sequenceActivityReason({ state: 'missing_baseline' }, '2026-05-28')).toContain('May 28');
    expect(sequenceActivityReason({ state: 'ambiguous_duplicate' })).toContain('Ambiguous duplicate');
    expect(sequenceActivityReason({ state: 'missing' })).toContain('No data');
    // A fully complete present value has no reason.
    expect(sequenceActivityReason(present({}))).toBe('');
  });
});

describe('incompleteDisclosure', () => {
  it('joins reasons into the standard safe-to-prove sentence', () => {
    expect(incompleteDisclosure(['3 sequences lacked the required May 28 baseline'])).toBe(
      'Incomplete: 3 sequences lacked the required May 28 baseline; values shown are the activity we can safely prove.',
    );
    expect(incompleteDisclosure([])).toBe('');
  });
});
