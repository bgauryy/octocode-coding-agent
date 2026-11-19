import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

describe("Text hanging indent", () => {
	it("wraps continuation rows to column 0 by default", () => {
		const text = new Text("  alpha, beta, gamma, delta", 0, 0);
		assert.deepStrictEqual(plain(text.render(16)), ["  alpha, beta,", "gamma, delta"]);
	});

	it("keeps the line's leading spaces on continuation rows when enabled", () => {
		const text = new Text("[Skills]\n\x1b[2m  alpha, beta, gamma, delta, epsilon\x1b[22m", 0, 0);
		text.setHangingIndent(true);
		assert.deepStrictEqual(plain(text.render(16)), ["[Skills]", "  alpha, beta,", "  gamma, delta,", "  epsilon"]);
	});

	it("continues under the text of a line that starts with a glyph marker", () => {
		const warning = "\x1b[33m⚠ Skill names collide, so the first found is used here\x1b[39m";
		const text = new Text(warning, 0, 0);
		text.setHangingIndent(true);
		const rows = plain(text.render(40));
		assert.ok(rows.length > 1);
		for (const row of rows.slice(1)) assert.ok(row.startsWith("  ") && row[2] !== " ", row);
		const bullet = new Text("• alpha, beta, gamma, delta, epsilon", 0, 0);
		bullet.setHangingIndent(true);
		assert.deepStrictEqual(plain(bullet.render(16)), ["• alpha, beta,", "  gamma, delta,", "  epsilon"]);
	});

	it("does not indent under a first word or when the glyph is not followed by a space", () => {
		const text = new Text("alpha beta gamma delta epsilon", 0, 0);
		text.setHangingIndent(true);
		assert.deepStrictEqual(plain(text.render(16)), ["alpha beta gamma", "delta epsilon"]);
		const bracket = new Text("[Skills] alpha beta gamma delta", 0, 0);
		bracket.setHangingIndent(true);
		assert.ok(
			plain(bracket.render(16))
				.slice(1)
				.every((row) => !row.startsWith(" ")),
		);
	});
});

describe("Text hanging indent with a path longer than a row", () => {
	it("keeps the characters of the path contiguous and indents every continuation row alike at 60 columns", () => {
		const path = "/Users/someone/code/octocodecode/packages/coding-agent/src/octocode/native-skills";
		const warning = `\x1b[33m⚠ 1 duplicate skill skipped, kept ${path} (ctrl+o lists)\x1b[39m`;
		const text = new Text(warning, 0, 0);
		text.setHangingIndent(true);
		const rows = plain(text.render(60));
		assert.strictEqual(
			rows.slice(1).join("").replace(/ /g, "").includes(path.replace(/ /g, "")),
			true,
			rows.join("\n"),
		);
		for (const row of rows) assert.ok(!/\S \S*native-skills/.test(row) || row.startsWith("⚠"), row);
		for (const row of rows.slice(1)) assert.ok(row.startsWith("  ") && row[2] !== " ", row);
		assert.strictEqual(rows.join("\n").includes("oc tocode"), false);
	});
});
