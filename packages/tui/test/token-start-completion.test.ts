import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import {
	FILE_INDEX_MISS_REFRESH_MS,
	FILE_INDEX_REFRESH_MS,
	resetFileIndexCache,
} from "../src/autocomplete/file-index.ts";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

describe("@ mentions of files created after the index was built", () => {
	let dir: string;
	let editor: Editor;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "token-start-"));
		resetFileIndexCache();
		writeFileSync(join(dir, "README.md"), "x");
		editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], dir));
	});

	afterEach(() => {
		mock.restoreAll();
		rmSync(dir, { recursive: true, force: true });
		resetFileIndexCache();
	});

	const type = async (text: string) => {
		for (const char of text) editor.handleInput(char);
		await settle();
	};
	const rendered = () => stripTerminalSequences(editor.render(80).join("\n"));

	/** Waits for the index build (a subprocess, slower under a loaded suite) instead of a fixed sleep. */
	const until = async (name: string) => {
		for (let waited = 0; waited < 3000 && !rendered().includes(name); waited += 50) await settle(50);
	};

	it("lists a root file created after an earlier @ built the index", async () => {
		await type("@READ");
		await until("README.md");
		assert.ok(rendered().includes("README.md"));
		editor.setText("");
		writeFileSync(join(dir, "CHECK.md"), "x");
		const realNow = Date.now();
		mock.method(Date, "now", () => realNow + FILE_INDEX_REFRESH_MS + 1);
		await type("see @CHECK");
		await until("CHECK.md");
		assert.ok(rendered().includes("CHECK.md"), rendered());
	});

	it("rebuilds on a miss once the index is a second old", async () => {
		await type("@READ");
		await until("README.md");
		editor.setText("");
		writeFileSync(join(dir, "FRESH.md"), "x");
		const realNow = Date.now();
		mock.method(Date, "now", () => realNow + FILE_INDEX_MISS_REFRESH_MS + 1);
		await type("see @FRESH");
		await until("FRESH.md");
		assert.ok(rendered().includes("FRESH.md"), rendered());
	});
});

describe("/ at a token start", () => {
	let dir: string;
	let editor: Editor;
	let submitted: string[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "token-start-slash-"));
		resetFileIndexCache();
		editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				[
					{ name: "model", description: "Pick a model" },
					{ name: "import", description: "Import a session", argumentKind: "path" },
					{ name: "skill:research", description: "Research skill" },
					{ name: "skill:review", description: "Review skill" },
					{ name: "planner", description: "Planning skill", skill: true },
				],
				dir,
			),
		);
		submitted = [];
		editor.onSubmit = (text) => submitted.push(text);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetFileIndexCache();
	});

	const type = async (text: string) => {
		for (const char of text) editor.handleInput(char);
		await settle();
	};
	const rendered = () => stripTerminalSequences(editor.render(80).join("\n"));

	it("opens the full command menu at the start of the input", async () => {
		await type("/");
		assert.ok(editor.isShowingAutocomplete());
		assert.ok(rendered().includes("model"));
	});

	it("opens a skills-only menu after whitespace mid-text", async () => {
		await type("please use /");
		assert.ok(editor.isShowingAutocomplete());
		const text = rendered();
		assert.ok(text.includes("skill:research"));
		assert.ok(!text.includes("model"));
	});

	it("lists a skill the app names bare (no skill: prefix) mid-text, and Enter inserts it", async () => {
		await type("please use /plan");
		assert.ok(editor.isShowingAutocomplete(), rendered());
		assert.ok(rendered().includes("planner"));
		editor.handleInput("\r");
		await settle();
		assert.strictEqual(editor.getText(), "please use /planner ");
		assert.deepStrictEqual(submitted, []);
	});

	it("opens the skills menu at the start of a later line", async () => {
		await type("first");
		editor.handleInput("\x1b\r");
		await type("/re");
		assert.ok(editor.isShowingAutocomplete());
		assert.ok(rendered().includes("skill:review"));
	});

	it("Tab inserts the skill at the cursor and Enter never submits it", async () => {
		await type("use /rese");
		editor.handleInput("\r");
		await settle();
		assert.strictEqual(editor.getText(), "use /skill:research ");
		assert.deepStrictEqual(submitted, []);
		await type("and /");
		assert.ok(editor.isShowingAutocomplete());
	});

	it("Enter on a command's absolute-path argument completion submits the command", async () => {
		writeFileSync(join(dir, "keep.jsonl"), "x");
		await type(`/import ${join(dir, "keep.js")}`);
		assert.ok(editor.isShowingAutocomplete(), rendered());
		editor.handleInput("\r");
		await settle();
		assert.deepStrictEqual(submitted, [`/import ${join(dir, "keep.jsonl")}`]);
	});

	it("does not open for a slash inside a path or URL", async () => {
		await type("see a/");
		assert.strictEqual(editor.isShowingAutocomplete(), false);
		editor.setText("");
		await type("https://");
		assert.strictEqual(editor.isShowingAutocomplete(), false);
		editor.setText("");
		await type("src/mo");
		assert.strictEqual(editor.isShowingAutocomplete(), false);
	});
});
