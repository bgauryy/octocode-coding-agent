import type { Terminal } from "@octocodeai/octocode-tui";

/** A terminal that records writes; enough of `Terminal` for the Ink host. */
export function fakeTerminal(columns = 40, rows = 10): Terminal & { output: string[] } {
	const output: string[] = [];
	const noop = () => {};
	return {
		output,
		columns,
		rows,
		kittyProtocolActive: false,
		start: noop,
		stop: noop,
		drainInput: async () => {},
		write: (data: string) => {
			output.push(data);
		},
		moveBy: noop,
		hideCursor: noop,
		showCursor: noop,
		clearLine: noop,
		clearFromCursor: noop,
		clearScreen: noop,
		setTitle: noop,
		setProgress: noop,
		setProgramStatus: noop,
	};
}
