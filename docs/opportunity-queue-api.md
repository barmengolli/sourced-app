# Opportunity Queue API and authorization foundation (Bite 5C2B2A)

Status: portable contract and pure service layer only. No server runtime,
no framework, no PingOne login, no database connection, and no production
route exist yet. IT hosts the eventual runtime on its approved internal
Node.js platform; everything here is framework-neutral TypeScript that
adapts to that platform without rewrites.

## Architecture: browser to database

```
React queue UI (browser, session cookie only, no tokens, no credentials)
        |
        v  same-origin /api requests
Server API (approved internal Node.js hosting; adapts these handlers)
        |  authenticated principal from the OIDC session
        v
Service layer (src/server/opportunityQueueService.ts, pure functions)
        |  capability authorization + queue domain rules
        v
Server repository (restricted database identity, server-held secret)
        |
        v
Six sf_opportunity_* tables + approved RPCs (RLS, zero browser policies)
```

The browser never talks to the database and never holds a service-role or
restricted credential. The six `sf_opportunity_*` tables keep RLS enabled
with zero browser policies.

## Future PingOne OIDC session flow (documented, not implemented)

1. Browser hits a protected page; the server redirects to PingOne using
   the OIDC Authorization Code flow (with PKCE).
2. PingOne authenticates the user and redirects back with a code.
3. The backend exchanges the code, validates tokens server-side, and
   creates a backend-managed session.
4. The session is delivered as a Secure/HttpOnly/SameSite cookie. Tokens
   are NEVER stored in localStorage or sessionStorage and never reach
   JavaScript.
5. All /api routes are same-origin and read the session cookie; the server
   builds the `QueuePrincipal` (subject, capabilities) from the session.
6. Logout invalidates the server session and clears the cookie.

There is no production authentication bypass: a missing principal is
always `unauthenticated`, and test principals exist only under `src/test/`.

## Capability model

Portable capabilities (never raw PingOne/AD group names in code):

| Capability | Grants |
|---|---|
| `opportunity_queue:read` | List and view reviews |
| `opportunity_queue:review` | Approve, ignore (Not selected), block, reconsider |
| `opportunity_queue:link` | Exact-ID linking |
| `opportunity_queue:admin` | All of the above |

IT maps identity-provider groups to these capabilities at deployment time
(for example `AD-Marketing-Ops` to read+review+link). Admin satisfies any
capability requirement but NEVER bypasses domain validation: channel
requirements, blocking issues, Service exclusion, the review-state
machine, and exact-ID-only linking apply to every principal.

## Endpoints

| Method and path | Purpose |
|---|---|
| `GET /api/opportunity-reviews` | List: attention queue or Not selected view, filters, pagination |
| `GET /api/opportunity-reviews/:reviewId` | One review |
| `POST /api/opportunity-reviews/:reviewId/approve` | Approve with explicit channel |
| `POST /api/opportunity-reviews/:reviewId/ignore` | Set aside (Not selected), optional note |
| `POST /api/opportunity-reviews/:reviewId/block` | Block with required reason |
| `POST /api/opportunity-reviews/:reviewId/reconsider` | Recover a Not selected review, required reason |
| `POST /api/opportunity-reviews/:reviewId/link-exact` | Exact link to a Sourced deal, verified server-side |
| `GET /api/health` | Process liveness only |
| `GET /api/ready` | Readiness checks (database, identity provider, configuration) |

`:reviewId` is the OPAQUE INTERNAL review identity: the UUID primary key
of `sf_opportunity_reviews.id`, validated as UUID-shaped before any
lookup. It is never a Salesforce Opportunity ID, `sf_opportunity_id`,
opportunity name, or account name; the server resolves the internal
review to its staged opportunity itself, and public responses never
depend on Salesforce IDs as primary keys. There are no bulk endpoints. The list contract supports view (attention or not_selected),
search, review status, record type, open/closed, missing channel,
blocking issue, campaign evidence, BDR evidence, created-date range, and
pagination with `MAX_PAGE_SIZE = 100` (default 25). Responses return
explicit allowlisted fields only, never raw database rows; a field added
to the domain never leaks into the API without an explicit mapping.
Ordinary responses expose no Salesforce Opportunity IDs, Salesforce
History IDs, User IDs, database row internals, tokens, or credentials:
evidence is reduced to presence flags plus the non-identifying Customer
Expansion label. If a future administrative diagnostic ever needs an
external ID, it will be a separate capability-gated contract; it does
not exist yet.

