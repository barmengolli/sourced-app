// Compute a full-funnel scorecard for a campaign tag by pulling from the tag's
// linked assets across the four silos. Pure functions over the data already
// loaded by the hooks; no fetching here.
//
// Join semantics (see the campaign-tag migration):
//   channel links       -> the channel + its leaf children -> leads/MQLs
//                          (leads.source_channel_id) and opps
//                          (attributions.channel_id OR any attribution_touch's
//                          channel_id, so a campaign sees deals it influenced
//                          without having sourced).
//   sixsense_segment    -> latest snapshot per tagged segment -> reach/engagement.
//   outreach_sequence   -> per-sequence volume (cumulative counters diffed to
//                          the sequence's span) -> sent / replied.
//
// Deliberate design choices (validated, not oversights):
//   - Leads bucket into a year by marketing_sourced_date; a lead with no date
//     can't belong to a year, so it's excluded from year-filtered views (it
//     still shows under "All time"). This is a data-quality signal, not a bug.
//   - Conversion rates cross two silos (marketing leads vs SFDC opps). A
//     channel can hold sales-sourced opps with no marketing MQL, so MQL->Opp
//     may read "-" (never a >100% impossibility; ratio() guards the zero).
//   - 6Sense multi-segment reach/engagement is an UNWEIGHTED mean of each
//     segment's latest snapshot. Fine for single-segment campaigns; revisit if
//     a campaign spans segments of very different account sizes.
//   - Outreach/email figures are lifetime-to-date (latest cumulative snapshot),
//     so they don't change with the year filter the way volume would.
//   - Open deals are scoped per DEAL, not per attribution row: a deal is in
//     scope if ANY of its stage rows or touches names a tagged channel, and its
//     stage/amount are then resolved from ALL its rows. The older per-row
//     prefilter could resolve a deal's stage from a channel-filtered subset of
//     its rows, which made the stage a property of the filter rather than of
//     the deal.
//   - A deal touched by two campaigns counts at FULL value under both (the
//     "full credit, labelled" model): each campaign's number stands alone and
//     matches Salesforce, so campaign totals OVERLAP and do not sum to company
//     pipeline. The Open opportunities card says so, and splits sourced (this
//     campaign was first touch) from influenced (it came in later).
//   - byChannel stays FIRST-TOUCH only. Spreading an influenced deal across
//     every channel that touched it would double-count inside the stacked bar
//     and break its Total row.

import type {
  Channel,
  Lead,
  Attribution,
  AttributionTouch,
  OutreachSnapshot,
  SixSenseSnapshot,
  LinkedinAdSnapshot,
  CampaignTagLink,
} from '../types/db';
import { reachPct, engagementPct } from './sixsense';
import { compareTouchesChronologically } from './compute';

// One channel's contribution to the campaign funnel (the channel that sourced
// the leads / was first-touch on the opps).
export interface ChannelFunnel {
  channelId: string; // '' for the "Other" roll-up
  channelName: string; // leaf name (year-stripped)
  parentName: string; // parent campaign name (year-stripped), '' if none
  leads: number;
  mqls: number;
  hpp: number;
  opp: number;
  pursuit: number;
  won: number;
}

// Lifetime email metrics for one tagged Outreach sequence (latest cumulative
// snapshot). Rates are derived from these counts in the UI, not stored, so the
// denominators stay explicit (open/click/reply over delivered; bounce/unsub
// over sent).
export interface SequenceEmailStats {
  sequenceId: number;
  name: string;
  sent: number;
  delivered: number;
  bounced: number;
  opened: number;
  clicked: number;
  replied: number;
  optedOut: number;
  calls: number;
  linkedinMessages: number;
}

// Lifetime-in-scope LinkedIn Ads metrics for one tagged ad set. Metrics are
// summed across the ad set's weekly rows (per-week data, not cumulative). Rates
// (CTR/CPC/CPM) are derived in the UI from these counts.
export interface LinkedinAdsetStats {
  adsetId: string;
  name: string;
  product: string | null;
  region: string | null;
  spend: number;
  impressions: number;
  clicks: number;
}

