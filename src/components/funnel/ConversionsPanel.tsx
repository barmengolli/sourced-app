import { useId } from 'react';
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

function InfoTip({ text, label }: { text: string; label: string }) {
  const tooltipId = useId();

  return (
    <span className="group relative inline-flex">
      <span
        tabIndex={0}
        role="img"
        aria-label={label}
        aria-describedby={tooltipId}
        className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-slate-muted/50 text-[10px] font-semibold leading-none text-slate-muted outline-none transition hover:border-indigo hover:text-indigo focus:border-indigo focus:text-indigo"
      >
        i
      </span>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-64 -translate-x-1/2 rounded-lg bg-charcoal px-3 py-2 text-[11px] font-normal leading-4 text-white shadow-lg group-hover:block group-focus-within:block"
      >
        {text}
      </span>
    </span>
  );
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
    <li className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 text-charcoal">
          {label}
          <InfoTip text={metric.basis} label={`How ${label} is calculated`} />
        </span>
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
    <aside className="w-full self-start rounded-xl border border-border bg-bg p-4 shadow-sm">
      <div className="mb-4 border-b border-border pb-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo">Conversion quality</p>
      <div className="mt-1 flex items-center gap-2">
        <h2 className="text-base font-semibold text-charcoal">Cohort conversion</h2>
        <InfoTip
          label="How cohort conversion is calculated"
          text="Follows the same people or opportunities forward. These rates are not calculated by dividing the stage totals in the table."
        />
      </div>
      </div>
      <ul className="space-y-3.5">
        <MetricRow label="Lead to MQL" metric={conversions.leadToMql} />
        <MetricRow label="MQL account to HPP" metric={conversions.mqlAccountToHpp} />
        <MetricRow label="HPP to Opp" metric={conversions.hppToOpp} />
        <MetricRow label="Opp to Pursuit" metric={conversions.oppToPursuit} />
        <MetricRow label="Pursuit to Won" metric={conversions.pursuitToWon} />
      </ul>
      <div className="mt-4">
        <OutcomeBlock conversions={conversions} />
      </div>
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
      <div className="flex items-center gap-1.5 text-[10px] font-medium text-slate-muted">
        HPP cohort outcomes
        <InfoTip
          label="How HPP cohort outcomes are calculated"
          text={`Current outcome of the ${hppCohort} opportunities that entered HPP in the selected period. Recent cohorts may still be maturing.`}
        />
      </div>
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
