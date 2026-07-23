// Pure formatting of Bite 3A data-quality results into human-readable reasons
// (Bite 3C). This module performs NO calculation: every message is derived
// directly from the engine's own MetricTotal.issues, SequenceActivity states,
// and OutreachCompleteness fields, so the displayed reason always matches the
// result that made a value incomplete. It never claims more detail than the
// engine proved.

import type {
  MetricTotal,
  SequenceActivity,
  OutreachCompleteness,
} from './outreachReporting';

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

// Timezone-safe "May 28" / "May 28, 2026" from YYYY-MM-DD.
export function formatShortDate(iso: string | null, withYear = false): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  const mo = parseInt(m[2], 10);
  if (mo < 1 || mo > 12) return '';
  const base = `${MONTHS_SHORT[mo - 1]} ${parseInt(m[3], 10)}`;
  return withYear ? `${base}, ${m[1]}` : base;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Reason list for an aggregated metric total, using the engine's own issue
// counts and (when available) the completeness assessment's boundary date.
// Returns [] for a complete total.
export function metricIssueReasons(
  total: MetricTotal,
  completeness?: Pick<OutreachCompleteness, 'requiredBaselineThursday' | 'missingBaselineThursday' | 'missingThursdays'> | null,
): string[] {
  if (total.state !== 'present' || !total.incomplete) return [];
  const out: string[] = [];
  const { missingBaselines, missingMeasurements, resets, ambiguousDuplicates } = total.issues;
  if (missingBaselines > 0) {
    const boundary = completeness?.requiredBaselineThursday
      ? ` required ${formatShortDate(completeness.requiredBaselineThursday)} baseline`
      : ' required baseline snapshot';
    out.push(`${plural(missingBaselines, 'sequence')} lacked the${boundary}`);
  }
  if (missingMeasurements > 0) {
    out.push(`${plural(missingMeasurements, 'sequence')} had missing measurements for this metric`);
  }
  if (resets > 0) {
    out.push(`${plural(resets, 'counter reset')} detected (values excluded)`);
  }
  if (ambiguousDuplicates > 0) {
    out.push(`${plural(ambiguousDuplicates, 'ambiguous duplicate snapshot')} excluded`);
  }
  // The total can also be incomplete because a contributing sequence's baseline
  // was itself incomplete (debut growth). The engine folds that into
  // `incomplete` without a separate count; when no other issue explains it,
  // state the debut cause without inventing a number.
  if (out.length === 0) {
    out.push('some sequences debuted without a prior baseline, so earlier activity is unknown');
  }
  return out;
}

// Reason list for the period's schedule cadence, from the completeness result.
export function cadenceIssueReasons(c: OutreachCompleteness): string[] {
  const out: string[] = [];
  if (c.missingBaselineThursday && c.requiredBaselineThursday) {
    out.push(`the required ${formatShortDate(c.requiredBaselineThursday)} baseline snapshot is missing`);
  }
  if (c.missingThursdays.length > 0) {
    out.push(
      `${plural(c.missingThursdays.length, 'scheduled Thursday run')} missing (${c.missingThursdays
        .map((d) => formatShortDate(d))
        .join(', ')})`,
    );
  }
  if (c.completeness === 'partial' && out.length === 0) {
    out.push('data has not yet reached the final scheduled Thursday of this period');
  }
  if (c.completeness === 'missing') {
    return ['no snapshots exist in this period'];
  }
  return out;
}

// A one-line tooltip for a single sequence's per-metric activity state. The
// message matches the exact SequenceActivity that produced the cell.
export function sequenceActivityReason(a: SequenceActivity, boundaryDate?: string | null): string {
  switch (a.state) {
    case 'present':
      if (a.baselineIncomplete && a.missingMeasurements) {
        return 'Incomplete: this sequence debuted without a prior baseline and has missing measurements; the value is the safely measured activity only.';
      }
      if (a.baselineIncomplete) {
        return 'Incomplete: this sequence debuted without a prior baseline, so activity before its first snapshot is unknown; the value is the safely measured activity only.';
      }
      if (a.missingMeasurements) {
        return 'Incomplete: some snapshots in this period did not measure this metric; the value is the safely measured activity only.';
      }
      return '';
    case 'missing':
      return 'No data for this sequence in the selected period.';
    case 'missing_baseline':
      return boundaryDate
        ? `No usable baseline: the required ${formatShortDate(boundaryDate)} snapshot (or its measurement) is missing, so period activity cannot be computed.`
        : 'No usable baseline snapshot, so period activity cannot be computed.';
    case 'reset':
      return 'Counter reset or correction detected during this period; the difference is not a valid activity total.';
    case 'ambiguous_duplicate':
      return 'Ambiguous duplicate snapshots prevent a reliable value.';
  }
}

// Join reasons into the standard concise disclosure sentence, e.g.
// "Incomplete: 3 sequences lacked the required May 28 baseline; values shown
// are the activity we can safely prove."
export function incompleteDisclosure(reasons: readonly string[]): string {
  if (reasons.length === 0) return '';
  return `Incomplete: ${reasons.join('; ')}; values shown are the activity we can safely prove.`;
}
