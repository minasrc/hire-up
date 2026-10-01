# Local embeddings for the recruiting demo

Runs `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` on this Mac with no embedding-provider API account. The service creates vectors only: it does not fetch Telegram data, extract candidate fields, store a search index, or connect the hosted app to the Mac. The outbound `../semantic-worker/` process supplies scoped profile indexing and query jobs; the hosted app stores the search index.

The model revision and preprocessing identity are pinned in `model_config.py`. All vectors are normalized, 384-dimensional, and tagged with `index_version`. A consuming index must store this identity and reject mismatched query vectors. Switching models or preprocessing requires reindexing; moving this exact service to another host does not.

## Setup and operation

Use Python 3.12 and run commands from this directory. `requirements.lock` pins the dependency versions tested on Apple Silicon. No global Python environment is changed.

```sh
EMBEDDING_PYTHON=/path/to/python3.12 sh setup.sh
.venv/bin/python control.py start
.venv/bin/python control.py status
.venv/bin/python benchmark.py
.venv/bin/python control.py stop
```

Setup downloads the public model and generates a private token in `.runtime/token`. It never asks for a Hugging Face account or reads an existing Hugging Face token. Runtime loads local safetensors only, with remote code and downloads disabled. Do not commit, print, or expose the token. Both the virtual environment and runtime directory are ignored by Git.

The service runs detached until stopped or the Mac shuts down. It does not install a login item or prevent sleep. Restart it after reboot with `control.py start`. The Mac must remain awake and online for a future hosted demo that depends on it. Indexing jobs retry after interruptions. Semantic search displays worker availability and incomplete coverage explicitly; keyword search remains a separate mode, never a silent semantic fallback.

## HTTP contract

Base URL: `http://127.0.0.1:8817`. `GET /health` reports readiness and model identity without a credential. `POST /v1/embeddings` requires `Authorization: Bearer <contents of .runtime/token>` and `Content-Type: application/json`.

```json
{
  "model": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
  "input": ["Solidity engineer experienced in Ethereum protocols"],
  "input_type": "passage",
  "encoding_format": "float"
}
```

Use `input_type: "query"` for search queries and `"passage"` for profile chunks. Send raw text without adding prefixes; the service sends both kinds without prefixes; input_type controls scheduling. This is an OpenAI-style response envelope with an explicitly required input type, not a drop-in implementation of every OpenAI API option.

Successful responses contain `data[].embedding`, `data[].index`, `model`, `index_version` and token usage. Callers must preserve input order and scope vectors by organization, private owner/approved visibility, and source version. Embeddings are private derived data and must be deleted with their sources. Recheck authorization before returning search results.

Limits: 32 inputs per request, 128 KiB request body, and 128 tokens per input including special tokens. Long inputs return `422 INPUT_TOO_LONG` with indexes; callers must split them. There is no silent truncation. The bounded queue accepts at most16 requests/128 inputs; a full queue returns `429` with `Retry-After`, and failures return `503`. One model thread uses two CPU threads and inference batches of at most8. Urgent queries run before the remaining passage batches; after8 query batches one waiting passage gets a turn. Cancelled queued work never runs; active cancelled inference finishes safely and discards its result. Use a durable hosted queue with bounded retries.

## Hosted connection boundary

The listener is loopback-only, browser requests are rejected, and request access logging is disabled. Inputs, vectors and credentials are not written by the service. The private runtime log contains startup diagnostics only; the benchmark report contains synthetic checks.

Do not expose this port directly or place its token in frontend code. The implemented outbound semantic worker uses scoped hosted jobs, never a public model tunnel or a database credential. No tunnel, production connection, or real candidate processing is configured by this service setup.

## Verification

```sh
.venv/bin/python -m unittest discover -p 'test_*.py' -v
.venv/bin/python benchmark.py
```

Unit tests exercise authentication, browser/host restrictions, validation, input redaction, request limits, concurrency and recovery. The live benchmark exercises real model inference through HTTP, normalized vectors, paraphrase and Spanish retrieval, timing, and rejection of oversized token inputs. These small synthetic checks are smoke tests, not evidence of production search accuracy or full-history capacity.

