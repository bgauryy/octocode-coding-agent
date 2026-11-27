"""PTY driver for terminal-typeahead.test.ts: types lines while the child is still in line mode, starts its terminal UI,
then types a raw line feed. Prints the child's report (every input it received, joined) as JSON."""
import json, os, pty, select, signal, subprocess, sys, time

node, child = sys.argv[1], sys.argv[2]
master, slave = pty.openpty()
read_end, write_end = os.pipe()
proc = subprocess.Popen([node, child], stdin=slave, stdout=slave, stderr=slave, pass_fds=(write_end,),
                        env=dict(os.environ, RESULT_FD=str(write_end), TERM="xterm-256color"), start_new_session=True)
os.close(slave)
os.close(write_end)
reports, pending, screen = [], b"", bytearray()

def pump(seconds, until):
    global pending
    end = time.time() + seconds
    while time.time() < end and not until():
        ready, _, _ = select.select([master, read_end], [], [], 0.02)
        for fd in ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if fd == master:
                screen.extend(chunk)
            elif chunk:
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    reports.append(json.loads(line))

def fail(message):
    proc.kill()
    sys.exit(message + ": " + screen.decode(errors="replace"))

pump(15, lambda: any(r.get("cooked") for r in reports))
if not reports:
    fail("never ready")
# Line mode: two Enters (the terminal sends CR, the line discipline hands over LF), then a line still being typed.
os.write(master, b"hello\rtwo\rpartial")
time.sleep(0.2)
os.kill(proc.pid, signal.SIGUSR1)
pump(10, lambda: any(r.get("started") for r in reports))
# Raw mode now: a line feed is Ctrl+J, a newline key, and stays one.
os.write(master, b"\n")
pump(10, lambda: any("inputs" in r for r in reports))
if not any("inputs" in r for r in reports):
    fail("no inputs " + json.dumps(reports))
pump(10, lambda: proc.poll() is not None)
print(json.dumps(next(r for r in reports if "inputs" in r)))
