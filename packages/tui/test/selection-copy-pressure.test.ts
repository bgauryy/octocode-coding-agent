import assert from "node:assert/strict";
import { it } from "node:test";
import { AltScreenSelection, type AltScreenSelectionHost } from "../src/tui-alt-screen/selection-controller.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

it("rejects oversized terminal clipboard transfers and permits a later small copy", async () => {
	const terminal = new VirtualTerminal();
	const writes: string[] = [];
	terminal.write = (data) => {
		writes.push(data);
	};
	const messages: string[] = [];
	const host: AltScreenSelectionHost = {
		getTerminal: () => terminal,
		flash: (message) => {
			messages.push(message);
		},
		getCurrentLayout: () => undefined,
		getPreviousScreen: () => [],
		hasOverlay: () => false,
		requestRender() {},
		getCopyOnSelect: () => true,
		createMouseEvent() {
			throw new Error("copy test does not dispatch mouse input");
		},
		dispatchMouseToOverlay: () => ({ hit: false }),
		dispatchMouseToLayout: () => undefined,
		applyMouseDispatchResult: () => false,
	};
	const selection = new AltScreenSelection(host);
	assert.equal(await selection.copyTextToClipboard("界".repeat(30_000)), false);
	assert.equal(writes.length, 0);
	assert.match(messages[0], /exceeds terminal clipboard limit/);
	assert.equal(await selection.copyTextToClipboard("copied"), true);
	assert.equal(writes[0], "\x1b]52;c;Y29waWVk\x07");
});

function copyHost(screen: string[], copied: string[], messages: string[]): AltScreenSelectionHost {
	return {
		getTerminal: () => new VirtualTerminal(),
		flash: (message) => {
			messages.push(message);
		},
		getCurrentLayout: () => undefined,
		getPreviousScreen: () => screen,
		hasOverlay: () => false,
		requestRender() {},
		getCopyOnSelect: () => true,
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
		createMouseEvent() {
			throw new Error("copy test does not dispatch mouse input");
		},
		dispatchMouseToOverlay: () => ({ hit: false }),
		dispatchMouseToLayout: () => undefined,
		applyMouseDispatchResult: () => false,
	};
}

for (const rows of [1_000, 10_000, 100_000]) {
	it(`yields to timers while extracting a ${rows}-row selection and keeps exact text`, async () => {
		const screen = Array.from({ length: rows }, (_, i) => `\x1b[31m行${i} 界界界界 text\x1b[0m`);
		const copied: string[] = [];
		const messages: string[] = [];
		const selection = new AltScreenSelection(copyHost(screen, copied, messages));
		selection.selectionAnchor = { row: 0, col: 0 };
		selection.selectionFocus = { row: rows - 1, col: 1000 };
		// Extraction yields after each time slice. A clock that moves 1 ms a reading makes the yield count independent of
		// host speed; the event-loop gap is measured on the real monotonic clock.
		const realNow = performance.now.bind(performance);
		const realImmediate = globalThis.setImmediate;
		let clock = realNow();
		let yields = 0;
		performance.now = () => (clock += 1);
		globalThis.setImmediate = ((...args: Parameters<typeof setImmediate>) => {
			yields++;
			return realImmediate(...args);
		}) as typeof setImmediate;
		const realMs = () => Number(process.hrtime.bigint()) / 1e6;
		let last = realMs();
		let maxGap = 0;
		const timer = setInterval(() => {
			const now = realMs();
			maxGap = Math.max(maxGap, now - last);
			last = now;
		}, 1);
		try {
			assert.equal(await selection.copySelectionToClipboard(), true);
		} finally {
			clearInterval(timer);
			performance.now = realNow;
			globalThis.setImmediate = realImmediate;
		}
		assert.equal(copied.length, 1);
		assert.equal(copied[0].split("\n").length, rows);
		assert.equal(copied[0].split("\n")[rows - 1], `行${rows - 1} 界界界界 text`);
		assert.deepEqual(messages, ["Copied!"]);
		if (rows >= 100_000) {
			assert.ok(yields > 5, `extraction yielded to the event loop (${yields})`);
			assert.ok(maxGap < 150, `event loop gap ${maxGap}ms`);
		}
	});
}

it("reports a superseded copy instead of silently dropping it", async () => {
	const screen = Array.from({ length: 50_000 }, (_, i) => `行${i} 界界界界 text`);
	const copied: string[] = [];
	const messages: string[] = [];
	const selection = new AltScreenSelection(copyHost(screen, copied, messages));
	selection.selectionAnchor = { row: 0, col: 0 };
	selection.selectionFocus = { row: screen.length - 1, col: 1000 };
	// Extraction yields only after a time slice; a clock that moves 1 ms a reading makes it yield on any machine.
	const realNow = performance.now.bind(performance);
	let clock = realNow();
	performance.now = () => (clock += 1);
	try {
		const first = selection.copySelectionToClipboard();
		const second = selection.copySelectionToClipboard();
		assert.equal(await first, false);
		assert.equal(await second, true);
	} finally {
		performance.now = realNow;
	}
	assert.match(messages[0], /Copy cancelled/);
	assert.equal(copied.length, 1);
});
