"""Changing this identity requires rebuilding the index, including query vectors."""

MODEL_ID = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
MODEL_REVISION = "e8f8c211226b894fcb81acc59f3b34ba3efd5f42"
DIMENSIONS = 384
MAX_TOKENS = 128
MAX_INPUTS = 32
MAX_BODY_BYTES = 128 * 1024
INDEX_VERSION = f"{MODEL_ID}@{MODEL_REVISION}:mean-pool:l2:384:v1"


def verify_model_assets(path):
    """Reject an old384-dimensional model accidentally linked to this namespace."""
    from pathlib import Path
    root = Path(path)
    required = ["config.json", "model.safetensors", "modules.json",
                "sentence_bert_config.json", "1_Pooling/config.json",
                "tokenizer.json", "tokenizer_config.json"]
    for name in required:
        metadata = root / ".cache" / "huggingface" / "download" / (name + ".metadata")
        try:
            revision = metadata.read_text().splitlines()[0]
        except (OSError, IndexError, UnicodeError):
            raise RuntimeError("Pinned model assets unavailable; run prepare.py.") from None
        if not (root / name).is_file() or revision != MODEL_REVISION:
            raise RuntimeError("Model asset revision does not match this index; run prepare.py.")
