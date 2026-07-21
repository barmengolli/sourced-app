# LinkedIn Ads → Supabase: n8n mapping spec

The consultant drops weekly LinkedIn ad performance into a Google Sheet. This n8n
workflow reads the sheet, aggregates the daily line items into one row per
(ad set × week), and upserts into the `linkedin_ads_snapshots` Supabase table
that the Sourced app reads.

Build this in your n8n instance. Sourced only reads the table; it never writes.

## Target table

`linkedin_ads_snapshots` (created by `migrations/2026-07-07_linkedin_ads.sql`):

| column | type | source |
|---|---|---|
| `snapshot_date` | date (YYYY-MM-DD) | the **week-ending Sunday**, from the sheet's **Week** column (parsed as **MM/DD/YYYY**) |
| `year` | int | year of `snapshot_date` |
| `week_number` | int | ISO week number of `snapshot_date` |
| `campaign_id` | text | **Campaign ID** |
| `campaign_name` | text | **Campaign Name** |
| `product` | text | **Product** |
| `region` | text | **Region** |
| `adset_id` | text | **Ad Set Name** (there is no numeric ad-set id in the export; the NAME is the stable key) |
| `adset_name` | text | **Ad Set Name** (same value) |
| `spend` | numeric | SUM of **Spend ($)** across the week's rows for this ad set |
| `impressions` | int | SUM of **Impressions** |
| `clicks` | int | SUM of **Clicks** |

Upsert conflict target: **`(snapshot_date, adset_id)`**. Re-running a week
overwrites that week's rows (idempotent).

## Column selection (the sheet is messy)

- The export **duplicates** several columns: `Product`, `Region`, `Spend ($)`,
  `Impressions`, `Clicks`, `CTR`, `CPM`, `CPC` appear twice. **Use the FIRST
  occurrence** of each (columns ~5–10, before the second `Product`/`Area` block).
- **Ignore** the ~60 near-zero columns (Reactions, Comments, Shares, Follows,
  Conversions, Leads, Event Registrations, Viral*, Subscriptions, etc.). Only
  Spend / Impressions / Clicks carry signal today. (They can be added later
  without breaking the table.)
- **Do NOT store CTR / CPM / CPC** from the sheet. Sourced derives them from the
  summed counts: CTR = clicks/impressions, CPC = spend/clicks, CPM =
  spend/impressions×1000. Storing the sheet's per-row rates would be wrong once
  rows are summed.

## Aggregation (one row per ad set per week)

The sheet has **multiple rows per ad set per week** (daily/line-item splits).
Group them and sum:

```
GROUP BY (Week, Ad Set Name)
  spend       = SUM(Spend ($))
  impressions = SUM(Impressions)
  clicks      = SUM(Clicks)
  campaign_id, campaign_name, product, region = first value in the group
                (constant within an ad set)
```

Output one row per group.

## Reporting semantics (how Sourced reports this source)

- **`Week` is the week-ending Sunday.** Every row's `Week` in the source is the
  Sunday that closes that reporting week. `snapshot_date` carries it verbatim.
- **Weekly additive totals**, not cumulative counters. A period is the plain sum
  of its matching weekly rows; nothing is differenced.
- **Period assignment: a whole week belongs to the month, quarter, and year
  that contain its week-ending Sunday.** The week is never split or prorated
  across calendar months. Example: the week ending 2026-07-26 is entirely July
  and Q3; the week ending 2026-08-02 is entirely August and Q3, even though it
  covers late-July days.
- **Reporting basis: Activity** — "Weekly LinkedIn Ads activity assigned by
  week-ending Sunday." The dashboard discloses this beside the title.
- **Natural key and upsert (confirmed):** the workflow groups by
  (`snapshot_date`, `Ad Set Name`) with `adset_id = adset_name`, and upserts on
  `on_conflict=(snapshot_date, adset_id)`. Re-running a week merges duplicates
  idempotently.
- **Exact calendar-day reporting is not possible from this feed.** The source
  delivers one aggregated value per week-ending Sunday with no per-day
  breakdown, so Sourced cannot report by day, arbitrary date range, or partial
  week. Moving to day-level reporting would require the source to preserve a
  **daily date** per row (a source and workflow change, out of scope here).

## Current n8n limitations (documented, not fixed here)

- **Timezone is not explicit.** The schedule trigger runs "Every Monday 12:00
  (Mountain)", but the exported workflow does not store an explicit
  `America/Denver` timezone. See the recommendation at the end of this file.
- **The sheet tab is hardcoded to `Q3 S`.** The read node points at a single
  quarter tab; it must be repointed each quarter until a permanent feed tab
  replaces it. Separate n8n follow-up.
- Completeness detection in Sourced compares the latest imported week-ending
  Sunday against a period's final Sunday. It **cannot** detect a missing
  intermediate weekly run (a gap between imported weeks) on its own.

## n8n node outline

1. **Google Sheets (Read rows)** — read the weekly sheet/tab.
2. **Code / Set** — normalize each row:
   - Parse `Week` "MM/DD/YYYY" (the week-ending Sunday) → `snapshot_date`
     "YYYY-MM-DD".
   - Coerce `Spend ($)`, `Impressions`, `Clicks` to numbers (strip `$`, commas).
   - Keep `Campaign ID`, `Campaign Name`, `Product`, `Region`, `Ad Set Name`.
3. **Item Lists / Code (Aggregate)** — group by `snapshot_date` + `Ad Set Name`,
   sum spend/impressions/clicks; compute `year` and ISO `week_number` from
   `snapshot_date`; set `adset_id = adset_name = Ad Set Name`.
4. **Supabase (Upsert)** — table `linkedin_ads_snapshots`, on-conflict
   `(snapshot_date, adset_id)`, insert-or-update all columns above.

### ISO week number (JS, for the Code node)

```js
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (date.getUTCDay() + 6) % 7;          // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - day + 3);    // Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
  return { year: date.getUTCFullYear(), week };
}
```

## Verify

After a run, in Supabase:

```sql
SELECT snapshot_date, adset_id, spend, impressions, clicks
FROM linkedin_ads_snapshots
ORDER BY snapshot_date DESC, spend DESC
LIMIT 20;
```

Then in Sourced: **LinkedIn Ads → Dashboard** should show the week/month with
matching spend/impressions/clicks, and tagging an ad set on **Campaigns → Tags**
surfaces it in that campaign's **LinkedIn Ads Performance** tile.
