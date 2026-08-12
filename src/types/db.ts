import type { RegionKey } from '../constants/regions';

export type StageKey = 'lead' | 'mql';

export type AttributionStageKey =
  | 'hpp'
  | 'opp'
  | 'pursuit'
  | 'closeWon'
  | 'closeLost';

export type PeriodIndex = 1 | 2 | 3 | 4;

export interface StageHistoryEntry {
  stage: StageKey;
  entered_at: string;
  // `baseline` means the person was already at this stage when the daily
  // observation ledger first saw them. `transition` means the ledger
  // witnessed the change after an earlier observation. Older rows predate
  // this discriminator and remain valid.
  event_kind?: 'baseline' | 'transition';
  edited_by?: string;
  edit_locked?: boolean;
  notes?: string;
}

export interface Lead {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  sfdc_lead_id?: string | null;
  sfdc_contact_id?: string | null;
  // Exact Salesforce Account identity used for account-level conversion
  // cohorts. Names remain display-only and are never an identity join key.
  sfdc_account_id?: string | null;
  hubspot_contact_id?: string | null;
  account?: string | null;
  title?: string | null;
  country?: string | null;
  region?: RegionKey | null;
  owner?: string | null;
  lead_source?: string | null;
  current_stage: StageKey;
  marketing_sourced_date?: string | null;
  source_channel_id?: string | null;
  stage_history: StageHistoryEntry[];
  field_locks: Record<string, boolean>;
  source_sfdc: Record<string, unknown>;
  notes?: string | null;
  // Closed set of event-marketing engagement values from SFDC's
  // "Event Activation" field (Pre-Event Meeting, Booth Meeting,
  // Session Attendee, Post-Event Meeting). DB column is TEXT[] NOT
  // NULL with a '{}' default, so an empty array (never undefined) is
  // the canonical "no activations" representation.
  event_activations: string[];
  created_at: string;
  updated_at: string;
  last_synced_at?: string | null;
  last_edited_by?: string | null;
}

export interface Channel {
  id: string;
  name: string;
  parent_channel_id?: string | null;
  // NULL = evergreen (not tied to a specific year). Set by the
  // year-aware-channels migration. Funnel sub-tabs hide rows whose
  // year doesn't match the selected year; evergreen rows always
  // render.
  year?: number | null;
  display_order: number;
  hidden: boolean;
  created_at: string;
}

// A campaign tag: the canonical "campaign" that unifies the silos. Assets
// (channels, 6Sense segments, Outreach sequences) are linked to a tag via
// campaign_tag_links; leads/opps come through the tag's channels by FK.
export interface CampaignTag {
  id: string;
  name: string;
  color?: string | null;
  display_order: number;
  created_at: string;
}

// The silo an asset lives in. asset_ref is the channel UUID, the 6Sense
// segment string, or the Outreach sequence_id (as text) accordingly.
export type CampaignAssetType =
  | 'channel'
  | 'sixsense_segment'
  | 'outreach_sequence'
  | 'linkedin_adset';

export interface CampaignTagLink {
  id: string;
  tag_id: string;
  asset_type: CampaignAssetType;
  asset_ref: string;
  created_at: string;
}

export interface FunnelProjection {
  id: string;
  channel_id: string;
  year: number;
  period_index: PeriodIndex;
  stage_key: StageKey | AttributionStageKey;
  projection: number | null;
  edited_at: string;
  edited_by?: string | null;
}

export interface FunnelActual {
  id: string;
  channel_id: string;
  year: number;
  period_index: PeriodIndex;
  // Matches the relaxed DB CHECK: HPP+ remains the primary case, but
  // 'lead' and 'mql' rows are valid as historical-year fallbacks
  // (e.g. 2025 pre-Sourced). The compute layer treats lead/mql
  // funnel_actuals as a fallback used only when no leads cover the
  // same (channel, year, period) cell.
  stage_key: StageKey | AttributionStageKey;
  actual: number | null;
  edited_at: string;
  edited_by?: string | null;
}

