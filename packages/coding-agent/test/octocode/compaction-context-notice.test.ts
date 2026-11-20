import { describe, expect, it } from "vitest";
import {
	CONTEXT_NOTICE_TYPE,
	contextNoticeText,
	lastNoticedBand,
	noticeBand,
	noticeContextUsage,
} from "../../src/octocode/monitor/attention/context.ts";
import { asSetup } from "./fake-host.ts";

const model = { provider: "anthropic", id: "claude-x", contextWindow: 200_000 };

describe("context usage notice", () => {
	it.each([{ band: 0.9, compactionId: null }, { band: 0.9 }])(
		"starts notice bands over when an older notice survives in the retained tail: %j",
		(details) => {
			const sent: Array<Record<string, unknown>> = [];
			const entries = [{ message: { role: "custom", customType: CONTEXT_NOTICE_TYPE, details } }];
			const api = asSetup({
				sendMessage: (message: Record<string, unknown>) => {
					sent.push(message);
					return Promise.resolve();
				},
			});
			const ctx = { model, getContextUsage: () => ({ tokens: 100_000, contextWindow: 200_000, percent: 50 }) };
			noticeContextUsage(api, ctx as never, entries, undefined, false, "new-checkpoint");
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({ details: { band: 0.5, compactionId: "new-checkpoint" } });
		},
	);

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
		const api = asSetup({
			sendMessage: (message: Record<string, unknown>, options: unknown) => {
				sent.push({ message, options });
				entries.push({ message: { role: "custom", ...message } });
				return Promise.resolve();
			},
		});
		let tokens = 100_000;
		const ctx = { model, getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: 50 }) };
		noticeContextUsage(api, ctx as never, entries);
		noticeContextUsage(api, ctx as never, entries);
		expect(sent).toHaveLength(1);
		expect(sent[0].message).toMatchObject({ customType: CONTEXT_NOTICE_TYPE, display: false, details: { band: 0.5 } });
		expect(sent[0].options).toEqual({ triggerTurn: false });
		tokens = 175_000;
		noticeContextUsage(api, ctx as never, entries);
		expect(sent.map((entry) => (entry.message.details as { band: number }).band)).toEqual([0.5, 0.9]);
	});

	it("stays quiet when usage is unknown or the model has no window", () => {
		const sent: unknown[] = [];
		const api = asSetup({ sendMessage: (message: unknown) => sent.push(message) });
		noticeContextUsage(api, { model, getContextUsage: () => ({ tokens: null }) } as never, []);
		noticeContextUsage(api, { model: undefined, getContextUsage: () => ({ tokens: 1 }) } as never, []);
		expect(sent).toEqual([]);
	});
});

describe("compact hint", () => {
	it("is only in the last band's notice, near automatic compaction, never at half", () => {
		const usage = (tokens: number) => ({
			model,
			getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: tokens / 2_000 }),
		});
		const half: Array<{ content: string }> = [];
		noticeContextUsage(
			asSetup({ sendMessage: (message: { content: string }) => half.push(message) }) as never,
			usage(100_000) as never,
			[],
			undefined,
			true,
		);
		expect(half).toHaveLength(1);
		expect(half[0].content).not.toContain("`compact`");
		const sent: Array<{ content: string }> = [];
		const api = asSetup({ sendMessage: (message: { content: string }) => sent.push(message) });
		const ctx = usage(170_000);
		noticeContextUsage(api, ctx as never, [], undefined, true);
		expect(sent).toHaveLength(1);
		expect(sent[0].content).toMatch(/\(9\d%\).*`compact`/);
		// Without the tool the notice does not offer it.
		const bare: Array<{ content: string }> = [];
		noticeContextUsage(
			asSetup({ sendMessage: (message: { content: string }) => bare.push(message) }) as never,
			ctx as never,
			[],
			undefined,
			false,
		);
		expect(bare[0].content).not.toContain("`compact`");
	});

	it("waits for the prewarm lead in a window where nine tenths comes before it", () => {
		const large = { provider: "anthropic", id: "claude-x", contextWindow: 1_000_000 };
		const notice = (tokens: number) => {
			const sent: Array<{ content: string; details: { limit: number } }> = [];
			noticeContextUsage(
				asSetup({ sendMessage: (message: never) => sent.push(message) }) as never,
				{
					model: large,
					getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 }),
				} as never,
				[],
				undefined,
				true,
			);
			return sent[0];
		};
		const limit = notice(900_000).details.limit;
		// Nine tenths of a 1M window's room is about 65k tokens before the plan made 32k ahead of the threshold.
		const early = notice(Math.ceil(0.9 * limit));
		expect(early.content).toMatch(/\(90%\)/);
		expect(early.content).not.toContain("`compact`");
		expect(notice(limit - 20_000).content).toContain("`compact`");
	});
});
