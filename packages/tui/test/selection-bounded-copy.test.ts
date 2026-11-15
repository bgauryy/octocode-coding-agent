import assert from "node:assert/strict";
import { it } from "node:test";
import { AltScreenSelection, type AltScreenSelectionHost } from "../src/tui-alt-screen/selection-controller.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function fixture(lines: readonly string[], copySelection?: (text: string) => Promise<boolean | string>) {
	const terminal = new VirtualTerminal();
	const writes: string[] = [];
	terminal.write = (text) => writes.push(text);
	const flashes: string[] = [];
	const host: AltScreenSelectionHost = {
		getTerminal: () => terminal,
		getPreviousScreen: () => lines,
		getCurrentLayout: () => undefined,
		hasOverlay: () => false,
		requestRender() {},
		getCopyOnSelect: () => true,
		flash: (message) => flashes.push(message),
		copySelection,
		createMouseEvent() {
			throw new Error("fixture does not dispatch mouse events");
		},
		dispatchMouseToOverlay: () => ({ hit: false }),
		dispatchMouseToLayout: () => undefined,
		applyMouseDispatchResult: () => false,
	};
	const selection = new AltScreenSelection(host);
	selection.selectionAnchor = { row: 0, col: 0 };
	selection.selectionFocus = { row: lines.length - 1, col: 1 };
	return { selection, writes, flashes };
}

it("stops reading an oversized OSC52 selection before later rows and still permits a later small copy", async () => {
	const rows = Array.from({ length: 100_000 }, () => "界".repeat(40));
	let read = 0;
	const lines = new Proxy(rows, {
		get(target, key, receiver) {
			if (typeof key === "string" && /^\d+$/.test(key)) {
				read++;
				assert.ok(Number(key) < 1000, "oversized transfer must stop before reading the rest");
			}
			return Reflect.get(target, key, receiver);
		},
	});
	const { selection, writes, flashes } = fixture(lines);
	assert.equal(selection.hasActiveSelection(), true);
	assert.equal(read, 1);
	assert.equal(await selection.copySelectionToClipboard(), false);
	assert.equal(writes.length, 0);
	assert.match(flashes[0], /exceeds terminal clipboard limit/);
	selection.selectionAnchor = { row: 0, col: 0 };
	selection.selectionFocus = { row: 0, col: 1 };
	assert.equal(await selection.copySelectionToClipboard(), true);
	assert.equal(writes[0], `\x1b]52;c;${Buffer.from("界").toString("base64")}\x07`);
});

it("passes a selection beyond the OSC52 limit whole to an injected clipboard", async () => {
	const lines = Array.from({ length: 2000 }, () => "native 文 ".repeat(15));
	let received = "";
	const { selection, writes } = fixture(lines, async (text) => {
		received = text;
		return true;
	});
	selection.selectionFocus = { row: lines.length - 1, col: 1000 };
	assert.equal(await selection.copySelectionToClipboard(), true);
	assert.ok(Buffer.byteLength(received) > 75_000);
	assert.equal(received, lines.map((line) => line.trimEnd()).join("\n"));
	assert.equal(writes.length, 0);
});

it("detects empty selections without extracting an entire multi-row selection", () => {
	const { selection } = fixture(["", ""]);
	selection.selectionFocus = { row: 0, col: 2 };
	assert.equal(selection.hasActiveSelection(), false);
	selection.selectionFocus = { row: 1, col: 0 };
	assert.equal(selection.hasActiveSelection(), true);
});

it("counts inserted newlines toward the existing base64 transfer boundary", async () => {
	const exact = fixture(["x".repeat(74_998), "y"]);
	exact.selection.selectionFocus = { row: 1, col: 0 };
	assert.equal(await exact.selection.copySelectionToClipboard(), true);
	const over = fixture(["x".repeat(74_999), "y"]);
	over.selection.selectionFocus = { row: 1, col: 0 };
	assert.equal(await over.selection.copySelectionToClipboard(), false);
	assert.equal(over.writes.length, 0);
});
