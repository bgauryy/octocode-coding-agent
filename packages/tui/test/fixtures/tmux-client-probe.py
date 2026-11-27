"""Attach a real tmux client over a pty, resize it, and report how many bytes tmux sent that client.

capture-pane cannot see synchronized-output expiry: only the stream tmux writes to an attached client shows whether a
redraw was held back or streamed as intermediate frames. Usage:
  tmux-client-probe.py SOCKET SESSION COLS ROWS NEW_COLS NEW_ROWS READY_TEXT
Prints one JSON object: {"bytes": <client bytes after the resize>, "ready": <bool>}.
"""
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time

sock, session, cols, rows, new_cols, new_rows, ready_text = sys.argv[1:8]
cols, rows, new_cols, new_rows = int(cols), int(rows), int(new_cols), int(new_rows)


def tmux(*args):
    return subprocess.run(["tmux", "-L", sock, "-f", "/dev/null", *args], capture_output=True, text=True).stdout


def set_size(fd, r, c):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))


pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp("tmux", ["tmux", "-L", sock, "-f", "/dev/null", "attach", "-t", session])
set_size(fd, rows, cols)
received = []


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.02)
        if ready:
            try:
                received.append(os.read(fd, 65536))
            except OSError:
                return


pump(0.5)
deadline = time.time() + 90
while ready_text not in tmux("capture-pane", "-p", "-t", session) and time.time() < deadline:
    pump(0.2)
is_ready = ready_text in tmux("capture-pane", "-p", "-t", session)
pump(0.5)
received.clear()
set_size(fd, new_rows, new_cols)
pump(8)
print(json.dumps({"bytes": sum(len(chunk) for chunk in received), "ready": is_ready}))
