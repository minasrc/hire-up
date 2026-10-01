"""Synthetic live HTTP checks; does not read Telegram or platform records."""

import json
import math
import os
import statistics
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from model_config import DIMENSIONS, INDEX_VERSION, MODEL_ID

ROOT = Path(__file__).resolve().parent
TOKEN = (ROOT / ".runtime" / "token").read_text().strip()


def embed(texts, kind):
    body = json.dumps({"model": MODEL_ID, "input": texts, "input_type": kind}).encode()
    request = Request(f"http://127.0.0.1:{int(os.environ.get('LOCAL_EMBEDDINGS_PORT', '8817'))}/v1/embeddings", data=body, headers={
        "Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json",
    })
    started = time.perf_counter()
    with urlopen(request, timeout=60) as response:
        result = json.load(response)
    assert result["index_version"] == INDEX_VERSION
    vectors = [item["embedding"] for item in result["data"]]
    for vector in vectors:
        assert len(vector) == DIMENSIONS and all(math.isfinite(x) for x in vector)
        assert abs(sum(x * x for x in vector) - 1) < 0.0001
    return vectors, (time.perf_counter() - started) * 1000


def main():
    documents = [
        "Maya is a Solidity engineer building Ethereum smart contracts and DeFi protocols. She prefers remote work.",
        "Alex is a product designer working on mobile app interfaces, usability research and Figma prototypes.",
        "Sofia is a Python backend engineer with PostgreSQL and Django experience, based in Madrid.",
        "Luca recruits financial analysts and accountants for investment banks in London.",
        "Nora is a machine learning engineer building recommendation systems and natural language processing models.",
    ]
    queries = [
        ("smart contract developer for decentralized finance", 0),
        ("designing mobile user experiences", 1),
        ("ingeniera de backend con Python en Madrid", 2),
        ("engineer for personalized recommendations and NLP", 4),
    ]
    passages, passage_ms = embed(documents, "passage")
    matches = []
    for text, expected in queries:
        vectors, _ = embed([text], "query")
        scores = [sum(a * b for a, b in zip(vectors[0], passage)) for passage in passages]
        actual = max(range(len(scores)), key=scores.__getitem__)
        matches.append({"expected_document": expected, "actual_document": actual, "passed": actual == expected})
    timings = [embed([queries[i % len(queries)][0]], "query")[1] for i in range(20)]
    _, batch_ms = embed([documents[i % len(documents)] for i in range(32)], "passage")
    try:
        embed(["synthetic " * 800], "passage")
        raise AssertionError("Long input was silently truncated.")
    except HTTPError as error:
        assert error.code == 422
        assert json.load(error)["detail"]["code"] == "INPUT_TOO_LONG"
    report = {
        "index_version": INDEX_VERSION, "synthetic_only": True,
        "retrieval_checks": matches, "checks_passed": sum(x["passed"] for x in matches),
        "checks_total": len(matches), "dimensions": DIMENSIONS,
        "query_median_ms": round(statistics.median(timings), 1),
        "query_p95_ms": round(sorted(timings)[18], 1),
        "five_passages_ms": round(passage_ms, 1), "batch_32_ms": round(batch_ms, 1),
        "long_input_rejected": True,
    }
    (ROOT / ".runtime" / "benchmark.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    assert all(x["passed"] for x in matches), "Synthetic retrieval regression."


if __name__ == "__main__":
    main()
