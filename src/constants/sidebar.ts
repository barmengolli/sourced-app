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
      { key: 'funnel-dashboard', label: 'Dashboard' },
      { key: 'funnel-velocity', label: 'Velocity' },
      { key: 'funnel-compare', label: 'Compare' },
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
      { key: 'outreach-compare', label: 'Compare' },
    ],
  },
];

export const UTILITY_PAGES: SidebarChild[] = [
  { key: 'leads', label: 'Leads' },
  { key: 'channels', label: 'Channels' },
  { key: 'funnel-import', label: 'Funnel Import' },
  { key: 'settings', label: 'Settings' },
];

// Quick lookup: which section, if any, owns this PageKey?
export function sectionForPage(page: PageKey): SidebarSection | null {
  for (const s of SIDEBAR_SECTIONS) {
    if (s.children.some((c) => c.key === page)) return s;
  }
  return null;
}
