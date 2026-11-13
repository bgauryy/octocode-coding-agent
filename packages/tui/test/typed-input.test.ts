import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import type { AutocompleteProvider } from "../src/autocomplete/types.ts";
import { Editor } from "../src/components/editor.ts";
import {
	getKeybindings,
	type Keybinding,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "../src/keybindings.ts";

const BINDINGS = Object.keys(TUI_KEYBINDINGS) as Keybinding[];
import { matchesKey } from "../src/keys/match.ts";
import { setKittyProtocolActive } from "../src/keys/state.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import type { Component } from "../src/tui/component.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { randomChunks, randomStream, rng } from "./helpers/key-corpus.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const original = getKeybindings();
afterEach(() => {
	setKeybindings(original);
	setKittyProtocolActive(false);
});

describe("typed characters and keybindings", () => {
	it("answers a typed character from its bindings exactly as the matcher does", () => {
		// Printable keys bound on purpose, so the per-character table has entries to get wrong.
		const user = {
			"tui.editor.undo": ["ctrl+-", "z"],
			"tui.editor.jumpForward": ["ctrl+]", "~"],
			"tui.input.submit": "shift+s",
		} as KeybindingsConfig;
		for (const kitty of [false, true]) {
			setKittyProtocolActive(kitty);
			const manager = new KeybindingsManager(TUI_KEYBINDINGS, user);
			for (let code = 0x20; code < 0x7f; code++) {
				const char = String.fromCharCode(code);
				for (const binding of BINDINGS) {
					const expected = manager.getKeys(binding).some((key) => matchesKey(char, key));
					assert.strictEqual(manager.matches(char, binding), expected, `${kitty} ${binding} ${JSON.stringify(char)}`);
				}
			}
		}
	});

	it("matches pre-parsed bindings as matchesKey matches each key id, for random terminal input", () => {
		const random = rng(11);
		const corpus = Array.from({ length: 2000 }, () => randomStream(random, 1));
		for (const kitty of [false, true]) {
			setKittyProtocolActive(kitty);
			const manager = new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.editor.undo": ["ctrl+-", "z"],
			});
			for (const data of corpus) {
				for (const binding of BINDINGS) {
					const expected = manager.getKeys(binding).some((key) => matchesKey(data, key));
					assert.strictEqual(manager.matches(data, binding), expected, `${binding} ${JSON.stringify(data)}`);
				}
			}
		}
	});
});

describe("StdinBuffer typed runs", () => {
	it("emits the same keys as one code point at a time, joined only between typed characters", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const options = { timeout: 8, escapeTimeout: 4, pasteTimeout: 15 };
		for (let seed = 1; seed <= 200; seed++) {
			const random = rng(seed);
			const text = randomStream(random, 30);
			const chunks = randomChunks(random, text);
			const record = (buffer: StdinBuffer) => {
				const events: string[] = [];
				buffer.on("data", (data) => events.push(data));
				buffer.on("paste", (paste) => events.push(`\x00paste:${paste}`));
				return events;
			};
			const keys = new StdinBuffer({ ...options, typedRuns: false });
			const runs = new StdinBuffer(options);
			const expected = record(keys);
			const actual = record(runs);
			for (const chunk of chunks) {
				keys.process(chunk);
				runs.process(chunk);
				if (random() < 0.2) t.mock.timers.tick(1 + Math.floor(random() * 10));
			}
			t.mock.timers.tick(50);
			keys.destroy();
			runs.destroy();
			const split = actual.flatMap((event) => (/^[^\x00-\x1f\x7f-\x9f]{2,}$/u.test(event) ? [...event] : [event]));
			assert.deepStrictEqual(split, expected, `seed ${seed}`);
		}
	});

	it("keeps characters single after a partial keyboard protocol reply", () => {
		const buffer = new StdinBuffer();
		const events: string[] = [];
		buffer.on("data", (data) => events.push(data));
		buffer.process("ab");
		// The sequence timeout emitted the start of a reply; the reply parser downstream joins what follows one by one.
		(buffer as unknown as { emitDataSequence(sequence: string): void }).emitDataSequence("\x1b[?6");
		buffer.process("2;22cxy");
		buffer.destroy();
		// The reply ended at "c": input after it joins again.
		assert.deepStrictEqual(events, ["ab", "\x1b[?6", "2", ";", "2", "2", "c", "xy"]);
	});
});

class Recorder implements Component {
	keys: string[] = [];
	render(): string[] {
		return [];
	}
	invalidate(): void {}
	handleInput(data: string): void {
		this.keys.push(data);
	}
}

