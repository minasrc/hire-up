# Telegram extraction context evaluation

This harness prepares a bounded, synthetic evaluation of the opt-in v2 extraction contract. It defaults to offline validation and does not read credentials or call Telegram, a model provider, hosted worker endpoints, or a database. Passing the offline checks establishes fixture/schema/scorer behavior, not model quality. Actual provider use and model acceptance remain explicit operator actions; the v2 context feature should stay disabled until the operator accepts both additional provider disclosure and observed model behavior.

Run under Node22 after the v2 API/worker checkpoint is present:

```sh
node tests/evals/telegram-context/run.mjs
node --test tests/evals/telegram-context/harness.test.mjs
```

Both commands use the production v2 validator from the checkout. `V2_CHECKPOINT_REQUIRED` means the v2 checkpoint is not integrated. For a separate local implementation checkout, pass `--implementation-root /absolute/checkout` to the runner or set `TELEGRAM_CONTEXT_EVAL_IMPLEMENTATION_ROOT=/absolute/checkout` for the focused test command. The harness never changes that checkout. `--output /absolute/new/report.json` writes a new mode 0600 report and refuses to overwrite an existing file. The same report is printed to stdout; tokens, credential paths, raw rejected model output and provider error bodies are never printed.

Nine fixture cases cover generic replies to a different author, all nine explicitly stated primary fields, negation, forwarded original authors, ambiguous reply identity, unresolved contradiction, multilingual accented text, missing reply context and context prompt injection. All names, messages and `.test` email/URL identifiers are synthetic. Primary and context bodies use the exact v2 shape: `source.chat`, extraction targets in `source.messages`, and full original bodies in `source.contextOnly`. Quotes, identity references and attachment references are primary-only. Fixture cases remain within the ordinary 40-message/48 KiB envelope and eight-context/8 KiB envelope. The harness contains no account login, source import, embeddings, enrichment or corpus reconstruction.

For an explicitly authorized synthetic-provider evaluation, use the already configured extraction worker's private configuration and token file. Do not create a second provider setup or put credentials in CLI arguments. Create a mode 0600 JSON data policy outside the repository with these exact keys and values, matching the normalized configured provider URL/model:

```json
{
  "environment": "nonproduction",
  "permittedData": ["synthetic"],
  "providerBaseUrl": "https://your-configured-provider.example/v1",
  "providerModel": "your-configured-model",
  "maxProviderCalls": 9
}
```

The file declares permission to send these synthetic fixtures to that configured provider; it does not authorize real private data. The runner rejects production `NODE_ENV`, missing or extra policy fields, alternate provider/model targets, other data classes, or a different call bound. Configuration and policy files must satisfy the existing private-file reader (regular file owned by the current user, no symlink, no group/world permissions). The existing worker configuration can still contain hosted-worker credentials, but the evaluation only reads its provider token and never uses a hosted-worker token.

```sh
node tests/evals/telegram-context/run.mjs --provider \
  --worker-config /absolute/private/extraction-worker.json \
  --data-policy /absolute/private/context-evaluation-policy.json \
  --output /absolute/private/new-context-evaluation-report.json
```

Provider mode uses the production `extractionRequest` builder and bounded production transport against the configured `/chat/completions` endpoint. It makes exactly one attempt for each of the nine fixed cases, serially, with no automatic retries, a 60-second request timeout, 128 KiB request limit and 256 KiB response limit. Failed or malformed responses are marked `not_measured`; their contents do not enter the report. The runner does not issue extraction completions or apply any candidate changes.

The report separates these checks:

| Check | Meaning and limit |
| --- | --- |
| `contractAccepted` | Production schema, normalization and primary-reference validation accepted the result. This does not establish semantic truth. |
| `referenceChecked`, `invalidReference` | Exact primary quote/identity/attachment references were checked; context-only and missing message references fail. |
| `valueChecked`, `unsupportedLiteralValue` | Values must occur literally at v2 Unicode alphanumeric boundaries in a valid cited primary quote. |
| `unsupportedValue` | A proposed value is absent from that case's curated semantic allowlist. Negated or unresolved-conflict values can fail here despite valid quotes. The allowlist is intentionally narrow and is not a general factual-truth evaluator. |
| `identityChecked`, `identityAttribution` | Non-null identities must match that case's allowed candidate email or primary self-description. A sender quote must include the explicit self-description, rather than only a name/location substring. This tests these examples, not universal authorship inference. |
| `missingExpectedFacts` | Required explicitly stated fixture values are absent. Empty output cannot pass unnoticed by producing no unsupported facts. This is limited fixture coverage, not general recall. |
| `scoringTruncated` | Raw model arrays exceed schema bounds; assessment is bounded and cannot be treated as complete. |
| `reviewableResult`, `humanReview` | Structurally accepted, primary-quoted synthetic output and case-specific review questions. Rejected raw outputs remain absent to avoid logging arbitrary provider text. |

No overall accuracy threshold or automatic model acceptance is asserted. A human should inspect the accepted proposals, omissions, negation, ambiguity, contradictions, forwarded attribution and injection behavior. Zero measured violations on nine synthetic cases does not establish performance on representative private chats, historical gaps, multilingual variations, mixed candidates, or longer conversations. Any representative private-data evaluation requires its own explicit disclosure/data authorization and is outside this synthetic harness.
