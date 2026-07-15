// CampaignsOverviewPage — the full-funnel scorecard, one card per campaign tag,
// pulling 6Sense engagement, website leads/MQLs, opportunities, and Outreach
// activity for the tag's linked assets (via computeScorecard).

import { useMemo, useState } from 'react';
import type { PageKey } from '../App';
import type {
  Channel,
  Lead,
  Attribution,
  AttributionTouch,
  OutreachSnapshot,
  SixSenseSnapshot,
  LinkedinAdSnapshot,
  CampaignTag,
} from '../types/db';
import type { UseCampaignTagsResult } from '../hooks/useCampaignTags';
import {
  computeScorecard,
  type CampaignScorecard,
  type ChannelFunnel,
  type OpenDeal,
  type SequenceEmailStats,
  type LinkedinAdsetStats,
} from '../lib/campaignScorecard';
import ChartCard from '../components/charts/ChartCard';
import ChannelFunnelBars from '../components/campaigns/ChannelFunnelBars';

export default function CampaignsOverviewPage({
  tagsHook,
  channels,
  leads,
  attributions,
  attributionTouches,
  outreachSnapshots,
  sixSenseSnapshots,
  linkedinSnapshots,
  loading,
  onNavigate,
}: {
  tagsHook: UseCampaignTagsResult;
  channels: Channel[];
  leads: Lead[];
  attributions: Attribution[];
  attributionTouches: AttributionTouch[];
  outreachSnapshots: OutreachSnapshot[];
  sixSenseSnapshots: SixSenseSnapshot[];
  linkedinSnapshots: LinkedinAdSnapshot[];
  loading: boolean;
  onNavigate: (p: PageKey) => void;
}) {
  const { tags, links } = tagsHook;
  const [year, setYear] = useState<number | null>(new Date().getFullYear());

  // Year options from the data present across silos.
  const yearOptions = useMemo(() => {
    const ys = new Set<number>();
    for (const a of attributions) ys.add(a.year);
    for (const s of outreachSnapshots) ys.add(s.year);
    for (const s of sixSenseSnapshots) ys.add(s.year);
    for (const l of leads)
      if (l.marketing_sourced_date)
        ys.add(Number(l.marketing_sourced_date.slice(0, 4)));
    return [...ys].filter((y) => y > 2000).sort((a, b) => b - a);
  }, [attributions, outreachSnapshots, sixSenseSnapshots, leads]);

  const cards = useMemo(
    () =>
      tags.map((tag) => ({
        tag,
        score: computeScorecard(
          tag.id,
          links,
          {
            channels,
            leads,
            attributions,
            attributionTouches,
            outreachSnapshots,
            sixSenseSnapshots,
            linkedinSnapshots,
          },
          year,
        ),
      })),
    [
      tags,
      links,
      channels,
      leads,
      attributions,
      attributionTouches,
      outreachSnapshots,
      sixSenseSnapshots,
      linkedinSnapshots,
      year,
    ],
  );

  return (
    <div className="p-8 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-charcoal">
            Campaigns — Overview
          </h1>
          <p className="mt-1 text-sm text-slate-muted">
            Full-funnel view per campaign, from each campaign's tagged assets:
            6Sense engagement, leads and MQLs, opportunities, and Outreach.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-muted">
          Year
          <select
            value={year ?? 'all'}
            onChange={(e) =>
              setYear(e.target.value === 'all' ? null : Number(e.target.value))
            }
            className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
          >
            <option value="all">All time</option>
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </header>

      {loading && tags.length === 0 ? (
        <p className="text-sm text-slate-muted italic">Loading…</p>
      ) : tags.length === 0 ? (
        <div className="border border-border rounded p-6 text-sm text-slate-muted">
          No campaigns yet.{' '}
          <button
            type="button"
            onClick={() => onNavigate('campaigns-tags')}
            className="text-indigo hover:underline"
          >
            Create one and tag its assets
          </button>{' '}
          to see the scorecard here.
        </div>
      ) : (
        <div className="space-y-4">
          {cards.map(({ tag, score }) => (
            <CampaignCard key={tag.id} tag={tag} score={score} />
          ))}
        </div>
      )}
    </div>
  );
}

