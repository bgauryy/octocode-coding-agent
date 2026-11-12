"""Own a PTY that is not read while the child paints; then read it all and report what arrived.

Usage: frame-cap.py NODE CHILD. Prints JSON: ticks while unread, the child's largest queue, the cap, the essential
markers received in order, dropped frame bytes and whether a whole repaint followed the drain.
"""
import json
import os
import pty
import re
import select
import subprocess
import sys
import time

master, slave = pty.openpty()
health_read, health_write = os.pipe()
env = os.environ.copy()
env.pop("OCTOCODE_TUI_WRITE_LOG", None)
env["OUTPUT_HEALTH_FD"] = str(health_write)
child = subprocess.Popen([sys.argv[1], sys.argv[2]], stdout=slave, stderr=subprocess.PIPE,
                         stdin=subprocess.DEVNULL, pass_fds=(health_write,), env=env)
os.close(slave)
os.close(health_write)
health = b""
output = bytearray()
try:
    deadline = time.monotonic() + 10
    while b"max:" not in health and time.monotonic() < deadline:
        ready, _, _ = select.select([health_read], [], [], 0.05)
        if ready:
            health += os.read(health_read, 65536)
    ticks_unread = health.count(b"tick:")
    deadline = time.monotonic() + 15
    while b"done\n" not in health and time.monotonic() < deadline:
        ready, _, _ = select.select([master, health_read], [], [], 0.05)
        for fd in ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if fd == master:
                output.extend(chunk)
            else:
                health += chunk
    child.wait(timeout=5)
    text = health.decode()
    value = lambda name: int(re.search(name + r":(\d+)", text).group(1))
    markers = [int(m) for m in re.findall(rb"<E(\d+)>", bytes(output))]
    end = output.find(b"<END>")
    full = output.find(b"<FULL1>")
    print(json.dumps({
        "exit": child.returncode,
        "stderr": child.stderr.read().decode()[-500:],
        "ticks_unread": ticks_unread,
        "max": value("max"),
        "cap": value("cap"),
        "essentials": value("essentials"),
        "markers": markers,
        "dropped": value("dropped"),
        "recovered": "recovered:" in text,
        "repaint_after_end": full > end >= 0,
    }))
finally:
    if child.poll() is None:
        child.kill()
        child.wait(timeout=3)
    os.close(master)
    os.close(health_read)
