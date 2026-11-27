from base64 import b64decode
import json
import os
from pathlib import Path
import subprocess
import sys
import time

request = json.load(sys.stdin)
marker = Path(b64decode(request["body"]).decode())
if "memory" in request["url"]:
    membership = Path("/proc/self/cgroup").read_text().strip().removeprefix("0::")
    worker_group = Path("/sys/fs/cgroup" + membership)
    assert worker_group.name == "scrapling-worker"
    assert (worker_group / "memory.max").read_text().strip() == "1073741824"
    assert (worker_group / "memory.oom.group").read_text().strip() == "1"
    # Exercise an actual OOM with a small touch-allocation in the disposable unit.
    (worker_group / "memory.max").write_text("33554432")
    parent = os.getpid()
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import time; time.sleep(0.2); limit = bytearray(96 * 1024 * 1024); time.sleep(120)",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    marker.write_text(f"{parent} {child.pid}", encoding="utf8")
    assert child.wait(timeout=120) == 0
    sys.exit()

child = subprocess.Popen(
    [sys.executable, "-c", "import time; time.sleep(120)"],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
marker.write_text(f"{os.getpid()} {child.pid}", encoding="utf8")
if "crash" in request["url"]:
    os._exit(17)
time.sleep(120)
