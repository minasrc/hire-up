import unittest
from hashlib import sha256
from fastapi import HTTPException
from chunking import chunk_plan

class CharacterTokenizer:
    def __call__(self, text, **kwargs):
        result = {"input_ids": [0] + list(range(len(text))) + [1]}
        if kwargs.get("return_offsets_mapping"):
            result["offset_mapping"] = [(0, 0)] + [(i, i + 1) for i in range(len(text))] + [(0, 0)]
        return result

class ChunkTests(unittest.TestCase):
    def test_unicode_tail_is_covered_exactly_and_each_prefix_is_bounded(self):
        text = ("工程师 👩🏽‍💻 café e\u0301\n" * 400) + "critical long tail"
        tokenizer = CharacterTokenizer()
        plan = chunk_plan(text, tokenizer)
        raw = text.encode()
        self.assertGreater(len(plan["chunks"]), 1)
        position = 0
        for index, chunk in enumerate(plan["chunks"]):
            self.assertEqual((index, position), (chunk["ordinal"], chunk["start_byte"]))
            piece = raw[position:chunk["end_byte"]]
            self.assertEqual(sha256(piece).hexdigest(), chunk["sha256"])
            self.assertLessEqual(chunk["token_count"], 448)
            self.assertEqual(len(tokenizer("passage: " + piece.decode())["input_ids"]), chunk["token_count"])
            position = chunk["end_byte"]
        self.assertEqual(position, len(raw))
        self.assertEqual(plan["source_sha256"], sha256(raw).hexdigest())
        self.assertTrue(raw[plan["chunks"][-1]["start_byte"]:].decode().endswith("critical long tail"))

    def test_tokenizer_normalization_never_rewrites_source(self):
        text = "  Engineer\r\n Paris\t\tRésumé e\u0301  "
        plan = chunk_plan(text, CharacterTokenizer())
        self.assertEqual(plan["byte_length"], len(text.encode()))
        self.assertEqual(plan["chunks"][0]["sha256"], sha256(text.encode()).hexdigest())

    def test_bytes_and_codepoints_bounded_even_for_low_token_text(self):
        class LowTokenizer:
            def __call__(self, text, **kwargs):
                return {"input_ids": [1, 2, 3], "offset_mapping": [(0, 0), (0, len(text)), (0, 0)]}
        plan = chunk_plan("🙂" * 15000, LowTokenizer())
        self.assertEqual(plan["byte_length"], 60000)
        self.assertTrue(all(c["end_byte"] - c["start_byte"] <= 16384 for c in plan["chunks"]))

    def test_oversize_or_invalid_unicode_fails_explicitly(self):
        for text in ["x" * 131073, "  ", "private\ud800"]:
            with self.assertRaises(HTTPException):
                chunk_plan(text, CharacterTokenizer())

if __name__ == "__main__": unittest.main()
