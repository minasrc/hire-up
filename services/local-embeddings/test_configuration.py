"""Explicit launcher paths, without model downloads or a listening service."""
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import service
from model_config import DIMENSIONS, MAX_TOKENS, MODEL_REVISION

TOKEN = "synthetic-embedding-token-" * 3


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.root.chmod(0o700)
        self.token_file = self.root / "token"
        self.token_file.write_text(TOKEN + "\n")
        self.token_file.chmod(0o600)
        self.environment = patch.dict(os.environ, {"LOCAL_EMBEDDINGS_TOKEN_FILE": str(self.token_file)})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_explicit_private_token_and_default_paths(self):
        self.assertEqual(service.read_token(), TOKEN)
        with patch.dict(os.environ, {}, clear=True), patch.object(service, "ROOT", self.root):
            runtime = self.root / ".runtime"
            runtime.mkdir(mode=0o700)
            (runtime / "token").write_text(TOKEN)
            (runtime / "token").chmod(0o600)
            self.assertEqual(service.read_token(), TOKEN)
            self.assertEqual(service.model_directory(), runtime / "model")

    def reject_token(self):
        with self.assertRaisesRegex(RuntimeError, "Private embedding token unavailable or unsafe") as caught:
            service.read_token()
        self.assertNotIn(TOKEN, str(caught.exception))
        self.assertNotIn(str(self.root), str(caught.exception))

    def test_rejects_public_token_or_parent_and_wrong_owner(self):
        self.token_file.chmod(0o640)
        self.reject_token()
        self.token_file.chmod(0o600)
        self.root.chmod(0o750)
        self.reject_token()
        self.root.chmod(0o700)
        with patch.object(service.os, "getuid", return_value=os.getuid() + 1):
            self.reject_token()
        real_fstat = os.fstat
        def wrong_file_owner(fd):
            value = real_fstat(fd)
            if value.st_ino == self.token_file.stat().st_ino:
                return SimpleNamespace(st_mode=value.st_mode, st_uid=os.getuid() + 1,
                                       st_nlink=1, st_size=value.st_size)
            return value
        with patch.object(service.os, "fstat", side_effect=wrong_file_owner):
            self.reject_token()

    def test_rejects_symlinks_hardlinks_directories_and_fifos(self):
        alias = self.root / "alias"
        alias.symlink_to(self.token_file)
        with patch.dict(os.environ, {"LOCAL_EMBEDDINGS_TOKEN_FILE": str(alias)}):
            self.reject_token()
        directory_alias = self.root / "parent-alias"
        directory_alias.symlink_to(self.root, target_is_directory=True)
        with patch.dict(os.environ, {"LOCAL_EMBEDDINGS_TOKEN_FILE": str(directory_alias / "token")}):
            self.reject_token()
        hardlink = self.root / "hardlink"
        os.link(self.token_file, hardlink)
        self.reject_token()
        hardlink.unlink()
        with patch.dict(os.environ, {"LOCAL_EMBEDDINGS_TOKEN_FILE": str(self.root)}):
            self.reject_token()
        fifo = self.root / "fifo"
        os.mkfifo(fifo, 0o600)
        with patch.dict(os.environ, {"LOCAL_EMBEDDINGS_TOKEN_FILE": str(fifo)}):
            self.reject_token()

    def test_invalid_missing_or_large_tokens_do_not_echo_contents(self):
        for content in [b"short", b"x" * 8193, b"\xff" * 40, (TOKEN + "\nprivate").encode(), (TOKEN + "\x00").encode()]:
            self.token_file.write_bytes(content)
            self.reject_token()
        self.token_file.unlink()
        self.reject_token()

    def test_external_shared_model_uses_same_revision_verification_and_offline_loader(self):
        model_root = self.root / "shared-model"
        model_root.mkdir(mode=0o755)
        files = ["config.json", "model.safetensors", "modules.json", "sentence_bert_config.json",
                 "1_Pooling/config.json", "tokenizer.json", "tokenizer_config.json"]
        for filename in files:
            artifact = model_root / filename
            artifact.parent.mkdir(parents=True, exist_ok=True)
            artifact.write_text("synthetic artifact")
            artifact.chmod(0o444)
            metadata = model_root / ".cache" / "huggingface" / "download" / (filename + ".metadata")
            metadata.parent.mkdir(parents=True, exist_ok=True)
            metadata.write_text(MODEL_REVISION + "\nsynthetic checksum\n")
        fake_model = Mock(max_seq_length=MAX_TOKENS)
        fake_model.get_sentence_embedding_dimension.return_value = DIMENSIONS
        loader = Mock(return_value=fake_model)
        with patch.dict(os.environ, {"LOCAL_EMBEDDINGS_MODEL_DIRECTORY": str(model_root)}), \
                patch.dict("sys.modules", {"torch": Mock(), "sentence_transformers": SimpleNamespace(SentenceTransformer=loader)}), \
                patch.object(service.Encoder, "encode", return_value=([], 0)):
            service.Encoder()
            loader.assert_called_once_with(str(model_root), device="cpu", local_files_only=True,
                                           trust_remote_code=False, model_kwargs={"use_safetensors": True})
            (model_root / ".cache/huggingface/download/model.safetensors.metadata").write_text("old-revision\n")
            loader.reset_mock()
            with self.assertRaisesRegex(RuntimeError, "revision does not match"):
                service.Encoder()
            loader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
