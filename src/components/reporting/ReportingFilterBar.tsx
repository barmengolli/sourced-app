// Shared reporting filter bar (CLAUDE.md sections 4 and 5). Composes the
// timeframe controls in the standard order and focus sequence:
//
//   Timeframe (grain) -> period -> year -> comparison -> business filters
//
// It is fully controlled: the parent owns the ReportingSelection and business
// filters, this component only renders and reports changes. Time controls come
// before region, campaign, channel, sequence, and search (business filters are
// passed as children and rendered after the comparison control).
//
// Grain drives which period control shows:
//   - month  -> a month select (constrained-layout friendly)
//   - quarter-> a Q1..Q4 segmented control
//   - year   -> year select only
// Year is always a select.

import SegmentedControl, { type SegmentedOption } from './SegmentedControl';
import ReportingSelect, { type ReportingSelectOption } from './ReportingSelect';
import ComparisonControl from './ComparisonControl';
import type {
  ComparisonMode,
  MonthIndex,
  ReportingGrain,
  ReportingPeriod,
} from '../../types/reporting';
import type { PeriodIndex } from '../../types/db';

const GRAIN_OPTIONS: ReadonlyArray<SegmentedOption<ReportingGrain>> = [
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
];

const MONTH_OPTIONS: ReadonlyArray<ReportingSelectOption<string>> = [
  { value: '1', label: 'January' },
  { value: '2', label: 'February' },
  { value: '3', label: 'March' },
  { value: '4', label: 'April' },
  { value: '5', label: 'May' },
  { value: '6', label: 'June' },
  { value: '7', label: 'July' },
  { value: '8', label: 'August' },
  { value: '9', label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' },
];

const QUARTER_OPTIONS: ReadonlyArray<SegmentedOption<string>> = [
  { value: '1', label: 'Q1' },
  { value: '2', label: 'Q2' },
  { value: '3', label: 'Q3' },
  { value: '4', label: 'Q4' },
];

interface ReportingFilterBarProps {
  period: ReportingPeriod;
  comparison: ComparisonMode;
  // Selectable years, newest-first is the caller's choice.
  years: ReadonlyArray<number>;
  onPeriodChange: (period: ReportingPeriod) => void;
  onComparisonChange: (mode: ComparisonMode) => void;
  // Business filters (region, campaign, channel, sequence, search) render after
  // the comparison control, per the standard focus order.
  children?: React.ReactNode;
}

// Switch grain while keeping year, defaulting the sub-selection sensibly.
function changeGrain(
  current: ReportingPeriod,
  grain: ReportingGrain,
): ReportingPeriod {
  if (grain === 'month') {
    const month: MonthIndex = current.grain === 'month' ? current.month : 1;
    return { grain: 'month', year: current.year, month };
  }
  if (grain === 'quarter') {
    const quarter: PeriodIndex = current.grain === 'quarter' ? current.quarter : 1;
    return { grain: 'quarter', year: current.year, quarter };
  }
  return { grain: 'year', year: current.year };
}

export default function ReportingFilterBar({
  period,
  comparison,
  years,
  onPeriodChange,
  onComparisonChange,
  children,
}: ReportingFilterBarProps) {
  const yearOptions: ReadonlyArray<ReportingSelectOption<string>> = years.map(
    (y) => ({ value: String(y), label: String(y) }),
  );

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="reporting-filter-bar">
      {/* 1. Timeframe grain */}
      <SegmentedControl<ReportingGrain>
        label="Timeframe"
        options={GRAIN_OPTIONS}
        value={period.grain}
        onChange={(grain) => onPeriodChange(changeGrain(period, grain))}
      />

      {/* 2. Period (month select or quarter segmented; hidden for year) */}
      {period.grain === 'month' ? (
        <ReportingSelect
          label="Month"
          options={MONTH_OPTIONS}
          value={String(period.month)}
          onChange={(v) =>
            onPeriodChange({
              grain: 'month',
              year: period.year,
              month: Number(v) as MonthIndex,
            })
          }
        />
      ) : null}
      {period.grain === 'quarter' ? (
        <SegmentedControl
          label="Quarter"
          options={QUARTER_OPTIONS}
          value={String(period.quarter)}
          onChange={(v) =>
            onPeriodChange({
              grain: 'quarter',
              year: period.year,
              quarter: Number(v) as PeriodIndex,
            })
          }
        />
      ) : null}

      {/* 3. Year (always a select) */}
      <ReportingSelect
        label="Year"
        options={yearOptions}
        value={String(period.year)}
        onChange={(v) => {
          const year = Number(v);
          if (period.grain === 'month') {
            onPeriodChange({ grain: 'month', year, month: period.month });
          } else if (period.grain === 'quarter') {
            onPeriodChange({ grain: 'quarter', year, quarter: period.quarter });
          } else {
            onPeriodChange({ grain: 'year', year });
          }
        }}
      />

      {/* 4. Comparison */}
      <ComparisonControl
        grain={period.grain}
        value={comparison}
        onChange={onComparisonChange}
      />

      {/* 5. Business filters (region, campaign, channel, sequence, search) */}
      {children}
    </div>
  );
}