export interface Attribution {
  id: string;
  // Manual rows predate source_system and are treated as manual when absent.
  // Salesforce-generated rows carry both fields so regression cleanup can
  // never delete a reviewer-created attribution by mistake.
  source_system?: 'manual' | 'salesforce';
  sf_opportunity_id?: string | null;
  // M7 leaves lead_id null. M8 will add an "associate lead" picker.
  lead_id?: string | null;
  // Shared across stages for the same deal so HPP -> Opp -> Pursuit -> Won
  // all link back to one logical opportunity.
  deal_id?: string | null;
  stage_key: AttributionStageKey;
  // First-touch (primary) channel — the leaf that drives the funnel grid cell.
  channel_id?: string | null;
  year: number;
  period_index: PeriodIndex;
  label?: string | null;     // Deal name, e.g. "Acme Corp"
  account?: string | null;
  // Exact Salesforce Account identity. Account names are display-only and
  // never used to join an MQL cohort to an Opportunity.
  sfdc_account_id?: string | null;
  amount?: number | null;
  sf_link?: string | null;
  region?: RegionKey | null;
  // ISO date (YYYY-MM-DD) the deal entered THIS stage. Drives velocity
  // computations on the Marketing Funnel: Velocity sub-tab.
  stage_entered_at: string;
  // Why the deal was closed-lost. Only meaningful on closeLost rows; null on
  // every other stage and on pre-existing lost rows until edited. One of the
  // LOST_REASONS values (constants/funnelStages.ts).
  lost_reason?: string | null;
  // Which BDR a deal is credited to (BDR Quota tracker). Deal-level: the same
  // value across every row of a deal_id. One of the BDRS roster strings
  // (constants/bdr.ts), or null when untagged.
  bdr_name?: string | null;
  created_at: string;
  updated_at: string;
}

// Annual BDR quota target. One row per (bdr_name, year, stage_key) where
// stage_key is 'hpp' (HPP/SQL) or 'opp' (Opp/SAO). Actuals are computed from
// attributions, not stored here.
export interface BdrQuota {
  id: string;
  bdr_name: string;
  year: number;
  stage_key: 'hpp' | 'opp';
  quota: number | null;
  edited_at: string;
  edited_by?: string | null;
}

export interface AttributionTouch {
  id: string;
  attribution_id: string;
  touch_order: number;        // 1-indexed
  channel_id?: string | null;
  touched_at?: string | null; // ISO date
  notes?: string | null;
  created_at: string;
}

// One row per (sequence, export_date). Populated by the n8n weekly cron;
// the app never writes here. Region is inferred at read time from
// sequence_name (lib/outreach.ts) so it isn't on the row.
export interface OutreachSnapshot {
  id: string;
  export_date: string;        // ISO date (YYYY-MM-DD)
  week_number: number;
  year: number;
  sequence_id: number;
  sequence_name: string;
  enabled: boolean;
  step_count: number;
  duration_days: number;
  total_sent: number;
  delivered: number;
  bounced: number;
  failed: number;
  opened: number;
  clicked: number;
  replied: number;
  positive_replies: number;
  neutral_replies: number;
  negative_replies: number;
  opted_out: number;
  delivery_rate: number;      // percentage 0-100
  open_rate: number;
  click_rate: number;
  reply_rate: number;
  bounce_rate: number;
  opt_out_rate: number;
  contacted_prospects: number;
  replied_prospects: number;
  prospects_added: number;
  prospects_active: number;
  total_tasks: number;
  overdue_tasks: number;
  outbound_calls: number;
  linkedin_tasks_completed: number;
  created_at: string;
}

