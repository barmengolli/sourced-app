import { useId } from 'react';
import type { ChannelSpendBreakdown } from '../../lib/compute';
import { summarizeFunnelInvestment } from '../../lib/funnelExecutiveEfficiency';

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

function formatCompactUsd(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return formatUsd(value);
}

function formatRatio(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}x`;
}

function InfoTip({ label, text }: { label: string; text: string }) {
  const id = useId();
  return (
    <span className="group relative inline-flex">
      <span
        role="img"
        tabIndex={0}
        aria-label={label}
        aria-describedby={id}
        className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-slate-muted/50 text-[10px] font-semibold text-slate-muted outline-none transition hover:border-indigo hover:text-indigo focus:border-indigo focus:text-indigo"
      >
        i
      </span>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-72 -translate-x-1/2 rounded-lg bg-charcoal px-3 py-2 text-[11px] font-normal leading-4 text-white shadow-lg group-hover:block group-focus-within:block"
      >
        {text}
      </span>
    </span>
  );
}

const METRICS = [
  {
    key: 'investment',
    label: 'Recorded investment',
    help: 'Selected-period campaign cost recorded in Sourced, prorated by the same audited rules used on the Spend page. Unrecorded website, internal labor, and other overhead are excluded.',
  },
  {
    key: 'cpl',
    label: 'Cost per Lead',
    help: 'Recorded investment divided by primary-source Leads from channels that have recorded spend. Channels without recorded cost are excluded rather than treated as free.',
  },
  {
    key: 'cpmql',
    label: 'Cost per MQL',
    help: 'Recorded investment divided by primary-source MQLs from channels that have recorded spend. This intentionally differs from overlapping campaign-membership counts.',
  },
  {
    key: 'pipeline',
    label: 'Attributed pipeline',
    help: 'First-touch opportunity value from channels with recorded spend for selected-period HPP cohorts that are not Closed Lost.',
  },
  {
    key: 'won',
    label: 'Closed-won revenue',
    help: 'Closed-won value from channels with recorded spend, attributed to the same selected-period first-touch opportunity cohorts.',
  },
  {
    key: 'roi',
    label: 'Realized ROI',
    help: 'Closed-won revenue divided by recorded investment for the same cost-covered channels. Open pipeline is not treated as realized return.',
  },
] as const;

export default function FunnelExecutiveEfficiency({
  breakdown,
  embedded = false,
}: {
  breakdown: ChannelSpendBreakdown[];
  embedded?: boolean;
}) {
  const summary = summarizeFunnelInvestment(breakdown);
  const channelRows = breakdown
    .filter((row) => row.parentId === null && row.allocatedCost > 0)
    .slice()
    .sort((a, b) => b.allocatedCost - a.allocatedCost);
  const values: Record<(typeof METRICS)[number]['key'], string> = {
    investment: summary.totalCost > 0 ? formatCompactUsd(summary.totalCost) : '—',
    cpl: summary.costPerLead === null ? '—' : formatUsd(summary.costPerLead),
    cpmql: summary.costPerMql === null ? '—' : formatUsd(summary.costPerMql),
    pipeline: summary.coveredChannelCount > 0 ? formatCompactUsd(summary.totalPipeline) : '—',
    won: summary.coveredChannelCount > 0 ? formatCompactUsd(summary.totalWon) : '—',
    roi: formatRatio(summary.realizedRoi),
  };

  const content = (
    <>
      {!embedded && <header className="border-b border-border pb-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">Executive efficiency</p>
          <h2 id="investment-return-title" className="mt-1 text-lg font-semibold text-charcoal">Investment and return</h2>
          <p className="mt-1 text-xs text-slate-muted">Only channels with campaign spend recorded in Sourced are included.</p>
        </div>
      </header>}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {METRICS.map((metric) => (
          <article key={metric.key} className="rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-muted">{metric.label}</span>
              <InfoTip label={`How ${metric.label} is calculated`} text={metric.help} />
            </div>
            <p className="mt-3 text-2xl font-semibold tracking-tight text-charcoal tabular-nums">{values[metric.key]}</p>
          </article>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="border-b border-border bg-muted/20 px-4 py-3 sm:px-5">
          <h3 className="text-sm font-semibold text-charcoal">Investment by channel</h3>
          <p className="mt-1 text-xs text-slate-muted">Parent-channel totals; child campaigns are rolled up once.</p>
        </div>
        {channelRows.length === 0 ? (
          <p className="flex h-28 items-center justify-center px-4 text-xs italic text-slate-muted">
            No recorded campaign spend for this period.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[58rem] border-collapse text-xs">
              <thead>
                <tr className="bg-muted/45 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-muted">
                  <th className="px-4 py-2.5 sm:px-5">Channel</th>
                  <th className="px-3 py-2.5 text-right">Investment</th>
                  <th className="px-3 py-2.5 text-right">Leads</th>
                  <th className="px-3 py-2.5 text-right">CPL</th>
                  <th className="px-3 py-2.5 text-right">MQLs</th>
                  <th className="px-3 py-2.5 text-right">Cost / MQL</th>
                  <th className="px-3 py-2.5 text-right">Pipeline</th>
                  <th className="px-3 py-2.5 text-right">Won</th>
                  <th className="px-4 py-2.5 text-right sm:px-5">ROI</th>
                </tr>
              </thead>
              <tbody>
                {channelRows.map((row) => (
                  <tr key={row.channelId} className="border-t border-border/70">
                    <th scope="row" className="px-4 py-3 text-left font-medium text-charcoal sm:px-5">
                      {row.channelName}
                    </th>
                    <td className="px-3 py-3 text-right tabular-nums text-charcoal">{formatCompactUsd(row.allocatedCost)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-charcoal">{row.leads.toLocaleString()}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-charcoal">{row.costPerLead === null ? '—' : formatUsd(row.costPerLead)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-charcoal">{row.mqls.toLocaleString()}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-charcoal">{row.costPerMql === null ? '—' : formatUsd(row.costPerMql)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-charcoal">{formatCompactUsd(row.pipelineAmount)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-charcoal">{formatCompactUsd(row.wonAmount)}</td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums text-charcoal sm:px-5">{formatRatio(row.roi)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );

  if (embedded) return <div className="space-y-4">{content}</div>;

  return (
    <section aria-labelledby="investment-return-title" className="space-y-4 rounded-2xl border border-border bg-bg p-4 shadow-sm sm:p-5">
      {content}
    </section>
  );
}
