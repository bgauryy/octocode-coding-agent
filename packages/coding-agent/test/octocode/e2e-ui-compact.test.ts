import { afterEach, describe, expect, it } from "vitest";
import { KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/** `/compact` through the editor with a scripted summary: what the transcript shows and what the next request carries. */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

const shows = (pattern: RegExp | string) => async () => {
	const text = await t!.text();
	return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
};
const compacted = () => t!.host.sessionManager.getEntries().some((e) => e.type === "compaction");

/**
 * A turn whose prompt is pasted and large: the session keeps the last ~20k tokens of history, so the earlier turns
 * must outweigh that for `/compact` to have something to summarize.
 */
const bulky = (label: string) => `${label} ${"lorem ipsum dolor sit amet ".repeat(1_600)}`;
const askBulky = async (label: string, answer: string) => {
	t!.press(`\x1b[200~${bulky(label)}\x1b[201~`);
	await t!.until(shows(/\[paste #\d+ \d+ chars\]/), "the paste in the editor");
	t!.press(KEY.enter);
	await t!.until(shows(answer), `answer "${answer}"`);
	await t!.until(() => !t!.host.session.isStreaming, "turn to finish");
};

describe("/compact", () => {
	it("summarizes the conversation, shows the compaction and sends the summary with the next request", async () => {
		t = await startUi();
		t.script(
			"answer one",
			"answer two",
			"answer three",
			"SUMMARY-MARKER: the user asked about walruses",
			"after compaction reply",
		);
		await askBulky("WALRUS-TURN", "answer one");
		await askBulky("NARWHAL-TURN", "answer two");
		await askBulky("OTTER-TURN", "answer three");

		await t.type("/compact");
		t.press(KEY.enter);
		await t.until(compacted, "compaction persisted");
		await t.until(shows(/compact/i), "compaction shown in the transcript");
		const entry = t.host.sessionManager.getEntries().find((e) => e.type === "compaction");
		expect(JSON.stringify(entry)).toContain("SUMMARY-MARKER");

		await t.type("continue please");
		t.press(KEY.enter);
		await t.until(shows("after compaction reply"), "reply on screen");
		// Three turns, the summary request, then the post-compaction turn.
		expect(t.requests).toHaveLength(5);
		const next = t.requests[4];
		expect(next).toContain("SUMMARY-MARKER");
		expect(next).toContain("continue please");
		// The summarized turn is gone from the context; the newest one is kept.
		expect(next).not.toContain("WALRUS-TURN");
		expect(next).toContain("OTTER-TURN");
	});

	it("`/compact <focus>` passes the focus to the summarizer", async () => {
		t = await startUi();
		t.script("answer one", "answer two", "answer three", "FOCUS-SUMMARY");
		await askBulky("WALRUS-TURN", "answer one");
		await askBulky("NARWHAL-TURN", "answer two");
		await askBulky("OTTER-TURN", "answer three");
		await t.type("/compact keep the API names");
		t.press(KEY.enter);
		await t.until(compacted, "compaction persisted");
		expect(t.requests[3]).toContain("keep the API names");
	});

	it("says so when there is nothing to compact", async () => {
		t = await startUi();
		await t.type("/compact");
		t.press(KEY.enter);
		await t.until(shows(/Nothing to compact yet/), "notice");
		expect(t.requests).toHaveLength(0);
		expect(compacted()).toBe(false);
	});
});