describe("TUI delivery of a typed run", () => {
	it("routes each character through listeners and gives a component without handleTextRun one key at a time", () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const recorder = new Recorder();
		tui.addChild(recorder);
		tui.setFocus(recorder);
		const seen: string[] = [];
		tui.addInputListener((data) => {
			seen.push(data);
			return data === "x" ? { consume: true } : data === "y" ? { data: "Y" } : undefined;
		});
		tui.start();
		terminal.sendInput("héx😀y世");
		tui.stop();
		assert.deepStrictEqual(seen, ["h", "é", "x", "😀", "y", "世"]);
		assert.deepStrictEqual(recorder.keys, ["h", "é", "😀", "Y", "世"]);
	});

	it("leaves an editor as typing the run key by key does, listeners included", () => {
		const terminal = new VirtualTerminal(60, 10);
		const tui = new TuiMainScreen(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		const reference = new Editor(tui, defaultEditorTheme);
		const changes: string[] = [];
		editor.onChange = (text) => changes.push(text);
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.addInputListener((data) => (data === "#" ? { consume: true } : undefined));
		tui.start();
		terminal.sendInput("one two#three  four");
		tui.stop();
		for (const char of "one twothree  four") reference.handleInput(char);
		assert.strictEqual(editor.getText(), reference.getText());
		assert.deepStrictEqual(editor.getCursor(), reference.getCursor());
		// One change for the run.
		assert.deepStrictEqual(changes, ["one twothree  four"]);
		assert.deepStrictEqual(undoTrail(editor), undoTrail(reference));
	});

	it("sends the keys after one that opens an overlay to the overlay", () => {
		const terminal = new VirtualTerminal(60, 10);
		const tui = new TuiMainScreen(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		const overlay = new Recorder();
		const inner = editor.handleInput;
		// A key handler the app puts in front of the editor: "?" opens an overlay that takes focus.
		const wrapper = (data: string) => {
			if (data === "?") tui.showOverlay(overlay);
			else inner.call(editor, data);
		};
		editor.handleInput = Object.assign(wrapper, { wraps: inner, takesTyped: (char: string) => char === "?" });
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		terminal.sendInput("ab?cd");
		tui.stop();
		assert.strictEqual(editor.getText(), "ab");
		assert.deepStrictEqual(overlay.keys, ["c", "d"]);
	});
});

/** Hand `text` to `editor.handleTextRun` until all of it is handled, as the TUI does while focus stays put. */
function typeRun(editor: Editor, text: string): void {
	for (let rest = text; rest;) rest = rest.slice(editor.handleTextRun(rest));
}

/** The texts that undo walks back through, until it changes nothing. */
function undoTrail(editor: Editor): string[] {
	const trail = [editor.getText()];
	for (let i = 0; i < 200; i++) {
		editor.handleInput("\x1f"); // ctrl+- undo
		const text = editor.getText();
		if (text === trail[trail.length - 1] && i > 0) break;
		trail.push(text);
	}
	return trail;
}

function provider(log: string[]): AutocompleteProvider {
	return {
		triggerCharacters: ["$"],
		getSuggestions: async (lines, cursorLine, cursorCol) => {
			const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
			log.push(before);
			const token = /(?:^|\s)([@$/][\w.]*)$/.exec(before)?.[1];
			if (!token) return null;
			return {
				prefix: token,
				items: ["a", "ab", "abc"].map((value) => ({ value: `${token[0]}${value}`, label: value })),
			};
		},
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
			const line = lines[cursorLine] ?? "";
			const next = [...lines];
			next[cursorLine] = line.slice(0, cursorCol - prefix.length) + item.value + line.slice(cursorCol);
			return { lines: next, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
		},
	};
}

/** Editor state a typed run must leave as typing it key by key does. */
function snapshot(editor: Editor) {
	const model = (editor as unknown as { model: Record<string, any> }).model;
	const autocomplete = model.autocomplete;
	return {
		text: editor.getText(),
		cursor: editor.getCursor(),
		lastAction: model.lastAction,
		jumpMode: model.jumpMode,
		showing: editor.isShowingAutocomplete(),
		pending: editor.hasPendingAutocomplete(),
		debounced: autocomplete.autocompleteDebounceTimer !== undefined,
		dismissed: autocomplete.dismissed,
		prefix: autocomplete.autocompletePrefix,
		undo: model.undoStack.length,
	};
}

// Past the 60 ms `@` debounce and the provider answer.
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("Editor.handleTextRun", () => {
	it("equals typing each character, for random runs, lists, dismissals and bound printable keys", async () => {
		// "~" starts a jump and "z" undoes: such characters take the per-key path inside a run.
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.editor.jumpForward": ["ctrl+]", "~"],
				"tui.editor.undo": ["ctrl+-", "z"],
			}),
		);
		const alphabet = [
			"a",
			"b",
			"c",
			"x",
			" ",
			" ",
			"@",
			"$",
			"/",
			'"',
			"(",
			".",
			"-",
			"_",
			"~",
			"z",
			"é",
			"世",
			"，",
			"😀",
			"1",
		];
		for (let seed = 1; seed <= 30; seed++) {
			const random = rng(seed);
			const tui = new TuiMainScreen(new VirtualTerminal(80, 24));
			const runLog: string[] = [];
			const keyLog: string[] = [];
			const run = new Editor(tui, defaultEditorTheme);
			const keys = new Editor(tui, defaultEditorTheme);
			run.setAutocompleteProvider(provider(runLog));
			keys.setAutocompleteProvider(provider(keyLog));
			for (let phase = 0; phase < 4; phase++) {
				const length = 1 + Math.floor(random() * 30);
				let text = "";
				for (let i = 0; i < length; i++) text += alphabet[Math.floor(random() * alphabet.length)];
				typeRun(run, text);
				for (const char of text) keys.handleInput(char);
				assert.deepStrictEqual(snapshot(run), snapshot(keys), `seed ${seed} phase ${phase} ${JSON.stringify(text)}`);
				if (random() < 0.3) {
					run.handleInput("\x1b");
					keys.handleInput("\x1b");
				}
				await settle();
				assert.deepStrictEqual(snapshot(run), snapshot(keys), `seed ${seed} phase ${phase} settled`);
				assert.deepStrictEqual(runLog, keyLog, `seed ${seed} phase ${phase} requests`);
			}
			assert.deepStrictEqual(undoTrail(run), undoTrail(keys), `seed ${seed} undo`);
		}
	});
});

