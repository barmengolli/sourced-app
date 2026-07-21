// Shared reporting-basis disclosure (CLAUDE.md sections 4 and 5). A neutral,
// accessible badge plus short explanatory text that states how a report's
// numbers are assembled: Cohort, Activity, Snapshot, Derived activity, or
// Allocation.
//
// It is informational, not interactive: rendered as a labeled note, never a
// button, filter, or warning. It carries the anchor field or effective date in
// visible text (e.g. "Cohort based on marketing sourced date", "Snapshot as of
// July 31, 2026"). Neutral styling keeps it distinct from KPI status or alerts.

import type { ReportingBasis } from '../../types/reporting';

const BASIS_LABEL: Record<ReportingBasis, string> = {
  cohort: 'Cohort',
  activity: 'Activity',
  snapshot: 'Snapshot',
  derived_activity: 'Derived activity',
  allocation: 'Allocation',
};

interface ReportingBasisDisclosureProps {
  basis: ReportingBasis;
  // Concise plain-language explanation, ideally including the anchor field or
  // effective date, e.g. "based on marketing sourced date" or
  // "as of July 31, 2026".
  explanation: string;
}

export default function ReportingBasisDisclosure({
  basis,
  explanation,
}: ReportingBasisDisclosureProps) {
  const label = BASIS_LABEL[basis];
  return (
    <p
      className="inline-flex items-center gap-2 text-xs text-slate-muted"
      data-testid="reporting-basis-disclosure"
    >
      {/* Neutral, non-interactive badge. role=note keeps it out of the tab and
          control semantics; it must not read as a filter or warning. */}
      <span
        role="note"
        aria-label={`Reporting basis: ${label}`}
        className="inline-flex h-5 items-center rounded-md border border-border bg-muted px-2 font-medium text-charcoal"
      >
        {label}
      </span>
      <span>{explanation}</span>
    </p>
  );
}
