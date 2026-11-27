// Child for terminal-typeahead.test.ts: waits in line mode until SIGUSR1, then starts the terminal UI and reports every
// input it receives, joined, once a raw line feed arrived after the typed-ahead text.
import { writeSync } from "node:fs";
import { ProcessTerminal } from "../../src/terminal.ts";

const report = (value: object) => writeSync(Number(process.env.RESULT_FD), `${JSON.stringify(value)}\n`);
const keepAlive = setInterval(() => {}, 1000);
process.once("SIGUSR1", () => {
	const terminal = new ProcessTerminal();
	let inputs = "";
	terminal.start(
		(data) => {
			inputs += data;
			if (!inputs.endsWith("partial\n")) return;
			report({ inputs });
			terminal.stop();
			clearInterval(keepAlive);
			process.exit(0);
		},
		() => {},
	);
	report({ started: true });
});
report({ cooked: true });
