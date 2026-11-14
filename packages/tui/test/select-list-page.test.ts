import assert from "node:assert/strict";
import { it } from "node:test";
import { SelectList } from "../src/components/select-list.ts";
import { getKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";

const identity = (text: string) => text;
const theme = {
	selectedPrefix: identity,
	selectedText: identity,
	description: identity,
	scrollInfo: identity,
	noMatch: identity,
};

it("pages SelectList by its visible size and clamps without wrapping", () => {
	const list = new SelectList(
		Array.from({ length: 12 }, (_, i) => ({ value: String(i), label: String(i) })),
		5,
		theme,
	);
	const changes: string[] = [];
	list.onSelectionChange = (item) => changes.push(item.value);
	const selected = () => list.render(40).find((line) => line.startsWith("› "));
	list.handleInput("\x1b[6~");
	assert.equal(selected(), "› 5");
	list.handleInput("\x1b[6~");
	assert.equal(selected(), "› 10");
	list.handleInput("\x1b[6~");
	list.handleInput("\x1b[6~");
	assert.equal(selected(), "› 11");
	list.handleInput("\x1b[5~");
	assert.equal(selected(), "› 6");
	list.handleInput("\x1b[5~");
	list.handleInput("\x1b[5~");
	list.handleInput("\x1b[5~");
	assert.equal(selected(), "› 0");
	assert.deepEqual(changes, ["5", "10", "11", "6", "1", "0"]);
	list.handleInput("\x1b[A");
	assert.equal(selected(), "› 11", "single-row navigation still wraps");
});

it("pages filtered, short and empty lists safely", () => {
	const list = new SelectList(
		[
			{ value: "a", label: "a" },
			{ value: "ab", label: "ab" },
			{ value: "b", label: "b" },
		],
		5,
		theme,
	);
	list.setFilter("a");
	list.handleInput("\x1b[6~");
	assert.ok(list.render(40).includes("› ab"));
	list.handleInput("\x1b[5~");
	assert.ok(list.render(40).includes("› a"));
	list.setFilter("missing");
	list.handleInput("\x1b[6~");
	list.handleInput("\x1b[5~");
	assert.deepEqual(list.render(40), ["  No matching commands"]);
});

it("half-page defaults match shifted page keys without colliding with other TUI defaults", () => {
	for (const [action, key, sequence] of [
		["tui.altScreen.halfPageUp", "shift+pageUp", "\x1b[5;2~"],
		["tui.altScreen.halfPageDown", "shift+pageDown", "\x1b[6;2~"],
	] as const) {
		assert.equal(getKeybindings().matches(sequence, action), true);
		const owners = Object.entries(TUI_KEYBINDINGS)
			.filter(([, definition]) => {
				const keys: readonly string[] =
					typeof definition.defaultKeys === "string" ? [definition.defaultKeys] : definition.defaultKeys;
				return keys.includes(key);
			})
			.map(([id]) => id);
		assert.deepEqual(owners, [action]);
	}
});
