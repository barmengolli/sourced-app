// 6Sense segment constants.
//
// A snapshot's `segment` names the account set its Activities-By-Source report
// covers. The overall report (all target accounts) is the canonical segment
// below; campaign reports (e.g. "Life & Annuities") are their own values,
// added on import. The overall segment always renders first on the dashboard.

export const OVERALL_SEGMENT = 'Target Accounts in CRM';

// Order segments for display: overall first, then campaigns alphabetically.
export function orderSegments(segments: string[]): string[] {
  const unique = Array.from(new Set(segments));
  const rest = unique
    .filter((s) => s !== OVERALL_SEGMENT)
    .sort((a, b) => a.localeCompare(b));
  return unique.includes(OVERALL_SEGMENT)
    ? [OVERALL_SEGMENT, ...rest]
    : rest;
}