## Mutation, idempotency, and concurrency rules

Every state-changing request carries:

- `idempotencyKey`: caller-generated. An identical retry replays the
  original result (`replayed: true`); the same key with a different
  payload fails with `idempotency_conflict`.
- `expectedVersion`: optimistic concurrency. The version derives
  deterministically from the review projection; a stale version fails
  with `version_conflict` and changes nothing. The live implementation
  may substitute a stored row version.
- Only the fields that action requires. Unknown fields fail validation,
  which is also how actor smuggling is rejected: actor identity comes
  exclusively from the session principal, never from a request body.

Idempotency scope: the identity is namespaced over the COMPLETE scope
(principal subject, action, internal reviewId, caller key); the display
name never participates. The same principal+action+review+key with an
identical payload replays the original result; the same scope with a
different payload is `idempotency_conflict`; different principals may
safely use the same caller key; the same principal may reuse a key across
reviews or actions; one principal can never receive or replay another
principal's stored response; blank scope components fail validation. The
replay of a stored identical request happens BEFORE version checking, so
a completed request stays replayable after the review has advanced. The
future persistent store must enforce a UNIQUE constraint over the
complete four-part namespace.

Optimistic concurrency: the caller submits `expectedVersion`, but the
comparison target is always the version of the AUTHORITATIVE server-
loaded review projection; the client can never declare what the current
version is.

Exact linking: the client submits only the internal reviewId and the
target Sourced `dealId`. The server loads the staged Salesforce
Opportunity ID through the internal review, loads the Salesforce link
evidence stored on the target deal, and permits the link only when both
stored values are nonblank and exactly equal. The client is never
trusted to submit two Salesforce IDs and claim they match, and
names/accounts never auto-link.

Domain rules preserved end to end: approval requires an explicit channel
(never inferred from owner, creator, BDR, Lead Source, Primary Campaign
Source, or Customer Expansion); lead stays optional; reconsider requires
a reason; ignore/block follow the existing contract; similarity stays
suggestion-only with no mutation endpoint; every successful decision
couples the projection mutation and its append-only audit event
(transactionally in the live implementation).

## Error contract

Stable sanitized codes: `unauthenticated` (401), `forbidden` (403),
`validation_failed` (422), `not_found` (404), `version_conflict` (409),
`idempotency_conflict` (409), `review_blocked` (409), `internal_error`
(500). Responses never contain SQL errors, tokens, database or host
details, credentials, raw Salesforce payloads, or stack traces; `reasons`
carries only domain validation sentences.

## CSRF and session requirements (for the live implementation)

- Same-origin API only; validate allowed origins.
- Secure/HttpOnly/SameSite session cookie; no tokens in browser storage.
- CSRF protection on every mutation (SameSite plus a CSRF token or
  equivalent double-submit defense).
- Session expiration and server-side logout invalidation.
- No fake production session exists in this bite.

## Health and readiness

`/api/health` reports only that the process runs. `/api/ready` reports
per-check states (`ok`, `failed`, `unconfigured`) for database, identity
provider, and configuration, and never claims `ready` until every real
adapter reports ok; today all checks are `unconfigured`. Neither endpoint
exposes secrets or internal connection details.

## Database boundary (future implementation duties)

See `src/server/opportunityQueueServerRepository.ts`. The live repository
must use a server-held restricted database identity; touch only the six
`sf_opportunity_*` tables and approved RPCs; write projection and audit
changes atomically; respect the append-only triggers; never expose
credentials to React; enforce idempotency and optimistic concurrency; and
preserve reviewer decisions during ingestion.

## What remains unimplemented

- The HTTP runtime on IT's approved Node.js platform (framework choice is
  deliberately deferred; handlers are `{status, body}` pairs).
- Real PingOne OIDC login, session storage, and CSRF middleware.
- The live server repository against Supabase/PostgreSQL and the review
  RPC it needs.
- Production wiring of the Queue page to `/api`.

## What IT must eventually provide

- OIDC issuer URL and PingOne client registration (client id, auth
  method).
- Redirect and logout URLs for the hosted app.
- The group claim format and the group-to-capability mapping.
- Session and security policy (lifetime, idle timeout, cookie domain).
- Internal Node.js hosting for the API.
- Server secret storage (OIDC client secret, database credential).
- A restricted database identity limited to the six tables and approved
  RPCs.
