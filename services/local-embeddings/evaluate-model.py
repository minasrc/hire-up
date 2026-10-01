"""Offline, synthetic relevance acceptance using the production pinned planner.

No model downloads, hosted database, credentials or network calls. Node22 exports
repository fixtures; existing pinned Python dependencies perform local inference.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

from chunking import chunk_plan, CHUNKER_VERSION, CV_CHUNKER_VERSION
from model_config import INDEX_VERSION, MAX_TOKENS, verify_model_assets

ROOT = Path(__file__).resolve().parent


def fixtures(node):
    script = """
      import assert from 'node:assert/strict';
      import {cvRelevanceProfiles,cvRelevanceQueries} from './tests/fixtures/cv-search-relevance.js';
      import {relevanceProfiles,relevanceQueries,syntheticProjection} from './tests/fixtures/semantic-relevance.js';
      assert.equal(process.versions.node.split('.')[0], '22');
      console.log(JSON.stringify({cv:cvRelevanceProfiles,cvQueries:cvRelevanceQueries,
        profiles:relevanceProfiles.map(p=>({...p,text:syntheticProjection(p)})),queries:relevanceQueries}));
    """
    output = subprocess.run([node, "--input-type=module", "-e", script], cwd=ROOT.parents[1],
                            check=True, capture_output=True, text=True, timeout=30)
    return json.loads(output.stdout)


def evaluate(model, profiles, queries, chunker_version):
    started = time.monotonic()
    chunks = []
    for profile in profiles:
        source = profile["text"]
        plan = chunk_plan(source, model.tokenizer, chunker_version)
        raw = source.encode()
        pieces = [raw[c["start_byte"]:c["end_byte"]].decode() for c in plan["chunks"]]
        assert "".join(pieces) == source
        assert all(c["token_count"] <= MAX_TOKENS for c in plan["chunks"])
        chunks.append(pieces)
    unique = list(dict.fromkeys(piece for pieces in chunks for piece in pieces))
    vectors = model.encode(unique, batch_size=8, normalize_embeddings=True,
                           show_progress_bar=False, convert_to_numpy=True)
    positions = {text: i for i, text in enumerate(unique)}
    assert all(len(model.tokenizer(q["query"], truncation=False)["input_ids"]) <= MAX_TOKENS for q in queries)
    query_vectors = model.encode([q["query"] for q in queries], batch_size=8,
                                 normalize_embeddings=True, show_progress_bar=False, convert_to_numpy=True)
    rows, tail_hits, tail_total = [], 0, 0
    for query, vector in zip(queries, query_vectors):
        similarities = vectors @ vector
        scores = [max(similarities[positions[piece]] for piece in pieces) for pieces in chunks]
        order = sorted(range(len(profiles)), key=lambda i: (-float(scores[i]), profiles[i]["key"]))
        keys = [profiles[i]["key"] for i in order]
        relevant, top = set(query["relevantKeys"]), set(keys[:10])
        first = next(i for i, key in enumerate(keys) if key in relevant)
        for profile in profiles:
            if profile["key"] in relevant and profile.get("position") == "end":
                tail_total += 1
                tail_hits += profile["key"] in top
        rows.append({"id": query["id"], "recallAt10": len(top & relevant) / len(relevant),
                     "reciprocalRank": 1 / (first + 1)})
    result = {"chunkerVersion": chunker_version, "profiles": len(profiles), "queries": len(queries),
              "recallAt10": sum(r["recallAt10"] for r in rows) / len(rows),
              "mrr": sum(r["reciprocalRank"] for r in rows) / len(rows),
              "tailRecallAt10": tail_hits / tail_total if tail_total else None,
              "chunks": sum(map(len, chunks)), "maxChunks": max(map(len, chunks)),
              "uniqueSyntheticPassages": len(unique), "seconds": time.monotonic() - started,
              "cases": rows}
    assert result["recallAt10"] >= 0.85, result
    assert result["mrr"] >= 0.8, result
    if tail_total:
        assert result["tailRecallAt10"] >= 0.85, result
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=ROOT / ".runtime/model")
    parser.add_argument("--node", default=os.environ.get("EMBEDDING_NODE", "node"))
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    verify_model_assets(args.model_dir)
    import torch
    from sentence_transformers import SentenceTransformer
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    model = SentenceTransformer(str(args.model_dir), device="cpu", local_files_only=True,
                                trust_remote_code=False, model_kwargs={"use_safetensors": True})
    assert model.get_embedding_dimension() == 384 and model.max_seq_length == MAX_TOKENS
    data = fixtures(args.node)
    report = {"syntheticOnly": True, "indexVersion": INDEX_VERSION,
              "note": "Repeated synthetic passages are deduplicated for inference only; timing is not a production throughput estimate.",
              "profile": evaluate(model, data["profiles"], data["queries"], CHUNKER_VERSION),
              "cv": evaluate(model, data["cv"], data["cvQueries"], CV_CHUNKER_VERSION)}
    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({**report, "profile": {k: v for k, v in report["profile"].items() if k != "cases"},
                     "cv": {k: v for k, v in report["cv"].items() if k != "cases"}}, indent=2))


if __name__ == "__main__":
    main()