// One open opportunity in the campaign (deduped to its highest stage), for the
// "pipeline if won" tile.
export interface OpenDeal {
  dealId: string;
  name: string;
  account: string | null;
  stage: 'hpp' | 'opp' | 'pursuit';
  stageLabel: string;
  amount: number | null;
  sfLink: string | null; // Salesforce Lightning URL, when known.
  // Where THIS campaign sits in the deal's touch sequence: 1-based position of
  // its EARLIEST touch, chronologically. null when the deal has no recorded
  // touch on a channel of this campaign (it qualified via its stage row's
  // channel instead), which is the common case: most deals have one touch.
  touchRank: number | null;
  // true when this campaign brought the deal in (touch rank 1, or the no-touch
  // fallback where the deal's first-touch channel belongs to this campaign).
  // false means it influenced a deal another campaign sourced.
  sourced: boolean;
}

export interface CampaignScorecard {
  // 6Sense (null when no segment tagged / no data).
  reachPct: number | null;
  engagementPct: number | null;
  sixSenseAccounts: number | null;
  // Funnel from tagged channels.
  leads: number;
  mqls: number;
  hpp: number;
  opp: number;
  pursuit: number;
  won: number;
  wonAmount: number;
  // Outreach from tagged sequences (per-span volume).
  outreachSent: number;
  outreachReplied: number;
  // Per-sequence lifetime email metrics (one row per tagged sequence).
  emailBySequence: SequenceEmailStats[];
  // LinkedIn Ads from tagged ad sets (summed across weeks in scope).
  linkedinSpend: number;
  linkedinImpressions: number;
  linkedinClicks: number;
  adsByAdset: LinkedinAdsetStats[];
  // Per-channel funnel breakdown (sorted by leads desc, top-N + "Other").
  byChannel: ChannelFunnel[];
  // Stage-to-stage conversion (0..1, null when the denominator is 0).
  conversion: {
    leadToMql: number | null;
    mqlToOpp: number | null;
    oppToWon: number | null;
  };
  // Open opportunities (HPP/Opp/Pursuit), deduped by deal, for the pipeline
  // tile. Includes deals this campaign SOURCED (first touch) and deals it
  // INFLUENCED (a later touch), each at its full amount.
  openDeals: OpenDeal[];
  // Sum of amounts across openDeals (deals with no amount excluded). Every open
  // deal is either sourced or influenced, so the two subtotals partition the
  // total: openPipelineSourced + openPipelineInfluenced === openPipelineAmount.
  openPipelineAmount: number;
  openPipelineSourced: number;
  openPipelineInfluenced: number;
  openDealsSourcedCount: number;
  openDealsInfluencedCount: number;
  openDealsMissingAmount: number;
  // Coverage: how many assets of each type are tagged to this campaign.
  channelCount: number;
  segmentCount: number;
  sequenceCount: number;
  linkedinAdsetCount: number;
}

// Cap the per-channel breakdown to keep the stacked bar readable and within the
// 6-color palette; the rest roll into "Other".
const MAX_BREAKDOWN_CHANNELS = 6;

// Resolve this campaign's tagged channels to the full set of channel ids whose
// leads/opps count for it. Includes:
//   - every channel tagged directly to this campaign, and
//   - the sub-channels of a tagged PARENT, EXCEPT any sub-channel that carries
//     its own tag(s) none of which is this campaign (a sub-channel's own tags
//     win over its parent's).
// `claimedByOtherCampaigns` is the set of channel ids that are tagged to at
// least one campaign but NOT to this one. A channel tagged to BOTH this
// campaign and another is NOT in that set: multi-tag means both campaigns
// legitimately claim it, so it must not be excluded here.
function expandChannels(
  ownChannelIds: Set<string>,
  claimedByOtherCampaigns: Set<string>,
  channels: Channel[],
): Set<string> {
  const out = new Set(ownChannelIds);
  // Iterate to a fixpoint so the tree can be deeper than one level (a tagged
  // parent pulls in children, grandchildren, etc.), stopping when no new
  // descendant is added. A sub-channel claimed by another campaign is excluded.
  // A channel claimed only by other campaigns is skipped, which also stops the
  // walk descending THROUGH it: its own children belong to that campaign's
  // subtree, not this one. That is intentional and pre-existing.
  let added = true;
  while (added) {
    added = false;
    for (const c of channels) {
      if (
        c.parent_channel_id &&
        out.has(c.parent_channel_id) &&
        !out.has(c.id) &&
        !claimedByOtherCampaigns.has(c.id)
      ) {
        out.add(c.id);
        added = true;
      }
    }
  }
  return out;
}

