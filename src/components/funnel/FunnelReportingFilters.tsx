// FunnelReportingFilters.tsx
//
// The shared reporting filter bar for the Marketing Funnel pages, wrapping the
// standard ReportingFilterBar and adapting it to the legacy PeriodFilter that
// the funnel calculator still speaks.
//
// One implementation, not five. Each funnel page previously rendered its own
// PeriodSelector variant, which is how the quarter buttons on Leads & MQLs
// ended up physically relocated mid-page while the other pages kept theirs in
// the header.
//
// Month is DISABLED here rather than absent. The funnel calculator has no
// month grain, and splitting a stored quarter into three months would invent
// data that was never recorded. Disabling with a visible reason answers "where
// is Month?" in place; hiding it would leave the reader guessing.

import ReportingFilterBar from '../reporting/ReportingFilterBar';
import FilterChipGroup, { type FilterChip } from '../reporting/FilterChipGroup';
import type { PeriodFilter } from '../../lib/compute';
import type { ComparisonMode, ReportingPeriod } from '../../types/reporting';
import { REGIONS, type RegionKey } from '../../constants/regions';
import {
  fromPeriodFilter,
  toPeriodFilter,
  LEGACY_FUNNEL_GRAINS,
  MONTH_DISABLED_REASON,
} from '../../lib/reportingPeriodBridge';

interface FunnelReportingFiltersProps {
  year: number;
  filter: PeriodFilter;
  yearOptions: ReadonlyArray<number>;
  onYearChange: (y: number) => void;
  onFilterChange: (f: PeriodFilter) => void;
  regions: Set<RegionKey>;
  onRegionsChange: (next: Set<RegionKey>) => void;
  // Comparison is owned by the shared selection. Data Entry passes
  // showComparison={false}: it edits stored values rather than reporting a
  // change over time, so a Compare control there would be meaningless.
  comparison?: ComparisonMode;
  onComparisonChange?: (m: ComparisonMode) => void;
  showComparison?: boolean;
}

export default function FunnelReportingFilters({
  year,
  filter,
  yearOptions,
  onYearChange,
  onFilterChange,
  regions,
  onRegionsChange,
  comparison = 'off',
  onComparisonChange,
  showComparison = true,
}: FunnelReportingFiltersProps) {
  const period = fromPeriodFilter(year, filter);

  function handlePeriodChange(next: ReportingPeriod) {
    if (next.year !== year) onYearChange(next.year);
    const asFilter = toPeriodFilter(next);
    // Null means a month period, which this calculator cannot serve. Month is
    // disabled in the control, so this only guards a programmatic change; it
    // refuses rather than silently reporting the containing quarter.
    if (asFilter !== null && asFilter !== filter) onFilterChange(asFilter);
  }

  const regionChips: ReadonlyArray<FilterChip<RegionKey>> = REGIONS.map((r) => ({
    value: r,
    label: r,
  }));

  return (
    <ReportingFilterBar
      period={period}
      comparison={comparison}
      years={yearOptions}
      supportedGrains={LEGACY_FUNNEL_GRAINS}
      disabledGrainReason={MONTH_DISABLED_REASON}
      onPeriodChange={handlePeriodChange}
      onComparisonChange={onComparisonChange ?? (() => {})}
      showComparison={showComparison}
    >
      <FilterChipGroup
        label="Region"
        chips={regionChips}
        selected={[...regions]}
        onToggle={(value) => {
          const next = new Set(regions);
          if (next.has(value)) next.delete(value);
          else next.add(value);
          onRegionsChange(next);
        }}
        onClear={() => onRegionsChange(new Set<RegionKey>())}
        onSelectAll={() => onRegionsChange(new Set<RegionKey>(REGIONS))}
      />
    </ReportingFilterBar>
  );
}
