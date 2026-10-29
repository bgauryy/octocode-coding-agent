import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	SUMMARIZER_RESULT_CHARS,
	summarizerView,
	USER_MESSAGE_CHARS,
	userMessagesSection,
	writeSummary,
} from "../../src/octocode/compaction/summary.ts";

const at = 1_700_000_000_000;
const model = { provider: "p", id: "m", api: "anthropic-messages", maxTokens: 10_000, contextWindow: 200_000 };
const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 };
const bigResult = "R".repeat(SUMMARIZER_RESULT_CHARS + 3_000);
const bigUser = `please keep this whole ${"U".repeat(USER_MESSAGE_CHARS + 3_000)} end of the request`;

const user = { role: "user", content: [{ type: "text", text: bigUser }], timestamp: at };
const call = {
	role: "assistant",
	content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } }],
	timestamp: at + 1,
};
const result = {
	role: "toolResult",
	toolCallId: "c1",
	toolName: "read",
	content: [{ type: "text", text: bigResult }],
	isError: false,
	timestamp: at + 2,
};

function setup(sessionManager: unknown) {
	const requests: Array<{ messages: unknown[] }> = [];
	const notes: unknown[] = [];
	const api = {
		getThinkingLevel: () => "off",
		getActiveTools: () => [],
		getSettings: () => ({}),
		createUsageRecorder: () => () => {},
		appendEntry: (customType: string, data: unknown) => notes.push({ customType, data }),
	} as never;
	const ctx = {
		model,
		modelRegistry: {
			streamSimple: (_model: unknown, context: { messages: unknown[] }) => {
				requests.push(context);
				return {
					result: async () => ({
						role: "assistant",
						content: [{ type: "text", text: "## Goal\nread the file" }],
						stopReason: "stop",
						usage,
						timestamp: at,
					}),
				};
			},
		},
		sessionManager,
		hasUI: false,
		ui: {},
	} as never;
	const event = {
		preparation: {
			firstKeptEntryId: "kept",
			tokensBefore: 40_000,
			messagesToSummarize: [user, call, result],
			turnPrefixMessages: [],
			isSplitTurn: false,
			fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
			settings: { reserveTokens: 16_000 },
		},
		branchEntries: [],
		signal: new AbortController().signal,
	} as never;
	return { requests, notes, api, ctx, event };
}

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("compaction without a session file (--no-session)", () => {
	it("keeps a long tool result inline, cut to its budget with a marker, instead of failing", () => {
		const messages = [{ role: "toolResult", content: [{ type: "text", text: bigResult }] }];
		const [view] = summarizerView(messages, undefined, null);
		const text = view.content[0].text;
		expect(text.length).toBeLessThanOrEqual(SUMMARIZER_RESULT_CHARS);
		expect(text).toContain("characters omitted");
		expect(text.startsWith("RRR")).toBe(true);
		expect(text.endsWith("RRR")).toBe(true);
		expect(messages[0].content[0].text).toBe(bigResult);
		// A result within the budget is untouched.
		const small = [{ role: "toolResult", content: [{ type: "text", text: "short" }] }];
		expect(summarizerView(small, undefined, null)[0]).toBe(small[0]);
	});

	it("keeps a long user message inline, cut to its budget with a marker, instead of failing", () => {
		const section = userMessagesSection([], 0, [bigUser, "second"], undefined, undefined, null);
		expect(section).toContain("characters omitted");
		expect(section).toContain("please keep this whole");
		expect(section).toContain("end of the request");
		expect(section).toContain("<user-message>\nsecond\n</user-message>");
		expect(section.length).toBeLessThan(USER_MESSAGE_CHARS + 500);
		expect(section).not.toContain("Complete text saved at");
	});

	it("drops the oldest user messages, and says how many, when the total budget is over", () => {
		const many = Array.from({ length: 30 }, (_, i) => `${i} ${"w".repeat(900)}`);
		const section = userMessagesSection([], 0, many, { total: 5_000, perMessage: 2_000 }, undefined, null);
		expect(section.length).toBeLessThanOrEqual(5_000);
		expect(section).toContain("Earlier user messages not kept here:");
		expect(section).toContain("29 www");
		expect(section).not.toContain("<user-message>\n0 www");
	});

	it("writes the summary of an in-memory session over a long tool result and a long user message", async () => {
		const { requests, notes, api, ctx, event } = setup(SessionManager.inMemory());
		expect(SessionManager.inMemory().getSessionFile()).toBeUndefined();
		// Standalone request (the summary ran on the model before a downshift), so the summarizer sees `summarizerView`.
		const out = await writeSummary(api, event, ctx, model as never);
		expect(out?.cancel).toBeUndefined();
		expect(out?.compaction?.summary).toContain("## Goal\nread the file");
		expect(out?.compaction?.summary).toContain("please keep this whole");
		expect(out?.compaction?.summary).toContain("characters omitted");
		expect(notes).toEqual([]);
		const sent = JSON.stringify(requests);
		expect(sent).not.toContain("R".repeat(SUMMARIZER_RESULT_CHARS));
		expect(sent).toContain("characters omitted");
	});

	it("reports a persistence failure as a failure, not as a cancel, so the failure limit counts it", async () => {
		// A session file under a regular file cannot be written.
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "no-session-"));
		directories.push(directory);
		const blocker = path.join(directory, "file");
		fs.writeFileSync(blocker, "x");
		const manager = { getSessionFile: () => path.join(blocker, "session.jsonl") };
		const { requests, notes, api, ctx, event } = setup(manager);
		const out = await writeSummary(api, event, ctx, model as never);
		expect(out).toMatchObject({ cancel: true, failure: expect.stringContaining("Cannot persist") });
		expect(requests).toHaveLength(0);
		expect(notes).toMatchObject([{ data: { kind: "checkpoint-not-saved" } }]);
	});

	it("does not pay for the summary again on the next turn after a persistence failure that followed the paid call", async () => {
		// The tool result is short enough to reach the summarizer whole; the long user message fails to persist after the call.
		const small = { ...result, content: [{ type: "text", text: "short result" }] };
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "no-session-"));
		directories.push(directory);
		const blocker = path.join(directory, "file");
		fs.writeFileSync(blocker, "x");
		const manager = { getSessionFile: () => path.join(blocker, "session.jsonl") };
		const { requests, api, ctx, event } = setup(manager);
		(event as { preparation: { messagesToSummarize: unknown[] } }).preparation.messagesToSummarize = [
			user,
			call,
			small,
		];
		const first = await writeSummary(api, event, ctx, model as never);
		const second = await writeSummary(api, event, ctx, model as never);
		expect(first).toMatchObject({ cancel: true, failure: expect.any(String) });
		expect(second).toMatchObject({ cancel: true, failure: expect.any(String) });
		expect(requests).toHaveLength(1);
		// Another span is another summary.
		(event as { preparation: { firstKeptEntryId: string } }).preparation.firstKeptEntryId = "later";
		await writeSummary(api, event, ctx, model as never);
		expect(requests).toHaveLength(2);
	});
});
