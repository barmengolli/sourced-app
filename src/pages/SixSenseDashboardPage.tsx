// 6sense Dashboard: the headline view that replaces the manual reach/
// engagement math. Shows Reach % and Engagement % of total target accounts
// for a chosen monthly snapshot, with month-over-month deltas vs the prior
// snapshot, plus the three breakdown panels (Reach / Intent / Engagement)
// matching the 6sense "Activities By Source" layout.
//
// Data is read-only here; imports happen on the 6sense Import sub-tab.

import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PageKey } from '../App';
import type { SixSenseSnapshot } from '../types/db';
import {
  activityPct,
  engagementPct,
  intentPct,
  reachPct,
} from '../lib/sixsense';
import { OVERALL_SEGMENT, orderSegments } from '../constants/sixsense';
import { CHART_COLORS } from '../constants/chartColors';
import ChartCard from '../components/charts/ChartCard';

interface SixSenseDashboardPageProps {
  snapshots: SixSenseSnapshot[]; // newest snapshot_date first
  loading: boolean;
  renameSegment: (from: string, to: string) => Promise<void>;
  onNavigate: (p: PageKey) => void;
}

const fmtInt = (n: number | null): string =>
  n === null ? '—' : n.toLocaleString();

const fmtPct = (n: number): string => `${(Math.round(n * 10) / 10).toFixed(1)}%`;

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Snapshot date (YYYY-MM-DD, first of the month) -> "January 2026". 6Sense
// reporting is monthly; snapshots are keyed to the first of their month.
function fmtMonth(iso: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${months[Number(m[2]) - 1]} ${m[1]}`;
}

// Month number (1-12, stored in week_number) -> short month label for pills.
function monthShort(monthNum: number): string {
  return MONTHS_SHORT[monthNum - 1] ?? `M${monthNum}`;
}

export default function SixSenseDashboardPage({
  snapshots,
  loading,
  renameSegment,
  onNavigate,
}: SixSenseDashboardPageProps) {
  // Group snapshots by segment, then order: overall ('Target Accounts in CRM')
  // first, campaigns after alphabetically. Each segment renders its own
  // stacked section with its own month selector + prior-month compare.
  const sections = useMemo(() => {
    const bySegment = new Map<string, SixSenseSnapshot[]>();
    for (const s of snapshots) {
      const arr = bySegment.get(s.segment) ?? [];
      arr.push(s);
      bySegment.set(s.segment, arr);
    }
    return orderSegments([...bySegment.keys()]).map((segment) => ({
      segment,
      snapshots: bySegment.get(segment) ?? [],
    }));
  }, [snapshots]);

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-sm text-slate-muted italic">Loading…</p>
      </div>
    );
  }

  if (sections.length === 0) {
    return (
      <div className="p-8 space-y-4">
        <Header onNavigate={onNavigate} />
        <div className="border border-border rounded-lg bg-muted/40 px-6 py-10 text-center">
          <p className="text-sm text-charcoal">No 6sense snapshots yet.</p>
          <p className="mt-1 text-xs text-slate-muted">
            Import a 6sense "Activities By Source" export to see reach and
            engagement here.
          </p>
          <button
            type="button"
            onClick={() => onNavigate('sixsense-import')}
            className="mt-4 text-xs px-3 py-1.5 rounded bg-indigo text-white hover:bg-indigo/90"
          >
            Go to import
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-8">
      <Header onNavigate={onNavigate} />
      {sections.map(({ segment, snapshots: segSnaps }) => (
        <SegmentSection
          key={segment}
          segment={segment}
          // The overall segment is titled "All Target Accounts"; campaigns
          // are titled by their segment name. Only campaigns are renamable.
          title={segment === OVERALL_SEGMENT ? 'All Target Accounts' : segment}
          renamable={segment !== OVERALL_SEGMENT}
          onRename={renameSegment}
          snapshots={segSnaps}
        />
      ))}
    </div>
  );
}

// One segment's dashboard: month pills + KPI cards + breakdown panels, with its
// own selected month and prior-month comparison, scoped to the passed-in slice.
function SegmentSection({
  segment,
  title,
  renamable,
  onRename,
  snapshots,
}: {
  // The actual segment value (DB key); rename targets this. `title` is the
  // display label (the overall segment shows a friendlier title).
  segment: string;
  title: string;
  renamable: boolean;
  onRename: (from: string, to: string) => Promise<void>;
  snapshots: SixSenseSnapshot[];
}) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => {
    if (snapshots.length === 0) {
      setSelectedDate(null);
      return;
    }
    setSelectedDate((prev) =>
      prev && snapshots.some((s) => s.snapshot_date === prev)
        ? prev
        : snapshots[0].snapshot_date,
    );
  }, [snapshots]);

  const current = useMemo(
    () => snapshots.find((s) => s.snapshot_date === selectedDate) ?? null,
    [snapshots, selectedDate],
  );

  const orderedMonths = useMemo(
    () =>
      [...snapshots].sort((a, b) =>
        a.snapshot_date < b.snapshot_date ? -1 : 1,
      ),
    [snapshots],
  );

  const prior = useMemo(() => {
    if (!current) return null;
    return (
      snapshots.find((s) => s.snapshot_date < current.snapshot_date) ?? null
    );
  }, [snapshots, current]);

  if (!current) return null;

  return (
    <section className="space-y-3">
      <SegmentTitle
        segment={segment}
        title={title}
        renamable={renamable}
        onRename={onRename}
      />

      {/* Reach & engagement % trend across all of this segment's months. */}
      <ReachEngagementTrend months={orderedMonths} />

      {/* Month pills, mirroring the Outreach Dashboard. Selecting a month
          shows its metrics and auto-compares to the prior imported month. */}
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-slate-muted mr-1">Month</span>
        {orderedMonths.map((s) => {
          const active = s.snapshot_date === current.snapshot_date;
          return (
            <button
              key={s.id}
              type="button"
              title={fmtMonth(s.snapshot_date)}
              onClick={() => setSelectedDate(s.snapshot_date)}
              className={
                'text-xs px-2 py-1 rounded border transition-colors ' +
                (active
                  ? 'bg-indigo text-white border-indigo'
                  : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
              }
            >
              {monthShort(s.week_number)}
            </button>
          );
        })}
        {prior && (
          <span className="text-xs text-slate-muted ml-2">
            vs {monthShort(prior.week_number)}
          </span>
        )}
      </div>

      <p className="text-xs text-slate-muted">
        {fmtMonth(current.snapshot_date)}.
        {prior
          ? ` Change vs ${fmtMonth(prior.snapshot_date)}.`
          : ' No earlier month to compare.'}
      </p>

      {/* Headline KPI cards: the reach/engagement percentages the team
          used to compute by hand, plus the supporting totals. auto-fit grid
          spreads the cards across the full page width and reflows as the
          window resizes; each card stays square via aspect-square. */}
      <div
        className="grid gap-4"
        style={{
          gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
        }}
      >
        <KpiCard
          label="Reach"
          primary={fmtPct(reachPct(current))}
          secondary={`${fmtInt(current.reach)} of ${fmtInt(current.total_accounts)} accounts`}
          delta={pctPointDelta(prior, current, reachPct)}
        />
        <KpiCard
          label="Engagement"
          primary={fmtPct(engagementPct(current))}
          secondary={`${fmtInt(current.engagement)} of ${fmtInt(current.total_accounts)} accounts`}
          delta={pctPointDelta(prior, current, engagementPct)}
        />
        <KpiCard
          label="Intent"
          primary={fmtPct(intentPct(current))}
          secondary={`${fmtInt(current.intent)} accounts`}
          delta={pctPointDelta(prior, current, intentPct)}
        />
        <KpiCard
          label="Accounts with activity"
          primary={fmtPct(activityPct(current))}
          secondary={`${fmtInt(current.accounts_with_activity)} accounts`}
          delta={pctPointDelta(prior, current, activityPct)}
        />
        <KpiCard
          label="Total accounts"
          primary={fmtInt(current.total_accounts)}
          secondary="Target accounts"
          delta={countDelta(prior?.total_accounts ?? null, current.total_accounts)}
        />
      </div>

      {/* Source breakdowns, mirroring the three-column 6sense layout. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ChartCard title="Reach" subtitle={`${fmtInt(current.reach)} accounts`}>
          <BreakdownList
            current={current}
            prior={prior}
            rows={[
              ['CRM / MAP campaigns reached', 'crm_map_campaigns_reached'],
              ['Sales reached', 'sales_reached'],
              ['6sense campaigns reached', 'sixsense_campaigns_reached'],
              ['External campaigns reached', 'external_campaigns_reached'],
              ['LinkedIn campaigns reached', 'linkedin_campaigns_reached'],
              ['A.I. emails reached', 'ai_emails_reached'],
            ]}
          />
        </ChartCard>

        <ChartCard title="Intent" subtitle={`${fmtInt(current.intent)} accounts`}>
          <BreakdownList
            current={current}
            prior={prior}
            rows={[
              ['6sense keyword research', 'sixsense_keyword_research'],
              ['Bombora topics', 'bombora_topics'],
              ['G2 intent', 'g2_intent'],
              ['TrustRadius intent', 'trustradius_intent'],
            ]}
          />
        </ChartCard>

        <ChartCard
          title="Engagement"
          subtitle={`${fmtInt(current.engagement)} accounts`}
        >
          <BreakdownList
            current={current}
            prior={prior}
            rows={[
              ['Anonymous web engaged', 'anonymous_web_engaged'],
              ['Known web engaged', 'known_web_engaged'],
              ['CRM / MAP campaigns engaged', 'crm_map_campaigns_engaged'],
              ['Sales engaged', 'sales_engaged'],
              ['6sense campaigns engaged', 'sixsense_campaigns_engaged'],
              ['External campaigns engaged', 'external_campaigns_engaged'],
              ['LinkedIn campaigns engaged', 'linkedin_campaigns_engaged'],
              ['Attended webinars', 'attended_webinars'],
              ['Attended trade shows', 'attended_trade_shows'],
              ['Attended field events', 'attended_field_events'],
              ['A.I. emails engaged', 'ai_emails_engaged'],
            ]}
          />
        </ChartCard>
      </div>
    </section>
  );
}

// Section heading with inline rename for campaign segments. Click the pencil
// to edit; Enter or Save commits the rename across all the segment's rows,
// Escape cancels. The overall segment (renamable=false) renders a plain title.
function SegmentTitle({
  segment,
  title,
  renamable,
  onRename,
}: {
  segment: string;
  title: string;
  renamable: boolean;
  onRename: (from: string, to: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setDraft(title);
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setError(null);
  };
  const save = async () => {
    const next = draft.trim();
    if (!next || next === segment) {
      cancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRename(segment, next);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename failed');
    } finally {
      setBusy(false);
    }
  };

  if (!renamable) {
    return <h2 className="text-lg font-semibold text-charcoal">{title}</h2>;
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draft}
            autoFocus
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
              if (e.key === 'Escape') cancel();
            }}
            className="text-lg font-semibold text-charcoal border border-border rounded px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-indigo"
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="text-xs px-2 py-1 rounded bg-indigo text-white hover:bg-indigo/90 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            className="text-xs px-2 py-1 text-slate-muted hover:text-charcoal"
          >
            Cancel
          </button>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 group">
      <h2 className="text-lg font-semibold text-charcoal">{title}</h2>
      <button
        type="button"
        onClick={start}
        title="Rename segment"
        aria-label="Rename segment"
        className="inline-flex items-center justify-center w-6 h-6 rounded text-slate-muted hover:bg-muted hover:text-charcoal"
      >
        <span className="text-sm">✎</span>
      </button>
    </div>
  );
}

// Full-width line chart at the top of each section: Reach % and Engagement %
// across all the segment's months (oldest -> newest). Independent of the month
// pill selection below; always shows the full trend.
function ReachEngagementTrend({ months }: { months: SixSenseSnapshot[] }) {
  const data = useMemo(
    () =>
      months.map((s) => ({
        month: monthShort(s.week_number),
        reach: Math.round(reachPct(s) * 10) / 10,
        engagement: Math.round(engagementPct(s) * 10) / 10,
      })),
    [months],
  );

  // A single month can't show a trend; skip the chart until there are 2+.
  if (data.length < 2) return null;

  return (
    <ChartCard title="Reach & Engagement Trend" subtitle="% of accounts, by month">
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.border} />
          <XAxis
            dataKey="month"
            tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
            axisLine={{ stroke: CHART_COLORS.border }}
            tickLine={{ stroke: CHART_COLORS.border }}
          />
          <YAxis
            tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
            axisLine={{ stroke: CHART_COLORS.border }}
            tickLine={{ stroke: CHART_COLORS.border }}
            tickFormatter={(v) => `${v}%`}
            domain={[0, 100]}
            width={44}
          />
          <Tooltip
            formatter={(v) => `${v}%`}
            contentStyle={{
              fontSize: 11,
              border: `1px solid ${CHART_COLORS.border}`,
              borderRadius: 6,
            }}
            labelStyle={{ color: CHART_COLORS.charcoal, fontWeight: 600 }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line
            type="monotone"
            dataKey="reach"
            name="Reach"
            stroke={CHART_COLORS.indigo}
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="engagement"
            name="Engagement"
            stroke={CHART_COLORS.teal}
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function Header({
  onNavigate,
  children,
}: {
  onNavigate: (p: PageKey) => void;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-charcoal">
          6Sense: Account Reach &amp; Engagement
        </h1>
        <p className="mt-1 text-sm text-slate-muted">
          Target-account reach and engagement from the 6sense "Activities By
          Source" summary. Import a new monthly export on the Import tab.
        </p>
      </div>
      <div className="flex items-center gap-3">
        {children}
        <button
          type="button"
          onClick={() => onNavigate('sixsense-import')}
          className="text-xs px-3 py-1.5 rounded border border-border text-charcoal hover:border-charcoal/30"
        >
          Import
        </button>
      </div>
    </header>
  );
}

// A delta to render: signed value + direction. null when no comparison.
interface Delta {
  text: string;
  dir: 'up' | 'down' | 'flat';
}

// Percentage-point change of a derived percentage (e.g. reach %) between two
// snapshots. The arrow direction follows the sign.
function pctPointDelta(
  prior: SixSenseSnapshot | null,
  current: SixSenseSnapshot,
  fn: (s: SixSenseSnapshot) => number,
): Delta | null {
  if (!prior) return null;
  const diff = fn(current) - fn(prior);
  const rounded = Math.round(diff * 10) / 10;
  return {
    text: `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} pts`,
    dir: rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat',
  };
}

// Absolute count change between two snapshots.
function countDelta(prior: number | null, current: number | null): Delta | null {
  if (prior === null || current === null) return null;
  const diff = current - prior;
  return {
    text: `${diff > 0 ? '+' : ''}${diff.toLocaleString()}`,
    dir: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
  };
}

function DeltaPill({ delta }: { delta: Delta | null }) {
  if (!delta) return null;
  const color =
    delta.dir === 'up'
      ? 'text-success'
      : delta.dir === 'down'
        ? 'text-danger'
        : 'text-slate-muted';
  const arrow = delta.dir === 'up' ? '↑' : delta.dir === 'down' ? '↓' : '→';
  return (
    <span className={`text-xs font-medium whitespace-nowrap ${color}`}>
      {arrow} {delta.text}
    </span>
  );
}

function KpiCard({
  label,
  primary,
  secondary,
  delta,
}: {
  label: string;
  primary: string;
  secondary: string;
  delta: Delta | null;
}) {
  // Square tile (aspect-square + inline aspectRatio fallback): label pinned
  // top, the headline value centered in the middle, supporting count + delta
  // pinned at the bottom. Bottom text wraps (no truncation) so longer counts
  // like "219 of 271 accounts" stay fully readable.
  return (
    <div
      style={{ aspectRatio: '1 / 1' }}
      className="border border-border rounded-lg bg-bg shadow-sm p-4 flex flex-col"
    >
      <p className="text-xs text-slate-muted">{label}</p>
      <div className="flex-1 flex items-center justify-center">
        <p className="text-3xl font-semibold text-indigo text-center">
          {primary}
        </p>
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="text-xs text-slate-muted leading-tight">
          {secondary}
        </span>
        <span className="flex-shrink-0">
          <DeltaPill delta={delta} />
        </span>
      </div>
    </div>
  );
}

// One breakdown panel's rows: label + count + MoM count delta. Reads the
// count fields off the snapshot by key.
type CountField = {
  [K in keyof SixSenseSnapshot]: SixSenseSnapshot[K] extends number | null
    ? K
    : never;
}[keyof SixSenseSnapshot];

function BreakdownList({
  current,
  prior,
  rows,
}: {
  current: SixSenseSnapshot;
  prior: SixSenseSnapshot | null;
  rows: [label: string, field: CountField][];
}) {
  return (
    <ul className="divide-y divide-border">
      {rows.map(([label, field]) => {
        const value = current[field] as number | null;
        const priorValue = (prior?.[field] ?? null) as number | null;
        return (
          <li
            key={field}
            className="flex items-center justify-between gap-3 py-1.5"
          >
            <span className="text-xs text-charcoal truncate">{label}</span>
            <span className="flex items-center gap-2 flex-shrink-0">
              <span className="text-xs font-medium text-charcoal tabular-nums">
                {fmtInt(value)}
              </span>
              <DeltaPill delta={countDelta(priorValue, value)} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