function CampaignCard({
  tag,
  score,
}: {
  tag: CampaignTag;
  score: CampaignScorecard;
}) {
  // Default to expanded: the per-channel breakdown is the primary insight, so
  // don't hide it behind a click.
  const [expanded, setExpanded] = useState(true);
  const untagged =
    score.channelCount === 0 &&
    score.segmentCount === 0 &&
    score.sequenceCount === 0 &&
    score.linkedinAdsetCount === 0;
  const hasChannels = score.byChannel.length > 0;

  return (
    <div className="bg-white rounded-lg border border-border shadow-sm p-4">
      <div className="flex items-center gap-2 mb-3">
        <span
          className="inline-block w-3 h-3 rounded-full"
          style={{ backgroundColor: tag.color || '#4F46E5' }}
        />
        <h2 className="text-lg font-semibold text-charcoal">{tag.name}</h2>
        <span className="text-xs text-slate-muted ml-2">
          {score.channelCount} channels · {score.segmentCount} segments ·{' '}
          {score.sequenceCount} sequences · {score.linkedinAdsetCount} LinkedIn
        </span>
        {!untagged && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="ml-auto text-xs text-indigo hover:underline"
          >
            {expanded ? 'Hide details ▾' : 'Details ▸'}
          </button>
        )}
      </div>

      {untagged ? (
        <p className="text-sm text-slate-muted italic">
          No assets tagged yet. Tag this campaign's channels, 6Sense segment,
          and Outreach sequences on the Tags page.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            <Stat
              label="Reach"
              value={score.reachPct == null ? '—' : `${score.reachPct.toFixed(0)}%`}
            />
            <Stat
              label="Engagement"
              value={
                score.engagementPct == null
                  ? '—'
                  : `${score.engagementPct.toFixed(0)}%`
              }
            />
            <Stat label="Leads" value={score.leads.toLocaleString()} />
            <Stat label="MQLs" value={score.mqls.toLocaleString()} />
            <Stat
              label="Opps"
              value={(score.hpp + score.opp + score.pursuit).toLocaleString()}
              sub={`${score.hpp} HPP · ${score.opp} Opp · ${score.pursuit} Pursuit`}
            />
            <Stat label="Won" value={score.won.toLocaleString()} />
            <Stat label="Sent" value={score.outreachSent.toLocaleString()} />
            <Stat label="Replied" value={score.outreachReplied.toLocaleString()} />
          </div>

          {expanded && (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {hasChannels ? (
                  <>
                    <ChartCard
                      title="Funnel by Channel"
                      subtitle="Which channel drove each stage of this campaign."
                    >
                      <ChannelFunnelBars byChannel={score.byChannel} />
                      {/* Campaign-wide stage conversion, folded into this tile. */}
                      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs border-t border-border pt-2">
                        <Conv label="Lead → MQL" rate={score.conversion.leadToMql} />
                        <Conv label="MQL → Opp" rate={score.conversion.mqlToOpp} />
                        <Conv label="Opp → Won" rate={score.conversion.oppToWon} />
                      </div>
                    </ChartCard>
                    <ChartCard
                      title="Leads & Opps by Channel"
                      subtitle="Counts and stage conversion per source channel."
                    >
                      <ChannelBreakdownTable byChannel={score.byChannel} />
                    </ChartCard>
                  </>
                ) : (
                  <p className="text-sm text-slate-muted italic lg:col-span-2">
                    No channels tagged to this campaign, so there's no per-channel
                    funnel. Tag its channels on the Tags page to see the breakdown.
                  </p>
                )}
              </div>

              <ChartCard
                title="Outbound performance"
                subtitle="Lifetime totals per tagged Outreach sequence."
              >
                {score.emailBySequence.length > 0 ? (
                  <SequenceEmailTable sequences={score.emailBySequence} />
                ) : (
                  <p className="text-sm text-slate-muted italic">
                    No Outreach sequences tagged to this campaign. Tag them on
                    the Tags page to see outbound performance.
                  </p>
                )}
              </ChartCard>

              <ChartCard
                title="LinkedIn Ads Performance by Ad Set"
                subtitle="Spend, impressions, clicks, and derived CTR / CPC / CPM."
              >
                {score.adsByAdset.length > 0 ? (
                  <LinkedinAdsTable adsets={score.adsByAdset} />
                ) : (
                  <p className="text-sm text-slate-muted italic">
                    No LinkedIn ad sets tagged to this campaign. Tag them on the
                    Tags page to see ad performance.
                  </p>
                )}
              </ChartCard>

              <ChartCard
                title="Open opportunities"
                subtitle="Pipeline if this campaign's open deals close-won, split into deals it sourced (first touch) and deals it influenced later. Every campaign that touched a deal counts it in full, so totals overlap across campaigns."
              >
                <DealsPipelineCard
                  deals={score.openDeals}
                  sourced={score.openPipelineSourced}
                  influenced={score.openPipelineInfluenced}
                  sourcedCount={score.openDealsSourcedCount}
                  influencedCount={score.openDealsInfluencedCount}
                  missing={score.openDealsMissingAmount}
                />
              </ChartCard>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Conv({ label, rate }: { label: string; rate: number | null }) {
  return (
    <span className="text-slate-muted">
      {label}:{' '}
      <span
        className={rate == null ? 'text-slate-muted' : 'text-charcoal font-medium'}
      >
        {rate == null ? '—' : `${(rate * 100).toFixed(1)}%`}
      </span>
    </span>
  );
}

// Exact per-channel counts: the direct answer to "how many leads came through
// Website vs Content Syndication vs ...". Rows are already sorted by leads desc.
// Full cell borders + zebra-shaded alternating numeric columns for readability.
function ChannelBreakdownTable({ byChannel }: { byChannel: ChannelFunnel[] }) {
  const oppsOf = (c: ChannelFunnel) => c.hpp + c.opp + c.pursuit + c.won;
  const pct = (num: number, den: number) =>
    den > 0 ? `${((num / den) * 100).toFixed(0)}%` : '—';

  // Numeric columns, in order. `shade` alternates so every other column reads
  // as a band; header tooltips spell out the conversion abbreviations.
  const cols: {
    key: string;
    label: string;
    title?: string;
    value: (c: ChannelFunnel) => string;
  }[] = [
    { key: 'leads', label: 'Leads', value: (c) => c.leads.toLocaleString() },
    { key: 'mqls', label: 'MQLs', value: (c) => c.mqls.toLocaleString() },
    {
      key: 'lm',
      label: 'L→M',
      title: 'Lead to MQL conversion',
      value: (c) => pct(c.mqls, c.leads),
    },
    { key: 'opps', label: 'Opps', value: (c) => oppsOf(c).toLocaleString() },
    {
      key: 'mo',
      label: 'M→O',
      title: 'MQL to Opp conversion',
      value: (c) => pct(oppsOf(c), c.mqls),
    },
    { key: 'won', label: 'Won', value: (c) => c.won.toLocaleString() },
  ];
  const shadeAt = (i: number) => (i % 2 === 1 ? 'bg-muted/50' : '');

  const total = byChannel.reduce(
    (t, c) => ({
      leads: t.leads + c.leads,
      mqls: t.mqls + c.mqls,
      opps: t.opps + oppsOf(c),
      won: t.won + c.won,
    }),
    { leads: 0, mqls: 0, opps: 0, won: 0 },
  );
  const totalCells = [
    total.leads.toLocaleString(),
    total.mqls.toLocaleString(),
    pct(total.mqls, total.leads),
    total.opps.toLocaleString(),
    pct(total.opps, total.mqls),
    total.won.toLocaleString(),
  ];

  const cell = 'border border-border px-2 py-1';

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm border-collapse border border-border">
        <thead className="text-xs text-slate-muted bg-muted/40">
          <tr>
            <th className={`${cell} text-left font-medium`}>Campaign</th>
            <th className={`${cell} text-left font-medium`}>Channel</th>
            {cols.map((col, i) => (
              <th
                key={col.key}
                title={col.title}
                className={`${cell} text-right font-medium ${shadeAt(i)}`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {byChannel.map((c) => (
            <tr key={c.channelId || c.channelName}>
              <td className={`${cell} text-slate-muted truncate max-w-[180px]`}>
                {c.parentName || '—'}
              </td>
              <td className={`${cell} text-charcoal truncate max-w-[200px]`}>
                {c.channelName}
              </td>
              {cols.map((col, i) => (
                <td
                  key={col.key}
                  className={`${cell} text-right tabular-nums text-slate-muted ${shadeAt(i)}`}
                >
                  {col.value(c)}
                </td>
              ))}
            </tr>
          ))}
          <tr className="font-medium">
            <td className={`${cell} text-charcoal`} colSpan={2}>
              Total
            </td>
            {totalCells.map((v, i) => (
              <td
                key={i}
                className={`${cell} text-right tabular-nums text-charcoal ${shadeAt(i)}`}
              >
                {v}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// LinkedIn ad-set performance (summed across weeks in scope). CTR = clicks/impr,
// CPC = spend/clicks, CPM = spend/impr*1000. The Total row recomputes each rate
// from the SUMMED spend/impressions/clicks (blended), never an average of rows.
function LinkedinAdsTable({ adsets }: { adsets: LinkedinAdsetStats[] }) {
  const money = (n: number) =>
    `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const money2 = (n: number) => `$${n.toFixed(2)}`;
  const num = (n: number) => n.toLocaleString();
  const ctr = (clicks: number, impr: number) =>
    impr > 0 ? `${((clicks / impr) * 100).toFixed(2)}%` : '—';
  const cpc = (spend: number, clicks: number) =>
    clicks > 0 ? money2(spend / clicks) : '—';
  const cpm = (spend: number, impr: number) =>
    impr > 0 ? money2((spend / impr) * 1000) : '—';

  type Row = { spend: number; impressions: number; clicks: number };
  const cols: { key: string; label: string; title?: string; value: (r: Row) => string }[] = [
    { key: 'spend', label: 'Spend', value: (r) => money(r.spend) },
    { key: 'impr', label: 'Impr.', value: (r) => num(r.impressions) },
    { key: 'clicks', label: 'Clicks', value: (r) => num(r.clicks) },
    { key: 'ctr', label: 'CTR', title: 'Clicks / Impressions', value: (r) => ctr(r.clicks, r.impressions) },
    { key: 'cpc', label: 'CPC', title: 'Spend / Clicks', value: (r) => cpc(r.spend, r.clicks) },
    { key: 'cpm', label: 'CPM', title: 'Spend / Impressions × 1000', value: (r) => cpm(r.spend, r.impressions) },
  ];
  const shadeAt = (i: number) => (i % 2 === 1 ? 'bg-muted/50' : '');
  const total = adsets.reduce(
    (t, a) => ({
      spend: t.spend + a.spend,
      impressions: t.impressions + a.impressions,
      clicks: t.clicks + a.clicks,
    }),
    { spend: 0, impressions: 0, clicks: 0 },
  );
  const cell = 'border border-border px-2 py-1';

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm border-collapse border border-border">
        <thead className="text-xs text-slate-muted bg-muted/40">
          <tr>
            <th className={`${cell} text-left font-medium`}>Ad set</th>
            {cols.map((col, i) => (
              <th key={col.key} title={col.title} className={`${cell} text-right font-medium ${shadeAt(i)}`}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {adsets.map((a) => (
            <tr key={a.adsetId}>
              <td className={`${cell} text-charcoal truncate max-w-[240px]`} title={a.name}>
                {a.name}
              </td>
              {cols.map((col, i) => (
                <td key={col.key} className={`${cell} text-right tabular-nums text-slate-muted ${shadeAt(i)}`}>
                  {col.value(a)}
                </td>
              ))}
            </tr>
          ))}
          <tr className="font-medium">
            <td className={`${cell} text-charcoal`}>Total</td>
            {cols.map((col, i) => (
              <td key={col.key} className={`${cell} text-right tabular-nums text-charcoal ${shadeAt(i)}`}>
                {col.value(total)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// Lifetime email metrics per tagged sequence. Open/Click/Reply over Delivered;
// Bounce/Unsub over Sent; Delivery = Delivered/Sent. The Total row recomputes
// each rate from the SUMMED counts (blended), never an average of the rows.
function SequenceEmailTable({ sequences }: { sequences: SequenceEmailStats[] }) {
  const pct = (num: number, den: number) =>
    den > 0 ? `${((num / den) * 100).toFixed(1)}%` : '—';
  const num = (n: number) => n.toLocaleString();

  // Numeric columns in order; value(s) reads a sequence (or the summed total).
  const cols: {
    key: string;
    label: string;
    title?: string;
    value: (s: SequenceEmailStats) => string;
  }[] = [
    { key: 'sent', label: 'Sent', value: (s) => num(s.sent) },
    { key: 'delivered', label: 'Delivered', value: (s) => num(s.delivered) },
    {
      key: 'deliv',
      label: 'Deliv %',
      title: 'Delivered / Sent',
      value: (s) => pct(s.delivered, s.sent),
    },
    {
      key: 'open',
      label: 'Open %',
      title: 'Opened / Delivered',
      value: (s) => pct(s.opened, s.delivered),
    },
    {
      key: 'click',
      label: 'Click %',
      title: 'Clicked / Delivered',
      value: (s) => pct(s.clicked, s.delivered),
    },
    {
      key: 'reply',
      label: 'Reply %',
      title: 'Replied / Delivered',
      value: (s) => pct(s.replied, s.delivered),
    },
    {
      key: 'bounce',
      label: 'Bounce %',
      title: 'Bounced / Sent',
      value: (s) => pct(s.bounced, s.sent),
    },
    { key: 'unsub', label: 'Unsub', value: (s) => num(s.optedOut) },
    {
      key: 'unsubpct',
      label: 'Unsub %',
      title: 'Opted out / Sent',
      value: (s) => pct(s.optedOut, s.sent),
    },
    {
      key: 'calls',
      label: 'Calls made',
      title: 'Outbound calls completed on this sequence',
      value: (s) => num(s.calls),
    },
    {
      key: 'linkedin',
      label: 'LinkedIn msgs',
      title: 'LinkedIn tasks completed on this sequence',
      value: (s) => num(s.linkedinMessages),
    },
  ];
  const shadeAt = (i: number) => (i % 2 === 1 ? 'bg-muted/50' : '');

  // Blended total: sum every count, then the column value() reads that sum.
  const total: SequenceEmailStats = sequences.reduce(
    (t, s) => ({
      sequenceId: 0,
      name: 'Total',
      sent: t.sent + s.sent,
      delivered: t.delivered + s.delivered,
      bounced: t.bounced + s.bounced,
      opened: t.opened + s.opened,
      clicked: t.clicked + s.clicked,
      replied: t.replied + s.replied,
      optedOut: t.optedOut + s.optedOut,
      calls: t.calls + s.calls,
      linkedinMessages: t.linkedinMessages + s.linkedinMessages,
    }),
    {
      sequenceId: 0,
      name: 'Total',
      sent: 0,
      delivered: 0,
      bounced: 0,
      opened: 0,
      clicked: 0,
      replied: 0,
      optedOut: 0,
      calls: 0,
      linkedinMessages: 0,
    },
  );

  const cell = 'border border-border px-2 py-1';

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm border-collapse border border-border">
        <thead className="text-xs text-slate-muted bg-muted/40">
          <tr>
            <th className={`${cell} text-left font-medium`}>Sequence</th>
            {cols.map((col, i) => (
              <th
                key={col.key}
                title={col.title}
                className={`${cell} text-right font-medium ${shadeAt(i)}`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sequences.map((s) => (
            <tr key={s.sequenceId}>
              <td className={`${cell} text-charcoal truncate max-w-[220px]`}>
                {s.name}
              </td>
              {cols.map((col, i) => (
                <td
                  key={col.key}
                  className={`${cell} text-right tabular-nums text-slate-muted ${shadeAt(i)}`}
                >
                  {col.value(s)}
                </td>
              ))}
            </tr>
          ))}
          <tr className="font-medium">
            <td className={`${cell} text-charcoal`}>Total</td>
            {cols.map((col, i) => (
              <td
                key={col.key}
                className={`${cell} text-right tabular-nums text-charcoal ${shadeAt(i)}`}
              >
                {col.value(total)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// Compact currency: $1.2M, $450K, $0.
function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

// Which touch this campaign was on a deal. Rank 1 (or the no-touch fallback on
// the deal's own channel) means the campaign sourced it; 2+ means it came in
// after another campaign sourced it. Deals with no recorded touches show no
// rank, only whether their channel belongs to this campaign.
function ordinalTouch(n: number): string {
  const s = n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
  return `${s} touch`;
}

function TouchBadge({
  rank,
  sourced,
}: {
  rank: number | null;
  sourced: boolean;
}) {
  const label =
    rank == null ? (sourced ? '1st touch' : 'Influenced') : ordinalTouch(rank);
  return (
    <span
      className={
        'inline-block rounded-full px-1.5 py-0.5 text-[10px] border ' +
        (sourced
          ? 'border-indigo/40 text-indigo bg-indigo/5'
          : 'border-border text-slate-muted bg-muted/40')
      }
      title={
        sourced
          ? 'First touch: this campaign sourced the deal'
          : 'This campaign influenced the deal after another sourced it'
      }
    >
      {label}
    </span>
  );
}

// Open opportunities by name + amount, with the total pipeline they'd generate
// if won, split into deals this campaign sourced vs influenced. Deals with no
// amount show "—" and are excluded from the totals.
function DealsPipelineCard({
  deals,
  sourced,
  influenced,
  sourcedCount,
  influencedCount,
  missing,
}: {
  deals: OpenDeal[];
  sourced: number;
  influenced: number;
  sourcedCount: number;
  influencedCount: number;
  missing: number;
}) {
  if (deals.length === 0) {
    return (
      <p className="text-sm text-slate-muted italic">
        No open opportunities in this campaign for the selected year.
      </p>
    );
  }
  const dealWord = (n: number) => (n === 1 ? 'deal' : 'deals');
  // A bucket holding only deals with no amount would read "$0", which says the
  // pipeline is worth nothing rather than unknown. Show a dash instead.
  const money = (amount: number, count: number) =>
    count > 0 && amount === 0 ? '—' : fmtMoney(amount);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold text-charcoal tabular-nums">
            {money(sourced, sourcedCount)}
          </span>
          <span className="text-xs text-slate-muted">
            sourced · {sourcedCount} {dealWord(sourcedCount)}
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold text-slate-muted tabular-nums">
            {money(influenced, influencedCount)}
          </span>
          <span className="text-xs text-slate-muted">
            influenced · {influencedCount} {dealWord(influencedCount)}
          </span>
        </div>
        <span className="text-xs text-slate-muted">
          {money(sourced + influenced, deals.length)} pipeline if won
          {missing > 0 && ` · ${missing} without an amount`}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-xs text-slate-muted">
            <tr className="border-b border-border">
              <th className="text-left font-medium py-1 pr-3">Opportunity</th>
              <th className="text-left font-medium py-1 px-2">Stage</th>
              <th className="text-left font-medium py-1 px-2">Touch</th>
              <th className="text-right font-medium py-1 pl-2">Amount</th>
            </tr>
          </thead>
          <tbody>
            {deals.map((d) => (
              <tr key={d.dealId} className="border-b border-border/50">
                <td className="py-1 pr-3 truncate max-w-[360px]">
                  {d.sfLink ? (
                    <a
                      href={d.sfLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo hover:underline"
                      title="Open in Salesforce"
                    >
                      {d.name} ↗
                    </a>
                  ) : (
                    <span className="text-charcoal">{d.name}</span>
                  )}
                </td>
                <td className="py-1 px-2 text-slate-muted">{d.stageLabel}</td>
                <td className="py-1 px-2">
                  <TouchBadge rank={d.touchRank} sourced={d.sourced} />
                </td>
                <td className="py-1 pl-2 text-right tabular-nums text-charcoal">
                  {d.amount == null ? '—' : fmtMoney(d.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="border border-border rounded bg-muted/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-slate-muted">
        {label}
      </p>
      <p className="mt-0.5 text-lg font-semibold text-charcoal tabular-nums">
        {value}
      </p>
      {sub && <p className="text-[9px] text-slate-muted mt-0.5">{sub}</p>}
    </div>
  );
}
