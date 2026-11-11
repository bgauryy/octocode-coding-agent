import { writeSync } from "node:fs";
import { ProcessTerminal } from "../../src/terminal.ts";
import { TuiAltScreen } from "../../src/tui-alt-screen.ts";

const terminal = new ProcessTerminal();
const tui = new TuiAltScreen(terminal);
tui.addChild({ render: () => ["hello"], invalidate() {} });
tui.start();
tui.renderNow();
terminal.setProgress(true);
terminal.write("x".repeat(1024 * 1024));
writeSync(Number(process.env.OUTPUT_HEALTH_FD), "queued\n");
if (process.argv[2] === "stopped" || process.argv[2] === "drained") {
	tui.stop({ preserveScreen: true });
	await terminal.drainOutput(process.argv[2] === "stopped" ? 25 : 5000);
}
process.exit(0);
