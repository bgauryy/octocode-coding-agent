import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { createChatViewport } from "../src/layout/chat-viewport.ts";
import { Container } from "../src/tui/container.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Rows {
	private readonly lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render() {
		return this.lines;
	}
	invalidate() {}
}

const PROMPT = "LAST-SUBMITTED-PROMPT";

async function withChat(run: (ctx: { terminal: VirtualTerminal; editor: Editor }) => Promise<void>) {
	const terminal = new VirtualTerminal(40, 12);
	const tui = new TuiAltScreen(terminal);
	const document = new Container();
	for (let i = 0; i < 40; i++) document.addChild(new Rows([`row ${i}`]));
	const editor = new Editor(tui, defaultEditorTheme);
	editor.addToHistory(PROMPT);
	const viewport = createChatViewport({
		document,
		pendingMessages: new Container(),
		status: new Rows([]),
		editor,
		footer: new Rows(["footer"]),
	});
	tui.setLayoutRoot(viewport.root);
	tui.setFocus(editor);
	tui.start();
	try {
		await terminal.waitForRender();
		await run({ terminal, editor });
	} finally {
		tui.stop();
	}
}

const top = (terminal: VirtualTerminal) => terminal.getViewport()[0]?.trim();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("arrow keys sent for the wheel", () => {
	for (const [name, up] of [
		["CSI A", "\x1b[A"],
		["SS3 A", "\x1bOA"],
	] as const) {
		it(`scroll the transcript and leave the editor alone (${name})`, async () => {
			await withChat(async ({ terminal, editor }) => {
				const before = top(terminal);
				for (let i = 0; i < 3; i++) terminal.sendInput(up);
				await terminal.waitForRender();
				await delay(20);
				assert.equal(editor.getText(), "");
				assert.notEqual(top(terminal), before);
			});
		});
	}

	it("scroll back down with Down arrows", async () => {
		await withChat(async ({ terminal, editor }) => {
			for (let i = 0; i < 4; i++) terminal.sendInput("\x1b[A");
			await terminal.waitForRender();
			const scrolled = top(terminal);
			for (let i = 0; i < 4; i++) terminal.sendInput("\x1bOB");
			await terminal.waitForRender();
			await delay(20);
			assert.equal(editor.getText(), "");
			assert.notEqual(top(terminal), scrolled);
		});
	});

	for (const up of ["\x1b[A", "\x1bOA"]) {
		it(`still recall history for a single Up (${JSON.stringify(up)})`, async () => {
			await withChat(async ({ terminal, editor }) => {
				const before = top(terminal);
				terminal.sendInput(up);
				await delay(20);
				assert.equal(editor.getText(), PROMPT);
				assert.equal(top(terminal), before);
			});
		});
	}

	it("deliver a held arrow before the key that follows it", async () => {
		await withChat(async ({ terminal, editor }) => {
			terminal.sendInput("\x1b[A");
			terminal.sendInput("x");
			await delay(20);
			assert.equal(editor.getText(), `x${PROMPT}`);
		});
	});
});
