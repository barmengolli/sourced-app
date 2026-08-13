# Opportunity review queue

Status: implemented in the application; production enablement is blocked only
on the pending migration and Vercel server-secret configuration.

## What users see

Data Entry contains **Review Salesforce opportunities**. Unlocking it opens the
live staging queue; it is not a separate application or navigation area.

For one Opportunity at a time, Marketing Operations can:

- approve it with an explicit source channel and Commercial Region;
- confirm/edit Market, GTM Cube, BDR, optional lead link, and stage dates;
- mark it Not selected;
- block it with a reason; or
- reconsider a prior Not selected decision.

Salesforce creator, BDR, and Primary Campaign Source remain evidence only. They
never approve a source automatically.

## Reporting behavior

Approval creates a stable exact Salesforce deal link and only
`source_system='salesforce'` attribution rows. Manual rows are never changed.

- current HPP -> HPP row;
- current Opportunity -> HPP + Opportunity rows;
- current Pursuit -> HPP + Opportunity + Pursuit rows;
- closed, deleted, or Service -> no current-pipeline rows.

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

Apply `migrations/2026-08-12_opportunity_review_queue_runtime.sql` and verify it
before configuring the Vercel variables or importing the regenerated daily
workflow.
