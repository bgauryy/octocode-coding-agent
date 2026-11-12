import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const lifecycle = new URL("../src/modes/interactive/interactive-mode/lifecycle.ts", import.meta.url).href;
const tuiModule = new URL("../../tui/src/index.ts", import.meta.url).href;

/**
 * Runs `NODE --eval SOURCE` in its own session on a PTY slave, reads the PTY and the result fd, and sends the signals:
 * SIGTSTP once the child reports ready, SIGCONT once the child has stopped. The child gets its own process group so
 * the suspend's group SIGTSTP reaches nothing else. Prints JSON: whether the child stopped, the PTY bytes between the
 * SIGTSTP and the stop, the bytes after the SIGCONT, the child's reports and its exit code.
 */
const DRIVER = `
import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
read_end, write_end = os.pipe()
env = dict(os.environ, RESULT_FD=str(write_end), TERM="xterm-256color")
child = subprocess.Popen([sys.argv[1], "--input-type=module", "--eval", sys.argv[2]], stdin=slave, stdout=slave,
                         stderr=slave, pass_fds=(write_end,), env=env, start_new_session=True)
os.close(slave)
os.close(write_end)
out = bytearray()
reports = []
pending = b""
def pump(seconds, until=lambda: False):
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
                out.extend(chunk)
            elif chunk:
                pending += chunk
                while b"\\n" in pending:
                    line, pending = pending.split(b"\\n", 1)
                    reports.append(json.loads(line))
def fail(message):
    child.kill()
    sys.exit(message + ": " + out.decode(errors="replace"))
pump(15, lambda: any(r.get("ready") for r in reports))
if not any(r.get("ready") for r in reports):
    fail("never ready")
mark = len(out)
os.kill(child.pid, signal.SIGTSTP)
stopped = False
end = time.time() + 10
while time.time() < end:
    pump(0.02)
    pid, status = os.waitpid(child.pid, os.WUNTRACED | os.WNOHANG)
    if pid and os.WIFSTOPPED(status):
        stopped = True
        break
    if pid:
        fail("exited instead of stopping")
if not stopped:
    fail("did not stop")
pump(0.3)
suspend = bytes(out[mark:])
resumed_at = len(out)
os.kill(child.pid, signal.SIGCONT)
pump(10, lambda: any("starts" in r for r in reports))
pump(10, lambda: child.poll() is not None)
if child.poll() is None:
    fail("did not exit after resume, reports " + json.dumps(reports))
code = child.returncode
pump(0.2)
print(json.dumps({"stopped": stopped, "suspend": suspend.decode(errors="replace"),
                  "resume": bytes(out[resumed_at:]).decode(errors="replace"), "reports": reports, "code": code}))
`;

/** A fullscreen terminal UI with the interactive mode's real signal handlers; reports its `start()` count on resume. */
const CHILD = `
import { writeSync } from "node:fs";
const lifecycle = await import(${JSON.stringify(lifecycle)});
const { ProcessTerminal, TuiAltScreen } = await import(${JSON.stringify(tuiModule)});
const report = (event) => writeSync(Number(process.env.RESULT_FD), JSON.stringify(event) + "\\n");
const ui = new TuiAltScreen(new ProcessTerminal());
let starts = 0;
const start = ui.start.bind(ui);
ui.start = () => {
	starts++;
	start();
};
const host = {
	ui,
	signalCleanupHandlers: [],
	isShuttingDown: false,
	showStatus: () => undefined,
	shutdown: async () => undefined,
	emergencyTerminalExit: () => process.exit(9),
	backgroundError: (_kind, error) => report({ error: String(error) }),
};
host.unregisterSignalHandlers = () => lifecycle.unregisterSignalHandlers(host);
ui.start();
lifecycle.registerSignalHandlers(host);
process.once("SIGCONT", () =>
	setTimeout(() => {
		report({ starts });
		host.unregisterSignalHandlers();
		ui.stop();
		process.exit(0);
	}, 300),
);
setTimeout(() => report({ ready: true }), 300);
`;

// A POSIX PTY regression; python3 owns the PTY.
const noPty = process.platform === "win32" || spawnSync("python3", ["--version"]).error !== undefined;

it.skipIf(noPty)(
	"an external SIGTSTP restores the terminal before the process stops, and SIGCONT restarts the UI once",
	() => {
		const result = spawnSync("python3", ["-c", DRIVER, process.execPath, CHILD], {
			encoding: "utf8",
			timeout: 60_000,
		});
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		const run = JSON.parse(result.stdout) as {
			stopped: boolean;
			suspend: string;
			resume: string;
			reports: Array<{ ready?: boolean; starts?: number; error?: string }>;
			code: number;
		};
		expect(run.stopped).toBe(true);
		// Written before the stop: mouse reports off, bracketed paste off, the keyboard protocol popped, the alternate
		// screen left and the cursor shown.
		expect(run.suspend).toContain("\x1b[?1000l");
		expect(run.suspend).toContain("\x1b[?2004l");
		expect(run.suspend).toContain("\x1b[<u");
		expect(run.suspend).toContain("\x1b[?1049l");
		expect(run.suspend).toContain("\x1b[?25h");
		// The resume enters the alternate screen again, once.
		expect(run.resume.split("\x1b[?1049h")).toHaveLength(2);
		expect(run.reports.filter((report) => report.error)).toEqual([]);
		// The first start plus exactly one restart on SIGCONT.
		expect(run.reports.find((report) => "starts" in report)).toEqual({ starts: 2 });
		expect(run.code).toBe(0);
	},
	70_000,
);
