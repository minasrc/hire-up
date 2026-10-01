# Private CV analysis worker

This outbound Mac worker retrieves one scoped, validated CV from the platform, parses it in a credential-free Docker container, then submits evidence-backed profile suggestions through the configured OpenAI-compatible provider. A recruiter reviews the draft and CV before approval. Images are not OCRed, and the original document remains necessary for review. This service does not index approved CV text in semantic search.

Use Node22 and a **local** Docker Engine/Desktop. The service refuses remote Docker endpoints. It shares no database, storage or Telegram session credentials with the parser. Keep the existing connector/extraction/search services running separately; this worker has its own process lock and encrypted pending queue.

## Setup

From the repository root:

```sh
npm ci --prefix services/cv-analysis-worker --ignore-scripts
docker build -t agora-cv-parser:v1 services/cv-analysis-worker
node services/cv-analysis-worker/cli.mjs --config /absolute/private/cv-analysis.json
```

Create the configuration and token files locally with mode0600 in a mode0700 directory. The worker token is an existing owner-scoped platform worker token with the required candidate/document permissions. Provider credentials are read from a separate private file; this supports the approved temporary local proxy without installing or authenticating that proxy. No endpoint or token is configured implicitly.

```json
{
  "serverUrl": "https://your-platform.example",
  "workerTokenFile": "/absolute/private/worker.token",
  "providerBaseUrl": "http://127.0.0.1:8317/v1",
  "providerModel": "your-configured-model",
  "providerTokenFile": "/absolute/private/provider.token",
  "stateDirectory": "/absolute/private/cv-analysis-state",
  "parserImage": "agora-cv-parser:v1"
}
```

Each setting supports the corresponding `CV_ANALYSIS_SERVER_URL`, `CV_ANALYSIS_WORKER_TOKEN_FILE`, `CV_ANALYSIS_PROVIDER_BASE_URL`, `CV_ANALYSIS_PROVIDER_MODEL`, `CV_ANALYSIS_PROVIDER_TOKEN_FILE`, `CV_ANALYSIS_STATE_DIRECTORY` or `CV_ANALYSIS_PARSER_IMAGE` environment variable. Prefer private files for credentials. `--once` processes/replays one stage; `--unlock` removes only a verified stopped-process lock. A401/403 stops the service. Restart after permissions/configuration are corrected. Credential rotation uses a new encrypted queue scope, so drain uncertain receipts before rotating where possible.

## Boundaries and provenance

Parser dependencies are exactly PDF.js6.2.108 and xmldom0.8.15, recorded in `package-lock.json`; parser version is `pdfjs-6.2.108-docx-xml-0.8.15-v1`. The Docker base pins Node22.21.1 by multi-platform manifest digest. PDF.js6.2.108 includes the fix for GHSA-hq66-cqwq-w95j; the parser uses only core text APIs and never initializes viewer scripting.

The container has no network, host mounts, supplied environment credentials or capabilities. Its root filesystem is read-only; it runs as uid65534 with512MiB memory/no swap,1CPU,64PIDs,32MiB temporary tmpfs and a45second wall deadline. The parent bounds stdout to1MiB, suppresses library diagnostics, and removes the named container on completion/cancellation. CV bytes travel over stdin and are never written to plaintext disk by the parent.

Files are limited to4MiB, PDFs to50pages, DOCX to2000paragraph blocks and256 ZIP entries. ZIP validation checks names, paths, encryption flags, declared and actual inflation, overlapping entries and CRC; aggregate expansion is32MiB and an individual entry16MiB. XML entities/DOCTYPE, external header/footer references, embedded objects and unsupported alternate content fail explicitly. Hyperlink targets are never fetched. DOCX extraction covers body/table paragraphs, referenced headers/footers and referenced footnotes/endnotes; deleted tracked text, separator notes and unreferenced parts are excluded. Other images are not OCRed.

Blocks preserve page or part/paragraph coordinates, genuine empty blocks, Unicode and line breaks. Every block and the complete text joined by two LF characters is hashed. The complete joined text must fit64KiBUTF8; there is no truncation. PDF image-only pages, including mixed text/scanned documents, fail `OCR_REQUIRED`. Encrypted, malformed and over-limit inputs have fixed safe codes.

Each parse/facts completion is encrypted with AES-GCM and saved atomically before submission. The queue is isolated by platform origin, token and CV namespace. Matching receipt retries precede new claims; a lost ACK never re-runs an already produced parser/model result. Fenced409 responses clear stale pending work; uncertain5xx responses preserve it. Hosted validation independently checks document identity, hashes, exact UTF8 evidence and current permissions/revision before accepting any facts.

## Verification

```sh
node --test tests/unit/cv-analysis-worker.test.js
CV_PARSER_DOCKER=1 node --test tests/database/cv-analysis-parser.test.js
```

The first command uses injected adapters and synthetic loopback HTTP only. The second requires the installed service dependencies and built image, covering real PDF/DOCX extraction and Docker roundtrips. No live Telegram account or model provider is contacted. Root integration tests additionally exercise real platform jobs, CV replacement fences, human review and approval.