// One row per (LinkedIn ad set x week). Populated by the n8n weekly cron from a
// Google Sheet; the app never writes here. Metrics are PER-WEEK (this week's
// spend/impressions/clicks), NOT cumulative — the app sums rows for a period.
// adset_id = adset_name (the export has no numeric id) and is the tag asset_ref.
export interface LinkedinAdSnapshot {
  id: string;
  snapshot_date: string;      // ISO date (YYYY-MM-DD), the week's date
  year: number;
  week_number: number;        // ISO week
  campaign_id: string | null;
  campaign_name: string | null;
  product: string | null;
  region: string | null;
  adset_id: string;
  adset_name: string;
  spend: number;
  impressions: number;
  clicks: number;
  created_at: string;
}

// One 6sense "Activities By Source" summary snapshot per import, keyed by
// snapshot_date (the analysis-window end). Only raw counts are stored;
// reach % / engagement % and week-over-week deltas are computed in-app.
// Metrics 6sense shows as "--" (e.g. unlicensed G2 / TrustRadius intent)
// arrive NULL, hence the `number | null` on those two.
export interface SixSenseSnapshot {
  id: string;
  snapshot_date: string;          // ISO date (YYYY-MM-DD), window end
  // Account set this report covers. 'Target Accounts in CRM' = overall;
  // campaigns (e.g. 'Life & Annuities') are their own values. Part of the
  // natural key with snapshot_date.
  segment: string;
  window_start: string | null;
  window_end: string | null;
  year: number;
  week_number: number;
  total_accounts: number;
  accounts_with_activity: number;
  no_activity: number;
  reach: number;
  intent: number;
  engagement: number;
  crm_map_campaigns_reached: number;
  sales_reached: number;
  sixsense_campaigns_reached: number;
  external_campaigns_reached: number;
  linkedin_campaigns_reached: number;
  ai_emails_reached: number;
  sixsense_keyword_research: number;
  bombora_topics: number;
  g2_intent: number | null;
  trustradius_intent: number | null;
  anonymous_web_engaged: number;
  known_web_engaged: number;
  crm_map_campaigns_engaged: number;
  sales_engaged: number;
  sixsense_campaigns_engaged: number;
  external_campaigns_engaged: number;
  linkedin_campaigns_engaged: number;
  attended_webinars: number;
  attended_trade_shows: number;
  attended_field_events: number;
  ai_emails_engaged: number;
  source: string;
  // Import audit. file_name is the original uploaded CSV name (null on rows
  // imported before this was captured); imported_at is set on every upsert.
  file_name: string | null;
  imported_at: string | null;
  created_at: string;
}

// Date-range budget per channel. Multiple rows per channel are
// allowed: each contract / line item gets its own row. The Spend
// report pro-rates each row to the selected period based on the
// overlap of [start_date, end_date] with the period.
export interface CampaignCost {
  id: string;
  channel_id: string;
  amount: number;
  start_date: string;        // ISO date (YYYY-MM-DD), inclusive
  end_date: string;          // ISO date (YYYY-MM-DD), inclusive
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// One campaign membership touch per row (Bite 4C,
// docs/lead-multi-attribution-program.md): the STORAGE shape of the Bite 4A
// `LeadCampaignTouch` calculation type in src/lib/campaignAttribution.ts
// (row = what the database holds; the 4A type = calculation input; the pure
// mapper touchRowToLeadCampaignTouch converts row -> calculation type).
// campaign_member_id is the preferred idempotency key (UNIQUE where
// non-null); Id-less rows fall back to the (lead_id, campaign_id,
// touch_date) natural key per dedupeTouches. 'backfill' rows are the seeded
// primary source mirrored from leads.source_channel_id and carry no
// campaign identity. Nothing reads this table until Bite 4D/4E.
export interface LeadCampaignTouchRow {
  id: string;
  lead_id: string;
  campaign_member_id: string | null;  // SFDC CampaignMember Id
  campaign_id: string | null;         // SFDC Campaign Id (sub-campaign level)
  channel_id: string | null;
  touch_date: string | null;          // ISO date (YYYY-MM-DD)
  parent_campaign: string | null;
  sub_campaign: string | null;
  observed_at: string;
  source: 'import' | 'n8n_sync' | 'backfill' | 'manual';
  raw: Record<string, unknown>;
  created_at: string;
}
