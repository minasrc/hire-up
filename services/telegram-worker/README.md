# Outbound embedding worker foundation

This manually started Node 22 process claims embedding jobs from the app and sends
them to the existing Mac service at `http://127.0.0.1:8817`. It opens no listener.
This checkpoint includes no Telegram calls, extraction, production configuration,
login item, tunnel, or hosted deployment. The app's queue endpoints and scoped
worker credential must already be configured independently.

Start the local embedding service using its own setup instructions. Create a
private JSON configuration file outside the repository:

```json
{
  "serverUrl": "https://your-app.example",
  "workerTokenFile": "/absolute/private/path/worker-token",
  "embeddingTokenFile": "/absolute/path/to/local-embeddings/.runtime/token"
}
```

Token files must be readable only by their owner (`chmod 600`), contain one
32–4096 character bearer token, and stay outside source control. The worker token
is only for the claim/complete/fail endpoints: do not supply database, storage,
session, bot, or service-role credentials. The embedding token stays on loopback.
If omitted, `embeddingTokenFile` defaults to
`services/local-embeddings/.runtime/token` relative to this code; set it explicitly
if that service has moved. Relative configuration paths resolve against the JSON
file's directory.

```sh
node services/telegram-worker/run.mjs --config /absolute/private/path/worker.json --once
node services/telegram-worker/run.mjs --config /absolute/private/path/worker.json
```

Environment overrides are `TELEGRAM_WORKER_SERVER_URL`,
`TELEGRAM_WORKER_TOKEN_FILE`, and `TELEGRAM_WORKER_EMBEDDING_TOKEN_FILE`.
No raw token environment variable is supported. A local synthetic development
server can use `http://127.0.0.1:<port>` with
`"allowInsecureLocalhost": true` or
`TELEGRAM_WORKER_ALLOW_INSECURE_LOCALHOST=1`; the exception only permits literal
loopback hosts and `localhost`. Server URLs must be origins without path, query,
fragment, or credentials. All requests refuse redirects.

The worker keeps texts and vectors in memory only and prints fixed status codes,
never job identifiers, payloads, tokens, response bodies, or exception messages.
Each API request times out after 10 seconds; inference times out after 45 seconds.
Polling uses jittered backoff up to 30 seconds. Completion/failure acknowledgments
retry at most three times with the same lease. An uncertain completion never
becomes a failure report; unacknowledged work is left for the server's lease
recovery. A 409 drops the expired lease. Ctrl-C aborts active requests and polling;
unfinished work also recovers through the server lease. `--once` executes one
claim cycle and exits nonzero when it cannot complete/idle successfully.

Only `intfloat/multilingual-e5-small` at the pinned index version in `worker.mjs`
is accepted. Input batches respect the local service's 32-input and 128 KiB
limits. Returned vectors must be finite, normalized (norm tolerance 0.001),
384-dimensional, indexed uniquely, and tagged with the exact model identity.
The local service enforces its own 512-token input limit; oversized inputs are
reported as `INVALID_JOB` without including text. No silent truncation occurs.

Run the bounded synthetic unit tests with Node 22:

```sh
node --test tests/unit/telegram-worker.test.js
```
