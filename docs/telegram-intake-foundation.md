# Telegram intake: private review checkpoint

This branch provides a feature-flagged private candidate draft inbox and an
outbound Mac embedding worker. It incorporates performance PR #28 and reuses the
existing candidate upload, duplicate detection, permissions and MFA boundaries.
The shared staff navigation and candidate list are unchanged.

## Available in this checkpoint

- `/staff/telegram-intake` defaults to Ready to review, with Needs information,
  Snoozed, Duplicates and All views, required-field filters and paginated results.
- Draft edits use versions: conflicting changes preserve the recruiter's local
  edits and require an explicit refresh. Approval lists all missing requirements.
- First name, last name, primary email and a validated PDF/DOCX CV are required.
  Up to nine secondary emails and optional preferences are supported.
- CV uploads reuse the existing byte validation and 4 MB limit. Pending uploads
  have durable reservations before storage writes. Private downloads check the
  owning recruiter and issue a 60-second signed URL.
- Approval atomically creates the normal shared candidate record, including
  Telegram username and stable user ID as identifiers. Email duplicates remain
  private drafts requiring review; they are never merged automatically.
- Approval/discard removes draft fields, source-message links and private vectors.
  A message survives while another unresolved draft still references it. Approval
  retains the candidate's reviewed fields and CV plus a minimal review stub.
- Worker tokens are hashed, scoped to one recruiter and organization, revocable,
  and expire after 30 days. Jobs use expiring leases, bounded retries, version
  fencing and idempotent completion. A failed job can be explicitly queued again.

This is **not yet live Telegram ingestion or semantic search**. There is no
Telegram login/chat selector, history synchronizer, extraction provider, automatic
index scheduling, ranked search endpoint, or approved-candidate search index in
this checkpoint. Draft creation and embedding enqueue are currently API seams for
synthetic validation and the next implementation phase. The Mac stores no database
or hosted storage credentials and opens no public listener.

## Enable in an isolated environment

1. Apply existing platform migrations followed by
   `20261002130000_telegram_intake_foundation.sql`. Use the normal migration
   operator, never the staff runtime connection. The migration is portable
   PostgreSQL 17 and additive. Keep the feature disabled during migration.
2. On the hosted app, set `TELEGRAM_INTAKE_ENABLED=1`. Leave it unset elsewhere.
   Existing staff auth, MFA, database and private CV storage configuration apply.
3. Provision a separate hosted database login: `NOINHERIT NOSUPERUSER NOCREATEDB
   NOCREATEROLE NOBYPASSRLS`, granted **only** `app_telegram_worker`. Store its URL
   as hosted `TELEGRAM_WORKER_DATABASE_URL`; never put it on the Mac. Do not reuse
   a migration, owner, executor or staff database credential. If the database
   uses a private certificate authority, also set hosted server-only
   `TELEGRAM_WORKER_DATABASE_CA_CERT` to its provider-issued PEM CA certificate
   (with real newlines). All worker API pools use this CA with certificate and
   hostname verification; URL SSL options cannot override it. Leave it unset
   for existing database URL TLS configuration. Never disable TLS verification
   to accommodate a private CA. Keep both settings out of browser bundles and
   Mac worker configuration. Worker pools bound connection setup to five seconds
   (pairing retains its two-second limit), so database outages fail promptly.
4. As a verified recruiter, POST `/api/staff/telegram-intake/workers` with
   `{"name":"Demo Mac"}`. Save the returned token once into a private `0600`
   file outside source control. Record the worker ID for revocation with
   `DELETE /api/staff/telegram-intake/workers/{id}`.
5. Follow `services/local-embeddings/README.md`, then
   `services/telegram-worker/README.md`. The worker's hosted origin uses HTTPS;
   inference remains authenticated on Mac loopback port 8817. Processes currently
   start manually and stop when the Mac sleeps, shuts down, or the process exits.
   Pending work stays queued and expired leases recover after restart.

Only synthetic data has been used for this checkpoint. Do not enable this as a
complete Telegram product or import real conversations yet.