Model reference: https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 (Apache-2.0 license).

## Exact profile and CV chunk plans

`POST /v1/chunk-plan` uses the same authentication boundary. Send `{ "model": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", "chunker_version": "minilm-utf8-128-v1", "text": "exact hosted projection" }`. Text is nonblank and at most65,536 UTF-8 bytes; the JSON envelope is bounded to1MiB for escaping. The response contains `index_version`, `chunker_version`, `source_sha256`, `byte_length`, and `chunks` with `ordinal`, `start_byte`, `end_byte`, `sha256`, `token_count`.

Ranges are contiguous, nonoverlapping, zero-based half-open UTF-8 byte offsets in the exact original text. No normalization, trimming or prefixes change source bytes. Each slice is independently checked with the pinned tokenizer and special tokens. Each chunk is at most128 tokens/16,384 UTF-8 bytes/16,000 codepoints, and the manifest has at most256 chunks. The entire source must be covered. Unrepresentable token/byte budgets fail explicitly instead of truncating; codepoint boundaries may split grapheme clusters without changing source bytes.

Use `minilm-utf8-128-v1` for profile projections: short profiles remain one chunk; long profiles prefer nearby sentence boundaries within the token budget. Use `minilm-cv-lines-128-v1` for CV projections: retain coherent lines and paragraph separators, splitting long lines within the same bounds. If a CV has more than256 slices, a bounded heap merges the shortest adjacent pairs that still fit. A complete token-packed fallback handles fragmentation; if the full source still cannot fit, it returns an explicit error. Claim and completion versions bind the selected planner to the profile or CV component.

For an isolated upgraded service, prepare a separate checkout/runtime and token, then set `LOCAL_EMBEDDINGS_PORT=8818` on every `control.py` command (the normal default remains8817). Existing model assets can be shared read-only. This does not migrate or stop another checkout's service.

```sh
LOCAL_EMBEDDINGS_PORT=8818 .venv/bin/python control.py start
EMBEDDING_ACCEPTANCE_URL=http://127.0.0.1:8818 .venv/bin/python acceptance.py
LOCAL_EMBEDDINGS_PORT=8818 .venv/bin/python control.py stop
```

`acceptance.py` uses only synthetic data and reports exact Unicode coverage, long-passage throughput and query latency under passage/planning load. It defaults to8818 and this checkout's private token; `EMBEDDING_ACCEPTANCE_TOKEN_FILE` can select another private token file. It is intentionally separate from dependency-light unit discovery and requires an already running, pinned real model. It does not download models or modify a service.

## Coordinated model upgrade and relevance evidence

The model is pinned to `e8f8c211226b894fcb81acc59f3b34ba3efd5f42`, with mean pooling, L2 normalization and no prefixes. The old E5 vectors are incompatible despite also having384 dimensions. Apply the hosted model migration, retire old query caches, reindex all profile/CV projections, and update the outbound worker together. The worker advertises `minilm-v1` and `approved-cv-v1`; an old worker must receive no new-model jobs. Coverage remains incomplete until indexing finishes. Never relabel old vectors or switch only the query model.

Prepare the new model in its own runtime. Its allowlisted public assets occupy approximately485MB; `model.safetensors` is470,641,600bytes. Runtime verifies the pinned download revision for weights/config/tokenizer files and the model's native128-token limit, so accidentally pointing it at the old384-dimensional model fails startup. Read-only asset sharing must preserve the download metadata under `.cache/huggingface/download`.

The unchanged100-profile/40-query and100-CV/40-query English/Spanish fixtures motivated the upgrade. See `model-evaluation.md` for baseline and comparison results. Reproduce the offline production-planner check without network or database access:

```sh
.venv/bin/python evaluate-model.py --node /path/to/node22 --report .runtime/relevance.json
```

This loads local safetensors only and asserts Recall@10>=0.85, MRR>=0.8 and CV tail recall>=0.85. Actual hosted authorization, pagination and capacity checks remain separate acceptance tests. No fixture or threshold is adjusted to make a model pass.
