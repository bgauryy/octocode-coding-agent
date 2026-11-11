import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const commands = new URL("../src/core/package-manager/commands.ts", import.meta.url).href;
const terminal = new URL("../../tui/src/terminal.ts", import.meta.url).href;

/** Runs `NODE --eval SOURCE` on a PTY slave as stdin, stdout and stderr, draining the master; prints the result fd. */
const DRIVER = `
import os, pty, select, subprocess, sys
master, slave = pty.openpty()
read_end, write_end = os.pipe()
env = dict(os.environ, RESULT_FD=str(write_end))
child = subprocess.Popen([sys.argv[1], "--input-type=module", "--eval", sys.argv[2]], stdin=slave, stdout=slave,
                         stderr=slave, pass_fds=(write_end,), env=env)
os.close(slave)
os.close(write_end)
result = b""
while True:
    ready, _, _ = select.select([master, read_end], [], [], 10)
    if not ready:
        child.kill()
        sys.exit("timed out")
    for fd in ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            chunk = b""
        if fd == read_end:
            if not chunk:
                child.wait(timeout=5)
                sys.stdout.write(result.decode())
                sys.exit(child.returncode)
            result += chunk
`;

/** The terminal UI holds the PTY while a package command runs, then releases it and runs one more. */
const CHILD = `
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
const { runCommand } = await import(${JSON.stringify(commands)});
const { ProcessTerminal } = await import(${JSON.stringify(terminal)});
// The flag belongs to the open file, so a child given stdout as fd 3 reads what this process writes with.
const stdoutMode = () => spawnSync("python3", ["-c", "import fcntl, os; print('nonblocking' if fcntl.fcntl(3, fcntl.F_GETFL) & os.O_NONBLOCK else 'blocking')"], { stdio: ["ignore", "pipe", "ignore", 1], encoding: "utf8" }).stdout.trim();
const stdinIsTerminal = (expected) => runCommand(process.execPath, ["-e", "process.exit(require('node:tty').isatty(0) === " + expected + " ? 0 : 3)"]).then(() => true, () => false);
const ui = new ProcessTerminal();
ui.start(() => {}, () => {});
const owned = { before: stdoutMode() };
owned.childGotNoInput = await stdinIsTerminal(false);
owned.after = stdoutMode();
ui.stop();
const childGotTerminal = await stdinIsTerminal(true);
writeSync(Number(process.env.RESULT_FD), JSON.stringify({ owned, childGotTerminal }));
process.exit(0);
`;

// A POSIX PTY regression; python3 owns the PTY.
const noPty = process.platform === "win32" || spawnSync("python3", ["--version"]).error !== undefined;

it.skipIf(noPty)("keeps a running terminal UI's output nonblocking while a package command runs", () => {
	const result = spawnSync("python3", ["-c", DRIVER, process.execPath, CHILD], { encoding: "utf8", timeout: 20_000 });
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		owned: { before: "nonblocking", childGotNoInput: true, after: "nonblocking" },
		childGotTerminal: true,
	});
});
