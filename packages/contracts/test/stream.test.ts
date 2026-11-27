import { describe, expect, it } from "vitest";
import {
	appendApplicationMessage,
	appendPreviewText,
	applicationMessageText,
	previewText,
	type ApplicationMessage,
} from "../src/index.ts";

const asset = { id: "a".repeat(64), mimeType: "text/plain", size: 1, revision: "r" };

describe("append-only message deltas", () => {
	it("extends a block's preview exactly as previewing the whole text would", () => {
		let whole = "";
		let shown = previewText("");
		for (let i = 0; i < 3000; i++) {
			const piece = `w${i} `;
			whole += piece;
			shown = appendPreviewText(shown.text, shown.previewed, piece)!;
			expect(shown).toEqual(previewText(whole));
		}
	});

	it("applies an append to the block the sender assumed and refuses any other state", () => {
		const message: ApplicationMessage = {
			id: "m",
			role: "assistant",
			text: "Hello",
			content: [{ id: "m:0", type: "text", text: "Hello" }],
			complete: false,
		};
		const next = appendApplicationMessage(message, { index: 0, length: 5 }, " world")!;
		expect(next.content).toEqual([{ id: "m:0", type: "text", text: "Hello world" }]);
		expect(next.text).toBe(applicationMessageText(next.content!));
		expect(appendApplicationMessage(message, { index: 0, length: 4 }, "x")).toBeUndefined();
		expect(appendApplicationMessage(message, { index: 1, length: 0 }, "x")).toBeUndefined();
		// Crossing the preview size needs the whole-text asset.
		expect(appendApplicationMessage(message, { index: 0, length: 5 }, "x".repeat(4000))).toBeUndefined();
		const previewed = appendApplicationMessage(message, { index: 0, length: 5, full: asset }, "x".repeat(4000))!;
		expect(previewed.content![0]).toMatchObject({ full: asset, text: previewText(`Hello${"x".repeat(4000)}`).text });
	});
});