// Did this lead ever reach MQL? current_stage OR any stage_history entry.
function isMql(lead: Lead): boolean {
  if (lead.current_stage === 'mql') return true;
  return (lead.stage_history ?? []).some((h) => h.stage === 'mql');
}

const stripYear = (name: string) => name.replace(/^\d{4}\s*-\s*/, '');

// Display name for a channel in the breakdown: its own (leaf) name with the
// "YYYY - " prefix stripped, since the leaf is the sub-channel that drove it.
function channelDisplayName(id: string, byId: Map<string, Channel>): string {
  if (!id) return 'Unattributed'; // deal/lead with no channel on its rows
  const c = byId.get(id);
  if (!c) return 'Unknown';
  return stripYear(c.name);
}

// The parent campaign name for a channel (year-stripped); '' when the channel
// is itself top-level or unknown. Lets the breakdown show which parent campaign
// a leaf like "Life Campaign" (Marketing SDR) or "Limra L&A" (Events) belongs to.
function channelParentName(id: string, byId: Map<string, Channel>): string {
  const c = byId.get(id);
  if (!c || !c.parent_channel_id) return '';
  const p = byId.get(c.parent_channel_id);
  return p ? stripYear(p.name) : '';
}

function ratio(numer: number, denom: number): number | null {
  return denom > 0 ? numer / denom : null;
}

// One record per opportunity, collapsed to its HIGHEST stage. Attributions
// carry one row per stage entered; this dedupes by deal_id (falling back to the
// row id for unlinked singletons) so every count is per-deal, not per-stage.
interface DealRecord {
  dealId: string;
  stage: string; // highest stage reached: hpp | opp | pursuit | closeWon | closeLost
  channelId: string; // first-touch channel of the deal (from its earliest row)
  name: string;
  account: string | null;
  amount: number | null;
  sfLink: string | null;
}

// Stage precedence for collapsing a deal to its highest stage. closeWon and
// closeLost are BOTH terminal, but they must NOT tie: a deal with both a won and
// a lost row would otherwise resolve non-deterministically (by input order).
// closeWon outranks closeLost so a won deal is always counted as won.
const STAGE_RANK: Record<string, number> = {
  hpp: 1,
  opp: 2,
  pursuit: 3,
  closeLost: 4,
  closeWon: 5,
};

const OPEN_STAGE_LABEL: Record<string, string> = {
  hpp: 'HPP',
  opp: 'Opp',
  pursuit: 'Pursuit',
};

