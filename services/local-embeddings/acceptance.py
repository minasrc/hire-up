"""Optional real-model UTF-8 coverage and scheduling benchmark; synthetic data only."""
import concurrent.futures
import json
import os
from hashlib import sha256
from pathlib import Path
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
BASE = os.environ.get("EMBEDDING_ACCEPTANCE_URL", "http://127.0.0.1:8818")
TOKEN = Path(os.environ.get("EMBEDDING_ACCEPTANCE_TOKEN_FILE", str(ROOT / ".runtime" / "token"))).read_text().strip()
from model_config import MODEL_ID as MODEL
from chunking import CHUNKER_VERSION


def post(path, body):
    request = Request(BASE + path, data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    start = time.perf_counter()
    with urlopen(request, timeout=60) as response:
        result = json.load(response)
    return result, round((time.perf_counter() - start) * 1000, 1)


def main():
    source = ("工程师开发智能合约和分布式系统。Résumé 👩🏽‍💻 é，" * 1000).encode()[:65000].decode("utf8", errors="ignore")
    body = {"model": MODEL, "chunker_version": CHUNKER_VERSION, "text": source}
    plan, plan_ms = post("/v1/chunk-plan", body)
    raw = source.encode()
    chunks, cursor = [], 0
    for ordinal, chunk in enumerate(plan["chunks"]):
        assert chunk["ordinal"] == ordinal and chunk["start_byte"] == cursor
        piece = raw[cursor:chunk["end_byte"]]
        assert sha256(piece).hexdigest() == chunk["sha256"] and chunk["token_count"] <= 128
        chunks.append(piece.decode())
        cursor = chunk["end_byte"]
    assert cursor == len(raw) == plan["byte_length"]
    assert plan["source_sha256"] == sha256(raw).hexdigest()
    _, encode_ms = post("/v1/embeddings", {"model": MODEL, "input": chunks[:8], "input_type": "passage"})
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(post, "/v1/embeddings", {"model": MODEL, "input": chunks[:24], "input_type": "passage"})
        time.sleep(.02)
        _, query_ms = post("/v1/embeddings", {"model": MODEL, "input": "smart contract developer", "input_type": "query"})
        _, backlog_ms = pending.result()
        pending = pool.submit(post, "/v1/chunk-plan", body)
        time.sleep(.005)
        _, plan_query_ms = post("/v1/embeddings", {"model": MODEL, "input": "senior software engineer", "input_type": "query"})
        pending.result()
    print(json.dumps({"source_bytes": len(raw), "chunks": len(chunks), "max_tokens": max(c["token_count"] for c in plan["chunks"]), "plan_ms": plan_ms, "eight_passages_ms": encode_ms, "query_under_backlog_ms": query_ms, "backlog_ms": backlog_ms, "query_during_plan_ms": plan_query_ms}))


if __name__ == "__main__":
    main()
