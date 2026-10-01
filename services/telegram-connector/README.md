# Telegram connection worker (Mac, Node 22)

This separately installed process connects Agora's private Telegram connection
screen to Teleproto. It supports QR login, Telegram's optional two-step password,
restart recovery, connection status, acknowledged logout, private chat discovery
and resumable full available history for selected chats. This stage imports text
and attachment metadata; it does not download CV/media bytes or extract drafts. The hosted application never imports this package.

The Mac sends outbound HTTPS requests to Agora and outbound connections to
Telegram. It opens no listener or tunnel and needs no database/storage password.
Keep the Mac awake and online while demonstrating this workflow. If it sleeps,
leases expire and the UI shows the worker offline; restart reconciles hosted
state before using any saved session.

## Setup

1. Deploy the connection migration/API/UI and set `TELEGRAM_INTAKE_ENABLED=1` in
   the hosted application only after its synthetic checks pass.
2. Obtain a recruiter-scoped worker ID and token through the existing private
   worker registration API. A token is shown once; never put it in a URL, shell
   argument, shared document or commit.
3. Supply your own Telegram application `apiId` and `apiHash` on this Mac. They
   are never sent to Agora. The CLI does not obtain these credentials for you.
4. Create a private configuration file **outside the repository**, with mode
   `0600`, in a private directory. Its JSON keys are `server` (HTTPS origin),
   `workerId`, `token`, `apiId` (positive integer), `apiHash`, and optionally
   `stateDirectory` (absolute private directory on this Mac).
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
skipping it. An empty raw page confirms completion. New messages after the initial
snapshot and edits to previously imported messages need a later incremental-sync
feature; deleted/inaccessible Telegram content cannot be recovered by this import.

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
