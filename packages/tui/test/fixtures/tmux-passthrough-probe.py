"""Attach a real tmux client over a pty and report which Kitty uploads tmux forwarded to it.

capture-pane cannot show passthrough: tmux hands the payload to the attached client and keeps nothing. Usage:
  tmux-passthrough-probe.py SOCKET SESSION COLS ROWS
Waits for READY in the pane, sends one key, waits for DONE, then prints one JSON object:
  {"ready": bool, "done": bool, "uploads": [{"id": <i= value>, "chars": <payload characters>, "chunks": <APCs>}]}
"""
import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

sock, session, cols, rows = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])


def tmux(*args):
    return subprocess.run(["tmux", "-L", sock, "-f", "/dev/null", *args], capture_output=True, text=True).stdout


pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp("tmux", ["tmux", "-L", sock, "-f", "/dev/null", "attach", "-t", session])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
received = bytearray()


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.02)
        if ready:
            try:
                received.extend(os.read(fd, 1 << 20))
            except OSError:
                return


def wait_for(text, seconds):
    end = time.time() + seconds
    while text not in tmux("capture-pane", "-p", "-t", session) and time.time() < end:
        pump(0.1)
    return text in tmux("capture-pane", "-p", "-t", session)


ready = wait_for("READY", 60)
pump(0.5)
received.clear()
tmux("send-keys", "-t", session, "x")
done = wait_for("DONE", 60)
pump(1.0)

uploads = {}
for params, payload in re.findall(rb"\x1b_G([^;\x1b]*);([A-Za-z0-9+/=]*)\x1b\\", bytes(received)):
    match = re.search(rb"i=(\d+)", params)
    key = int(match.group(1)) if match else (max(uploads) if uploads else 0)
    entry = uploads.setdefault(key, {"id": key, "chars": 0, "chunks": 0})
    entry["chars"] += len(payload)
    entry["chunks"] += 1
print(json.dumps({"ready": ready, "done": done, "uploads": list(uploads.values())}))
