"""A forced exit must restore terminal modes even with an in-flight asynchronous write."""
import json
import os
import pty
import select
import subprocess
import sys
import time

master, slave = pty.openpty()
health_read, health_write = os.pipe()
env = os.environ.copy()
env.pop("OCTOCODE_TUI_WRITE_LOG", None)
env["OUTPUT_HEALTH_FD"] = str(health_write)
child = subprocess.Popen([sys.argv[1], sys.argv[2], *sys.argv[3:]], stdout=slave, stderr=subprocess.PIPE,
                         stdin=subprocess.DEVNULL, pass_fds=(health_write,), env=env)
os.close(slave)
os.close(health_write)
output = bytearray()
try:
    ready, _, _ = select.select([health_read], [], [], 5)
    assert ready and b"queued\n" in os.read(health_read, 65536), "child did not queue output"
    if sys.argv[3:] == ["paused"]:
        # The reader never resumes: the exit must give up on the restore bytes instead of hanging.
        started = time.monotonic()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            raise AssertionError("process hung at exit while the terminal was not reading")
        assert child.returncode == 0, child.stderr.read().decode()
        print(json.dumps({"exited": True, "exit_ms": round((time.monotonic() - started) * 1000)}))
        sys.exit(0)
    time.sleep(0.2)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)
    child.wait(timeout=3)
    assert child.returncode == 0, child.stderr.read().decode()
    for sequence in [b"\x1b[?1049l", b"\x1b[?2004l", b"\x1b[?25h", b"\x1b[?7h", b"\x1b]9;4;0\x07"]:
        assert sequence in output, "missing restore sequence: " + repr(sequence)
    assert 0 <= output.rfind(b"\x1b[<u") < output.rfind(b"\x1b[?1049l"), "keyboard flags must pop before leaving the alternate screen"
    assert output.count(b"\x1b[?1049l") == 1, "alternate screen must be left once"
    print(json.dumps({"restored": True, "bytes": len(output), "exit": child.returncode}))
finally:
    if child.poll() is None:
        child.kill()
        child.wait(timeout=3)
    os.close(master)
    os.close(health_read)