function dedupeDealsByHighestStage(attrs: Attribution[]): DealRecord[] {
  const map = new Map<
    string,
    { rows: Attribution[]; topStage: string; topRank: number }
  >();
  for (const a of attrs) {
    const key = a.deal_id ?? a.id;
    const rank = STAGE_RANK[a.stage_key] ?? 0;
    const entry = map.get(key);
    if (!entry) {
      map.set(key, { rows: [a], topStage: a.stage_key, topRank: rank });
    } else {
      entry.rows.push(a);
      if (rank > entry.topRank) {
        entry.topRank = rank;
        entry.topStage = a.stage_key;
      }
    }
  }
  const out: DealRecord[] = [];
  for (const [dealId, entry] of map) {
    const named = entry.rows.find((r) => r.label) ?? entry.rows[0];
    // Amount comes from the deal's HIGHEST-stage row. SFDC amounts get revised
    // as a deal progresses and the stage rows genuinely disagree (a deal can
    // read $1.5M on HPP and $1.9M on Pursuit), so the latest stage carries the
    // freshest number. Ties within a stage break on stage_entered_at desc then
    // id, so the pick is deterministic rather than dependent on array order.
    // Rows with no positive amount are skipped, falling BACK DOWN the ladder,
    // so a deal whose top row has no amount still reports its earlier one.
    const byStageDesc = [...entry.rows].sort((a, b) => {
      const ra = STAGE_RANK[a.stage_key] ?? 0;
      const rb = STAGE_RANK[b.stage_key] ?? 0;
      if (ra !== rb) return rb - ra;
      if (a.stage_entered_at !== b.stage_entered_at) {
        return a.stage_entered_at < b.stage_entered_at ? 1 : -1;
      }
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    const amountRow = byStageDesc.find((r) => r.amount != null && r.amount > 0);
    // First-touch channel = the channel on the deal's earliest stage row.
    // Tie-break on id so rows sharing a stage_entered_at resolve deterministically.
    const byDate = [...entry.rows].sort((a, b) => {
      if (a.stage_entered_at !== b.stage_entered_at) {
        return a.stage_entered_at < b.stage_entered_at ? -1 : 1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const linkRow = entry.rows.find((r) => r.sf_link);
    out.push({
      dealId,
      stage: entry.topStage,
      channelId: byDate[0].channel_id ?? named.channel_id ?? '',
      name: named.label || named.account || 'Untitled opportunity',
      account: named.account ?? null,
      amount: amountRow?.amount ?? null,
      sfLink: linkRow?.sf_link ?? null,
    });
  }
  return out;
}

export function computeScorecard(
  tagId: string,
  allLinks: CampaignTagLink[],
  data: {
    channels: Channel[];
    leads: Lead[];
    attributions: Attribution[];
    // Required, not optional: a caller that forgot to pass touches would
    // silently fall back to first-touch-only opps, which is the exact bug the
    // touch join exists to fix.
    attributionTouches: AttributionTouch[];
    outreachSnapshots: OutreachSnapshot[];
    sixSenseSnapshots: SixSenseSnapshot[];
    linkedinSnapshots: LinkedinAdSnapshot[];
  },
  filterYear: number | null,
): CampaignScorecard {
  const links = allLinks.filter((l) => l.tag_id === tagId);
  // Every tag carried by each channel. A channel can be tagged to SEVERAL
  // campaigns, so "claimed by someone else" is a property of its whole tag set,
  // not of any single link: a channel tagged to both this campaign and another
  // is claimed by both and must NOT be excluded from this one's expansion.
  const tagsByChannel = new Map<string, Set<string>>();
  for (const l of allLinks) {
    if (l.asset_type !== 'channel') continue;
    let s = tagsByChannel.get(l.asset_ref);
    if (!s) {
      s = new Set();
      tagsByChannel.set(l.asset_ref, s);
    }
    s.add(l.tag_id);
  }
  // Tagged, but not to this campaign: a tagged parent must not absorb it.
  const claimedByOtherCampaigns = new Set(
    [...tagsByChannel.entries()]
      .filter(([, tagIds]) => !tagIds.has(tagId))
      .map(([channelId]) => channelId),
  );
  const channelRefs = new Set(
    links.filter((l) => l.asset_type === 'channel').map((l) => l.asset_ref),
  );
  const segmentRefs = new Set(
    links
      .filter((l) => l.asset_type === 'sixsense_segment')
      .map((l) => l.asset_ref),
  );
  const sequenceRefs = new Set(
    links
      .filter((l) => l.asset_type === 'outreach_sequence')
      .map((l) => Number(l.asset_ref)),
  );
  const linkedinAdsetRefs = new Set(
    links
      .filter((l) => l.asset_type === 'linkedin_adset')
      .map((l) => l.asset_ref),
  );

  const channelSet = expandChannels(
    channelRefs,
    claimedByOtherCampaigns,
    data.channels,
  );

  // --- Leads / MQLs (by source channel) ---
  const yearOf = (iso?: string | null) =>
    iso ? Number(iso.slice(0, 4)) : null;
  const campaignLeads = data.leads.filter(
    (l) =>
      l.source_channel_id != null &&
      channelSet.has(l.source_channel_id) &&
      (filterYear == null ||
        yearOf(l.marketing_sourced_date) === filterYear),
  );
  const leads = campaignLeads.length;
  const mqls = campaignLeads.filter(isMql).length;

  // --- Opportunities (sourced or influenced) ---
  // An opportunity has one attribution ROW per stage it entered (HPP -> Opp ->
  // Pursuit -> Won). Counting rows over-counts deals, so first collapse to ONE
  // record per deal at its HIGHEST stage, then everything downstream (stage
  // totals, conversion, per-channel breakdown) counts DEALS, not stage events.
  //
  // Scoping is per DEAL: gather every row of a deal, then decide once whether
  // the deal belongs to this campaign. Filtering rows first (the old approach)
  // would resolve a deal's stage and amount from only the rows that happened to
  // name a tagged channel.
  const dealKey = (a: Attribution) => a.deal_id ?? a.id;

  const rowsByDeal = new Map<string, Attribution[]>();
  for (const a of data.attributions) {
    const k = dealKey(a);
    const arr = rowsByDeal.get(k) ?? [];
    arr.push(a);
    rowsByDeal.set(k, arr);
  }

  const touchesByRow = new Map<string, AttributionTouch[]>();
  for (const t of data.attributionTouches) {
    const arr = touchesByRow.get(t.attribution_id) ?? [];
    arr.push(t);
    touchesByRow.set(t.attribution_id, arr);
  }

  // A deal's touches, unioned across ALL its stage rows and deduped. Promoting
  // a deal COPIES its touches onto each new downstream row (useAttributions),
  // so the same logical touch recurs once per stage with a fresh row id and
  // touch id. Neither id can be the dedupe key; the identity that survives a
  // copy is (touch_order, channel_id, touched_at).
  const touchesForDeal = (rows: Attribution[]): AttributionTouch[] => {
    const seen = new Map<string, AttributionTouch>();
    for (const r of rows) {
      for (const t of touchesByRow.get(r.id) ?? []) {
        const k = `${t.touch_order}|${t.channel_id ?? ''}|${t.touched_at ?? ''}`;
        if (!seen.has(k)) seen.set(k, t);
      }
    }
    return [...seen.values()];
  };

  const campaignDealRows: Attribution[] = [];
  const touchesByDealKey = new Map<string, AttributionTouch[]>();
  for (const [k, rows] of rowsByDeal) {
    // Year filter at the DEAL level: in scope if any row falls in the year.
    if (filterYear != null && !rows.some((r) => r.year === filterYear)) continue;
    const touches = touchesForDeal(rows);
    const inScope =
      rows.some((r) => r.channel_id != null && channelSet.has(r.channel_id)) ||
      touches.some((t) => t.channel_id != null && channelSet.has(t.channel_id));
    if (!inScope) continue;
    campaignDealRows.push(...rows);
    touchesByDealKey.set(k, touches);
  }
  const deals = dedupeDealsByHighestStage(campaignDealRows);

  let hpp = 0,
    opp = 0,
    pursuit = 0,
    won = 0,
    wonAmount = 0;
  for (const d of deals) {
    switch (d.stage) {
      case 'hpp':
        hpp++;
        break;
      case 'opp':
        opp++;
        break;
      case 'pursuit':
        pursuit++;
        break;
      case 'closeWon':
        won++;
        wonAmount += d.amount ?? 0;
        break;
    }
  }

  // --- Per-channel breakdown (which channel drove each stage) ---
  const channelById = new Map(data.channels.map((c) => [c.id, c]));
  const perChannel = new Map<string, ChannelFunnel>();
  const bump = (id: string): ChannelFunnel => {
    let cf = perChannel.get(id);
    if (!cf) {
      cf = {
        channelId: id,
        channelName: channelDisplayName(id, channelById),
        parentName: channelParentName(id, channelById),
        leads: 0,
        mqls: 0,
        hpp: 0,
        opp: 0,
        pursuit: 0,
        won: 0,
      };
      perChannel.set(id, cf);
    }
    return cf;
  };
  for (const l of campaignLeads) {
    const cf = bump(l.source_channel_id as string);
    cf.leads++;
    if (isMql(l)) cf.mqls++;
  }
  for (const d of deals) {
    const cf = bump(d.channelId);
    switch (d.stage) {
      case 'hpp':
        cf.hpp++;
        break;
      case 'opp':
        cf.opp++;
        break;
      case 'pursuit':
        cf.pursuit++;
        break;
      case 'closeWon':
        cf.won++;
        break;
    }
  }
  // Sort by leads (then any opp activity) desc; cap to top-N with an "Other"
  // roll-up so the stacked bar stays readable and within the palette.
  const oppTotal = (c: ChannelFunnel) => c.hpp + c.opp + c.pursuit + c.won;
  const sorted = [...perChannel.values()].sort(
    (a, b) => b.leads - a.leads || oppTotal(b) - oppTotal(a),
  );
  let byChannel: ChannelFunnel[];
  if (sorted.length > MAX_BREAKDOWN_CHANNELS) {
    const top = sorted.slice(0, MAX_BREAKDOWN_CHANNELS - 1);
    const rest = sorted.slice(MAX_BREAKDOWN_CHANNELS - 1);
    const other: ChannelFunnel = {
      channelId: '',
      channelName: 'Other',
      parentName: '',
      leads: 0,
      mqls: 0,
      hpp: 0,
      opp: 0,
      pursuit: 0,
      won: 0,
    };
    for (const c of rest) {
      other.leads += c.leads;
      other.mqls += c.mqls;
      other.hpp += c.hpp;
      other.opp += c.opp;
      other.pursuit += c.pursuit;
      other.won += c.won;
    }
    byChannel = [...top, other];
  } else {
    byChannel = sorted;
  }

  // --- Conversion rates (stage totals already computed above) ---
  const oppReached = hpp + opp + pursuit + won;
  const conversion = {
    leadToMql: ratio(mqls, leads),
    mqlToOpp: ratio(oppReached, mqls),
    oppToWon: ratio(won, oppReached),
  };

  // --- Open deals (pipeline if won) ---
  // The deals are already deduped to their highest stage. Keep those still open
  // (HPP/Opp/Pursuit); a deal that reached closeWon/closeLost is terminal.
  //
  // Each open deal is credited to this campaign at its EARLIEST touch: a
  // campaign that touched a deal at positions 2 and 3 is shown its strongest
  // claim ("2nd touch"), not every claim. Rank 1 means the campaign sourced the
  // deal; 2+ means it influenced one another campaign sourced.
  const creditFor = (
    d: DealRecord,
  ): { touchRank: number | null; sourced: boolean } => {
    const touches = (touchesByDealKey.get(d.dealId) ?? [])
      .filter((t) => t.channel_id)
      .sort(compareTouchesChronologically);
    const idx = touches.findIndex(
      (t) => t.channel_id != null && channelSet.has(t.channel_id),
    );
    if (idx >= 0) return { touchRank: idx + 1, sourced: idx === 0 };
    // No touch on this campaign's channels: the deal came in via a stage row's
    // channel. Most deals have no touches recorded at all, so this is the
    // ordinary path. DealRecord.channelId is the earliest row's channel, i.e.
    // the deal's first touch as far as the row data knows.
    return {
      touchRank: null,
      sourced: d.channelId !== '' && channelSet.has(d.channelId),
    };
  };

  const openDeals: OpenDeal[] = deals
    .filter((d) => d.stage in OPEN_STAGE_LABEL)
    .map((d) => ({
      dealId: d.dealId,
      name: d.name,
      account: d.account,
      stage: d.stage as 'hpp' | 'opp' | 'pursuit',
      stageLabel: OPEN_STAGE_LABEL[d.stage],
      amount: d.amount,
      sfLink: d.sfLink,
      ...creditFor(d),
    }));
  // Sourced first (the deals this campaign owns are the primary read), then
  // amount desc (nulls last), then name.
  openDeals.sort((a, b) => {
    if (a.sourced !== b.sourced) return a.sourced ? -1 : 1;
    const av = a.amount ?? -1;
    const bv = b.amount ?? -1;
    return bv - av || a.name.localeCompare(b.name);
  });
  const sumAmount = (ds: OpenDeal[]) => ds.reduce((t, d) => t + (d.amount ?? 0), 0);
  // Every open deal is exactly one of sourced / influenced, so these partition
  // openPipelineAmount.
  const sourcedDeals = openDeals.filter((d) => d.sourced);
  const influencedDeals = openDeals.filter((d) => !d.sourced);
  const openPipelineAmount = sumAmount(openDeals);
  const openPipelineSourced = sumAmount(sourcedDeals);
  const openPipelineInfluenced = sumAmount(influencedDeals);
  const openDealsSourcedCount = sourcedDeals.length;
  const openDealsInfluencedCount = influencedDeals.length;
  const openDealsMissingAmount = openDeals.filter(
    (d) => d.amount == null,
  ).length;

  // --- 6Sense (latest snapshot per tagged segment, averaged) ---
  let reach: number | null = null;
  let engagement: number | null = null;
  let sixSenseAccounts: number | null = null;
  if (segmentRefs.size > 0) {
    let rSum = 0,
      eSum = 0,
      aSum = 0,
      n = 0;
    for (const seg of segmentRefs) {
      const rows = data.sixSenseSnapshots
        .filter(
          (s) =>
            s.segment === seg &&
            (filterYear == null || s.year === filterYear),
        )
        .sort((a, b) => (a.snapshot_date < b.snapshot_date ? 1 : -1));
      const latest = rows[0];
      if (latest) {
        rSum += reachPct(latest);
        eSum += engagementPct(latest);
        aSum += latest.total_accounts;
        n++;
      }
    }
    if (n > 0) {
      reach = rSum / n;
      engagement = eSum / n;
      sixSenseAccounts = aSum;
    }
  }

  // --- Outreach (latest cumulative snapshot per tagged sequence) ---
  let outreachSent = 0;
  let outreachReplied = 0;
  const emailBySequence: SequenceEmailStats[] = [];
  if (sequenceRefs.size > 0) {
    for (const seqId of sequenceRefs) {
      const rows = data.outreachSnapshots
        .filter(
          (s) =>
            s.sequence_id === seqId &&
            (filterYear == null || s.year === filterYear),
        )
        .sort((a, b) =>
          a.export_date < b.export_date ? -1 : a.export_date > b.export_date ? 1 : 0,
        );
      if (rows.length === 0) continue;
      // Cumulative lifetime counters: the latest row holds the running total.
      const last = rows[rows.length - 1];
      outreachSent += last.total_sent;
      outreachReplied += last.replied;
      emailBySequence.push({
        sequenceId: seqId,
        name: last.sequence_name.replace(/^\[\d{4}\]\s*-\s*/, ''),
        sent: last.total_sent,
        delivered: last.delivered,
        bounced: last.bounced,
        opened: last.opened,
        clicked: last.clicked,
        replied: last.replied,
        optedOut: last.opted_out,
        calls: last.outbound_calls,
        linkedinMessages: last.linkedin_tasks_completed,
      });
    }
    emailBySequence.sort((a, b) => b.sent - a.sent);
  }

  // --- LinkedIn Ads (per-week rows SUMMED per tagged ad set) ---
  // Unlike Outreach's cumulative counters, LinkedIn metrics are per-week, so we
  // sum every in-scope row rather than taking the latest.
  let linkedinSpend = 0;
  let linkedinImpressions = 0;
  let linkedinClicks = 0;
  const adsByAdset: LinkedinAdsetStats[] = [];
  if (linkedinAdsetRefs.size > 0) {
    for (const adsetId of linkedinAdsetRefs) {
      const rows = data.linkedinSnapshots.filter(
        (s) =>
          s.adset_id === adsetId &&
          (filterYear == null || s.year === filterYear),
      );
      if (rows.length === 0) continue;
      let spend = 0,
        impressions = 0,
        clicks = 0;
      for (const r of rows) {
        spend += r.spend ?? 0;
        impressions += r.impressions ?? 0;
        clicks += r.clicks ?? 0;
      }
      linkedinSpend += spend;
      linkedinImpressions += impressions;
      linkedinClicks += clicks;
      const latest = rows[0]; // for display fields (name/product/region)
      adsByAdset.push({
        adsetId,
        name: latest.adset_name,
        product: latest.product,
        region: latest.region,
        spend,
        impressions,
        clicks,
      });
    }
    adsByAdset.sort((a, b) => b.spend - a.spend);
  }

  return {
    reachPct: reach,
    engagementPct: engagement,
    sixSenseAccounts,
    leads,
    mqls,
    hpp,
    opp,
    pursuit,
    won,
    wonAmount,
    outreachSent,
    outreachReplied,
    emailBySequence,
    linkedinSpend,
    linkedinImpressions,
    linkedinClicks,
    adsByAdset,
    byChannel,
    conversion,
    openDeals,
    openPipelineAmount,
    openPipelineSourced,
    openPipelineInfluenced,
    openDealsSourcedCount,
    openDealsInfluencedCount,
    openDealsMissingAmount,
    channelCount: channelRefs.size,
    segmentCount: segmentRefs.size,
    sequenceCount: sequenceRefs.size,
    linkedinAdsetCount: linkedinAdsetRefs.size,
  };
}
