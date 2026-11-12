// Child process for terminal-exit-restore.test.ts: starts a fullscreen TUI on the real process terminal, then
// leaves by the path named in argv[2]. stdout is a pipe, so the test reads the escape sequences it was sent.
import { ProcessTerminal } from "../../src/terminal.ts";
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
	if (how === "throw") throw new Error("boom");
	throw new Error(`unknown exit path ${how}`);
}, 100);
