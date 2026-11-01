import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setKittyProtocolActive } from "../src/keys/state.ts";
import { ProcessTerminal } from "../src/terminal.ts";
import { type FakeTmux, installFakeTmux } from "./helpers/fake-tmux.ts";

const ENABLE = "\x1b[?2004h";
const DISABLE = "\x1b[?2004l";

type Harness = {
	terminal: ProcessTerminal;
	writes: string[];
	inputs: string[];
	resizes: number;
	stdin(data: string): void;
	resize(): void;
	clock: { ms: number };
	cleanup(): void;
};

/** Starts a ProcessTerminal on stubbed stdin/stdout, with a clock the test moves. */
function startTerminal(): Harness {
	const terminal = new ProcessTerminal();
	const writes: string[] = [];
	const inputs: string[] = [];
	const clock = { ms: 10_000 };
	let dataHandler: ((data: string) => void) | undefined;
	let resizeHandler: (() => void) | undefined;
	const original = {
		write: process.stdout.write,
		stdoutOn: process.stdout.on,
		stdinOn: process.stdin.on,
	};
	mock.method(performance, "now", () => clock.ms);
	process.stdout.write = (chunk: string | Uint8Array) => {
		writes.push(String(chunk));
		return true;
	};
	process.stdout.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
		if (event === "resize") resizeHandler = listener;
		return process.stdout;
	}) as typeof process.stdout.on;
	process.stdin.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
		if (event === "data") dataHandler = listener;
		return process.stdin;
	}) as typeof process.stdin.on;
	const harness: Harness = {
		terminal,
		writes,
		inputs,
		resizes: 0,
		clock,
		stdin: (data) => dataHandler?.(data),
		resize: () => resizeHandler?.(),
		cleanup() {
			try {
				terminal.stop();
			} finally {
				process.stdout.write = original.write;
				process.stdout.on = original.stdoutOn;
				process.stdin.on = original.stdinOn;
				setKittyProtocolActive(false);
				mock.restoreAll();
			}
		},
	};
	terminal.start(
		(data) => inputs.push(data),
		() => {
			harness.resizes++;
		},
	);
	return harness;
}

const count = (writes: string[]) => writes.filter((write) => write === ENABLE).length;

describe("ProcessTerminal bracketed paste re-arm", () => {
	let fake: FakeTmux;
	const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };

	beforeEach(() => {
		fake = installFakeTmux({});
	});

	afterEach(() => {
		fake.restore();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("re-sends the enable sequence on input after a tmux pane may have lost the mode", () => {
		process.env.TMUX = "/tmp/tmux-1000/default,1,0";
		const harness = startTerminal();
		try {
			assert.equal(count(harness.writes), 1, "start enables the mode once");

			harness.stdin("a");
			assert.equal(count(harness.writes), 1, "typing right after start does not write again");

			harness.clock.ms += 1500;
			harness.stdin("b");
			assert.equal(count(harness.writes), 2);
			assert.equal(harness.inputs.join(""), "ab", "the key still reaches the input handler");
		} finally {
			harness.cleanup();
		}
	});

	it("writes at most once per interval while the user keeps typing", () => {
		process.env.TMUX = "/tmp/tmux-1000/default,1,0";
		const harness = startTerminal();
		try {
			harness.clock.ms += 1500;
			for (const key of "hello world") {
				harness.clock.ms += 50;
				harness.stdin(key);
			}
			assert.equal(count(harness.writes), 2, "start plus one re-arm for eleven keys");
		} finally {
			harness.cleanup();
		}
	});

	it("re-arms on resize, which tmux sends after a client reattaches with another size", () => {
		process.env.TMUX = "/tmp/tmux-1000/default,1,0";
		const harness = startTerminal();
		try {
			harness.clock.ms += 1500;
			harness.resize();
			assert.equal(count(harness.writes), 2);
			assert.equal(harness.resizes, 1, "the resize callback still runs");
		} finally {
			harness.cleanup();
		}
	});

	it("never re-arms inside a paste, however long it runs", () => {
		process.env.TMUX = "/tmp/tmux-1000/default,1,0";
		const harness = startTerminal();
		try {
			harness.clock.ms += 1500;
			harness.stdin("\x1b[200~line one\n");
			// The start marker is the chunk that finds the mode on, so it may re-arm once before the paste is open.
			const beforeChunks = count(harness.writes);
			for (let i = 0; i < 5; i++) {
				harness.clock.ms += 2000;
				harness.stdin(`line ${i + 2}\n`);
			}
			assert.equal(count(harness.writes), beforeChunks, "no write while the paste is open");

			harness.stdin("last\x1b[201~");
			assert.deepEqual(harness.inputs, ["\x1b[200~line one\nline 2\nline 3\nline 4\nline 5\nline 6\nlast\x1b[201~"]);

			harness.clock.ms += 2000;
			harness.stdin("x");
			assert.equal(count(harness.writes), beforeChunks + 1, "the next key after the paste may re-arm");
		} finally {
			harness.cleanup();
		}
	});

	it("does nothing outside tmux", () => {
		delete process.env.TMUX;
		delete process.env.TMUX_PANE;
		const harness = startTerminal();
		try {
			harness.clock.ms += 5000;
			harness.stdin("a");
			harness.resize();
			assert.equal(count(harness.writes), 1, "only start enables the mode");
		} finally {
			harness.cleanup();
		}
	});

	it("stops re-arming once the terminal is stopped", () => {
		process.env.TMUX = "/tmp/tmux-1000/default,1,0";
		const harness = startTerminal();
		const resize = () => harness.resize();
		harness.cleanup();
		harness.clock.ms += 5000;
		resize();
		assert.equal(count(harness.writes), 1);
		assert.ok(harness.writes.includes(DISABLE), "stop disables the mode");
	});
});
