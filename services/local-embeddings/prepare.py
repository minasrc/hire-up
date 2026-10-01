"""Download pinned, non-executable model assets. No account or API key is used."""

import os
import secrets
from pathlib import Path

os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["HF_HUB_DISABLE_XET"] = "1"

from huggingface_hub import snapshot_download
from model_config import MODEL_ID, MODEL_REVISION

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / ".runtime"


def main():
    os.umask(0o077)
    RUNTIME.mkdir(mode=0o700, exist_ok=True)
    token_file = RUNTIME / "token"
    if not token_file.exists():
        with token_file.open("x") as handle:
            handle.write(secrets.token_urlsafe(48))
    token_file.chmod(0o600)
    snapshot_download(
        MODEL_ID,
        revision=MODEL_REVISION,
        token=False,
        local_dir=RUNTIME / "model",
        allow_patterns=[
            "config.json", "model.safetensors", "modules.json",
            "sentence_bert_config.json", "config_sentence_transformers.json", "1_Pooling/config.json",
            "sentencepiece.bpe.model", "special_tokens_map.json",
            "tokenizer.json", "tokenizer_config.json",
        ],
        max_workers=2,
    )
    print(f"Prepared {MODEL_ID}@{MODEL_REVISION}; local token created (not displayed).")


if __name__ == "__main__":
    main()
