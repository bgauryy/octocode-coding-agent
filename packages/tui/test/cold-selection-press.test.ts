import assert from "node:assert";
import { describe, it } from "node:test";
import { createHarness, firstScreenDifference } from "./b65-harness.ts";

/** The press frame must not measure the rest of a long transcript that is still laid out virtually. */
const PRESS_FRAME_MS = 50;

interface SelectionInternals {
	selection: { getActiveSelectionText(): string | undefined };
}

function coldSelection(rows: number, virtualize: boolean) {
	const h = createHarness({ rows, virtualize, markdown: true });
	h.frame("start");
	h.update("scroll to start", () => h.transcript.scrollToStart());
	// The selection first paints on the drag that follows the press.
	const frames = [h.input("press", "\x1b[<0;5;3M")];
	h.update("scroll to end", () => h.transcript.scrollToEnd());
	for (const y of [10, 20]) frames.push(h.input("drag", `\x1b[<32;40;${y}M`));
	h.input("release", "\x1b[<0;40;20m");
	return { h, frames };
}

describe("a mouse press while the transcript is still laid out virtually", () => {
	for (const rows of [1000, 10000]) {
		it(`${rows} Markdown rows: paints within ${PRESS_FRAME_MS} ms and selects the exact path's text`, () => {
			const cold = coldSelection(rows, true);
			const exact = coldSelection(rows, false);
			try {
				assert.strictEqual(cold.frames[0].path, "virtual", "the press arrives before the layout settles");
				const slowest = Math.max(...cold.frames.map((frame) => frame.totalMs));
				assert.ok(slowest < PRESS_FRAME_MS, `press or drag frame took ${slowest.toFixed(1)} ms for ${rows} rows`);
				const text = (cold.h.tui as unknown as SelectionInternals).selection.getActiveSelectionText();
				const reference = (exact.h.tui as unknown as SelectionInternals).selection.getActiveSelectionText();
				assert.ok(text && text.length > 0, "the selection holds text");
				assert.strictEqual(text, reference);
				cold.h.settle("settled");
				exact.h.settle("settled");
				assert.strictEqual(firstScreenDifference(cold.h.screen(), exact.h.screen()), undefined);
			} finally {
				cold.h.stop();
				exact.h.stop();
			}
		});
	}
});
