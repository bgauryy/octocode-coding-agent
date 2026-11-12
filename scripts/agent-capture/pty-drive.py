#!/usr/bin/env python3
"""pty-drive.py <out.raw> <steps.json> -- cmd...
steps: [["wait", secs], ["send", "text"], ["key", "enter|ctrl-c|esc|up"], ["resize", cols, rows]]
Records every byte the program writes; answers DSR/DA queries minimally."""
import fcntl, json, os, pty, select, signal, struct, sys, termios, time

out_path, steps_path = sys.argv[1], sys.argv[2]
cmd = sys.argv[sys.argv.index("--") + 1:]
steps = json.load(open(steps_path))
KEYS = {"enter": b"\r", "ctrl-c": b"\x03", "esc": b"\x1b", "up": b"\x1b[A", "tab": b"\t", "ctrl-d": b"\x04"}

def setsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = os.environ.get("TERM", "xterm-256color")
    os.execvp(cmd[0], cmd)
setsize(fd, 120, 40)
log = open(out_path, "wb")

def pump(secs):
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            log.write(data)
            # Minimal terminal replies so TUIs that probe do not stall.
            if b"\x1b[6n" in data: os.write(fd, b"\x1b[1;1R")
            if b"\x1b[c" in data or b"\x1b[0c" in data: os.write(fd, b"\x1b[?62;22c")
            if b"\x1b]11;?" in data: os.write(fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
            if b"\x1b]10;?" in data: os.write(fd, b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\")
    return True

for step in steps:
    kind = step[0]
    if kind == "wait": pump(step[1])
    elif kind == "send":
        for ch in step[1].encode():
            os.write(fd, bytes([ch])); pump(0.02)
    elif kind == "paste": os.write(fd, b"\x1b[200~" + step[1].encode() + b"\x1b[201~")
    elif kind == "key": os.write(fd, KEYS[step[1]])
    elif kind == "resize":
        setsize(fd, step[1], step[2]); os.kill(pid, signal.SIGWINCH)
    pump(0.1)
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
pump(1)
log.close()
