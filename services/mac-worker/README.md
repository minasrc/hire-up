# Run the recruiting workers on this Mac

One foreground command runs the Telegram connector (including history and CV
retrieval), candidate extraction, CV analysis, semantic search, and an owned
loopback embedding service. Keep the terminal open and the Mac awake and online.
Ctrl-C stops this launch's processes and preserves Telegram sessions and pending
work. A normal stop does not log out of Telegram.

This full launcher is optional when accepting Telegram import and original
conversation keyword/phrase search. For that workflow, run the
[standalone connector](../telegram-connector/README.md) with Node 22, its pinned
Teleproto dependency, a paired credential and Telegram application API credentials.
Search runs in the hosted application without an AI model, embedding service,
Python or Docker. The setup below also prepares candidate extraction, CV analysis
and semantic profile/CV search.

## Prepare once

Use Node 22, Python 3.12, and a local Docker Engine/Desktop. From this checkout:

```sh
npm ci
npm ci --prefix services/telegram-connector --ignore-scripts
npm ci --prefix services/cv-analysis-worker --ignore-scripts
docker build -t agora-cv-parser:v1 services/cv-analysis-worker
```

Prepare the pinned model and Python environment using
[local embedding setup](../local-embeddings/README.md). This is the explicit
download/install step; launcher startup never downloads or installs anything.
Reuse matching model assets read-only if already installed. Do not start the
detached embedding service on the launcher's chosen port. An occupied port is
refused; another service is never adopted or stopped.

After hosted deployment checks pass, the operator enables
`TELEGRAM_INTAKE_ENABLED=1` for controlled staff-account acceptance with permitted
test conversations. This global staff-app flag is required even for pairing;
it does not restrict access to a test-account allowlist. Keep automatic per-chat
extraction off during import/search acceptance and disable the flag if acceptance
fails. [Pair the Mac](../worker-pairing/README.md) to obtain its private credential file.
Keep that file and all other configuration outside the repository in private
local storage. Configure the intended provider separately; an already configured
local CLIProxyAPI endpoint is supported. The launcher does not install or sign
into a proxy, select a provider, or send test candidate data to it.

## Private configuration

Save a JSON file with mode0600 inside a directory with mode0700. Replace every
example path/value below; paths resolve beside this JSON. Telegram API credentials
belong to your Telegram application. Provider and model tokens stay in their
existing private files. Never paste secrets into command arguments or logs.

```json
{
  "version": 1,
  "credentialFile": "./paired-device/credential.json",
  "runtimeDirectory": "./launcher",
  "stateDirectories": {
    "connector": "./telegram-state",
    "extraction": "./extraction-state",
    "cvAnalysis": "./cv-analysis-state",
    "semantic": "./semantic-state"
  },
  "telegram": {"apiId": 12345, "apiHash": "YOUR_TELEGRAM_API_HASH"},
  "provider": {
    "baseUrl": "http://127.0.0.1:8317/v1",
    "model": "codex-dev",
    "tokenFile": "./provider.token"
  },
  "embedding": {
    "python": "/absolute/checkout/services/local-embeddings/.venv/bin/python",
    "modelDirectory": "/absolute/checkout/services/local-embeddings/.runtime/model",
    "tokenFile": "/absolute/checkout/services/local-embeddings/.runtime/token",
    "port": 8821
  }
}
```

If workers already exist, use their exact existing state directories and paired
identity. Do not move their vaults or generate a replacement token to fix a setup
error. All four state directories and the launcher's runtime must be distinct and
must not contain one another. Paths for private files cannot traverse symlinks;
on macOS use `/private/tmp` instead of its `/tmp` alias. The model directory and
Python environment may use their established read-only asset paths.

```sh
node services/mac-worker/cli.mjs check --config /absolute/private/mac.json
node services/mac-worker/cli.mjs start --config /absolute/private/mac.json
```

`check` verifies local dependencies, a local Docker context, the parser image and
pinned model assets. `start` verifies the model's identity and performs one
authenticated synthetic inference before starting workers. Process-running output
does not mean Telegram or the provider is ready. Use Connect Telegram to complete
QR/2FA login, select chats, and watch import/extraction progress. Review a live
draft, its CV and evidence, approve it, and verify search before broad rollout.
Only approved candidate records are shared.

The paired token is referenced directly by every worker; it is never copied into
temporary configuration. Environment overrides for old worker credentials,
models, or endpoints are excluded. Provider/embedding tokens and pending receipts
are not printed. Renewal can preserve the same token; changed paired identity
requires an explicit restart and review of any old pending receipts.

## Stop, restart and recovery

Press Ctrl-C, wait for `LAUNCHER_STOPPED_STATE_PRESERVED`, then use the same start
command to resume. A worker exit stops the group instead of silently restarting
or hiding a failed service. Owned process groups include subprocesses; parser
containers carry a unique launch label so cleanup cannot remove another launch's
containers. A cleanup failure is reported explicitly. No login item is installed.

After an OS crash or forced termination, check for surviving processes before
restarting. Never delete state to bypass a live lock. The existing pairing CLI can
remove the launcher's PID lock only after its owner has stopped:

```sh
node services/worker-pairing/cli.mjs --directory /absolute/private/launcher --unlock
```

Individual worker locks remain authoritative. Use their documented stopped-process
unlock commands only after verifying those workers are stopped; see the connector,
extraction, CV-analysis and semantic READMEs. Preserve encrypted sessions and
receipts throughout recovery. Normal decommission requires acknowledged Telegram
disconnect before revocation; emergency device revocation stops hosted access but
cannot erase this Mac.

## Verification and limits

`npm test` includes real subprocess lifecycle checks and paired-credential tests
for all three processing CLIs. Python service tests cover explicit model paths and
private token files. The optional test below runs this actual launcher, all four
worker entrypoints and the pinned model against synthetic loopback hosted jobs,
then verifies restart with the same connector identity. No provider or Telegram
account is contacted. It needs the prepared runtimes and local parser image.

```sh
MAC_WORKER_PYTHON=/absolute/path/to/python3.12 \
MAC_WORKER_MODEL_DIRECTORY=/absolute/path/to/pinned-model \
node --test tests/local/mac-worker-runtime.test.js
```

This checkpoint adds local orchestration, not additional hosted capacity. The
current CV-inclusive search limit is12,000 authorized ready passages. The connector
implements new-message synchronization, native account/channel edit and deletion
gap recovery, and eventual retained-ID repair. Its bounded lanes share provider
requests with history and CV retrieval; sleeping Macs and Telegram waits delay
freshness. Missing responses do not prove deletion, and purged source is not
recreated. See the [connector's import and freshness limits](../telegram-connector/README.md#private-history-imports).
Login-at-startup integration and permitted real-account/model acceptance remain
separate work. Enabling the hosted flag for controlled acceptance does not mean
broader rollout or live acceptance is complete; pairing and local dependency
checks alone do not satisfy it.
