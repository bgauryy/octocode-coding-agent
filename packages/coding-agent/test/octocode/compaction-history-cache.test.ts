import { fauxAssistantMessage, type SimpleStreamOptions } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { prepareCompaction } from "../../src/core/compaction/index.ts";
import { sharedSummary } from "../../src/octocode/compaction/shared-summary.ts";
import { CLEARED_RESULTS_TYPE } from "../../src/octocode/files/reads.ts";
import { historyPrefixRewritten } from "../../src/octocode/compaction/history-cache.ts";
import { startEarlySummary } from "../../src/octocode/compaction/early-summary.ts";
import { asSetup } from "./fake-host.ts";

const model = { provider: "p", id: "m", api: "anthropic-messages", contextWindow: 100_000, maxTokens: 10_000 } as never;
const reply = () => ({
	...fauxAssistantMessage("A completed step."),
	provider: "p",
	model: "m",
	api: "anthropic-messages" as const,
	usage: { ...fauxAssistantMessage("").usage, cacheRead: 1_000 },
});

function setup() {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "system", content: "Stable instructions.", timestamp: 0 });
	const user = manager.appendMessage({ role: "user", content: "Original objective.", timestamp: 0 });
	manager.appendMessage({
		...reply(),
		content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" } }],
		stopReason: "toolUse",
	});
	const evidence = manager.appendMessage({
		role: "toolResult",
		toolCallId: "read-1",
		toolName: "read",
		isError: false,
		content: [{ type: "text", text: "Original file evidence." }],
		timestamp: 0,
	});
	const assistant = manager.appendMessage(reply());
	const calls: SimpleStreamOptions[] = [];
	const notes: string[] = [];
	const api = asSetup({
		getSettings: () => ({}),
		getThinkingLevel: () => "off",
		getHiddenDeclarations: () => [],
		getActiveTools: () => [],
		createUsageRecorder: () => () => undefined,
		appendEntry: (_type: string, data: { reason: string }) => notes.push(data.reason),
	}) as never;
	const ctx = {
		model,
		sessionManager: manager,
		modelRegistry: {
			getCachePolicy: () => ({ options: { cacheRetention: "short", instructionCacheRetention: "long" } }),
			streamSimple: (_model: unknown, _context: unknown, options: SimpleStreamOptions) => {
				calls.push(options);
				return { result: async () => reply() };
			},
		},
	} as never;
	const summarize = async () => {
		const preparation = prepareCompaction(manager.getBranch(), {
			enabled: true,
			keepRecentTokens: 1,
			reserveTokens: 10_000,
		})!;
		const written = await sharedSummary(
			api,
			{ preparation, signal: new AbortController().signal },
			ctx,
			model,
			"Keep the task.",
		);
		expect(written).toBeDefined();
		return calls.at(-1)!;
	};
	return { manager, user, assistant, evidence, summarize, calls, notes, api, ctx };
}

describe("compaction cache after context changes", () => {
	it.each(["edit", "clear"] as const)("does not write dead history cache after a post-reply %s", async (kind) => {
		const { manager, user, summarize } = setup();
		if (kind === "edit") manager.appendContextEdit(user, { content: "Revised objective." });
		else manager.appendCustomEntry(CLEARED_RESULTS_TYPE, { results: [{ id: "read-1", saved: "/tmp/evidence.txt" }] });
		const options = await summarize();
		expect(options.cacheRetention).toBe("none");
		expect(options.keepInstructionCache).toBe(true);
	});

	it("keeps history warm after the changed input has reached a new cache-using reply", async () => {
		const { manager, user, summarize } = setup();
		manager.appendContextEdit(user, { content: "Revised objective." });
		manager.appendMessage(reply());
		expect((await summarize()).cacheRetention).toBe("short");
	});

	it("does not mistake a new tail or the last assistant output for rewritten cached input", async () => {
		for (const kind of ["tail", "output"] as const) {
			const { manager, assistant, summarize } = setup();
			if (kind === "tail") manager.appendMessage({ role: "user", content: "A new instruction.", timestamp: 0 });
			else manager.appendContextEdit(assistant, { content: [{ type: "text", text: "Corrected visible answer." }] });
			expect((await summarize()).cacheRetention).toBe("short");
		}
	});

	it("keeps an identical or restored edit on the cached input warm", () => {
		const { manager, user } = setup();
		expect(historyPrefixRewritten(manager)).toBe(false);
		manager.appendContextEdit(user, { content: "Original objective." });
		expect(historyPrefixRewritten(manager)).toBe(false);
		manager.appendContextEdit(user, { content: "Revised objective." });
		expect(historyPrefixRewritten(manager)).toBe(true);
		manager.appendContextEdit(user, { content: "Original objective." });
		expect(historyPrefixRewritten(manager)).toBe(false);
	});

	it("does not invalidate cached tool text for an equivalent string replacement", () => {
		const { manager, evidence } = setup();
		manager.appendContextEdit(evidence, { content: "Original file evidence." });
		expect(historyPrefixRewritten(manager)).toBe(false);
		// Earlier records can hold the string form that the projection normalizes to text blocks.
		const branch = manager
			.getBranch()
			.map((entry) =>
				entry.type === "context_edit" ? { ...entry, replacement: { content: "Original file evidence." } } : entry,
			);
		expect(historyPrefixRewritten({ getBranch: () => branch })).toBe(false);
	});

	it("does not request an early summary when history changed after the cached reply", async () => {
		const { manager, user, api, ctx, calls, notes } = setup();
		manager.appendContextEdit(user, { content: "Revised objective." });
		const preparation = prepareCompaction(manager.getBranch(), {
			enabled: true,
			keepRecentTokens: 1,
			reserveTokens: 10_000,
		})!;
		startEarlySummary(
			api,
			{
				type: "session_compact_prewarm",
				preparation,
				branchEntries: manager.getBranch(),
				signal: new AbortController().signal,
			},
			ctx,
			false,
		);
		await vi.waitFor(() => expect(notes.some((note) => note.includes("cannot be used"))).toBe(true));
		expect(calls).toEqual([]);
	});

	it("does not use an unrelated warmer receipt as proof that edited history was cached", () => {
		const { manager, user } = setup();
		manager.appendContextEdit(user, { content: "Revised objective." });
		manager.appendUsage("cache_warm", "p", "m", reply().usage);
		expect(historyPrefixRewritten(manager)).toBe(true);
		manager.appendMessage(reply());
		expect(historyPrefixRewritten(manager)).toBe(false);
	});

	it("marks a new checkpoint cold but ignores later edits of history it summarized away", () => {
		const { manager, user, assistant } = setup();
		manager.appendCompaction("Checkpoint", assistant, 1_000);
		expect(historyPrefixRewritten(manager)).toBe(true);
		manager.appendMessage(reply());
		expect(historyPrefixRewritten(manager)).toBe(false);
		manager.appendContextEdit(user, { content: "An edit outside the active context." });
		expect(historyPrefixRewritten(manager)).toBe(false);
	});

	it("follows a branch switch rather than reusing a sibling's rewrite state", () => {
		const { manager, user, assistant } = setup();
		manager.appendContextEdit(user, { content: "Revised objective." });
		expect(historyPrefixRewritten(manager)).toBe(true);
		manager.branch(assistant);
		expect(historyPrefixRewritten(manager)).toBe(false);
	});
});
