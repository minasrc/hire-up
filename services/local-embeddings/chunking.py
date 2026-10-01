"""Exact UTF-8 partitions; tokenizer normalization never alters source bytes."""
from bisect import bisect_right
from hashlib import sha256

from fastapi import HTTPException
from model_config import INDEX_VERSION

CHUNKER_VERSION = "e5-utf8-448-v1"
MAX_SOURCE_BYTES = 65536
CHUNK_TOKENS = 448
CHUNK_BYTES = 16384
MAX_CHUNKS = 256


def chunk_plan(text, tokenizer):
    try:
        encoded = text.encode("utf-8")
    except UnicodeError:
        raise HTTPException(422, {"code": "INVALID_REQUEST"}) from None
    if not text.strip() or len(encoded) > MAX_SOURCE_BYTES:
        raise HTTPException(422, {"code": "SOURCE_TOO_LARGE"})
    byte_offsets = [0]
    for char in text:
        byte_offsets.append(byte_offsets[-1] + len(char.encode("utf-8")))
    prefix = "passage: "
    # One bounded whole-source tokenization supplies approximate boundaries.
    # Every exact slice is still verified independently with its own E5 prefix.
    whole = tokenizer(prefix + text, truncation=False, padding=False, add_special_tokens=True, return_offsets_mapping=True)
    starts = [max(0, a - len(prefix)) for a, b in whole["offset_mapping"] if b > len(prefix)]
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + 16000, bisect_right(byte_offsets, byte_offsets[start] + CHUNK_BYTES) - 1)
        token_position = bisect_right(starts, start)
        if token_position + 440 < len(starts):
            proposed = starts[token_position + 440]
            if proposed > start:
                end = min(end, proposed)
        while True:
            value = prefix + text[start:end]
            result = tokenizer(value, truncation=False, padding=False, add_special_tokens=True, return_offsets_mapping=True)
            count = len(result["input_ids"])
            if count <= CHUNK_TOKENS:
                break
            # Offset mappings refer to original Unicode codepoints, including prefix.
            # Retokenize the chosen slice: boundary changes can alter tokenization.
            offsets = result["offset_mapping"]
            boundary = max((a - len(prefix) for a, b in offsets[:CHUNK_TOKENS - 1] if b > len(prefix)), default=0)
            next_end = start + boundary
            end = min(end - 1, next_end) if next_end > start else start + (end - start) // 2
            if end <= start:
                raise HTTPException(422, {"code": "INPUT_TOO_LONG"})
        if end < len(text):
            # Prefer a nearby line/sentence boundary without dropping separators.
            section = text[start:end]
            boundary = max(section.rfind("\n"), section.rfind(". ")) + 1
            if boundary >= max(1, len(section) // 2):
                proposed = start + boundary
                proposed_count = len(tokenizer(prefix + text[start:proposed], truncation=False, padding=False, add_special_tokens=True)["input_ids"])
                if proposed_count <= CHUNK_TOKENS:
                    end, count = proposed, proposed_count
        if not text[start:end].strip():
            raise HTTPException(422, {"code": "INPUT_TOO_LONG"})
        a, b = byte_offsets[start], byte_offsets[end]
        chunks.append({"ordinal": len(chunks), "start_byte": a, "end_byte": b,
                       "sha256": sha256(encoded[a:b]).hexdigest(), "token_count": count})
        if len(chunks) > MAX_CHUNKS:
            raise HTTPException(422, {"code": "SOURCE_TOO_LARGE"})
        start = end
    return {"index_version": INDEX_VERSION, "chunker_version": CHUNKER_VERSION,
            "source_sha256": sha256(encoded).hexdigest(), "byte_length": len(encoded), "chunks": chunks}
