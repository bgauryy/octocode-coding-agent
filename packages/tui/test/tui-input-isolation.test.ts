import assert from "node:assert";
import { describe, it, mock } from "node:test";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class InputRecorder implements Component {
	readonly inputs: string[] = [];
	failOn: string | undefined;

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		if (data === this.failOn) throw new Error(`cannot handle ${data}`);
		this.inputs.push(data);
	}

	invalidate(): void {}
}

/** Run `fn` with Promise.reject captured: the interactive session's unhandledRejection listener shows these. */
function captureReports(fn: (reported: unknown[]) => void): void {
	const reported: unknown[] = [];
	const reject = mock.method(Promise, "reject", (error: unknown) => {
		reported.push(error);
		return Promise.resolve();
	});
	try {
		fn(reported);
	} finally {
		reject.mock.restore();
	}
}

function messages(reported: unknown[]): string[] {
	return reported.map((error) => (error as Error).message);
}

describe("TUI input isolation", () => {
	it("a focused component that throws loses that key, reports it once, and keeps receiving input", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		const recorder = new InputRecorder();
		recorder.failOn = "x";
		tui.setFocus(recorder);
		tui.start();
		try {
			captureReports((reported) => {
				assert.doesNotThrow(() => terminal.sendInput("x"));
				assert.doesNotThrow(() => terminal.sendInput("x"));
				terminal.sendInput("q");
				assert.deepStrictEqual(recorder.inputs, ["q"]);
				assert.deepStrictEqual(messages(reported), ["cannot handle x"]);
			});
		} finally {
			tui.stop();
		}
	});

	it("drops an input listener that throws, so later keys reach the focused component", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		const recorder = new InputRecorder();
		let calls = 0;
		tui.addInputListener(() => {
			calls++;
			throw new Error("stale extension listener");
		});
		tui.setFocus(recorder);
		tui.start();
		try {
			captureReports((reported) => {
				terminal.sendInput("a");
				terminal.sendInput("b");
				assert.strictEqual(calls, 1);
				assert.deepStrictEqual(recorder.inputs, ["a", "b"]);
				assert.deepStrictEqual(messages(reported), ["stale extension listener"]);
			});
		} finally {
			tui.stop();
		}
	});
});