## API contract

All staff endpoints below require a verified staff session/MFA and the same
organization context as the current workspace. Private draft operations require
candidate read/write permissions; uploads and approval require document write,
CV downloads require document download. Mutations reject cross-site origins.

| Method and suffix under `/api/staff/telegram-intake` | Purpose |
| --- | --- |
| `GET /drafts?view=ready&missing=cv&q=&page=1` | Private inbox; 25 per page, counts and next-page flag |
| `POST /drafts` | `{fields,sourceTitle?}`; incomplete names/email/CV permitted |
| `GET /drafts/{id}` | Private detail and source evidence |
| `PATCH /drafts/{id}` | `{fields,expectedVersion}` |
| `POST /drafts/{id}/cv` | Multipart `cvFile` and `expectedVersion` |
| `GET /drafts/{id}/cv` | Owner-checked short-lived download redirect |
| `POST /drafts/{id}/decision` | `{action,expectedVersion,operationId}`; UUID operation ID |
| `POST /drafts/{id}/index` | Explicit embedding job for the current private draft version |
| `POST /uploads/cleanup` | Retry at most ten eligible private CV deletions |
| `POST /workers`, `DELETE /workers/{id}` | Register/revoke a scoped worker |

Decision actions are `approve`, `discard`, `snooze`, `reopen`. Successful approval
returns `candidateId`; duplicate approval returns HTTP 409 with duplicate status
and the existing candidate ID. Incomplete approval returns HTTP 422 and per-field
errors. Stale updates return HTTP 409. Resolved drafts cannot be edited.

Worker POST endpoints are `/api/telegram-intake/worker/{claim,complete,fail}`.
They use a scoped Bearer token, not browser authentication, and reject browser
Origin headers. Claim accepts `{}`; completion/failure carry job ID and lease
token. Payloads and vectors are bounded; every result must match the pinned E5
model/index version. Error responses never echo message text, SQL or credentials.

## Storage cleanup and rollback

A new upload reservation has a one-hour grace period to protect in-flight uploads.
Replacement/discarded CVs become eligible immediately. Cleanup commits a deletion
fence before touching storage; a late attachment cannot reference that object.
Draft and approved-candidate references prevent deletion. Failed storage deletes
or uncertain acknowledgements remain durable and retryable.

Cleanup runs after mutation responses, on inbox entry and through the bounded
cleanup endpoint. This checkpoint has no unattended global cleanup scheduler;
a recruiter who never returns can leave eligible private orphan bytes queued.
Before real ingestion, add hosted scheduled cleanup with its own constrained role
and retention observability. Never use the Mac worker for storage deletion.

To roll back application exposure, unset `TELEGRAM_INTAKE_ENABLED`, stop the Mac
worker and revoke issued worker tokens. Keep the additive tables and approved
candidate records. Do not drop data as an application rollback procedure.

## Verification

Use Node 22. `npm test`, `npm run lint`, `npm run typecheck` and `npm run build`
cover the code and routes. `npm run test:telegram-intake` uses labeled disposable
PostgreSQL 17 containers and an authenticated Next.js browser fixture. It never
connects to production. Do not run another Next dev/build in the same checkout
while this browser suite is active. Python service tests and the synthetic real
model benchmark are documented in the local embedding service README.

## Next independent work after this review

Agree on the Telegram account/session, chat checkpoint and extraction-output
contracts first. Then split work into isolated worktrees: (1) Telegram connection
and resumable full-history import, (2) evidence-backed extraction and draft
updates, (3) approved-profile and private-draft semantic retrieval with relevance
evaluations. One integrator owns shared migrations and acceptance tests. Preserve
private ownership, bounded batches, backpressure and retryable cursors throughout.

The next checkpoint must demonstrate connect → select chats → import → extract →
review → approve → search, including missing CVs, conflicting information, edited
messages, cross-recruiter isolation, worker outages and hundreds of lengthy chats.
Keep the temporary extraction provider behind an adapter so changing providers
does not require changes to draft approval or search storage.
