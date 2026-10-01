# Synthetic model comparison

These measurements use the unchanged repository fixtures:100 original profiles/40 English-Spanish queries and100 CV-only profiles/40 queries. CV role/location/pay facts appear only in the CV, including60 English/40 Spanish descriptions and a64,861-byte Unicode CV with relevant facts after byte64,542. Judgments and acceptance thresholds stayed fixed. Max-score retrieval includes every passage and returns one hit per profile; no keyword fallback or corpus-specific score adjustment is used.

| Model and planner | CV Recall@10 | CV MRR | CV tail recall |
| --- | ---: | ---: | ---: |
| Pinned E5, original448-token hosted pipeline |0.615|0.806|0.488|
| Same E5,192-token partitions (offline) |0.685|0.932|0.600|
| Same E5, exact paragraphs (offline) |0.685|0.957|0.638|
| Same E5, exact sentences (offline) |0.695|0.963|0.675|
| Same E5, coherent lines (offline) |0.745|0.981|0.713|
| MiniLM,128-token coherent lines/adaptive256 (offline) |0.975|0.951|0.975|

The old E5 pin was `intfloat/multilingual-e5-small@614241f622f53c4eeff9890bdc4f31cfecc418b3`, with query/passage prefixes. The chosen model is `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42`, with no prefixes, mean pooling, L2 normalization and384 dimensions. Its native128-token limit is enforced before inference, including special tokens.

The chosen token-packed profile planner separately scored0.975 Recall@10 and0.975 MRR on the original100-profile/40-query fixture, retaining one chunk per fixture profile. CV indexing covered all506,171 source bytes in2,230 chunks, at most256 per CV. Exact coherent lines improved retrieval while separating preferences from experience; adjacent packing handles the longest source without dropping bytes.

The primary [model card](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2) documents the Apache-2.0 license,384-dimensional outputs and128-token architecture. The public safetensors file is470,641,600bytes; the downloaded allowlisted runtime assets total approximately485MB. No Hugging Face credential or remote Python code is used.

Reproduce chosen-model results with `evaluate-model.py` against the exact local pinned assets. It uses the production planners, checks full UTF-8 coverage and both relevance gates, and can save per-query results. The offline comparison deduplicates identical synthetic passage inference for speed; it does not omit passages from ranking. Its elapsed time is therefore not a production throughput estimate. The actual hosted/runtime test additionally checks permission parity, component grouping and pagination; capacity is measured separately under concurrent database load.

These are synthetic ranking checks, not proof of universal recruiting relevance, OCR coverage, or exact satisfaction of numerical/negative constraints. Relevant analytics variants remained a weak case in the selected model. No model changes should reuse vectors from the old namespace.
