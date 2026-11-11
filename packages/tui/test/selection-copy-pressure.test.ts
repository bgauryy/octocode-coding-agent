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
