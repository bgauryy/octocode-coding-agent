import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inlineSummaryTokens } from "../../src/core/compaction/checkpoint.ts";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { splitSummary } from "../../src/core/compaction/summary-view.ts";
import {
	summarizerView,
	USER_MESSAGE_CHARS,
	userMessagesSection,
	writeSummary,
} from "../../src/octocode/compaction/summary.ts";

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
	it("keeps the newest requests word for word beside the reference when an older message is too long", () => {
		const pasted = `LOG ${"x".repeat(5_000)}`;
		const latest = "now fix the Safari login bug";
		const budget = { total: 1000, perMessage: 250 };
		const section = userMessagesSection([], 0, [pasted, "second ask", latest], budget, undefined, () => "/d/u.txt");
		const back = splitSummary(`## Goal\nx${section}`);
		expect(section.length).toBeLessThanOrEqual(1000);
		expect(back.messages[0]).toContain("/d/u.txt");
		expect(back.messages.slice(1)).toEqual(["second ask", latest]);
		expect(section).not.toContain(pasted);
	});
	it("gives only an oversized message its own pointer, in its own position, with budget free", () => {
		const prohibition = "Never touch packages/db. Budget: 3 children.";
		const paste = `LOG ${"x".repeat(6_358)}`;
		const saved: string[] = [];
		const save = (text: string) => {
			saved.push(text);
			return `/d/${saved.length}.txt`;
		};
		const section = userMessagesSection(
			[],
			0,
			[prohibition, paste, "fix it"],
			{ total: 60_000, perMessage: 6_000 },
			undefined,
			save,
		);
		const back = splitSummary(`## Goal\nx${section}`);
		expect(back.messages).toHaveLength(3);
		expect(back.messages[0]).toBe(prohibition);
		expect(back.messages[1]).toContain("/d/1.txt");
		expect(back.messages[2]).toBe("fix it");
		expect(saved).toEqual([paste]);
		// Carried on, the pointer stays one short message and nothing is saved again.
		const next = userMessagesSection(
			back.messages,
			back.omitted,
			["and this"],
			{ total: 60_000, perMessage: 6_000 },
			undefined,
			save,
		);
		expect(splitSummary(`## Goal\nx${next}`).messages).toEqual([...back.messages, "and this"]);
		expect(saved).toHaveLength(1);
	});
	it("evicts oldest first only when the total is over, keeping the pointers and the newest that fit", () => {
		const paste = `LOG ${"x".repeat(5_000)}`;
		const older = Array.from({ length: 4 }, (_, i) => `older ${i} ${"o".repeat(200)}`);
		const saved: string[] = [];
		const section = userMessagesSection(
			[],
			0,
			[...older, "recent", paste, "latest"],
			{ total: 700, perMessage: 250 },
			undefined,
			(text) => {
				saved.push(text);
				return `/d/${saved.length}.txt`;
			},
		);
		const back = splitSummary(`## Goal\nx${section}`);
		expect(section.length).toBeLessThanOrEqual(700);
		// The complete collection is on file, behind one reference at the front.
		expect(back.messages[0]).toContain("/d/2.txt");
		for (const message of [...older, "recent", paste, "latest"]) expect(saved[1]).toContain(message);
		expect(back.messages.slice(-3, -2)).toEqual(["recent"]);
		expect(back.messages.at(-2)).toContain("/d/1.txt");
		expect(back.messages.at(-1)).toBe("latest");
		expect(section).not.toContain("older 0");
	});
	it("evicts a child's task last, and moves it to a pointer only when it cannot fit", () => {
		const task = `Task ${"t".repeat(290)}`;
		const mail = Array.from({ length: 6 }, (_, i) => `mail ${i} ${"m".repeat(190)}`);
		const budget = { total: 1_000, perMessage: 300, keepOldest: true };
		const save = () => "/d/u.txt";
		const section = (messages: string[], omitted = 0) =>
			splitSummary(`## Goal\nx${userMessagesSection([], omitted, messages, budget, undefined, save)}`).messages;
		const back = section([task, ...mail]);
		expect(back[0]).toBe(task);
		expect(back[1]).toContain("/d/u.txt");
		expect(back.at(-1)).toBe(mail.at(-1));
		expect(back.join("\n")).not.toContain("mail 0");
		expect(section([`Task ${"t".repeat(2_000)}`])).toEqual([expect.stringContaining("/d/u.txt")]);
		// Without a task of its own to protect, the oldest goes first, as in a main session.
		expect(
			splitSummary(
				`## Goal\nx${userMessagesSection([], 0, [task, ...mail], { total: 1_000, perMessage: 300 }, undefined, save)}`,
			).messages[0],
		).toContain("/d/u.txt");
		// Older messages already dropped: what is first now is not known to be the task.
		expect(section([task, ...mail], 2)[0]).toContain("/d/u.txt");
	});
	it("keeps a subagent's task inline past a user's per-message limit, with its parent's mail beside it", async () => {
		const task = `Migrate the parser.\n${"Step: check the module and record what it does.\n".repeat(150)}`.trim();
		expect(task.length).toBeGreaterThan(USER_MESSAGE_CHARS);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-child-"));
		const summarize = async (parentId?: string) => {
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
					messagesToSummarize: [
						{ role: "user", content: [{ type: "text", text: task }] },
						{ role: "user", content: [{ type: "text", text: "Go on." }] },
					],
					turnPrefixMessages: [],
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
					settings: { reserveTokens: 20_000 },
				},
				branchEntries: [],
			};
			const ctx = {
				model: { provider: "p", id: "m", api: "anthropic-messages", maxTokens: 30_000, contextWindow: 200_000 },
				modelRegistry: {
					getCachePolicy: () => ({ options: {} }),
					streamSimple: () => ({
						result: async () => ({
							role: "assistant",
							content: [{ type: "text", text: "## Goal\nwork" }],
							stopReason: "stop",
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
							timestamp: 1,
						}),
					}),
				},
				sessionManager: {
					getSessionId: () => "s",
					getSessionFile: () => path.join(dir, "session.jsonl"),
					getBranch: () => [],
					buildSessionProjection: () => ({ entries: [], messages: [] }),
				},
				hasUI: false,
			};
			const out = await writeSummary(api as never, event as never, ctx as never, undefined, undefined, parentId);
			return splitSummary(out!.compaction!.summary).messages;
		};
		expect(await summarize("main-1")).toEqual([task, "Go on."]);
		// The same text from a user is over the limit: its own pointer, and the next message stays.
		const main = await summarize();
		expect(main[0]).toContain("Complete text saved at");
		expect(main[1]).toBe("Go on.");
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
			sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s" },
			modelRegistry: {
				getCachePolicy: () => ({ options: {} }),
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
				getCachePolicy: () => ({ options: {} }),
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
