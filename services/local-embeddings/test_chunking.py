import unittest
from hashlib import sha256
from fastapi import HTTPException
from chunking import chunk_plan, CHUNKER_VERSION, CV_CHUNKER_VERSION

class CharacterTokenizer:
    def __call__(self, text, **kwargs):
        if isinstance(text, list):
            return {"input_ids": [self(value, **kwargs)["input_ids"] for value in text]}
        result = {"input_ids": [0] + list(range(len(text))) + [1]}
        if kwargs.get("return_offsets_mapping"):
            result["offset_mapping"] = [(0, 0)] + [(i, i + 1) for i in range(len(text))] + [(0, 0)]
        return result

class ChunkTests(unittest.TestCase):
    def test_unicode_tail_is_covered_exactly_and_each_input_is_bounded(self):
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
            self.assertLessEqual(chunk["token_count"], 128)
            self.assertEqual(len(tokenizer(piece.decode())["input_ids"]), chunk["token_count"])
            position = chunk["end_byte"]
        self.assertEqual(position, len(raw))
        self.assertEqual(plan["source_sha256"], sha256(raw).hexdigest())
        self.assertTrue(raw[plan["chunks"][-1]["start_byte"]:].decode().endswith("critical long tail"))

    def test_tokenizer_normalization_never_rewrites_source(self):
        text = "  Engineer\r\n Paris\t\tRésumé e\u0301  "
        plan = chunk_plan(text, CharacterTokenizer())
        self.assertEqual(plan["byte_length"], len(text.encode()))
        self.assertEqual(plan["source_sha256"], sha256(text.encode()).hexdigest())
        self.assertEqual(b"".join(text.encode()[c["start_byte"]:c["end_byte"]] for c in plan["chunks"]), text.encode())

    def test_bytes_and_codepoints_bounded_even_for_low_token_text(self):
        class LowTokenizer:
            def __call__(self, text, **kwargs):
                return {"input_ids": [[1, 2, 3] for _ in text]} if isinstance(text, list) else {"input_ids": [1, 2, 3], "offset_mapping": [(0, 0), (0, len(text)), (0, 0)]}
        plan = chunk_plan("🙂" * 15000, LowTokenizer())
        self.assertEqual(plan["byte_length"], 60000)
        self.assertTrue(all(c["end_byte"] - c["start_byte"] <= 16384 for c in plan["chunks"]))

    def test_oversize_or_invalid_unicode_fails_explicitly(self):
        for text in ["x" * 131073, "  ", "private\ud800"]:
            with self.assertRaises(HTTPException):
                chunk_plan(text, CharacterTokenizer())

    def test_lines_keep_role_and_preferences_separate(self):
        source = "\n  Professional experience. Builds Python APIs.\r\n\r\nPreferences: remote.\n"
        plan = chunk_plan(source, CharacterTokenizer(), CV_CHUNKER_VERSION)
        self.assertEqual(plan["chunker_version"], CV_CHUNKER_VERSION)
        raw = source.encode()
        parts = [raw[c["start_byte"]:c["end_byte"]].decode() for c in plan["chunks"]]
        self.assertEqual(parts, ["\n  Professional experience. Builds Python APIs.\r\n\r\n", "Preferences: remote.\n"])
        self.assertEqual("".join(parts), source)

    def test_thousands_of_tiny_paragraphs_pack_without_losing_bytes(self):
        text = "é\n\n" * 3000
        plan = chunk_plan(text, CharacterTokenizer(), CV_CHUNKER_VERSION)
        self.assertLessEqual(len(plan["chunks"]), 256)
        raw = text.encode()
        self.assertEqual(b"".join(raw[c["start_byte"]:c["end_byte"]] for c in plan["chunks"]), raw)
        self.assertTrue(all(c["token_count"] <= 128 for c in plan["chunks"]))

    def test_short_profile_stays_one_chunk_while_cv_preserves_lines(self):
        text = "Name: Synthetic\nRole: Python developer\nLocation: Madrid"
        profile = chunk_plan(text, CharacterTokenizer())
        cv = chunk_plan(text, CharacterTokenizer(), CV_CHUNKER_VERSION)
        self.assertEqual(len(profile["chunks"]), 1)
        self.assertEqual(len(cv["chunks"]), 3)
        self.assertEqual(profile["source_sha256"], cv["source_sha256"])

    def test_packing_is_deterministic_and_an_impossible_budget_is_explicit(self):
        text = ("a" * 59 + "\n") * 300
        self.assertEqual(chunk_plan(text, CharacterTokenizer()), chunk_plan(text, CharacterTokenizer()))
        with self.assertRaises(HTTPException) as error:
            chunk_plan("x" * 65000, CharacterTokenizer())
        self.assertEqual(error.exception.detail["code"], "SOURCE_TOO_LARGE")

if __name__ == "__main__": unittest.main()
