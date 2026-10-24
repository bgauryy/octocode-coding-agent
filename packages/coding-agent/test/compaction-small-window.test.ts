import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtInCompactionSettings } from "../src/core/compaction/settings.ts";
import {
	CHARS_PER_TOKEN,
	charsToTokens,
	estimateProjectedContextTokens,
	estimateTokens,
	estimateUndeclaredToolTokens,
	finalizeCompactionResult,
	prepareCompaction,
	shouldCompact,
} from "../src/core/compaction/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const at = 1_700_000_000_000;
const window = 32_000;
const settings = builtInCompactionSettings({ contextWindow: window });
const trigger = window - settings.reserveTokens;

/** The fixed request of a main session in this checkout, measured in characters: prompt 18,175 + Octocode section 3,285, tools 12,845. */
function declarations(): Array<{ name: string; description: string; parameters: unknown }> {
	return Array.from({ length: 8 }, (_, i) => ({
		name: `tool_${i}`,
		description: "d".repeat(360),
		parameters: { type: "object", properties: { text: { type: "string", description: "p".repeat(1_100) } } },
	}));
}
const declared = declarations();
const declaredChars = JSON.stringify(declared).length;

function seed(sessionManager: SessionManager, pairs: number): void {
	sessionManager.appendMessage({
		role: "system",
		content: "",
		sections: { base: "b".repeat(18_175), octocode: "o".repeat(3_285) },
		toolsAdded: declared,
		timestamp: at,
	} as never);
	for (let i = 0; i < pairs; i++) {
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `ask ${i} ${"u".repeat(1_500)}` }],
			timestamp: at + i * 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `answer ${i} ${"a".repeat(1_500)}` }],
			api: "x",
			provider: "p",
			model: "small",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: at + i * 2 + 1,
		} as never);
	}
}

describe("one token estimator", () => {
	it("is shared by core and the Octocode add-ons at the more conservative three characters per token", () => {
		expect(CHARS_PER_TOKEN).toBe(3);
		expect(estimateTokens({ role: "user", content: "x".repeat(300), timestamp: 0 })).toBe(100);
		expect(estimateTokens({ role: "toolResult", content: [{ type: "text", text: "x".repeat(301) }] } as never)).toBe(
			101,
		);
		expect(charsToTokens(10)).toBe(4);
	});

	it("counts the declared tools of the system message in the projected context", () => {
		const sessionManager = SessionManager.inMemory();
		seed(sessionManager, 1);
		const projection = sessionManager.buildSessionProjection();
		const withTools = estimateProjectedContextTokens(projection, sessionManager.getBranch()).tokens;
		const withoutTools = estimateProjectedContextTokens(
			{
				...projection,
				messages: projection.messages.map((message) => {
					if (message.role !== "system") return message;
					const { toolsAdded: _tools, ...rest } = message;
					return rest;
				}),
			},
			sessionManager.getBranch(),
		).tokens;
		expect(withTools - withoutTools).toBeGreaterThanOrEqual(Math.floor(declaredChars / CHARS_PER_TOKEN));
	});

	it("adds the tools a request will declare that the transcript does not declare yet, and only those", () => {
		const sessionManager = SessionManager.inMemory();
		seed(sessionManager, 1);
		const { messages } = sessionManager.buildSessionProjection();
		const fresh = { name: "fresh", description: "f".repeat(300), parameters: { type: "object" } };
		const extra = estimateUndeclaredToolTokens(messages, [...declared, fresh]);
		expect(extra).toBe(
			charsToTokens(
				JSON.stringify({ name: "fresh", description: fresh.description, parameters: fresh.parameters }).length,
			),
		);
		expect(estimateUndeclaredToolTokens(messages, declared)).toBe(0);
		expect(estimateUndeclaredToolTokens(messages, [fresh], new Set(["fresh"]))).toBe(0);
	});

	it("counts a replacement schema before a same-name tool is redeclared", () => {
		const sessionManager = SessionManager.inMemory();
		seed(sessionManager, 1);
		const { messages } = sessionManager.buildSessionProjection();
		const replacement = {
			...declared[0],
			parameters: { type: "object", description: "larger replacement schema ".repeat(1_000) },
		};
		expect(estimateUndeclaredToolTokens(messages, [replacement])).toBe(
			charsToTokens(JSON.stringify(replacement).length),
		);
		expect(estimateUndeclaredToolTokens(messages, [replacement], new Set([replacement.name]))).toBe(0);
	});
});

describe("a 32k-window model after compaction", () => {
	it.each([
		["with a session file", true],
		["without a session file (--no-session)", false],
	])("holds the fixed request, the kept tail and the summary below the trigger %s", (_label, persisted) => {
		const sessionManager = SessionManager.inMemory();
		seed(sessionManager, 40);
		const branch = sessionManager.getBranch();
		const preparation = prepareCompaction(branch, settings);
		if (!preparation) throw new Error("expected a compaction");
		expect(shouldCompact(preparation.tokensBefore, window, settings)).toBe(true);
		// The fixed request alone is over a third of the window; the system message carries all of it.
		const fixed = charsToTokens(18_175 + 3_285 + declaredChars);
		expect(fixed / window).toBeGreaterThan(0.33);

		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "small-window-"));
		directories.push(directory);
		// What an Octocode summary of this window adds: the model's part at its cap, the user messages, the note.
		const summary = `${"s".repeat(9_600)}${"m".repeat(8_400)}${"n".repeat(1_000)}`;
		const finalized = finalizeCompactionResult(
			{ summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore },
			{
				branchEntries: branch,
				contextWindow: window,
				reserveTokens: settings.reserveTokens,
				...(persisted ? { sessionFile: path.join(directory, "session.jsonl") } : {}),
			},
		);
		sessionManager.appendCompaction(
			finalized.summary,
			preparation.firstKeptEntryId,
			preparation.tokensBefore,
			finalized.details,
		);
		const after = estimateProjectedContextTokens(
			sessionManager.buildSessionProjection(),
			sessionManager.getBranch(),
		).tokens;
		expect(after).toBeGreaterThanOrEqual(fixed);
		expect(after).toBeLessThanOrEqual(trigger);
		expect(shouldCompact(after, window, settings)).toBe(false);
		// Measured when written: 11,375 fixed tokens; the context lands at 19,562 (a checkpoint file) or 22,631 (inline, cut)
		// of the 28,000-token trigger.
		expect(after / trigger).toBeLessThan(1);
	});
});