describe("autocomplete results after a key", () => {
	it("asks for another frame only when the list looks different", async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(80, 24));
		let requests = 0;
		const requestRender = tui.requestRender.bind(tui);
		tui.requestRender = (force?: boolean) => {
			requests++;
			requestRender(force);
		};
		const editor = new Editor(tui, defaultEditorTheme);
		let items = ["alpha", "beta"];
		editor.setAutocompleteProvider({
			getSuggestions: async (lines, cursorLine, cursorCol) => {
				const token = /@\w*$/.exec((lines[cursorLine] ?? "").slice(0, cursorCol))?.[0];
				return token ? { prefix: token, items: items.map((value) => ({ value: `@${value}`, label: value })) } : null;
			},
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		});
		editor.handleInput("@");
		await settle();
		assert.ok(editor.isShowingAutocomplete());
		editor.render(80);

		requests = 0;
		editor.handleInput("z");
		await settle();
		assert.strictEqual(requests, 0, "same rows: the key's own frame shows them");

		items = ["gamma"];
		editor.handleInput("z");
		await settle();
		assert.strictEqual(requests, 1, "new rows: one frame for them");
	});
});

describe("a wrapped handleInput and typed runs", () => {
	const wrap = (editor: Editor, takesTyped?: (char: string) => boolean) => {
		const inner = editor.handleInput;
		const seen: string[] = [];
		const wrapper = (data: string) => {
			seen.push(data);
			inner.call(editor, data);
		};
		editor.handleInput = takesTyped ? Object.assign(wrapper, { wraps: inner, takesTyped }) : wrapper;
		return seen;
	};

	it("gives an unmarked wrapper every character, and a marked one only the characters it takes", () => {
		const tui = new TuiMainScreen(new VirtualTerminal(80, 24));
		const unmarked = new Editor(tui, defaultEditorTheme);
		const marked = new Editor(tui, defaultEditorTheme);
		const all = wrap(unmarked);
		const some = wrap(marked, (char) => char === "#");
		typeRun(unmarked, "ab#cd");
		typeRun(marked, "ab#cd");
		assert.deepStrictEqual(all, ["a", "b", "#", "c", "d"]);
		assert.deepStrictEqual(some, ["#"]);
		assert.strictEqual(marked.getText(), unmarked.getText());
		assert.deepStrictEqual(marked.getCursor(), unmarked.getCursor());
	});

	it("falls back to the wrapper for every character when its check throws", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		const seen = wrap(editor, () => {
			throw new Error("broken");
		});
		typeRun(editor, "xyz");
		assert.deepStrictEqual(seen, ["x", "y", "z"]);
		assert.strictEqual(editor.getText(), "xyz");
	});
});
