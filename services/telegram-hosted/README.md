# Shared Telegram service

This Node 22 supervisor runs browser-initiated Telegram connections on one
operator-controlled computer. Users sign into the hosted workspace, choose
Connect Telegram, scan Telegram's QR code, and select chats. They do not install
the connector, register API credentials, or pair a Mac. Existing local-connector
mode remains available when `TELEGRAM_HOSTED_ENABLED` is off.

The computer makes outbound requests to the application's HTTPS API and Telegram;
it exposes no listener and needs no inbound port, tunnel, or database credentials.
Keep it powered and online for synchronization. Imported conversation search uses
the hosted database and remains available while this service is offline.

## Operator configuration

Apply `20261012220000_telegram_hosted_service.sql` before enabling hosted mode.
Configure these production server variables privately:

- `TELEGRAM_INTAKE_ENABLED=1` and `TELEGRAM_HOSTED_ENABLED=1`
- `TELEGRAM_HOSTED_SERVICE_ID`: one persistent UUID identifying this deployment
- `TELEGRAM_HOSTED_SERVICE_SECRET`: 64 URL-safe characters from 48 random bytes
- `TELEGRAM_HOSTED_DATABASE_URL`: a dedicated NOINHERIT login whose sole
  membership is `app_telegram_hosted_service`, with SET permission and no ADMIN
- `TELEGRAM_HOSTED_DATABASE_CA_CERT`: the database provider's trusted CA when
  needed; the common helper always verifies certificates and hostnames

The database login is used only by the hosted control API. The Mac holds the
service secret, not the database password. This control API refuses browser
Origin headers and reveals no control or worker credentials to browser users.

With Node 22, install the connector's pinned dependency:

```sh
npm ci --prefix services/telegram-connector --ignore-scripts
```

Save configuration outside the repository in a private directory (`0700`) and
file (`0600`), replacing the example values:

```json
{
  "server": "https://your-platform.example",
  "serviceId": "00000000-0000-4000-8000-000000000001",
  "serviceToken": "YOUR_PRIVATE_SERVICE_SECRET",
  "apiCredentialsFile": "/absolute/private/telegram-api.json",
  "stateDirectory": "/absolute/private/hosted-telegram-state"
}
```

`apiCredentialsFile` is an owner-only JSON file containing the application's
positive numeric `apiId` and Telegram-issued `apiHash`. These identify the
application; each user separately authorizes their own Telegram account. Never
put secrets into command arguments, source control, public logs, or browser
storage. Start using only the nonsecret file path:

```sh
TELEGRAM_HOSTED_CONFIG=/absolute/private/hosted-service.json \
  node services/telegram-hosted/run.mjs
```

For automatic restart on macOS, use a user LaunchAgent with an absolute Node 22
binary and script path, the configuration path environment variable,
`KeepAlive=true`, and a throttle interval. Use `ProcessType=Interactive`: browser
sign-in and lease renewals require timely responses, and this service does not
use XPC transactions for adaptive scheduling. `Background` can heavily throttle
SDK loading and I/O, making sign-in time out. Keep logs in the private service
directory. The entry point accepts only fixed child status codes over IPC,
discards raw child output, and
automatically removes only a verified stopped supervisor PID lock. It never
replaces local identities, sessions, or uncertain registration credentials.
`CONNECTOR_SPAWNED` records process creation; `CONNECTOR_STARTED` records completed
startup and `CONNECTOR_HEARTBEAT_ACKNOWLEDGED` confirms website access. These
codes do not mean a user has authorized Telegram or that an import has completed.

## Isolation and recovery

### Immediate sign-in wake

Apply `20261013180000_telegram_hosted_wake.sql` and deploy the website before
restarting an updated supervisor. A shared outbound HTTPS long poll wakes this
service when committed enrollment state changes. It uses the existing service
secret; users and the Mac need no new credentials. `SERVICE_WAKE_READY` confirms
that the channel is responding. Failure retains the ten-second control fallback,
with bounded reconnect backoff and fixed operational codes.

The website needs a PostgreSQL **session** connection for `LISTEN`. Supabase's
shared transaction pooler on port 6543 is automatically changed to its session
port 5432, using the same credentials and certificate verification. Other URLs
are unchanged. Set server-only `TELEGRAM_HOSTED_WAKE_DATABASE_URL` if another
provider requires a distinct session endpoint. The restricted database role
receives only a fenced snapshot function; wake reads never renew service leases.
Notifications contain a constant hint, and the HTTPS response contains only an
opaque cursor. Normal control requests still validate authority before work.

