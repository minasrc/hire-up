import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from model_config import INDEX_VERSION, MAX_BODY_BYTES, MODEL_ID
from service import create_app, Encoder

TOKEN = "synthetic-test-token-" * 3
HEADERS = {"Authorization": f"Bearer {TOKEN}"}
BODY = {"model": MODEL_ID, "input": ["Synthetic developer profile"], "input_type": "passage"}


class FakeEncoder:
    def plan(self, text, chunker_version=None):
        from chunking import chunk_plan
        from test_chunking import CharacterTokenizer
        return chunk_plan(text, CharacterTokenizer(), chunker_version) if chunker_version else chunk_plan(text, CharacterTokenizer())

    def encode(self, inputs, input_type):
        return [[1.0] + [0.0] * 383 for _ in inputs], 8


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(create_app(FakeEncoder(), TOKEN), base_url="http://127.0.0.1:8817")

    def post(self, body):
        return self.client.post("/v1/embeddings", headers=HEADERS, json=body)

    def test_authentication_is_required(self):
        for header in [None, "Bearer wrong", "Basic credentials"]:
            response = self.client.post("/v1/embeddings", json=BODY, headers={"Authorization": header} if header else {})
            self.assertEqual(response.status_code, 401)

    def test_browser_and_unrecognized_host_are_denied(self):
        response = self.client.post("/v1/embeddings", headers={**HEADERS, "Origin": "https://example.com"}, json=BODY)
        self.assertEqual(response.status_code, 403)
        response = self.client.get("/health", headers={"Host": "evil.example"})
        self.assertEqual(response.status_code, 400)

    def test_query_or_passage_is_required(self):
        body = dict(BODY)
        del body["input_type"]
        self.assertEqual(self.post(body).status_code, 422)
        self.assertEqual(self.post({**BODY, "input_type": "document"}).status_code, 422)

    def test_vectors_return_stable_index_identity(self):
        response = self.post({**BODY, "input": ["Person one", "Person two"]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["index_version"], INDEX_VERSION)
        self.assertEqual([item["index"] for item in response.json()["data"]], [0, 1])
        self.assertEqual(len(response.json()["data"][0]["embedding"]), 384)
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_invalid_inputs_and_models_are_rejected_without_echo(self):
        for value in [[], ["x"] * 33, " ", [None], [123], "a" * 16001]:
            self.assertEqual(self.post({**BODY, "input": value}).status_code, 422)
        response = self.post({**BODY, "model": "private-invalid-model", "private-message": "secret text"})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("secret text", response.text)
        self.assertNotIn("private-invalid-model", response.text)

    def test_body_size_and_content_type_are_bounded(self):
        response = self.client.post("/v1/embeddings", headers={**HEADERS, "Content-Type": "application/json"}, content=b"x" * (MAX_BODY_BYTES + 1))
        self.assertEqual(response.status_code, 413)
        response = self.client.post("/v1/embeddings", headers=HEADERS, content=b"not json")
        self.assertEqual(response.status_code, 415)

    def test_malformed_json_has_no_input_echo(self):
        response = self.client.post("/v1/embeddings", headers={**HEADERS, "Content-Type": "application/json"}, content=b'{"private-content"')
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("private-content", response.text)

    def test_inference_errors_do_not_expose_content(self):
        class BrokenEncoder:
            def encode(self, *args):
                raise RuntimeError("private conversation")
        client = TestClient(create_app(BrokenEncoder(), TOKEN), base_url="http://127.0.0.1:8817")
        response = client.post("/v1/embeddings", headers=HEADERS, json=BODY)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private conversation", response.text)

    def test_single_string_is_one_embedding(self):
        response = self.post({**BODY, "input": "one complete string"})
        self.assertEqual(len(response.json()["data"]), 1)

    def test_plan_endpoint_authenticated_and_versioned(self):
        from chunking import CHUNKER_VERSION
        body = {"model": MODEL_ID, "chunker_version": CHUNKER_VERSION, "text": "private source " * 100}
        self.assertEqual(self.client.post("/v1/chunk-plan", json=body).status_code, 401)
        result = self.client.post("/v1/chunk-plan", json=body, headers=HEADERS)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["byte_length"], len(body["text"].encode()))
        self.assertGreater(len(result.json()["chunks"]), 1)
        response = self.client.post("/v1/chunk-plan", json={**body, "chunker_version": "secret-wrong"}, headers=HEADERS)
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("secret-wrong", response.text)
        from chunking import CV_CHUNKER_VERSION
        response = self.client.post("/v1/chunk-plan", json={**body, "chunker_version": CV_CHUNKER_VERSION}, headers=HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["chunker_version"], CV_CHUNKER_VERSION)

    def test_queries_preempt_remaining_passage_batches(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        class BlockingEncoder(FakeEncoder):
            def encode(self, inputs, kind):
                calls.append((kind, len(inputs)))
                if len(calls) == 1:
                    entered.set()
                    if not release.wait(5): raise RuntimeError("test timed out")
                return super().encode(inputs, kind)
        client = TestClient(create_app(BlockingEncoder(), TOKEN), base_url="http://127.0.0.1:8817")
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(client.post, "/v1/embeddings", headers=HEADERS, json={**BODY, "input": ["profile"] * 24})
            self.assertTrue(entered.wait(3))
            second = executor.submit(client.post, "/v1/embeddings", headers=HEADERS, json={**BODY, "input_type": "query"})
            time.sleep(0.1)
            release.set()
            self.assertEqual(first.result(timeout=5).status_code, 200)
            self.assertEqual(second.result(timeout=5).status_code, 200)
        self.assertEqual(calls, [("passage", 8), ("query", 1), ("passage", 8), ("passage", 8)])


    def test_old_model_assets_cannot_advertise_new_namespace(self):
        from pathlib import Path
        from tempfile import TemporaryDirectory
        from model_config import verify_model_assets, MODEL_REVISION
        files = ["config.json", "model.safetensors", "modules.json", "sentence_bert_config.json",
                 "1_Pooling/config.json", "tokenizer.json", "tokenizer_config.json"]
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for name in files:
                artifact = root / name; artifact.parent.mkdir(parents=True, exist_ok=True)
                artifact.write_text("synthetic artifact")
                metadata = root / ".cache" / "huggingface" / "download" / (name + ".metadata")
                metadata.parent.mkdir(parents=True, exist_ok=True)
                metadata.write_text(MODEL_REVISION + "\nsynthetic checksum\n")
            verify_model_assets(root)
            (root / ".cache/huggingface/download/model.safetensors.metadata").write_text("old-model-revision\n")
            with self.assertRaises(RuntimeError): verify_model_assets(root)

    def test_model_inputs_have_no_prefix_and_never_truncate(self):
        from types import SimpleNamespace
        calls = []
        class Model:
            def tokenizer(self, inputs, **kwargs):
                self.assertions(inputs, kwargs)
                return {"input_ids": [[0] * (len(value) + 2) for value in inputs]}
            def assertions(self, inputs, kwargs):
                calls.append((inputs, kwargs))
            def encode(self, inputs, **kwargs):
                calls.append((inputs, kwargs))
                return SimpleNamespace(tolist=lambda: [[1.0] + [0.0] * 383 for _ in inputs])
        encoder = object.__new__(Encoder)
        encoder.model = Model()
        for kind in ["query", "passage"]:
            values = ["Exact résumé text"]
            self.assertEqual(len(encoder.encode(values, kind)[0]), 1)
            self.assertEqual(calls[-2][0], values)
            self.assertFalse(calls[-2][1]["truncation"])
            self.assertEqual(calls[-1][0], values)
        count = len(calls)
        with self.assertRaises(Exception) as error:
            encoder.encode(["x" * 127], "query")
        self.assertEqual(error.exception.status_code, 422)
        self.assertEqual(error.exception.detail["max_tokens_including_specials"], 128)
        self.assertEqual(len(calls), count + 1, "Over-limit input must not reach inference")

if __name__ == "__main__":
    unittest.main()
