import type { PageKey } from '../App';

export interface SidebarChild {
  key: PageKey;
  label: string;
}

export interface SidebarSection {
  // Stable id used as a prefix for storage keys and to identify the section.
  id: string;
  label: string;
  // Where to navigate when the user clicks the parent label (not the chevron),
  // if no last-visited child is recorded yet.
  defaultChild: PageKey;
  // localStorage key for "last visited child" within this section.
  lastTabStorageKey: string;
  // localStorage key for the expand/collapse state.
  expandedStorageKey: string;
  children: SidebarChild[];
}

// Adding a new domain (Outreach, 6Sense, LinkedIn ads, ...) is a config-only
// change: append a new SidebarSection here, add its child PageKeys to the
// PageKey union in App.tsx, and route them in the PageBody switch. The
// Sidebar component does not need to change.
export const SIDEBAR_SECTIONS: SidebarSection[] = [
  {
    id: 'funnel',
    label: 'Marketing Funnel',
    defaultChild: 'funnel-data',
    lastTabStorageKey: 'sourced.funnel.lastTab',
    expandedStorageKey: 'sourced.sidebar.expanded.funnel',
    children: [
      { key: 'funnel-data', label: 'Data Entry' },
      // PageKey values stay as `funnel-dashboard` / `funnel-velocity` so
      // storage and routing identifiers don't move when these labels
      // change. The labels reflect the user-facing content split:
      // lead/MQL-side analytics vs deal-side analytics.
      { key: 'funnel-dashboard', label: 'Leads & MQLs' },
      { key: 'funnel-velocity', label: 'Opportunities' },
      { key: 'funnel-events', label: 'Events' },
      { key: 'funnel-spend', label: 'Spend' },
      // Compare is HIDDEN (not deleted): the funnel-compare PageKey, its
      // route case, and FunnelComparePage.tsx stay for a possible return.
    ],
  },
  {
    // UI label is "Reach & Engagement"; the id / PageKeys keep the `sixsense`
    // prefix (the underlying data source) so routing + storage keys are stable.
    id: 'sixsense',
    label: 'Reach & Engagement',
    defaultChild: 'sixsense-dashboard',
    lastTabStorageKey: 'sourced.sixsense.lastTab',
    expandedStorageKey: 'sourced.sidebar.expanded.sixsense',
    children: [
      { key: 'sixsense-dashboard', label: 'Dashboard' },
      { key: 'sixsense-import', label: 'Import' },
    ],
  },
  {
    id: 'bdr-quota',
    label: 'BDR Quota',
    defaultChild: 'bdr-quota-dashboard',
    lastTabStorageKey: 'sourced.bdrquota.lastTab',
    expandedStorageKey: 'sourced.sidebar.expanded.bdrquota',
    children: [
      { key: 'bdr-quota-dashboard', label: 'Dashboard' },
      { key: 'bdr-quota-quotas', label: 'Quotas' },
    ],
  },
  {
    id: 'outreach',
    label: 'Outreach',
    defaultChild: 'outreach-data',
    lastTabStorageKey: 'sourced.outreach.lastTab',
    expandedStorageKey: 'sourced.sidebar.expanded.outreach',
    children: [
      { key: 'outreach-data', label: 'Data' },
      { key: 'outreach-dashboard', label: 'Dashboard' },
      // Compare retired in Bite 3C; the old route redirects to Dashboard.
    ],
  },
  {
    id: 'linkedin-ads',
    label: 'LinkedIn Ads',
    defaultChild: 'linkedin-dashboard',
    lastTabStorageKey: 'sourced.linkedin.lastTab',
    expandedStorageKey: 'sourced.sidebar.expanded.linkedin',
    children: [{ key: 'linkedin-dashboard', label: 'Dashboard' }],
  },
  {
    id: 'campaigns',
    label: 'Campaigns',
    defaultChild: 'campaigns-overview',
    lastTabStorageKey: 'sourced.campaigns.lastTab',
    expandedStorageKey: 'sourced.sidebar.expanded.campaigns',
    children: [
      { key: 'campaigns-overview', label: 'Overview' },
      { key: 'campaigns-tags', label: 'Tags' },
    ],
  },
];

export const UTILITY_PAGES: SidebarChild[] = [
  { key: 'user-manual', label: 'User Manual' },
  { key: 'feedback', label: 'Feedback & Bug Reports' },
  { key: 'leads', label: 'Leads' },
  { key: 'channels', label: 'Channels' },
  { key: 'funnel-import', label: 'Funnel Import' },
  { key: 'settings', label: 'Settings' },
];

// Resolve where a section-label click should land: the stored last-visited
// child when it is still one of the section's children, else the default.
// Guards stale localStorage values pointing at hidden or retired tabs
// (e.g. a stored 'funnel-compare' after the Compare tab was hidden).
export function resolveSectionTarget(
  section: SidebarSection,
  storedLastTab: PageKey | null,
): PageKey {
  return storedLastTab && section.children.some((c) => c.key === storedLastTab)
    ? storedLastTab
    : section.defaultChild;
}

// Quick lookup: which section, if any, owns this PageKey?
export function sectionForPage(page: PageKey): SidebarSection | null {
  for (const s of SIDEBAR_SECTIONS) {
    if (s.children.some((c) => c.key === page)) return s;
  }
  return null;
}
