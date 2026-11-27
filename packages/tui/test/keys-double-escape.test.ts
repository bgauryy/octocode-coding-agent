import assert from "node:assert";
import { describe, it } from "node:test";
import { splitDoubleEscape } from "../src/keys/double-escape.ts";
import { matchesKey } from "../src/keys/match.ts";
import { parseKey } from "../src/keys/parse.ts";
import { setKittyProtocolActive } from "../src/keys/state.ts";

describe("two Escapes in one read", () => {
	it("split into two Escape presses, each of which parses as escape", () => {
		for (const kitty of [false, true]) {
			setKittyProtocolActive(kitty);
			const presses = splitDoubleEscape("\x1b\x1b");
			assert.deepStrictEqual(presses, ["\x1b", "\x1b"]);
			for (const press of presses) {
				assert.strictEqual(parseKey(press), "escape");
				assert.strictEqual(matchesKey(press, "escape"), true);
			}
		}
		setKittyProtocolActive(false);
	});

	it("leaves everything else alone, including the Kitty encoding of Ctrl+Alt+[", () => {
		for (const data of ["\x1b", "\x1b\x1b\x1b", "\x1b\x1c", "\x1b[27u", "\x1b[91;7u", "a", ""]) {
			assert.deepStrictEqual(splitDoubleEscape(data), [data]);
		}
		setKittyProtocolActive(true);
		assert.strictEqual(parseKey("\x1b[91;7u"), "ctrl+alt+[");
		assert.strictEqual(matchesKey("\x1b[91;7u", "ctrl+alt+["), true);
		setKittyProtocolActive(false);
	});

	it("keeps the legacy bytes readable as ctrl+alt+[ for callers that match them directly", () => {
		setKittyProtocolActive(false);
		assert.strictEqual(parseKey("\x1b\x1b"), "ctrl+alt+[");
	});
});
