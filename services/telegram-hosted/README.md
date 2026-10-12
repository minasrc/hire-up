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

This initial deployment supports ten durable owner enrollments, including
stopped/revoked registrations. It intentionally does not recycle uncertain
identities. Capacity errors are real limits, not an invitation to bypass them.
Public workspace signup and independent workspace selection are separate work;
this service currently uses the existing authorized workspace membership gate.

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
