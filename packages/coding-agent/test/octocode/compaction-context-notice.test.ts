import { describe, expect, it } from "vitest";
import {
	CONTEXT_NOTICE_TYPE,
	contextNoticeText,
	lastNoticedBand,
	noticeBand,
	noticeContextUsage,
} from "../../src/octocode/compaction/context-notice.ts";

const model = { provider: "anthropic", id: "claude-x", contextWindow: 200_000 };

describe("context usage notice", () => {
	it("bands usage of the room before automatic compaction", () => {
		expect(noticeBand(10_000, 184_000)).toBeUndefined();
		expect(noticeBand(92_000, 184_000)).toBe(0.5);
		expect(noticeBand(140_000, 184_000)).toBe(0.75);
		expect(noticeBand(170_000, 184_000)).toBe(0.9);
	});

	it("states used, limit and what happens at the limit", () => {
		expect(contextNoticeText(140_000, 184_000, 200_000)).toBe(
			"[Context] 140k of 184k usable tokens used (76%); about 44k left before automatic compaction summarizes older turns. The window is 200k.",
		);
	});

	it("reads the last band noticed from the context, so a resume does not repeat it", () => {
		const messages = [
			{ message: { role: "custom", customType: CONTEXT_NOTICE_TYPE, details: { band: 0.5 } } },
			{ message: { role: "user", content: "hi" } },
			{ message: { role: "custom", customType: CONTEXT_NOTICE_TYPE, details: { band: 0.75 } } },
		];
		expect(lastNoticedBand(messages)).toBe(0.75);
		expect(lastNoticedBand([])).toBeUndefined();
	});

	it("sends one notice per band crossed, hidden from the transcript view, without starting a turn", () => {
		const sent: Array<{ message: Record<string, unknown>; options: unknown }> = [];
		const entries: Array<{ message: unknown }> = [];
		const api = {
			sendMessage: (message: Record<string, unknown>, options: unknown) => {
				sent.push({ message, options });
				entries.push({ message: { role: "custom", ...message } });
				return Promise.resolve();
			},
		};
		let tokens = 100_000;
		const ctx = { model, getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: 50 }) };
		noticeContextUsage(api as never, ctx as never, entries);
		noticeContextUsage(api as never, ctx as never, entries);
		expect(sent).toHaveLength(1);
		expect(sent[0].message).toMatchObject({ customType: CONTEXT_NOTICE_TYPE, display: false, details: { band: 0.5 } });
		expect(sent[0].options).toEqual({ triggerTurn: false });
		tokens = 175_000;
		noticeContextUsage(api as never, ctx as never, entries);
		expect(sent.map((entry) => (entry.message.details as { band: number }).band)).toEqual([0.5, 0.9]);
	});

	it("stays quiet when usage is unknown or the model has no window", () => {
		const sent: unknown[] = [];
		const api = { sendMessage: (message: unknown) => sent.push(message) };
		noticeContextUsage(api as never, { model, getContextUsage: () => ({ tokens: null }) } as never, []);
		noticeContextUsage(api as never, { model: undefined, getContextUsage: () => ({ tokens: 1 }) } as never, []);
		expect(sent).toEqual([]);
	});
});
