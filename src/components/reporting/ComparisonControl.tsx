// Shared comparison control (CLAUDE.md section 4). Renders the "Compare to"
// choice as a segmented control. For Year grain, previous_period and
// previous_year coincide, so a single "Previous year" option is shown instead
// of both. Controlled.

import SegmentedControl, { type SegmentedOption } from './SegmentedControl';
import { comparisonModesCollapse } from '../../lib/reportingPeriods';
import type { ComparisonMode, ReportingGrain } from '../../types/reporting';

interface ComparisonControlProps {
  grain: ReportingGrain;
  value: ComparisonMode;
  onChange: (mode: ComparisonMode) => void;
  showLabel?: boolean;
}

export default function ComparisonControl({
  grain,
  value,
  onChange,
  showLabel = true,
}: ComparisonControlProps) {
  const collapsed = comparisonModesCollapse(grain);

  const options: Array<SegmentedOption<ComparisonMode>> = collapsed
    ? [
        { value: 'previous_year', label: 'Previous year' },
        { value: 'off', label: 'Off' },
      ]
    : [
        { value: 'previous_period', label: 'Previous period' },
        { value: 'previous_year', label: 'Previous year' },
        { value: 'off', label: 'Off' },
      ];

  // If the grain collapsed and the caller still holds 'previous_period', treat
  // it as 'previous_year' for display so the selection stays valid. The parent
  // is controlled, so we surface the corrected value on the next change only;
  // for rendering we map it here without mutating parent state.
  const displayValue: ComparisonMode =
    collapsed && value === 'previous_period' ? 'previous_year' : value;

  return (
    <SegmentedControl
      label="Compare to"
      options={options}
      value={displayValue}
      onChange={onChange}
      showLabel={showLabel}
    />
  );
}
