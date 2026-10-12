# Reviewed sources and automatic extraction release

This checkpoint keeps extraction running as more pages of an enabled chat's full
history arrive. Recruiters can stop automatic extraction separately from history
import. It also lets them release a reviewed batch's message context once every
linked draft, suggestion and CV operation is resolved.

## Source decisions

The default is to keep source context. A candidate approval does not prove that
the recruiter reviewed unrelated job, client or lead information in the same
batch. “Release after candidate review” explicitly releases that remaining
context; it is safe to request while candidates still need work. The interface
shows what still prevents deletion. Keeping context again cancels a pending
release, but cannot restore a completed purge.

Cleanup removes raw message bodies, source snapshots, resolved proposal quotes
and unused evidence or attachment hints. Reviewed profiles and their CVs remain.
Minimal message identities and result receipts prevent repeated imports or lost
acknowledgements from recreating deleted material. Storage quotas are released
only after the deletion transaction succeeds.

## Hosted maintenance

Deploy migration `20261002190000` and the hosted application together while the
Telegram intake feature remains disabled for broad rollout. Provision a separate
database login with membership in `app_telegram_maintenance`, `NOINHERIT`, and no
other application, owner, administrative or bypass-RLS role. This login can only
execute the bounded maintenance entry point. It cannot choose a recruiter, read
messages, approve candidates or change source decisions.

Set server-only `TELEGRAM_MAINTENANCE_DATABASE_URL` to that login's connection
string. Set `TELEGRAM_MAINTENANCE_SECRET` to a newly generated random 32-byte
base64url token (43 characters). Store credentials through private deployment
secret management; never put them in the repository, a public environment
variable, a URL or a command argument.

If the database uses a private certificate authority, set server-only
`TELEGRAM_MAINTENANCE_DATABASE_CA_CERT` to its provider-issued PEM CA certificate
(with actual newlines). Obtain it through the provider's authenticated settings
or official certificate distribution (such as a pinned provider CLI release),
and confirm its provenance before deployment. This explicitly enables TLS with
certificate-chain and hostname verification; connection URL SSL parameters are
ignored when this CA is set. Without this optional setting, the connection URL's
existing TLS configuration applies. Use `sslmode=verify-full` for hosted
connections; never disable verification to work around a trust-chain failure.

Set these repository Actions secrets:

- `TELEGRAM_MAINTENANCE_URL`: the production HTTPS URL ending exactly in
  `/api/telegram-maintenance`, with no query string or embedded credentials.
- `TELEGRAM_MAINTENANCE_SECRET`: the same private maintenance token.

The `Telegram source maintenance` workflow runs hourly, at minute 7, on the default
branch and supports manual dispatch. The separate `Telegram maintenance manual
run` workflow has no schedule and can run while the hourly workflow is disabled.
Both use the same bounded runner and concurrency lock, preventing overlapping
manual and scheduled cleanup. They need no npm install, model service,
Telegram session or personal Mac. Each request processes bounded work; each
scheduled run makes at most eight requests and stops early when no work can
progress. The endpoint remains available when the Telegram feature is disabled.
It rejects browser-origin requests, invalid credentials and owner/limit query
parameters, and returns aggregate counts only. Redirects are never followed.

Before enabling intake or activating the hourly schedule, explicitly approve and
dispatch `Telegram maintenance manual run` on the default branch and confirm an
authenticated successful response. Keep the hourly workflow disabled until this
test passes, then enable it and verify a scheduled run. An unconfigured workflow now fails and
reports that no request was sent; a green run requires actual cleanup requests.
The run summary records bounded request counts and aggregate cleanup totals,
and identifies pending work without exposing conversation text or credentials.
Monitor failed runs and repeated `remainingWork: true` results. A database or network failure
leaves a retryable transaction, not partially decremented quotas. GitHub's
scheduled jobs can be delayed; this is eventual cleanup, not a deletion-time SLA.
The hourly schedule reduces scheduled runner starts from 96 to 24 per day.
Reviewed-source and expired-cache physical cleanup can now wait about an hour,
plus scheduler delays, while searches still become unusable at their existing
15-minute expiry. No deletion bound or authorization check is relaxed.
Use a more reliable hosted scheduler against the same endpoint if an exact
operational deadline is required.

Searches become unusable at their 15-minute expiry even when maintenance has a
backlog. Physical deletion is separately bounded: up to 100 query text/vector
expirations and 5,000 cached result rows per request. Large result sets can need
multiple passes. Retained source batches with unresolved consumers remain held.

The local PostgreSQL 17 volume check seeded 100,036 expired results across several
owners. Staff expiry removed the first 500; 20 restricted maintenance calls
removed the remaining 99,536. Calls took 104 ms at p95 and at most 110 ms, and the
small owners finished within three calls. The live query, its vector and results,
and all 100,000 indexed sources remained intact. These synthetic local timings
do not include hosted-network latency or production load. Run the opt-in check
with `TELEGRAM_RETENTION_SCALE=1 node --test tests/database/telegram-retention-volume.test.js`.

## Release acceptance

Verify catch-up when extraction temporarily empties before the final import page,
enable/disable isolation, the largest legal singleton message, explicit source
release, pending draft/proposal/CV holds, replay after purge, quota accounting and
reimport prevention. Test the maintenance role directly against a disposable
database and test the authenticated hosted endpoint with the intake feature off.

Live Telegram login, provider authentication and real-account acceptance are
separate requirements. This change does not parse CV contents, continuously watch
for newly sent Telegram messages, or erase the original Telegram conversation.
