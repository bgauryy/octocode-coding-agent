import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inlineSummaryTokens } from "../../src/core/compaction/checkpoint.ts";
import { CHARS_PER_TOKEN } from "../../src/core/compaction/tokens.ts";
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
	it("keeps the evidence inline, cut with a marker, when the session has no file to persist it in; the messages stay whole", async () => {
		const messages = [{ role: "toolResult", content: [{ type: "text", text: "complete evidence ".repeat(1000) }] }];
		const api = {
			getThinkingLevel: () => "off",
			getActiveTools: () => [],
			getSettings: () => ({}),
			appendEntry: () => {},
			createUsageRecorder: () => () => {},
		};
		const event = {
			signal: new AbortController().signal,
			preparation: {
				firstKeptEntryId: "kept",
				tokensBefore: 10,
				isSplitTurn: false,
				messagesToSummarize: messages,
				turnPrefixMessages: [],
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { reserveTokens: 1000 },
			},
			branchEntries: [],
		};
		const ctx = {
			model: { id: "test", provider: "p", api: "x", maxTokens: 1000, contextWindow: 100_000 },
			hasUI: false,
			sessionManager: { getSessionFile: () => undefined },
			modelRegistry: {
				streamSimple: () => ({
					result: async () => ({
						role: "assistant",
						content: [{ type: "text", text: "## Goal\nsummary" }],
						stopReason: "stop",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						timestamp: 0,
					}),
				}),
			},
		};
		const out = await writeSummary(api as never, event as never, ctx as never, ctx.model as never);
		expect(out?.cancel).toBeUndefined();
		expect(out?.compaction?.summary).toContain("## Goal\nsummary");
		expect(messages[0].content[0].text).toBe("complete evidence ".repeat(1000));
	});
	it("sizes the kept user messages to the room the inline summary has left, saving them whole behind a reference", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-lossless-"));
		const sessionFile = path.join(dir, "session.jsonl");
		fs.writeFileSync(sessionFile, "");
		// About 15k tokens of the user's own words: more than the inline summary may hold with the model's part.
		const words = Array.from({ length: 10 }, (_, i) => `${i} ${"pasted spec line ".repeat(260)}`);
		const reserveTokens = 16_384;
		const body = `## Goal\n${"summary detail ".repeat(2_000)}`;
		const api = {
			getThinkingLevel: () => "off",
			getActiveTools: () => [],
			getSettings: () => ({}),
			appendEntry: () => {},
			createUsageRecorder: () => () => {},
		};
		const event = {
			signal: new AbortController().signal,
			preparation: {
				firstKeptEntryId: "kept",
				tokensBefore: 10,
				isSplitTurn: false,
				messagesToSummarize: words.map((content) => ({ role: "user", content, timestamp: 0 })),
				turnPrefixMessages: [],
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { reserveTokens },
			},
			branchEntries: [],
		};
		const ctx = {
			model: { id: "test", provider: "p", api: "x", maxTokens: 32_000, contextWindow: 200_000 },
			hasUI: false,
			sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "s" },
			modelRegistry: {
				streamSimple: () => ({
					result: async () => ({
						role: "assistant",
						content: [{ type: "text", text: body }],
						stopReason: "stop",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						timestamp: 0,
					}),
				}),
			},
		};
		try {
			const out = await writeSummary(api as never, event as never, ctx as never, ctx.model as never);
			const summary = out?.compaction?.summary ?? "";
			expect(summary).toContain(body);
			expect(summary).toContain("Complete text saved at");
			expect(summary.length).toBeLessThanOrEqual(inlineSummaryTokens(reserveTokens) * CHARS_PER_TOKEN);
			const saved = fs
				.readdirSync(dir)
				.filter((name) => name.includes(".checkpoint-"))
				.map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
				.join("\n");
			for (const text of words) expect(saved).toContain(text);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
