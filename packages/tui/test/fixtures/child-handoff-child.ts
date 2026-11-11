import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { ProcessTerminal } from "../../src/terminal.ts";

// The terminal is handed to a child that inherits stdout (an external editor, a sign-in CLI), then taken back.
const health = (message: string) => writeSync(Number(process.env.OUTPUT_HEALTH_FD), `${message}\n`);
const terminal = new ProcessTerminal();
terminal.start(
	() => {},
	() => {},
);
terminal.stop();
const child = spawnSync("true", [], { stdio: "inherit" });
if (child.status !== 0) throw new Error(`handoff child failed: ${String(child.error ?? child.status)}`);
terminal.start(
	() => {},
	() => {},
);
let ticks = 0;
const timer = setInterval(() => health(`tick:${++ticks}`), 25);
health(`tty:${process.stdout.isTTY}`);
terminal.write("x".repeat(1024 * 1024));
terminal.write("end");
health(`returned:${terminal.pendingOutputBytes}`);
health(`deadline:${await terminal.drainOutput(50)}`);
if (!(await terminal.drainOutput(5000))) throw new Error("output did not drain");
clearInterval(timer);
terminal.stop();
if (!(await terminal.drainOutput(1000))) throw new Error("terminal restore output did not drain");
health("drained");
process.exit(0);
