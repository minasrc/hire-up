#!/bin/sh
set -eu
cd "$(dirname "$0")"
PYTHON_BIN="${EMBEDDING_PYTHON:-python3.12}"
"$PYTHON_BIN" -c 'import sys; assert sys.version_info[:2] == (3, 12), "Use Python 3.12 for this tested dependency lock."'
"$PYTHON_BIN" -m venv .venv
.venv/bin/python -m pip install --no-cache-dir -r requirements.lock
.venv/bin/python prepare.py
.venv/bin/python -m unittest discover -p 'test_*.py' -v
printf '%s\n' 'Ready. Start with: .venv/bin/python control.py start'
