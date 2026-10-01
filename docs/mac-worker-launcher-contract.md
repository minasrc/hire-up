# Mac launcher checkpoint

One foreground command starts the four existing outbound workers and an owned
loopback embedding service. Ctrl-C stops only its own children and preserves all
sessions and pending receipts. No login item, public listener, proxy installation,
account authentication, or implicit download is part of startup. Dependency setup
is explicit in the runbook. Failed children stop the group with a fixed error;
restart is explicit using the same configuration and state directories.

The private launcher JSON is version 1, with `credentialFile`, `runtimeDirectory`,
`stateDirectories` (`connector`, `extraction`, `cvAnalysis`, `semantic`),
`telegram` (`apiId`, `apiHash`), `provider` (`baseUrl`, `model`, `tokenFile`), and
`embedding` (`python`, `modelDirectory`, `tokenFile`, `port`). All paths resolve
beside the config. Provider and embedding tokens remain in their original files;
the paired token is never copied. State directories are explicit and distinct.
The supervisor generates temporary private per-service configuration files,
uses the current checkout and Node 22, and removes only its generated files.
It never moves or changes existing vault namespaces.

Commands: `node services/mac-worker/cli.mjs check --config /private/mac.json`
and `node services/mac-worker/cli.mjs start --config /private/mac.json`.
Check validates configuration, installed runtime/dependencies, local Docker and
parser image, and the local model assets; no hosted jobs or real provider calls.
Start additionally refuses any occupied embedding port, starts its own model,
verifies exact model/index/chunkers through bounded authenticated loopback
inference, then starts workers. Output distinguishes dependency checks and process
running from actual hosted/Telegram/provider readiness; browser status remains the
authority for connection/import/review. Child output is suppressed rather than
forwarding arbitrary diagnostics or secrets. No automatic service restart loop.

Shared credential change (worker adapter owner): extraction, CV-analysis and
semantic config accept optional `credentialFile` / their respective
`*_CREDENTIAL_FILE` environment variable. This can supply server origin and token.
Legacy serverUrl/workerTokenFile still work. If both are supplied, origins and
tokens must match. Read the paired file with the existing private credential
validator, preserve the original token and origin for the process, and recheck
identity before each hosted request. Renewal metadata changes are allowed;
replacement token/worker UUID/origin changes stop with a fixed credential error.
No store/vault scope changes. Connector already supports this file format.

Embedding change (model adapter owner): `service.py` accepts explicit
`LOCAL_EMBEDDINGS_MODEL_DIRECTORY` and `LOCAL_EMBEDDINGS_TOKEN_FILE`, retaining
existing defaults. Token requires an owner-only regular nonsymlink file and private
parent; model assets may be shared read-only and still pass exact revision checks.
`LOCAL_EMBEDDINGS_PORT` remains loopback only. Foreground service does not use
`control.py` or touch another runtime's PID/log files. No changes to preparation,
downloads or legacy detached control are needed for this checkpoint.

Ownership: root owns launcher/config/lifecycle, documentation and real subprocess
acceptance; worker adapter owns three existing worker configs/CLIs and shared
credential helper/tests; model adapter owns service.py and focused Python tests.
No hosted schema, UI, performance or other task files are changed.
