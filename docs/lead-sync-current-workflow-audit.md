# Current Salesforce lead-sync workflow: audit (Bite 4G1)

Audit of the n8n workflow that is **live in production today**, performed
by reading a sanitized export on 2026-07-31. Nothing in this bite changed,
imported, activated, disabled, or replaced that workflow.

The raw export is deliberately **not** committed: it carries the RPC
endpoint, credential references, and the Google document reference. This
document records structure and behavior only. No endpoint URL, credential
name or id, document id, Salesforce record id, campaign name, or person
record appears below.

Shape: six nodes in a single linear chain.

```
Schedule trigger -> Salesforce search -> Code transform
  -> HTTP POST (RPC) -> Set (compose log row) -> Google Sheets append
```

## Confirmed findings

### Scheduling and timezone

1. **Active and scheduled nightly at hour 3, with no explicit timezone.**
   The trigger declares only `triggerAtHour: 3`; the workflow settings
   carry no `timezone` key, so the run time follows the n8n instance
   default rather than a stated `America/Denver`. Any instance-level
   change silently moves the window, and the two-day lookback below is
   computed in UTC, so the effective boundary is not the one a reader
   would infer from "3 AM".

### Query scope and watermark

2. **Rolling two-day CreatedDate window.** The SOQL filters
   `CreatedDate >= now - 2 days`, evaluated in UTC.
3. **No LastModifiedDate, no SystemModstamp, no persisted watermark.**
   Nothing records where the previous run stopped, so a missed or failed
   run is never made up: rows created outside the last two days are
   simply never revisited.
4. **Hard `LIMIT 5000` and no full reconciliation.** The query truncates
   silently at 5,000 rows with no pagination and no periodic full scan to
   heal drift. Today's volumes sit well under that ceiling, but nothing in
   the workflow detects or reports crossing it.

### Identity and the touch contract

5. **CampaignMember `Id` is selected but discarded.** The transform never
   copies it into its output, so the preferred idempotency key for
   `lead_campaign_touches` is fetched and thrown away on every run.
6. **Campaign Id is never preserved.** The query selects campaign NAMES
   (campaign and parent campaign) but no campaign identifier, so the
   natural-key fallback defined by `dedupeTouches` cannot be formed
   either.
7. **It does not populate the `lead_campaign_touches` contract
   reliably.** The transform emits a flat lead-shaped row only. With
   neither CampaignMember Id nor Campaign Id, a touch written from this
   feed would have no stable identity, so the nightly workflow is
   currently incapable of maintaining memberships. Since Bite 4E, the
   funnel counts touches, which means **new memberships reach reporting
   only through the manual report import** until this is rebuilt.

### Lifecycle handling

8. **The lifecycle field is read in code but never selected in SOQL.**
   The transform reads a HubSpot lifecycle field on Contact and the
   equivalent on Lead, but neither appears in the SELECT list. Salesforce
   therefore never returns them.
9. **Missing lifecycle data falls back to "Lead".** Because the field is
   absent from the payload, the lookup fails for every row and the code's
   `|| "Lead"` default applies universally. Every synced person is
   currently stamped as stage `lead` regardless of their real lifecycle
   state.
10. **The stage map mixes lead lifecycle with deal stages.** Its entries
    map lifecycle values onto `hpp`, `opp`, and `closeWon` alongside
    `lead` and `mql`. Those are deal-side stages owned by attributions in
    Sourced, not lead lifecycle states, so if the field were ever
    selected the map would begin writing deal stages onto lead records.
    The map is unreachable today (see finding 9), which is the only
    reason this has not caused damage.

### History, demotion, and dates

11. **It never queries LeadHistory or ContactHistory.** There is no
    field-history source anywhere in the workflow.
12. **It cannot observe demotions or requalifications reliably.** With no
    history query and a create-window-only scope, a person who moves MQL
    back to Lead, or requalifies later, produces no signal. The program's
    append-only event model (demotion and requalification are separate
    events, closed periods never change) cannot be fed from this design.
13. **CampaignMember `CreatedDate` is used as the sourced date without
    confirming the intended field.** The transform assigns
    `marketing_sourced_date` from the membership row's CreatedDate. The
    business definition is the report label "Member First Associated
    Date", whose underlying API field has never been confirmed. These may
    or may not be the same field; nothing validates it.

### Write path, logging, and operations

14. **The write is an unversioned HTTP RPC absent from this repository.**
    The workflow POSTs to a database function that exists only in the
    live environment: no migration defines it, no repository file
    documents its signature, and its behavior cannot be reviewed or
    tested here.
15. **The RPC node continues on error.** It is configured with
    `onError: continueRegularOutput`, so a failed write proceeds down the
    chain and is logged as though it had happened. Failures are
    invisible.
16. **The Google Sheet log contains person-level data and identifiers.**
    The composed log row carries email, first and last name, and the
    Salesforce contact and lead identifiers, appended to a shared
    spreadsheet on every run.
17. **No failure notification and no weekly reconciliation.** Nothing
    alerts on an errored run, and there is no periodic full scan to heal
    gaps. Combined with finding 15, a silently failing write path can
    persist indefinitely.

## Risk summary

The two findings that matter most for reporting correctness today are
**9** (every synced person is stamped `lead`, so MQL state never arrives
through this feed) and **5 plus 6** (no campaign identity survives, so the
feed cannot maintain the membership contract the funnel now counts). The
two that matter most operationally are **15** (failures continue silently)
and **17** (nobody is told). Finding **16** is a standing data-handling
concern independent of the rebuild.

## What this audit does not claim

This is a read of one export at one moment. It does not verify the live
instance's timezone setting, the RPC's server-side behavior, the Google
document's sharing scope, or whether the credential can read history
objects. Those are exactly what the Bite 4G1 discovery workflow is
designed to answer without guessing; see
`docs/lead-sync-discovery.md`.
