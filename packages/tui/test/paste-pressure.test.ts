import assert from "node:assert/strict";
import { it } from "node:test";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

it("preserves a fragmented large paste, every end-marker split, and the following keys", () => {
	const content = "a文\n".repeat(100_000);
	const marker = "\x1b[201~";
	for (let split = 1; split < marker.length; split++) {
		const buffer = new StdinBuffer();
		const pasted: string[] = [];
		const keys: string[] = [];
		buffer.on("paste", (text) => pasted.push(text));
		buffer.on("data", (text) => keys.push(text));
		try {
			buffer.process("\x1b[200~");
			for (let offset = 0; offset < content.length; offset += 127) buffer.process(content.slice(offset, offset + 127));
			buffer.process(marker.slice(0, split));
			buffer.process(marker.slice(split) + "x\r");
			assert.deepEqual(pasted, [content]);
			assert.deepEqual(keys, ["x", "\r"]);
		} finally {
			buffer.destroy();
		}
	}
});

it("sanitizes a large paste without changing Unicode, tabs, line endings or marker expansion", () => {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
	const content = "a\x00\x09文👨‍👩‍👧‍👦\r\nb\x0b\x1f".repeat(10_000);
	editor.handleInput(`\x1b[200~${content}\x1b[201~`);
	assert.match(editor.getText(), /^\[paste #1 /);
	assert.equal(editor.getExpandedText(), "a    文👨‍👩‍👧‍👦\nb".repeat(10_000));
});
