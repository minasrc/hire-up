# Telegram connection worker (Mac, Node 22)

This separately installed process connects Agora's private Telegram connection
screen to Teleproto. It supports QR login, Telegram's optional two-step password,
restart recovery, connection status, acknowledged logout, private chat discovery
and resumable full available history for selected chats. History import stores
text and attachment metadata; CV bytes require the separate recruiter-selected
retrieval workflow below. This connector does not extract drafts. The hosted
application never imports this package.

This standalone connector is sufficient for selected-chat import, new-message
sync and retained-source freshness. Original conversation keyword/phrase search
runs in the hosted app at `/staff/telegram-intake/context`; it needs no AI model,
embedding service, Python or Docker. The full [Mac worker launcher](../mac-worker/README.md)
is optional for candidate extraction, CV analysis and semantic profile/CV search.
Import/search setup needs Node 22, this directory's pinned Teleproto dependency,
a paired worker credential and your Telegram application API credentials.

The Mac sends outbound HTTPS requests to Agora and outbound connections to
Telegram. It opens no listener or tunnel and needs no database/storage password.
Keep the Mac awake and online while demonstrating this workflow. If it sleeps,
leases expire and the UI shows the worker offline; restart reconciles hosted
state before using any saved session.

## Setup

1. Confirm the hosted application and ordered migrations are compatible with
   this connector. After deployment checks pass, the operator enables hosted
   `TELEGRAM_INTAKE_ENABLED=1` for controlled staff-account acceptance with
   permitted test conversations. The flag is required even for Mac pairing and
   applies globally to the deployed staff app; it is not an account allowlist.
   Keep automatic per-chat extraction off for import/search acceptance, and
   disable the hosted flag if acceptance fails. Broader rollout requires passing
   live acceptance; synthetic checks alone do not establish it.
2. [Pair this Mac](../worker-pairing/README.md) to obtain a recruiter-scoped
   credential file, or use an existing private worker registration. Never put a token in a URL, shell
   argument, shared document or commit.
3. Supply your own Telegram application `apiId` and `apiHash` on this Mac. They
   are never sent to Agora. The CLI does not obtain these credentials for you.
4. Create a private configuration file **outside the repository**, with mode
   `0600`, in a private directory. Its JSON keys are `server` (HTTPS origin),
   `workerId`, `token`, `apiId` (positive integer), `apiHash`, and optionally
   `stateDirectory` (absolute private directory on this Mac).
   With a paired credential, use `credentialFile` instead of inline
   `server`/`workerId`/`token`; see the paired configuration below.
5. With Node 22 selected, run from this directory:

   ```sh
   npm ci --ignore-scripts
   TELEGRAM_CONNECTOR_CONFIG=/absolute/private/connector.json npm start
   ```

The hosted URL may use HTTP only for loopback testing. Redirects are rejected so
a changed endpoint cannot forward the worker token. Do not enable remote logs or
turn on Teleproto debugging. The CLI emits only fixed operational codes.