One held listener per service is enforced across website instances. Vercel pauses
active CPU billing during I/O waits but still bills provisioned memory while the
request waits. At published Pro rates, one continuous 2 GB listener is roughly
$15/month in US East or $20/month in Dublin before credits, CPU and other work;
this is an estimate, not a measured bill. See [Vercel pricing](https://vercel.com/docs/functions/usage-and-pricing)
and [Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres).
For larger deployments, a persistent gateway beside the workers can avoid
holding serverless requests while retaining the same lease and isolation rules.

The child scheduler responds immediately to a wake hint. The browser checks
requested sign-in every 500 ms for ten seconds, then every two seconds; initial
registration checks every 250 ms for ten seconds, then every two seconds. This
removes avoidable scheduling waits. Telegram network latency and provider retry
limits still determine when a real QR code can be shown.

The authenticated browser requests an idempotent enrollment scoped to its
organization and owner. The service saves a fresh worker UUID and token durably
before registration. The database stores only its token hash. Lost registration
acknowledgements retry the exact identity; missing files for a registered worker
fail closed and require restoring the private state from backup.

Each owner has a separate connector process, private config and state directory,
RSA password key, and encrypted Telegram session/cache. Keys are protected by
filesystem ownership, not a hardware vault. Use disk encryption and private
backups on the operator computer. Never copy or discard a live state directory.

Only one supervisor may hold the deployment's 90-second service lease. Its
children receive acknowledged deadlines over IPC and stop at least 15 seconds
before server expiry. They also stop on parent loss, sleep-related clock drift,
or an expired deadline. Graceful stop has a five-second hard-stop fallback.
The server refuses hosted worker activity after the service lease expires.
Initial lease receipt retries do not renew ownership without the exact proof.

After an unclean stop, restart can wait up to 90 seconds for the previous service
lease. Existing encrypted sessions and pending acknowledgements are retained.
The UI reflects service and connector availability; it does not report a
successful Telegram login or logout without the connector's acknowledgement.
Disconnect retains the existing remote logout protocol. Removing a worker token
does not guarantee remote logout; Telegram Settings → Devices remains the
emergency revocation path.

This deployment supports ten active owner enrollments. Stopped/revoked
registrations keep their slot until an explicit retirement with logout proof
or owner confirmation of external revocation. Historical identities remain
private audit records; uncertain credentials are never silently replaced.
Outside users can use invitation-only independent workspaces after the
[workspace release](../../docs/staff-workspace-release.md) is enabled. Workspace
membership and each owner's Telegram session remain separate; the ten active
enrollment limit is shared across this service. Public signup is not enabled.

## Moving to persistent hosting

The same supervisor runs in a Node 22 Linux container with its entire private
state on a durable encrypted volume. Preserve the service UUID, private tokens,
worker identities and all encryption keys. Stop the original supervisor and
confirm its children have exited before starting the replacement. This version
is a single active host, not a high-availability or multi-replica service.

## Verification

Runtime unit tests use temporary synthetic state and local child processes, with
no Telegram calls. `npm run test:telegram-connection` includes real disposable
PostgreSQL and browser coverage for hosted enrollment, QR/password handling,
cancel/retry, offline service, owner isolation and acknowledged logout.

## Polling and operating cost

Apply the efficient-polling migration (`20261013110000`) and the chat-removal
cleanup migration (`20261013120000`) before restarting the new service. Deploy
the website/API before restarting the Mac. Legacy heartbeat, claim and list
endpoints remain available during this rollout.

The supervisor renews its lease and obtains all owner scheduling hints in one
request every ten seconds. A connected idle child combines its heartbeat,
connection lease renewal and work plan in one request each minute. Browser
sign-in, password submission, disconnect and queue mutations change a bounded
wake counter; the next supervisor snapshot wakes that owner immediately.
Runnable hints also wake repeatedly, so a missed counter update cannot leave
queued work asleep. Hints never grant access or claim jobs. Pending encrypted
acknowledgements are processed even when the work plan says no new work exists.

The pinned Telegram SDK disables raw event delivery when its automatic update
manager is stopped. This version therefore uses explicit native differences
with a sixty-second quiet-feed cooldown, rather than claiming push freshness.
Account and channel lanes are independent; channels are served fairly using
the authoritative server feed order. Scheduler/provider delays and many due
channels add time. Missing updates, gaps and edits continue through the same
fenced server cursor and repair protocol. Automatic SDK difference fetching
remains disabled. This does not promise instantaneous edit/deletion detection.

With fast responses and no queued work, supervisor control falls from 25,920
to 8,640 requests/day. Ten enrolled idle children add 14,400 polls/day. A quiet
account plus one quiet selected channel per owner adds approximately 57,600
native claim/completion requests/day, including independent lane scheduling hints.
Idle maintenance adds 288 requests/day. The shared wake channel adds roughly
3,400 requests/day when each wait runs its full twenty-five seconds. With no
provider jobs the total is approximately 26,700 requests/day; with a quiet account
and one quiet selected channel per owner it is approximately 84,300 requests/day. These are respectively
about 97% and 90% below the previous roughly 817,920 empty requests/day.
These are request estimates, not bill estimates. More channels, source
repair, imports, browser tabs, retries and retention cleanup add real work.
Every request still validates current permissions and revocation. Worker
last-seen timestamps are written at most every thirty seconds and expiry is
extended only when less than twenty-nine days remain.

Disconnected owners retain their processes and poll once a minute. Parking is
not enabled: no server hint alone proves that an uncertain local authorization
session is safe to stop. Removal cleanup aborts the current provider epoch,
erases only the claimed chat's scratch and CV chunks, flushes deletions, and
then acknowledges its bounded page. Other chats' pending work and authentication
keys/sessions are preserved. Offline removal remains pending until those
acknowledgements arrive.

## Retiring a lost registration

`20261013150000` changes the ten-owner capacity limit to count active enrollments.
Retired registrations remain as private audit/provenance records, with their old
worker identity, owner, retirement time, reason and idempotent operation receipt.
They are excluded from provisioning and service snapshots. Imported history is
preserved.

The owner can open **Reset a lost or revoked connection registration** in the
hosted connection panel. A never-registered enrollment or server-recorded
logout/cancellation can retire directly. For an uncertain or unavailable session,
the owner must first terminate the old session in Telegram Settings → Devices,
or verify it is absent, and explicitly confirm that step. This is an owner
attestation; the website does not claim it performed remote logout.

Reset requires the existing authenticated owner session and MFA gate. It revokes
the old worker token immediately, fences the old connection generation, and
queues the retired registration's private files for deletion. Clicking Connect
then requests a fresh enrollment/worker; reset alone does not start sign-in. The
next complete supervisor snapshot stops retired children before starting
replacement children. The service verifies that the retired process is stopped,
erases only that registration's private directory and flushes the deletion before
acknowledging it. Unsafe paths or uncertain process state remain pending. Reset
cannot restore a lost encryption key or prove Telegram-side revocation itself.

## Retired private-state cleanup

After `20261013170000`, retirement queues deletion of that exact old request's
private directory. The supervisor first observes child exit and verifies any
orphan PID lock represents a stopped process. It uses only the configured
service root and canonical request UUID, checks deployment/worker/owner metadata,
rejects links or unsafe files, erases the retired directory asynchronously, and
flushes the parent directory before acknowledging the service's durable proof.
An old encryption key is unnecessary for deleting the entire known retired
scope. Active request directories and imported database history are preserved.

Retired cleanup claims contain at most five identity records and no file paths.
Fair claim ordering prevents an unverifiable old directory from indefinitely
hiding later work. A live or unknown process/path stays pending with a fixed
operational code and a five-minute retry. Lost acknowledgements retry the same
proof and verified absence; they cannot recreate an old registration. Cleanup
adds no idle polling requests: the existing maintenance aggregate provides its
wake hint.

Conversation removal keeps primary-worker cleanup evidence separate from old
retired-vault obligations. A new worker's acknowledgement never proves an old
worker's bytes were erased. Completion waits for both, plus server and storage
purge. Future removal requests inherit any still-unverified retired scopes;
verified whole-scope purge can cover later work because retired credentials are
permanently fenced. Migration repair reopens only still-removed completed chats
with missing old-scope proof, preserving explicit fresh reimports. Private
backups remain governed by the operator's backup retention policy.

## Shared candidate processing

Enable the bounded processing pool in the same supervisor by adding `processing`
to its private configuration:

```json
{
  "processing": {
    "extractionConfigFile": "/absolute/private/extraction.json",
    "cvAnalysisConfigFile": "/absolute/private/cv-analysis.json",
    "semanticConfigFile": "/absolute/private/semantic.json",
    "limits": { "extraction": 2, "cv": 1, "semantic": 2 }
  }
}
```

These use the existing worker configuration formats and shared model/embedding
providers. Keep extraction and CV `providerModel` set to `gpt-6-luna`. Template
account tokens are not used for processing: the supervisor automatically discovers
registered users and authenticates each task with that user's credential. Pending
results are encrypted in separate private directories per registration. Fixed
concurrency limits apply across all users; semantic search has separate capacity
so it can run while CVs or chats are being extracted. Removal, revocation, credential
changes, and loss of the supervisor lease stop the affected work.

Stop the standalone account-specific extraction, CV and semantic services before
enabling the pool. Let any in-flight requests finish first, and retain their state
for recovery. The supervisor needs Docker on its PATH for isolated PDF/DOCX parsing.
It must remain online for processing and semantic searches.

Recruiters review their own proposals and private Telegram evidence. Approved
candidate profiles are visible within the workspace. Exact email/Telegram identity
matches propose changes to the existing profile; ambiguous matches need explicit
review. Field decisions and candidate version checks prevent unwanted changes and
concurrent edits from being overwritten. Sharing a profile does not grant access
to another recruiter's conversation or proposal inbox.

To test a second user: invite them as Recruiter in Members, share the app URL (the
invite does not send email), and have them sign in with the invited Google account.
They connect Telegram, select a chat containing a candidate or a labelled CV, review
the proposal, and approve it. Verify both recruiters can find the approved candidate,
while only the importer can see the proposal/evidence. Import the same exact candidate
identity again with changed details to test individual field review.
