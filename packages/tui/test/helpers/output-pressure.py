"""Own a PTY whose reader pauses; verify timer liveness, ordered bytes and eventual drain.

Usage: output-pressure.py NODE CHILD [prefixed]. With `prefixed`, the child may write terminal setup and restoration
CSI sequences and the terminal capability query. The entire printable payload is compared exactly, and restoration
must follow it.
"""
import json
import os
import pty
import re
import select
import subprocess
import sys
import time

prefixed = len(sys.argv) > 3 and sys.argv[3] == "prefixed"
expected = b"x" * (1024 * 1024) + b"end"
csi = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")


def payload(data):
    # ProcessTerminal.start probes capabilities on each foreground handoff. No arbitrary prefix text is ignored.
    return csi.sub(b"", data).replace(b"\x1b]7501;?\x1b\\", b"")


def complete(data):
    return payload(data) == expected if prefixed else data == expected


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
    deadline = time.monotonic() + 5
    while b"tick:8\n" not in health and time.monotonic() < deadline:
        ready, _, _ = select.select([health_read], [], [], 0.05)
        if ready:
            chunk = os.read(health_read, 65536)
            if not chunk:
                break
            health += chunk
    assert b"tty:true\n" in health, health
    assert b"returned:" in health, health
    assert b"tick:8\n" in health, "event loop stalled while PTY was undrained: " + repr(health)
    assert b"deadline:false\n" in health, health
    assert b"drained\n" not in health, health
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
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
        if b"drained\n" in health and complete(output):
            break
    child.wait(timeout=3)
    assert child.returncode == 0, child.stderr.read().decode()
    assert complete(output), (len(output), bytes(output[-100:]), bytes(payload(output)[:100]))
    if prefixed:
        payload_start = output.find(expected)
        assert payload_start >= 0, "payload bytes must remain contiguous and ordered"
        payload_end = payload_start + len(expected)
        assert b"\x1b[?2004l" in output[payload_end:], "terminal restoration must follow the exact payload"
    print(json.dumps({"ticks_undrained": 8, "ordered_bytes": len(expected) if prefixed else len(output),
                      "exit": child.returncode}))
finally:
    if child.poll() is None:
        child.kill()
        child.wait(timeout=3)
    os.close(master)
    os.close(health_read)