Instead of the file, dedicated process environment variables are accepted:
`TELEGRAM_CONNECTOR_SERVER`, `TELEGRAM_CONNECTOR_WORKER_ID`,
`TELEGRAM_CONNECTOR_TOKEN`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`,
`TELEGRAM_CONNECTOR_STATE_DIR`. Environment values override file values. Prefer
the private file to avoid credentials ending up in shell history.

After the first heartbeat, the assigned Mac appears in the recruiter's Telegram
connection screen. The recruiter selects it and scans the QR using Telegram's
Devices screen. If Telegram requests a two-step password, the browser encrypts
it to this Mac's RSA key; only this process decrypts it, in memory, and submits
it to Telegram. It never writes the password to disk. Buffers are cleared after
use; JavaScript strings used inside Teleproto cannot be reliably zeroed.

## Local state and recovery

State defaults to ignored `.runtime/`. Directories are `0700`, files `0600`.
An RSA-2048 identity and an AES-256-GCM encryption key persist in a private local
identity file. Sessions are encrypted with authenticated organization-independent
scope composed of hosted origin, worker ID and connection ID; the worker ID is
already bound server-side to an organization/recruiter. Copying encrypted session
files across scopes does not make them usable. These are **filesystem-protected
keys, not a hardware/keychain vault**: protect this Mac and its backups with the
normal account security and disk encryption. Never share the state directory.

Run one connector process per state directory. Normal Ctrl-C/SIGTERM closes
clients and releases the process lock while retaining encrypted sessions for a
safe restart. After a crash, first ensure the old process has stopped, then run:

```sh
TELEGRAM_CONNECTOR_CONFIG=/absolute/private/connector.json node run.mjs --unlock-stopped
```

The recovery command refuses to unlock a live PID. Restart normally afterward;
it claims current hosted state before opening a saved session. A recycled PID
may conservatively block unlocking until that process exits. Do not remove the
state directory or rotate its keys while a connection is active.

Disconnect performs remote Telegram logout, replaces the local session with a
session-free acknowledgement receipt, and reports success only after the session
has been removed. The receipt survives a lost HTTP response or restart and is
deleted after hosted acknowledgement. Failed logout retains the encrypted session
and retries with backoff. If a potentially active session is missing locally, the
connector reports `LOGOUT_FAILED`; it does not fabricate remote success. Revoke
that session in Telegram's Devices screen. An expired/revoked worker token stops
this process; it cannot then acknowledge hosted disconnect until access is
restored. Remote revocation through Telegram Devices is the fallback.

## Verification

From the repository root, Node 22:

```sh
node --test tests/unit/telegram-connector*.test.js
```

Tests inject the Telegram adapter and hosted HTTP transport, use disposable local
vaults and synthetic credentials, and never contact Telegram or read a developer's
configuration. The pinned Teleproto runtime is isolated by its own lockfile. After `npm ci` in the
service directory, `node check-runtime.mjs` checks the real installed imports
without creating a client or opening a network connection. This connector pins maintained `teleproto@1.229.1`, recommended by archived
GramJS upstream, instead of copying the legacy app’s archived dependency. The
required QR/SRP/session APIs were inspected against the installed package and
covered with injected adapter tests. The separate lockfile pins transitive code. A real
account smoke test still requires operator-supplied API credentials, worker token
and a deliberate QR scan; no account was connected by these tests.


## Private history imports

After connecting, use Agora's chat screen to discover both regular and archived
chats, then select the conversations to import. A reconnect to the same Telegram
account preserves private history; Resume explicitly binds an interrupted import
to the new connection generation. A different account has separate selection,
messages and cursors. Migrated basic groups remain discoverable so their older
history is not silently lost; select both legacy and current conversations when
both contain relevant history.

Each connected tick performs at most one Telegram read, with a 10-second native
RPC deadline and cancellation signal. The connector renews its control lease and
heartbeat between pages. Dialogs and history are read in bounded pages of at most
100 entries; request bodies have a 256 KiB cap and larger pages are retried with a
smaller page size. One oversized message pauses its chat instead of truncating or
skipping it. An empty raw page confirms completion. After the initial snapshot is fully imported, selected chats automatically sync
new messages in bounded pages, with a target interval of 60 seconds per chat.
Each pass freezes its upper message ID; arrivals during paging are picked up by
the next pass. The hosted checkpoint advances only after the entire pass succeeds.
Downtime is recovered from that checkpoint, and reconnecting the same account
rebinds automatic work while preserving explicit pauses. Deselecting or pausing
a chat stops both import and sync. Resume continues from the saved position.
Edits and explicit deletions of retained messages are recovered through durable
account update state (`getDifference`) and separate selected-channel update state
(`getChannelDifference`). Initial baselines and provider gaps request bounded
retained-ID repair. Update state commits together with retained source changes;
encrypted acknowledgements survive restart and lost responses. Native recovery
and repair share the provider request budget with history and CV work.

Repair rotates selected chats and rereads four retained IDs per provider operation.
It is eventual, not a prompt full-history sweep: a 200,000-message import can need
at least roughly 84 hours, with sleeping Macs and Telegram waits extending delay.
Explicit provider deletion or `MessageEmpty` marks source unavailable; omitted
responses and access/network failures never prove deletion. Purged source is not
recreated, and inaccessible Telegram content cannot be recovered. Busy queues and
flood waits delay polling. See [source freshness and acceptance](../../docs/telegram-context-release.md#freshness).

The server schedules selected chats fairly, enforces private storage quotas, and
shows explicit pauses for quota, peer access and large-message problems. Flood
waits become server-side account cooldowns; the Mac never sleeps while holding a
job lease. History requests do not download attachments. No requests send
messages, join chats, or mark conversations as read.

Access hashes stay in encrypted, account-scoped peer-cache files. Usernames are
only metadata; they are never used to resolve a hosted job to a different person.
Only necessary chat locators are cached, not every message author's access hash.
If the local peer cache is missing, discover chats again and Resume the paused
import. Pending completed pages are encrypted before posting to the server and
retained until an acknowledgement, allowing exact retries after a network outage
or process restart. Successful disconnect removes this local history cache.

History checks use synthetic Telegram responses and disposable local caches:

```sh
node --test tests/unit/telegram-history-runtime.test.js tests/unit/telegram-connector*.test.js
```

## Recruiter-selected CV retrieval

After extraction, recruiters may select a PDF/DOCX attachment suggestion and
choose Retrieve CV. The same connector claims this account-scoped job while
connected. It re-fetches the exact source message, checks the original document
ID and available filename/size, and then reads at most 512 KiB per tick. Files
larger than 4 MiB are rejected. Unknown original size is resolved from the fresh
Telegram document before any file bytes are downloaded.

CV work alternates with history pages, with connection control checks between
ticks. Every file RPC has a 10-second deadline, cancellation signal and zero
automatic retries. Flood waits become the shared account cooldown (up to seven
days). File references can be refreshed at most three times for the same private
document; DC migrations are similarly bounded. No high-level parallel Telegram
downloader is used.

Partial bytes and document access fields stay encrypted in account/job-scoped
local chunk files, with 0600 files and 0700 directories. A restarted partial
download rechecks the source before resuming. Completed bytes are submitted only
to the configured platform's scoped binary upload endpoint; the Mac receives no
storage key, general storage credential or database credential. The host checks
the real byte length, SHA-256, file signature and filename extension before
attaching it to the still-open, still-empty draft.

Lost upload acknowledgements replay the same encrypted bytes and digest before
claiming new work, using the current connection proof. A definitive stale-job
response removes stale local work; uncertain network/server responses retain it.
Successful acknowledgement removes local chunks. Successful Telegram disconnect
removes the account cache as well. Permission denial stops the connector until
credentials or permissions are repaired. Cancelled retrieval or a manual CV
uploaded first cannot be overwritten by a late worker completion.

The recruiter chooses among suggestions and reviews the CV and candidate draft;
retrieval does not approve a candidate. Existing manual upload remains available.
Signature detection establishes file type, not malware clearance or complete
document-structure validation. CV text extraction is a separate checkpoint.

```sh
node --test tests/unit/telegram-cv-*.test.js
```

## Browser-paired device credential

The pairing CLI can create a shared private `credential.json`. Set `credentialFile`
in this connector's private config (relative paths resolve beside that config), or
`TELEGRAM_CONNECTOR_CREDENTIAL_FILE`, to use its server/workerId/token. Keep apiId,
apiHash and stateDirectory in the existing connector configuration. Existing
inline/env credentials still work; if supplied together with the paired file,
identities must match. Pairing does not start this connector or authenticate
Telegram. See `../worker-pairing/README.md` for the hidden invitation prompt and
restart-safe enrollment workflow.

## Connector upgrade and live acceptance

Use this compatible Mac connector after the hosted application and ordered
migrations have been deployed. Older connectors do not understand all current
bounded sync/source-freshness work. Follow the
[ordered release procedure](../../docs/telegram-context-release.md#deployment-and-validation);
do not rerun already applied migrations. Restart a worker that entered legacy
mode before its host was upgraded.
Already imported selected chats start syncing
on the next worker claim. No new credentials are required. Automatic extraction
remains a per-chat choice; enable it to send new text and attachment suggestions
through the existing private draft review pipeline. CV retrieval still requires
the recruiter to select an attachment. Verify a new message and CV suggestion,
then stop/restart the Mac and verify missed messages reach review once.
For import and lexical conversation-search acceptance, use a permitted test chat,
complete QR/2FA, import selected history, search retained original messages, and
verify restart/resume, new messages, edits, explicit deletions and offline gap
recovery. These live checks remain operator acceptance work; dependency checks
and synthetic tests do not establish their completion. Keep automatic extraction
off unless its processing and model acceptance are separately authorized.


## Session recovery and durable checkpoints

QR approval uses a narrow listener for Telegram's login-token notification,
including wrapped notifications. It bypasses the SDK's general update queue:
that queue can wait for an authorized account state before delivering the very
notification needed to authorize the account. Automatic SDK account/channel
fetching stays disabled during sign-in, migration and synchronization; explicit
server-fenced work owns the import and source checkpoints.

Private operational logs distinguish `CONNECTOR_PHONE_APPROVED`,
`CONNECTOR_PASSWORD_REQUIRED`, `CONNECTOR_AUTHENTICATED` and
`CONNECTOR_CONNECTION_CONFIRMED`. The last code is emitted only after the server
acknowledges the connection. These codes contain no token, password, account
identity or conversation content. An already expired/cancelled login generation
cannot be revived; start a fresh sign-in after deploying this connector.

Temporary Telegram network failures and SDK operation timeouts close the current
client and retry the encrypted session after 2, 4, 8, 16, then at most 30 seconds.
The connector continues renewing its host claim during the wait. The connection
remains authorized while synchronization catches up; the last successful sync
still determines source freshness. Expired login challenges, revoked sessions,
and terminal authentication failures retain the existing failure/logout fences.
A late SDK connect result from an earlier attempt is closed and cannot overwrite
a newer checkpoint.

Identity keys, sessions, pending page/update acknowledgements and CV chunks share
the same durable replacement protocol: create a private temporary file, write
and fsync it, rename it over the prior record, then fsync the containing directory.
New cache directories also flush their parent entry. Failures before rename keep
the old record and remove the temporary file. A directory-flush failure after
rename reports an error: the replacement may already be visible, so no caller
may treat that write as acknowledged durable. A process killed before publication
may leave a private temporary file; it is never used as the authoritative record.
