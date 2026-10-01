"""Start/stop/status without global installs or automatic login changes."""

import json
import fcntl
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / ".runtime"
PID_FILE = RUNTIME / "service.pid"
PORT = int(os.environ.get("LOCAL_EMBEDDINGS_PORT", "8817"))


def owned_pid():
    if not PID_FILE.exists():
        return None
    pid = int(PID_FILE.read_text())
    result = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True)
    return pid if str(ROOT / "service.py") in result.stdout else None


def health():
    try:
        with urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2) as response:
            return json.load(response)
    except (URLError, TimeoutError):
        return None


def perform_action(action):
    if action == "status":
        print(json.dumps({"pid": owned_pid(), "health": health()}, indent=2))
        return
    if action == "stop":
        pid = owned_pid()
        if pid:
            os.kill(pid, signal.SIGTERM)
            for _ in range(50):
                if not owned_pid():
                    break
                time.sleep(0.1)
            if owned_pid():
                raise SystemExit("Service is still stopping; retry status before restarting.")
        PID_FILE.unlink(missing_ok=True)
        print("Embedding service stopped.")
        return
    if action != "start":
        raise SystemExit("Usage: .venv/bin/python control.py start|stop|status")
    if owned_pid():
        print("Embedding service already started.")
        return
    if health():
        raise SystemExit(f"Port {PORT} already serves another process; leave it untouched.")
    if not (RUNTIME / "model" / "model.safetensors").exists():
        raise SystemExit("Run prepare.py first.")
    os.umask(0o077)
    with (RUNTIME / "service.log").open("ab") as log:
        child = subprocess.Popen(
            [str(ROOT / ".venv" / "bin" / "python"), str(ROOT / "service.py")],
            cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            start_new_session=True,
        )
    PID_FILE.write_text(str(child.pid))
    for _ in range(120):
        if child.poll() is not None:
            PID_FILE.unlink(missing_ok=True)
            raise SystemExit("Service failed to start; inspect .runtime/service.log.")
        if health():
            print(f"Embedding service ready at http://127.0.0.1:{PORT} (authentication required).")
            return
        time.sleep(0.5)
    raise SystemExit("Startup is still pending; inspect status and .runtime/service.log.")


def main(action):
    os.umask(0o077)
    RUNTIME.mkdir(mode=0o700, exist_ok=True)
    with (RUNTIME / "control.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("Another service control operation is running; retry shortly.")
        perform_action(action)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) == 2 else "")
