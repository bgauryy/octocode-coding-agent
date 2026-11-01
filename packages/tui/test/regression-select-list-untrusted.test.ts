import assert from "node:assert";
import { describe, it } from "node:test";
import { SelectList } from "../src/components/select-list.ts";

const identity = (text: string) => text;
const theme = {
	selectedPrefix: identity,
	selectedText: identity,
	description: identity,
	scrollInfo: identity,
	noMatch: identity,
};

const UNSAFE = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

describe("SelectList with untrusted text", () => {
	it("draws labels and descriptions without terminal sequences, controls or bidi overrides", () => {
		const list = new SelectList(
			[
				{
					value: "skill",
					label: "\x1b]0;pwned\x07skill\u202eevil",
					description: "Does \x1b]8;;https://x.test\x07this\x1b]8;;\x07\u2066 thing\u2069\x9b2J\nsecond",
				},
				{ value: "plain", label: "plain", description: "\x1b[31mred\x1b[0m \u202ddone" },
			],
			5,
			theme,
		);
		for (const selected of [0, 1]) {
			list.setSelectedIndex(selected);
			const lines = list.render(100);
			for (const line of lines) assert.doesNotMatch(line, UNSAFE, JSON.stringify(line));
			assert.match(lines[0] ?? "", /skillevil +Does this thing second/);
			assert.match(lines[1] ?? "", /plain +red done/);
		}
	});
});
