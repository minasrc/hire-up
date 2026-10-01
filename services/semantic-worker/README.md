# Outbound profile semantic worker

This Node22 process indexes complete, reviewed candidate profiles, approved retained CV text when the owner has documents.download, and the worker owner's private draft profiles. It also embeds that owner's urgent search queries. Hosted PostgreSQL stores scoped vectors and performs the exact search. The Mac needs only a scoped worker token and the local embedding token; it has no database or general storage credentials and requires no Telegram connection.

## Start the demo

1. Start the **updated** local embedding service described in `../local-embeddings/README.md`. Its `/health` must report `chunker_version: minilm-utf8-128-v1`. Existing older8817 instances do not provide the chunk planner; update them during an explicit maintenance step or start this checkout on a separate port and point this worker there. Never stop an unrelated service.
2. Create a private0600 JSON config, separate0600 token files, and a dedicated0700 state directory. An administrator must provision the scoped worker credential through the existing authenticated Telegram worker endpoint; see `../../docs/telegram-connection-release.md`. There is no self-service Mac setup screen yet. The token owner must retain candidate read/write access.

```json
{
  "serverUrl": "https://your-platform.example",
  "workerTokenFile": "/private/demo/profile-worker-token",
  "embeddingUrl": "http://127.0.0.1:8817",
  "embeddingTokenFile": "/private/demo/local-embedding-token",
  "stateDirectory": "/private/demo/semantic-state"
}
```

```sh
node services/semantic-worker/cli.mjs --config /private/demo/profile-worker.json
# One bounded stage, useful for a smoke check:
node services/semantic-worker/cli.mjs --config /private/demo/profile-worker.json --once
```

Equivalent environment variables: `SEMANTIC_SERVER_URL`, `SEMANTIC_WORKER_TOKEN_FILE`, `SEMANTIC_EMBEDDING_URL`, `SEMANTIC_EMBEDDING_TOKEN_FILE`, `SEMANTIC_STATE_DIRECTORY`. Relative config file paths resolve beside the config. The model endpoint accepts only loopback HTTP; production host origins require HTTPS. Never expose the model port or put either credential in frontend code.

Run one semantic process per state directory. Stop with Ctrl-C/SIGTERM. Restart with the same config to retry saved acknowledgements. After a confirmed crash, `--unlock` removes the lock only after checking that its PID is no longer running. Rotation of the hosted token stops the process; the replacement token gets a separate encrypted scope. Keep the local state directory and its encryption identity private and backed up together if pending receipts must survive disk loss.

Use this process for profile semantic search. Do **not** also run the older `services/telegram-worker/run.mjs` legacy embedding queue as an indexer: its old1200-character draft vectors are a different namespace and are never reused here. The Telegram connector and extraction worker remain separate processes for their respective workflows. No perpetual legacy reindexing is scheduled by this worker.

## Bounds and recovery

Each claim offers an urgent query before one index stage: exact UTF-8 chunk plan, then at most8 hosted chunk embeddings. The worker returns to the priority claim after every stage without an artificial indexing delay; idle polling is500ms. Local requests are split further when JSON escaping would exceed128KiB. The local service also prioritizes query inference between at most8 passage inputs. One active model call can finish after cancellation; its cancelled result is discarded. Host job/source revisions and leases fence publication after edits, approval, merge, cancellation or expiry.

All profile bytes must be covered by contiguous, hashed UTF-8 ranges. Each passage has at most128 pinned-tokenizer tokens including special tokens; MiniLM uses no prefixes. The worker verifies hashes, boundaries, dimensions, normalized vectors, pinned index/projection/chunker identities and complete batch order. Long queries fail explicitly. Model outages never return empty success or a keyword-only result labelled semantic.

Inference HTTP calls have60-second deadlines and each job's remaining120-second lease bounds the entire operation (maximum110seconds reserved for local work). Hosted calls have10-second deadlines; completions allow20seconds for the exact hosted search. Requests/responses, local queue admission, retries and error text are bounded. CLI output contains fixed statuses/error codes only, never profile text, query text, vectors or credentials.

Completed acknowledgements and failure reports are atomically saved in the existing AES-GCM private vault before transmission. A lost acknowledgement is replayed before another claim, including after restart or lease expiry; the host checks its committed receipt. A409 discards stale local work. Definite invalid results become explicit failures; uncertain network errors preserve the original receipt. Only encrypted receipts persist on disk; projection/query text is held in memory.

## Tests

```sh
node --test tests/unit/semantic-worker.test.js
```

Synthetic tests cover protocol versions/coverage, malformed or nonnormalized vectors, expired/cancelled work, lost-ACK restart using the real encrypted vault, terminal failures, request-byte packing and credential boundaries. Root's database acceptance additionally exercises the real scoped hosted operations. The optional local service `acceptance.py` measures full65KiB Unicode chunking and query latency during a long-passage backlog against the actual pinned model; the relevance evaluation is separate.

The global model namespace is pinned multilingual MiniLM. Query/profile jobs use `minilm-utf8-128-v1`; CV jobs use `minilm-cv-lines-128-v1` with the same model space and full byte coverage. The claim advertises both `minilm-v1` and `approved-cv-v1`. E5 jobs are rejected even though they also contain384-dimensional vectors; the hosted migration invalidates their receipts and requeues all projections. Use the coordinated model migration described in the local service README. CV document binding and projection/chunker versions are validated before inference. A definitive403 for a CV receipt clears only that local receipt so ordinary profile work continues;401, uncertain network errors and profile403 retain their existing behavior.

## Shared paired credential

Set `credentialFile` in the private configuration, or `SEMANTIC_CREDENTIAL_FILE`,
to the existing pairing `credential.json`. Relative paths resolve beside the
configuration. The file supplies the hosted origin and original worker token;
`serverUrl` and `workerTokenFile` are no longer required in this mode. Legacy
configuration remains supported. If both forms are supplied, origins and tokens
must match. Provider/model credentials remain separate.

The process rechecks the paired origin, token and worker UUID before each hosted
request. Replacement stops with `CREDENTIAL_UNAVAILABLE`; pending encrypted
receipts remain intact. Same-device renewal and display metadata updates are
allowed without changing the original encrypted namespace. Keep using the same
stateDirectory when adopting a paired credential for an existing identity; do not
copy, rotate or regenerate its token merely to start the launcher.
