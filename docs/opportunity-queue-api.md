# Opportunity review queue

Status: implemented in the application; production enablement is blocked only
on the pending migration and Vercel server-secret configuration.

## What users see

Data Entry contains **Review Salesforce opportunities**. Unlocking it opens the
live staging queue; it is not a separate application or navigation area.

For one Opportunity at a time, Marketing Operations can:

- approve it with an explicit source channel and Commercial Region;
- confirm/edit Market, GTM Cube, BDR, optional exact-email lead link, and stage dates;
- mark it Not selected;
- block it with a reason; or
- reconsider a prior Not selected decision.

Salesforce creator, BDR, and Primary Campaign Source remain evidence only. An
exact Primary Campaign Source match may preselect one child channel, but the
reviewer must still confirm or change it before approval. Parent and ambiguous
matches never preselect. Opportunity names open the trusted Salesforce record
in a new tab. Lead lookup is exact normalized email only; no fuzzy matching.

## Reporting behavior

Approval creates a stable exact Salesforce deal link and only
`source_system='salesforce'` attribution rows. Manual rows are never changed.

- current HPP -> HPP row;
- current Opportunity -> HPP + Opportunity rows;
- current Pursuit -> HPP + Opportunity + Pursuit rows;
- closed won -> prior funnel rows + one source-backed Closed Won row;
- closed lost -> prior funnel rows + one source-backed Closed Lost row; or
- deleted or Service -> no generated reporting rows.

For a closed Opportunity, Salesforce remains authoritative for `IsWon`,
`CloseDate`, and the terminal Stage. The review dialog shows the outcome and
close date before approval. Known terminal Stage values map to the reporting
loss reasons `Closed-Lost to Competitor`, `Closed-Lost In-House`, or
`Closed-Disqualified`; an unfamiliar value is never guessed. If Salesforce is
correct, the reviewer only confirms attribution. If it is wrong, Salesforce
must be corrected and the next daily sync reconciles the generated Sourced row.

HPP defaults to the Salesforce Opportunity CreatedDate. Opportunity and Pursuit
dates must come from Salesforce history or explicit review; the system does not
invent them. The daily 11:50 PM America/Denver staging workflow now refreshes
all approved projections after its atomic staging apply. A regression removes
only the generated higher-stage rows while retaining append-only movement and
review history.

## Security boundary

The React browser never receives the Supabase service-role key and never reads
the protected staging tables directly. `/api/opportunity-queue` holds the key
server-side, issues an eight-hour Secure/HttpOnly/SameSite session cookie, and
requires a same-origin CSRF token for every mutation. Login attempts are
rate-limited per runtime instance. Database RPC permissions remain denied to
PUBLIC, anon, and authenticated and granted only to service_role.

This password session is the simple interim control for the current single
Marketing Operations reviewer. It can later be replaced with PingOne OIDC
without changing the queue domain or database transaction.

Required Vercel variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPPORTUNITY_QUEUE_PASSWORD`
- `OPPORTUNITY_QUEUE_SESSION_SECRET` (at least 32 random bytes)
- `OPPORTUNITY_QUEUE_ALLOWED_ORIGIN`
- `OPPORTUNITY_QUEUE_ACTOR_ID` (audit label; defaults to `queue-reviewer`)

## Atomicity and retries

`sf_apply_opportunity_review_action` locks the review, checks its version, and
commits the decision, append-only audit, link, and reporting reconciliation in
one transaction. The persistent request ledger scopes retries by actor, action,
review, and idempotency key. Identical retries replay; conflicting reuse fails.

The runtime and review-context migrations are applied. The review-context
migration was applied manually on 2026-08-13 per operator confirmation; verify
its live catalog permissions as part of the preview smoke test.
