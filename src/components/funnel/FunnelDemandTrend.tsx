import { useId } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_COLORS } from '../../constants/chartColors';
import type { MonthlyLeadsForYear } from '../../lib/compute';
import QuarterlyBackfillNote from '../charts/QuarterlyBackfillNote';

interface FunnelDemandTrendProps {
  data: MonthlyLeadsForYear;
  year: number;
  priorYearTotals?: number[];
  priorYear?: number;
  loading?: boolean;
  embedded?: boolean;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function InfoTip({ text }: { text: string }) {
  const id = useId();
  return (
    <span className="group relative inline-flex">
      <span
        role="img"
        tabIndex={0}
        aria-label="How demand created is calculated"
        aria-describedby={id}
        className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-slate-muted/50 text-[10px] font-semibold text-slate-muted outline-none transition hover:border-indigo hover:text-indigo focus:border-indigo focus:text-indigo"
      >
        i
      </span>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-64 -translate-x-1/2 rounded-lg bg-charcoal px-3 py-2 text-[11px] font-normal leading-4 text-white shadow-lg group-hover:block group-focus-within:block"
      >
        {text}
      </span>
    </span>
  );
}

export default function FunnelDemandTrend({
  data,
  year,
  priorYearTotals,
  priorYear,
  loading = false,
  embedded = false,
}: FunnelDemandTrendProps) {
  const hasPrior = Array.isArray(priorYearTotals) && typeof priorYear === 'number';
  const chartData = MONTHS.map((month, index) => ({
    month,
    [year]: data.monthTotals[index] ?? 0,
    ...(hasPrior ? { [priorYear]: priorYearTotals[index] ?? 0 } : {}),
  }));
  const allZero = chartData.every((row) =>
    Number(row[year] ?? 0) === 0
    && (!hasPrior || Number(row[priorYear!] ?? 0) === 0),
  );

  return (
    <section className={embedded ? '' : 'rounded-xl border border-border bg-bg p-4 shadow-sm sm:p-5'}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-charcoal">Demand created</h3>
            <InfoTip text="Monthly Lead campaign memberships from their source dates. A contact in several campaigns counts in each campaign; quarterly backfills remain labeled and are never spread into invented monthly values." />
          </div>
          <p className="mt-1 text-xs text-slate-muted">Monthly Lead volume with prior-year context.</p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-indigo" />{year}
          </span>
          {hasPrior && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-slate-muted" />{priorYear}
            </span>
          )}
        </div>
      </header>

      <div className="mt-4">
        <QuarterlyBackfillNote fallback={data.quarterlyFallback} />
        {loading ? (
          <div className="flex h-[260px] items-center justify-center text-xs italic text-slate-muted">Loading…</div>
        ) : allZero ? (
          <div className="flex h-[260px] items-center justify-center text-xs italic text-slate-muted">No monthly Lead activity for this year.</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{ top: 8, right: 18, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.border} vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
                axisLine={{ stroke: CHART_COLORS.border }}
                tickLine={false}
              />
              <YAxis
                allowDecimals={false}
                width={44}
                tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                formatter={(value) => Number(value).toLocaleString()}
                contentStyle={{
                  fontSize: 11,
                  border: `1px solid ${CHART_COLORS.border}`,
                  borderRadius: 8,
                }}
              />
              {hasPrior && (
                <Line
                  type="monotone"
                  dataKey={String(priorYear)}
                  stroke={CHART_COLORS.slateMuted}
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  dot={false}
                />
              )}
              <Line
                type="monotone"
                dataKey={String(year)}
                stroke={CHART_COLORS.indigo}
                strokeWidth={3}
                dot={{ r: 3, fill: CHART_COLORS.indigo }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
