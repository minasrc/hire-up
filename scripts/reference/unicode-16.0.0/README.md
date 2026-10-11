# Pinned Unicode category reference

`DerivedGeneralCategory.txt` is the unmodified official Unicode Character Database 16.0.0 extracted General_Category reference, downloaded on 2026-10-11 from:

https://www.unicode.org/Public/16.0.0/ucd/extracted/DerivedGeneralCategory.txt

SHA256: `7676ab755a41ef82108460238569e60ad65c191ddafe61b36c6765ec1353f293`

Unicode copyright notices remain in the original file. `LICENSE.txt` is the Unicode License V3 downloaded from https://www.unicode.org/license.txt on the same date.

The generator verifies this checksum, selects P/S/Z categories and adds U+0009..U+000D. The exhaustive unit oracle independently parses all categories, checks complete non-overlapping coverage and compares every Unicode codepoint with runtime matching. Neither uses engine Unicode category regexes or ICU. Node22 remains required for generation; its bundled Unicode version may vary. `node scripts/generate-telegram-literal-boundaries.mjs --check` verifies byte-identical generated JS and migration20 without rewriting them. Upgrading the reference requires explicit review and a new migration, not an edit to the deployed migration.
