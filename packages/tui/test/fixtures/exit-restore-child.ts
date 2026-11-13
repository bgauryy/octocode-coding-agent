// Child process for terminal-exit-restore.test.ts: starts a fullscreen TUI on the real process terminal, then
// leaves by the path named in argv[2]. stdout is a pipe, so the test reads the escape sequences it was sent.
import * as fs from "node:fs";
import { ProcessTerminal } from "../../src/terminal.ts";
import { registerExitRestore } from "../../src/terminal/exit-restore.ts";
import { TuiAltScreen } from "../../src/tui-alt-screen.ts";

const how = process.argv[2];
const terminal = new ProcessTerminal();
const tui = new TuiAltScreen(terminal);
tui.addChild({ render: () => ["hello"], invalidate() {} });
tui.start();
tui.renderNow();

setTimeout(() => {
	if (how === "exit") process.exit(0);
	if (how === "status-exit") {
		terminal.setProgramStatus({ state: "working", app: "octocode" });
		process.exit(0);
	}
	if (how === "stop-then-exit") {
		tui.stop({ preserveScreen: true });
		process.exit(0);
	}
	if (how === "dead-terminal") {
		// A restore write to a terminal that hung up, then a later exit listener (one that stops child processes).
		registerExitRestore(() => {
			throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
		});
		process.on("exit", () => fs.writeSync(1, "later exit listener ran\n"));
		process.exit(0);
	}
	if (how === "throw") throw new Error("boom");
	throw new Error(`unknown exit path ${how}`);
}, 100);
