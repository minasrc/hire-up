# Private Telegram extraction worker

This Node 22 process claims imported message batches from the hosted platform,
asks an explicitly configured OpenAI-compatible Chat Completions provider for
candidate facts, validates every result against the shared schema and quotations,
and submits private draft proposals. It runs independently of the Telegram
connection worker; it does not need Telegram API keys, a Telegram session,
database credentials, storage credentials or an inbound port.

The provider receives private imported text and public attachment metadata.
Configure a provider you intend to process that data. No endpoint, model or key is
chosen automatically. An already configured local CLIProxyAPI endpoint can be
used for the demonstration; this service does not install it, authenticate a
browser account, or bypass its access controls. The endpoint must support
`/chat/completions` and strict `response_format: json_schema`. Unsupported output,
refusals, truncated output and failed requests become explicit job failures; there
is no keyword or guessed-fact fallback.

## Setup

Use the checkout containing the hosted extraction contract and Node 22. This
service uses Node built-ins and existing shared source modules, with no additional
package installation. Save configuration and credentials outside source control.
Make the parent directory private (`chmod 700`) and all three files below private
(`chmod 600`). Each token file contains only its token, optionally followed by a
newline. The hosted worker token must belong to the recruiter who owns the jobs.

Example private configuration (replace the illustrative values):

```json
{
  "serverUrl": "https://your-platform.example",
  "workerTokenFile": "./platform-worker.token",
  "providerBaseUrl": "http://127.0.0.1:8317/v1",
  "providerModel": "codex-dev",
  "providerTokenFile": "./provider.token",
  "stateDirectory": "./extraction-state"
}
```

Paths in a configuration file resolve relative to that file. HTTPS is required
except for literal loopback HTTP. Redirects, URL credentials and URL query strings
are rejected. Model identifiers are bounded and cannot contain URLs. Run:

```sh
node services/telegram-extraction-worker/cli.mjs --config /absolute/private/extraction.private.json
```

`--once` processes one batch or pending acknowledgement and exits. `--help` does
not read configuration or contact a provider. A private process lock prevents two
workers using the same state directory. After a crash, `--unlock` removes a stale
lock only when its recorded process no longer exists; then start normally.

Environment overrides are `TELEGRAM_EXTRACTION_SERVER_URL`,
`TELEGRAM_EXTRACTION_WORKER_TOKEN_FILE`, `TELEGRAM_EXTRACTION_PROVIDER_BASE_URL`,
`TELEGRAM_EXTRACTION_PROVIDER_MODEL`, `TELEGRAM_EXTRACTION_PROVIDER_TOKEN_FILE`
and `TELEGRAM_EXTRACTION_STATE_DIRECTORY`. Tokens themselves are accepted only
from private files. Restart after changing hosted credentials. Token rotation
creates a separate encrypted local queue scope; old private state can be removed
once its former jobs have been reconciled on the platform.

## Recovery and bounds

- One model request at a time. Each job has at most 40 messages / 48 KiB of source,
  a 180-second host lease, a 60-second provider timeout and a 10-second host timeout.
  A claimed lease must retain at least 75 seconds before generation starts.
- Provider responses are bounded to 256 KiB; completion submissions to 128 KiB.
  Provider output is limited to 8192 tokens. No message text, prompts, generated
  facts, tokens, endpoint URLs or raw error bodies are logged.
- Exact completion and failure submissions are encrypted on disk before posting.
  Network errors and ambiguous responses retain them for retry across restarts.
  An acknowledged receipt clears the local queue. A definitive lease conflict
  preserves hosted truth and allows the next claim. Invalid completion requests
  become explicit validation failures without repeatedly regenerating results.
- State uses the connector's tested AES-256-GCM vault, scoped to hosted origin and
  a digest of the hosted worker credential, with directory mode 0700 and file mode
  0600. Keep the state directory on private local storage. The shared vault creates
  its encryption identity locally; extraction does not publish its RSA public key.
- Hosted errors back off to 30 seconds. Provider failures are reported to the
  hosted job scheduler for bounded retry. Revoked hosted credentials stop the
  worker. Ctrl-C/SIGTERM cancels requests and releases the process lock.

## Review boundary and tests

Facts need exact source quotations. Names and email addresses must occur in those
quotations; sender names alone do not establish candidate names. The prompt treats
messages as untrusted data and distinguishes candidate self-description from job
requirements and forwarded material. This does not prove semantic truth: the
recruiter must review the private draft and any conflicting proposals.

Attachment references are metadata only. This checkpoint does not download CVs,
extract attachment text, delete source messages, or implement semantic search.
Recruiters upload a CV and fill required candidate fields before approval; only
approved records become shared.

Run synthetic tests without contacting a provider or Telegram:

```sh
node --test tests/unit/telegram-extraction-worker*.test.js
```

The tests cover request shape, injection boundaries, evidence validation, fixed
errors, timeout/cancellation, lost acknowledgement recovery, lease conflicts,
failure-only replay, private file permissions and encrypted restart isolation.
