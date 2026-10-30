/**
 * Fixture for real-tmux alternate-screen tests: an alternate-screen TUI over HISTORY lines. Pressing any key stops it,
 * which prints the whole document into the normal screen (the path that restores the alternate screen).
 */
import { Text } from "../../src/components/text.ts";
import { ProcessTerminal } from "../../src/terminal.ts";
import { TuiAltScreen } from "../../src/tui-alt-screen.ts";

const history = Number(process.env.HISTORY ?? 200);
const lines: string[] = [];
for (let i = 0; i < history; i++) lines.push(`\x1b[3${1 + (i % 6)}mhistory ${i}\x1b[0m xxxxxxxxxxxxxxxxxxxx`);
const tui = new TuiAltScreen(new ProcessTerminal(), false);
tui.addChild(new Text(lines.join("\n"), 0, 0));
tui.addChild(new Text("PROMPT-LINE", 0, 0));
tui.start();
process.stdin.on("data", () => {
	tui.stop();
	process.exit(0);
});
