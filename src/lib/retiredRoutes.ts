// Retired-route redirects. When a navigation target or a stored "last tab"
// value points at a page that has been retired, it is redirected to a live
// page so old bookmarks and persisted state do not break. The retired key is
// kept in the PageKey union only so this redirect can recognize it; the retired
// page's source may be kept but is no longer routed.
//
// Bite 3C: Outreach Compare -> Outreach Dashboard.

import type { PageKey } from '../App';

export function redirectRetiredPage(p: PageKey): PageKey {
  if (p === 'outreach-compare') return 'outreach-dashboard';
  return p;
}
