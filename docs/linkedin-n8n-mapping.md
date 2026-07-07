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
| `snapshot_date` | date (YYYY-MM-DD) | the week date, from the sheet's **Week** column (converted from DD/MM/YYYY) |
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

## n8n node outline

1. **Google Sheets (Read rows)** — read the weekly sheet/tab.
2. **Code / Set** — normalize each row:
   - Parse `Week` "DD/MM/YYYY" → `snapshot_date` "YYYY-MM-DD".
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
