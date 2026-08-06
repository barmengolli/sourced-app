// reportingPages.ts
//
// The reporting-contract registry: which pages must adopt the shared reporting
// filter standard (CLAUDE.md sections 4 and 5), and which are approved
// exceptions.
//
// WHY A REGISTRY
//   Without one, a new dashboard can ship with a hand-rolled month dropdown and
//   nobody notices until two pages disagree about what "Q3" means. The
//   completeness test in reportingPageContract.test.tsx walks SIDEBAR_SECTIONS
//   and fails when a visible page appears in neither list below, so adding a
//   page forces a deliberate choice: adopt the standard, or document why not.
//
// ADDING A PAGE
//   Reporting surface  -> add to REPORTING_PAGES and render ReportingFilterBar.
//   Administrative     -> add to APPROVED_NON_REPORTING_PAGES with a reason.
//   There is no third option, and that is the point.

import type { PageKey } from '../App';
import type { ReportingBasis } from '../types/reporting';

export interface ReportingPageContract {
  key: PageKey;
  label: string;
  // The source model this page's primary numbers follow. Drives the visible
  // reporting-basis disclosure; see CLAUDE.md section 4.
  basis: ReportingBasis;
  // What the basis is anchored to, in the words shown to a reader.
  anchor: string;
  // Grains this source can honestly support. A grain absent here is disabled
  // in the UI rather than fabricated: quarterly-only stored values must never
  // be spread into invented monthly bars.
  supportedGrains: ReadonlyArray<'month' | 'quarter' | 'year'>;
  // Why a grain is unavailable, shown on the disabled control so it explains
  // itself instead of looking broken. Required whenever a grain is omitted.
  disabledGrainReason?: string;
  // Whether this page offers a comparison control. A data-entry surface does
  // not: it edits stored values rather than reporting a change over time.
  supportsComparison?: boolean;
}

// Pages that MUST use the shared ReportingFilterBar and the shared selection.
export const REPORTING_PAGES: ReadonlyArray<ReportingPageContract> = [
  {
    // Data Entry is a reporting-CONTROL surface, not a reporting-output one.
    // It shares the Quarter, Year, and Region controls so a user moving from a
    // dashboard to Data Entry keeps their place, but it offers no Month and no
    // comparison: its editable storage IS quarterly, and a month control would
    // imply editable monthly cells that do not exist.
    key: 'funnel-data',
    label: 'Data Entry',
    basis: 'cohort',
    anchor: 'Quarterly stored values for the selected year',
    supportedGrains: ['quarter', 'year'],
    disabledGrainReason:
      'Month is not available here because funnel values are stored by '
      + 'quarter. Editing a month would imply a cell that does not exist.',
    supportsComparison: false,
  },
  {
    key: 'funnel-dashboard',
    label: 'Leads & MQLs',
    basis: 'cohort',
    anchor: 'Cohort based on marketing sourced date',
    supportedGrains: ['quarter', 'year'],
    disabledGrainReason:
      'Month is not available for this source yet. These figures are computed by quarter, and splitting a quarter into months would invent data that was never recorded.',
  },
  {
    key: 'funnel-velocity',
    label: 'Opportunities',
    basis: 'cohort',
    anchor: 'Cohort based on HPP stage entry date',
    supportedGrains: ['quarter', 'year'],
    disabledGrainReason:
      'Month is not available for this source yet. These figures are computed by quarter, and splitting a quarter into months would invent data that was never recorded.',
  },
  {
    key: 'funnel-events',
    label: 'Events',
    basis: 'cohort',
    anchor: 'Lead cohort based on marketing sourced date',
    supportedGrains: ['quarter', 'year'],
    disabledGrainReason:
      'Month is not available for this source yet. These figures are computed by quarter, and splitting a quarter into months would invent data that was never recorded.',
  },
  {
    key: 'funnel-spend',
    label: 'Spend',
    basis: 'allocation',
    anchor: 'Date-range cost prorated into the selected period',
    supportedGrains: ['quarter', 'year'],
    disabledGrainReason:
      'Month is not available for this source yet. These figures are computed by quarter, and splitting a quarter into months would invent data that was never recorded.',
  },
  {
    key: 'sixsense-dashboard',
    label: 'Reach & Engagement',
    basis: 'snapshot',
    anchor: 'Latest monthly snapshot at or before period end',
    supportedGrains: ['month', 'quarter', 'year'],
  },
  {
    key: 'bdr-quota-dashboard',
    label: 'BDR Dashboard',
    basis: 'cohort',
    anchor: 'HPP cohort based on stage entry date',
    supportedGrains: ['month', 'quarter', 'year'],
  },
  {
    key: 'outreach-dashboard',
    label: 'Outreach Dashboard',
    basis: 'derived_activity',
    anchor: 'Activity derived from cumulative weekly snapshots',
    supportedGrains: ['month', 'quarter', 'year'],
  },
  {
    key: 'linkedin-dashboard',
    label: 'LinkedIn Ads Dashboard',
    basis: 'activity',
    anchor: 'Weekly additive activity assigned by week-ending Sunday',
    supportedGrains: ['month', 'quarter', 'year'],
  },
  {
    key: 'campaigns-overview',
    label: 'Campaigns Overview',
    basis: 'activity',
    anchor: 'Each metric follows its own source model',
    supportedGrains: ['month', 'quarter', 'year'],
  },
];

export interface NonReportingPageException {
  key: PageKey;
  reason: string;
}

// Administrative and data-entry surfaces. These are NOT reporting dashboards
// and must not be forced to render a reporting filter bar: a data-entry grid
// that silently filtered itself to "this month" would hide rows the user is
// trying to edit.
export const APPROVED_NON_REPORTING_PAGES: ReadonlyArray<NonReportingPageException> = [
  { key: 'funnel-import', reason: 'Import workflow. Operates on an uploaded file, not a reporting period.' },
  { key: 'sixsense-import', reason: 'Import workflow. Operates on an uploaded file, not a reporting period.' },
  { key: 'outreach-data', reason: 'Source data table. Shows imported snapshot rows as stored.' },
  { key: 'leads', reason: 'Utility table. Row-level lead lookup, not a period report.' },
  { key: 'channels', reason: 'Taxonomy management. No time dimension.' },
  { key: 'campaigns-tags', reason: 'Tag management. No time dimension.' },
  { key: 'bdr-quota-quotas', reason: 'Quota entry. Annual targets are edited as stored, not reported by period.' },
  { key: 'settings', reason: 'Application settings. No time dimension.' },
  { key: 'user-manual', reason: 'Documentation. No time dimension.' },
  { key: 'feedback', reason: 'Feedback form. No time dimension.' },
];

export const REPORTING_PAGE_KEYS: ReadonlySet<PageKey> = new Set(
  REPORTING_PAGES.map((p) => p.key),
);

export const APPROVED_NON_REPORTING_KEYS: ReadonlySet<PageKey> = new Set(
  APPROVED_NON_REPORTING_PAGES.map((p) => p.key),
);

export function reportingContractFor(
  key: PageKey,
): ReportingPageContract | undefined {
  return REPORTING_PAGES.find((p) => p.key === key);
}
