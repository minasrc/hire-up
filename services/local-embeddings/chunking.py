"""Complete, prefix-free UTF-8 partitions for the pinned MiniLM tokenizer."""
from bisect import bisect_right
from hashlib import sha256
import heapq
import re

from fastapi import HTTPException
from model_config import INDEX_VERSION, MAX_TOKENS

CHUNKER_VERSION = "minilm-utf8-128-v1"
CV_CHUNKER_VERSION = "minilm-cv-lines-128-v1"
MAX_SOURCE_BYTES = 65536
CHUNK_TOKENS = MAX_TOKENS
CHUNK_BYTES = 16384
MAX_CHUNKS = 256


def chunk_plan(text, tokenizer, chunker_version=CHUNKER_VERSION):
    if chunker_version not in (CHUNKER_VERSION, CV_CHUNKER_VERSION):
        raise HTTPException(422, {"code": "INVALID_REQUEST"})
    try:
        encoded = text.encode("utf-8")
    except UnicodeError:
        raise HTTPException(422, {"code": "INVALID_REQUEST"}) from None
    if not text.strip() or len(encoded) > MAX_SOURCE_BYTES:
        raise HTTPException(422, {"code": "SOURCE_TOO_LARGE"})
    byte_offsets = [0]
    for char in text:
        byte_offsets.append(byte_offsets[-1] + len(char.encode("utf-8")))

    def measure(values):
        return [len(ids) for ids in tokenizer(values, truncation=False, padding=False,
                add_special_tokens=True, verbose=False)["input_ids"]]

    def split_span(start, stop):
        value = text[start:stop]
        tokenized = tokenizer(value, truncation=False, padding=False,
                              add_special_tokens=True, return_offsets_mapping=True, verbose=False)
        starts = [start + a for a, b in tokenized["offset_mapping"] if b > a]
        result = []
        while start < stop:
            end = min(stop, start + 16000, bisect_right(byte_offsets, byte_offsets[start] + CHUNK_BYTES) - 1)
            position = bisect_right(starts, start)
            if position + CHUNK_TOKENS - 4 < len(starts):
                end = min(end, starts[position + CHUNK_TOKENS - 4])
            count = measure([text[start:end]])[0]
            while count > CHUNK_TOKENS:
                offsets = tokenizer(text[start:end], truncation=False, padding=False,
                                    add_special_tokens=True, return_offsets_mapping=True, verbose=False)["offset_mapping"]
                boundary = max((a for a, b in offsets[:CHUNK_TOKENS - 1] if b > a), default=0)
                end = min(end - 1, start + boundary) if boundary else start + (end - start) // 2
                if end <= start:
                    raise HTTPException(422, {"code": "INPUT_TOO_LONG"})
                count = measure([text[start:end]])[0]
            if end < stop:
                # Keep complete sentences when a nearby boundary fits; separators
                # stay in the previous chunk and never disappear from the hash.
                boundaries = [m.end() for m in re.finditer(r"[.!?](?:[ \t]+|$)", text[start:end])]
                if boundaries and boundaries[-1] >= (end - start) // 2:
                    proposed = start + boundaries[-1]
                    proposed_count = measure([text[start:proposed]])[0]
                    if proposed_count <= CHUNK_TOKENS:
                        end, count = proposed, proposed_count
            if not text[start:end].strip():
                # Long whitespace-only suffixes cannot be represented as useful
                # nonoverlapping embeddings within the byte/token bounds.
                raise HTTPException(422, {"code": "INPUT_TOO_LONG"})
            result.append((start, end, count))
            start = end
        return result

    # Preserve coherent lines (including paragraph separators). Leading blanks
    # join the first nonblank line; other blank-only lines join their predecessor.
    spans, start = [], 0
    for match in re.finditer(r"(?:\r\n|\r|\n)+", text):
        end = match.end()
        if text[start:end].strip():
            spans.append((start, end)); start = end
        elif spans:
            spans[-1] = (spans[-1][0], end); start = end
    if start < len(text):
        if text[start:].strip() or not spans:
            spans.append((start, len(text)))
        else:
            spans[-1] = (spans[-1][0], len(text))
    if chunker_version == CHUNKER_VERSION:
        spans = [(0, len(text))]
    counts = measure([text[a:b] for a, b in spans])
    pieces = []
    for (a, b), count in zip(spans, counts):
        if count <= CHUNK_TOKENS and b - a <= 16000 and byte_offsets[b] - byte_offsets[a] <= CHUNK_BYTES:
            pieces.append((a, b, count))
        else:
            pieces.extend(split_span(a, b))

    if len(pieces) > MAX_CHUNKS:
        # Adjacent shortest-fit merges preserve useful boundaries where possible.
        # A heap and linked neighbours avoid quadratic rescans for tiny lines.
        nodes = [{"a": a, "b": b, "count": count, "prev": i - 1, "next": i + 1,
                  "version": 0, "alive": True} for i, (a, b, count) in enumerate(pieces)]
        nodes[-1]["next"] = -1
        heap = []

        def offer(indices):
            pairs = []
            for i in indices:
                if i < 0 or not nodes[i]["alive"]:
                    continue
                j = nodes[i]["next"]
                if j < 0:
                    continue
                a, b = nodes[i]["a"], nodes[j]["b"]
                if b - a <= 16000 and byte_offsets[b] - byte_offsets[a] <= CHUNK_BYTES:
                    pairs.append((i, j, a, b))
            for (i, j, a, b), count in zip(pairs, measure([text[a:b] for _, _, a, b in pairs]) if pairs else []):
                if count <= CHUNK_TOKENS:
                    heapq.heappush(heap, (count, a, i, j, nodes[i]["version"], nodes[j]["version"]))

        offer(range(len(nodes)))
        live = len(nodes)
        while live > MAX_CHUNKS and heap:
            count, _, i, j, vi, vj = heapq.heappop(heap)
            left, right = nodes[i], nodes[j]
            if not left["alive"] or not right["alive"] or left["version"] != vi or right["version"] != vj or left["next"] != j:
                continue
            left.update(b=right["b"], count=count, next=right["next"], version=vi + 1)
            right["alive"] = False
            if left["next"] >= 0:
                nodes[left["next"]]["prev"] = i
            live -= 1
            offer([left["prev"], i])
        pieces = [(n["a"], n["b"], n["count"]) for n in nodes if n["alive"]]
        if len(pieces) > MAX_CHUNKS:
            # Fragmentation may prevent pairwise packing despite a valid complete
            # partition. Fall back to full-source bounded sentence cuts, never a
            # partial result or a tokenizer truncation.
            pieces = split_span(0, len(text))
    if len(pieces) > MAX_CHUNKS:
        raise HTTPException(422, {"code": "SOURCE_TOO_LARGE"})
    chunks = [{"ordinal": i, "start_byte": byte_offsets[a], "end_byte": byte_offsets[b],
               "sha256": sha256(encoded[byte_offsets[a]:byte_offsets[b]]).hexdigest(), "token_count": count}
              for i, (a, b, count) in enumerate(pieces)]
    return {"index_version": INDEX_VERSION, "chunker_version": chunker_version,
            "source_sha256": sha256(encoded).hexdigest(), "byte_length": len(encoded), "chunks": chunks}
