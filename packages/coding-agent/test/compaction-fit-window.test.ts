import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtInCompactionSettings } from "../src/core/compaction/settings.ts";
import {
	CompactionFitError,
	estimateProjectedContextTokens,
	finalizeCompactionResult,
	fitCompactionToWindow,
	prepareCompaction,
	projectAfterCompaction,
} from "../src/core/compaction/index.ts";
import { runCompaction } from "../src/core/session-compaction.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const at = 1_700_000_000_000;
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A session built on a 200k model: an 11k-token prompt and tools, then `pairs` turns of about 1,000 tokens each. */
function seed(sessionManager: SessionManager, pairs: number, promptChars = 18_175): void {
	sessionManager.appendMessage({
		role: "system",
		content: "",
		sections: { base: "b".repeat(promptChars), octocode: "o".repeat(3_285) },
		toolsAdded: Array.from({ length: 8 }, (_, i) => ({
			name: `tool_${i}`,
			description: "d".repeat(360),
			parameters: { type: "object", properties: { text: { type: "string", description: "p".repeat(1_100) } } },
		})),
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
			model: "large",
			usage,
			stopReason: "stop",
			timestamp: at + i * 2 + 1,
		} as never);
	}
}

const small = 16_000;
const smallSettings = builtInCompactionSettings({ contextWindow: small });

describe("a switch from a 200k-window model to a 16k one", () => {
	it("shrinks the kept tail before summarizing, so the summary can be saved and the context fits", () => {
		const sessionManager = SessionManager.inMemory();
		seed(sessionManager, 26);
		const branch = sessionManager.getBranch();
		expect(estimateProjectedContextTokens(sessionManager.buildSessionProjection(), branch).tokens).toBeGreaterThan(
			2 * small,
		);
		const preparation = prepareCompaction(branch, smallSettings);
		if (!preparation) throw new Error("expected a compaction");
		const available = small - smallSettings.reserveTokens;
		// The tail kept for the 16k model's keepRecentTokens, with the prompt and tools, leaves no room for any summary.
		expect(projectAfterCompaction(branch, preparation.firstKeptEntryId)("")).toBeGreaterThan(available);
		expect(() =>
			finalizeCompactionResult(
				{ summary: "s", firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore },
				{ branchEntries: branch, contextWindow: small, reserveTokens: smallSettings.reserveTokens },
			),
		).toThrow(/cannot fit the retained context/);

		const fitted = fitCompactionToWindow(branch, preparation, small);
		const keptFrom = (id: string) => branch.findIndex((entry) => entry.id === id);
		expect(keptFrom(fitted.firstKeptEntryId)).toBeGreaterThan(keptFrom(preparation.firstKeptEntryId));
		expect(fitted.messagesToSummarize.length).toBeGreaterThan(preparation.messagesToSummarize.length);
		expect(fitted.settings).toBe(preparation.settings);

		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fit-window-"));
		directories.push(directory);
		const finalized = finalizeCompactionResult(
			{ summary: "s".repeat(6_000), firstKeptEntryId: fitted.firstKeptEntryId, tokensBefore: fitted.tokensBefore },
			{
				branchEntries: branch,
				contextWindow: small,
				reserveTokens: smallSettings.reserveTokens,
				sessionFile: path.join(directory, "session.jsonl"),
			},
		);
		sessionManager.appendCompaction(finalized.summary, fitted.firstKeptEntryId, fitted.tokensBefore, finalized.details);
		const after = estimateProjectedContextTokens(
			sessionManager.buildSessionProjection(),
			sessionManager.getBranch(),
		).tokens;
		expect(after).toBeLessThanOrEqual(available);
	});

	it("leaves a preparation that already fits unchanged", () => {
		const sessionManager = SessionManager.inMemory();
		seed(sessionManager, 26);
		const branch = sessionManager.getBranch();
		const settings = builtInCompactionSettings({ contextWindow: 200_000 });
		const preparation = prepareCompaction(branch, settings);
		if (!preparation) throw new Error("expected a compaction");
		expect(fitCompactionToWindow(branch, preparation, 200_000)).toBe(preparation);
		expect(fitCompactionToWindow(branch, preparation, 0)).toBe(preparation);
	});

	it("fails before any summary request when the prompt and tools alone fill the window", async () => {
		const sessionManager = SessionManager.inMemory();
		// A 30k-token prompt: nothing kept can leave room for a summary in 16k.
		seed(sessionManager, 26, 90_000);
		const branch = sessionManager.getBranch();
		const preparation = prepareCompaction(branch, smallSettings);
		if (!preparation) throw new Error("expected a compaction");
		const summarize = vi.fn();
		const emit = vi.fn();
		const run = runCompaction(
			{
				sessionManager,
				extensionRunner: { hasHandlers: () => true, emit } as never,
				summarize,
				refreshContext: vi.fn(),
			},
			{
				reason: "threshold",
				willRetry: false,
				model: { id: "small", contextWindow: small } as never,
				contextWindow: small,
				reserveTokens: smallSettings.reserveTokens,
				preparation,
				branchEntries: branch,
				signal: new AbortController().signal,
				checkAbort: () => {},
				outcome: { fromExtension: false, cancelledByExtension: false },
			},
		);
		await expect(run).rejects.toBeInstanceOf(CompactionFitError);
		await expect(run).rejects.toThrow(/Switch to a model with a larger window, or start a new session with \/new/);
		expect(summarize).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalled();
		expect(sessionManager.getBranch()).toHaveLength(branch.length);
	});
});
