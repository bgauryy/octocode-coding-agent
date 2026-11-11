import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { stripTerminalSequences } from "../src/utils.ts";

function transcript(lines: string[]): ScrollView {
	return new ScrollView({ render: () => lines, invalidate: () => {} }, { follow: "end" });
}

const visible = (view: ScrollView, height: number): string[] =>
	renderLayoutFrame(view, 20, height, () => {}).lines.map((line) => stripTerminalSequences(line).trimEnd());

describe("ScrollView keepRowsInView", () => {
	it("keeps the visible rows in place when rows are added above them", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `row ${i}`);
		const view = transcript(lines);
		visible(view, 5);
		view.scrollTo(10);
		assert.deepStrictEqual(visible(view, 5), ["row 10", "row 11", "row 12", "row 13", "row 14"]);

		lines.unshift(...Array.from({ length: 30 }, (_, i) => `earlier ${i}`));
		view.keepRowsInView();
		assert.deepStrictEqual(visible(view, 5), ["row 10", "row 11", "row 12", "row 13", "row 14"]);
		assert.strictEqual(view.scrollTop, 40);

		// Only the next layout is anchored: later growth below the viewport leaves the position alone.
		lines.push("later");
		visible(view, 5);
		assert.strictEqual(view.scrollTop, 40);
	});

	it("leaves a view that follows the end at the end", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `row ${i}`);
		const view = transcript(lines);
		visible(view, 5);
		lines.unshift("earlier");
		view.keepRowsInView();
		assert.deepStrictEqual(visible(view, 5), ["row 15", "row 16", "row 17", "row 18", "row 19"]);
		assert.strictEqual(view.isFollowingEnd, true);
	});
});
