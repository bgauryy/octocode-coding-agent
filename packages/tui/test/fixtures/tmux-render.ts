/**
 * Fixture for real-tmux renderer tests: renders HISTORY styled lines plus a prompt line with the real
 * ProcessTerminal. Env: HISTORY (line count, default 200), LINE_BYTES (padding per line), TICK_MS (re-render the prompt row at that interval, like a spinner).
 * Prints "READY" on its own once the first frame is written.
 */
import { Text } from "../../src/components/text.ts";
import { ProcessTerminal } from "../../src/terminal.ts";
import { TuiMainScreen } from "../../src/tui-main-screen.ts";

const history = Number(process.env.HISTORY ?? 200);
const pad = "x".repeat(Number(process.env.LINE_BYTES ?? 0));
const lines: string[] = [];
for (let i = 0; i < history; i++) lines.push(`\x1b[3${1 + (i % 6)}mhistory ${i}\x1b[0m ${pad}`);
const tui = new TuiMainScreen(new ProcessTerminal());
tui.addChild(new Text(lines.join("\n"), 0, 0));
const prompt = new Text("PROMPT-LINE", 0, 0);
tui.addChild(prompt);
tui.start();
process.stdin.on("data", (d) => {
	if (String(d).includes("q")) {
		tui.stop();
		process.exit(0);
	}
});
const tick = Number(process.env.TICK_MS ?? 0);
if (tick > 0) {
	let n = 0;
	setInterval(() => {
		prompt.setText(`PROMPT-LINE ${n++ % 10}`);
		tui.requestRender();
	}, tick);
}
