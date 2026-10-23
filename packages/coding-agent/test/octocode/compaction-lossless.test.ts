import { describe, expect, it } from "vitest";
import { summarizerView, userMessagesSection, writeSummary } from "../../src/octocode/compaction/summary.ts";

describe("lossless compaction references", () => {
	it("preserves a whole inherited message when a smaller budget requires a reference", () => {
		const original = "😀 complete user instruction ".repeat(1000);
		const saved: string[] = [];
		const section = userMessagesSection([original], 0, [], { total: 1000, perMessage: 250 }, undefined, (text) => {
			saved.push(text);
			return "/durable/users.txt";
		});
		expect(section.length).toBeLessThanOrEqual(1000);
		expect(section).toContain("/durable/users.txt");
		expect(saved.join("\n")).toContain(original);
	});
	it("preserves all excluded messages and the newest message without cutting any", () => {
		const originals = Array.from({ length: 20 }, (_, i) => `${i} ${"x".repeat(200)}`);
		const saved: string[] = [];
		const section = userMessagesSection([], 0, originals, { total: 1000, perMessage: 250 }, undefined, (text) => {
			saved.push(text);
			return "/durable/users.txt";
		});
		for (const message of originals) expect(section + saved.join("\n")).toContain(message);
		expect(section.length).toBeLessThanOrEqual(1000);
	});
	it("fails safely instead of dropping text when storage fails or no pointer fits", () => {
		expect(() =>
			userMessagesSection([], 0, ["x".repeat(5000)], { total: 1000, perMessage: 250 }, undefined, () => undefined),
		).toThrow(/persist/);
		expect(() =>
			userMessagesSection([], 0, ["original"], { total: 0, perMessage: 0 }, undefined, () => "/durable/users.txt"),
		).toThrow(/budget/);
	});
	it("saves the full tool result before using a pointer in the standalone summarizer", () => {
		const original = "FULL START " + "x".repeat(10000) + " FULL END";
		let saved = "";
		const messages = [{ role: "toolResult", content: [{ type: "text", text: original }] }];
		const view = summarizerView(messages, undefined, (text) => {
			saved = text;
			return "/durable/tool.txt";
		});
		expect(saved).toBe(original);
		expect(view[0].content[0].text).toContain("/durable/tool.txt");
		expect(messages[0].content[0].text).toBe(original);
	});
	it("cancels compaction rather than falling back when full tool evidence cannot be persisted", async () => {
		const messages = [{ role: "toolResult", content: [{ type: "text", text: "complete evidence ".repeat(1000) }] }];
		const pi = {
			getThinkingLevel: () => "off",
			getActiveTools: () => [],
			getSettings: () => ({}),
			appendEntry: () => {},
			createUsageRecorder: () => () => {},
		};
		const event = {
			signal: new AbortController().signal,
			preparation: { messagesToSummarize: messages, turnPrefixMessages: [], settings: { reserveTokens: 1000 } },
			branchEntries: [],
		};
		const ctx = {
			model: { id: "test" },
			hasUI: false,
			sessionManager: { getSessionFile: () => undefined },
			modelRegistry: {
				streamSimple: () => {
					throw new Error("provider must not be called");
				},
			},
		};
		expect(await writeSummary(pi as never, event as never, ctx as never)).toEqual({ cancel: true });
		expect(messages[0].content[0].text).toBe("complete evidence ".repeat(1000));
	});
});
