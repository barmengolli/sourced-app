import type {
  ConversionMetric,
  FunnelConversionCohorts,
} from '../../lib/funnelConversionCohorts';

interface ConversionsPanelProps {
  conversions: FunnelConversionCohorts;
}

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function MetricRow({ label, metric }: { label: string; metric: ConversionMetric }) {
  const value = (metric.status === 'ready' || metric.status === 'partial') && metric.percent !== null
    ? formatPct(metric.percent)
    : metric.status === 'unavailable'
      ? 'Pending data'
      : 'No cohort';
  const width = metric.percent === null
    ? 0
    : Math.min(100, Math.max(0, metric.percent));
  return (
    <li className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-charcoal">{label}</span>
        <span
          className={metric.status === 'ready' || metric.status === 'partial'
            ? 'font-medium tabular-nums text-charcoal'
            : 'text-slate-muted italic'}
          title={metric.status === 'ready' || metric.status === 'partial'
            ? `${metric.numerator} of ${metric.denominator}. ${metric.basis}`
            : metric.basis}
        >
          {value}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-indigo transition-all"
          style={{ width: `${width}%` }}
        />
      </div>
      <p className="text-[10px] leading-4 text-slate-muted">{metric.basis}</p>
      {metric.status === 'partial' && metric.coverage && (
        <p className="text-[10px] leading-4 text-amber-700">
          Partial account coverage: {metric.coverage.measured} of {metric.coverage.total} MQL memberships have an exact Salesforce Account ID.
        </p>
      )}
    </li>
  );
}

export default function ConversionsPanel({ conversions }: ConversionsPanelProps) {
  return (
    <aside className="w-72 flex-shrink-0 border border-border rounded-lg bg-bg p-4 space-y-3 self-start">
      <h2 className="text-sm font-semibold text-charcoal">Cohort conversion</h2>
      <p className="text-xs text-slate-muted">
        Follows the same people or opportunities forward. These rates are not
        calculated by dividing the stage activity totals in the table.
      </p>
      <ul className="space-y-3">
        <MetricRow label="Lead to MQL" metric={conversions.leadToMql} />
        <MetricRow label="MQL account to HPP" metric={conversions.mqlAccountToHpp} />
        <MetricRow label="HPP to Opp" metric={conversions.hppToOpp} />
        <MetricRow label="Opp to Pursuit" metric={conversions.oppToPursuit} />
        <MetricRow label="Pursuit to Won" metric={conversions.pursuitToWon} />
      </ul>
      <OutcomeBlock conversions={conversions} />
    </aside>
  );
}

function OutcomeBlock({ conversions }: ConversionsPanelProps) {
  const { hppCohort, won, lost, inFlight } = conversions.outcomes;
  const rows = [
    { label: 'Won', value: won, className: 'text-blue-600' },
    { label: 'Lost', value: lost, className: 'text-danger' },
    { label: 'In flight', value: inFlight, className: 'text-charcoal' },
  ];
  return (
    <div className="pt-2 border-t border-border space-y-2">
      <p className="text-[10px] leading-4 text-slate-muted">
        Current outcome of the {hppCohort} opportunities that entered HPP in
        the selected period. Recent cohorts are still maturing.
      </p>
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between text-xs">
          <span className="text-charcoal">{row.label}</span>
          {hppCohort === 0 ? (
            <span className="text-slate-muted italic">No cohort</span>
          ) : (
            <span className={`font-medium tabular-nums ${row.className}`}>
              {formatPct((row.value / hppCohort) * 100)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
