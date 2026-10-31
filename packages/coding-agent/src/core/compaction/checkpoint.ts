import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getCurrentSystemMessage } from "@octocodeai/octocode-ai";
import { buildSessionProjection, type CompactionEntry, type SessionEntry } from "../session-manager.ts";
import type { CompactionResult } from "./types.ts";
import { clipWithMarker } from "./inline.ts";
import { CHARS_PER_TOKEN, charsToTokens, estimateProjectedContextTokens } from "./tokens.ts";

export class CheckpointPersistenceError extends Error {}

/**
 * Tokens a compaction summary may take inline: 80% of the reserve, so the reply after it still has room. A longer
 * summary is saved whole and the context gets a reference to it instead.
 */
export function inlineSummaryTokens(reserveTokens: number): number {
	return Math.floor(reserveTokens * 0.8);
}

export function persistCheckpointText(text: string, sessionFile?: string): string {
	if (!sessionFile)
		throw new CheckpointPersistenceError("Cannot persist the complete checkpoint without a session file.");
	const file = `${sessionFile}.checkpoint-${randomUUID()}.md`;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text, { flag: "wx", mode: 0o600, flush: true });
		return file;
	} catch (error) {
		throw new CheckpointPersistenceError(`Cannot persist the complete checkpoint: ${String(error)}`);
	}
}

/** The complete text of a checkpoint that was saved to a file and replaced by a reference in the session. */
export function archivedSummary(details: unknown): string | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const archive = (details as { checkpointArchive?: { summary?: unknown } }).checkpointArchive;
	return typeof archive?.summary === "string" ? archive.summary : undefined;
}

export function finalizeCompactionResult(
	result: CompactionResult,
	options: { branchEntries: SessionEntry[]; contextWindow: number; reserveTokens: number; sessionFile?: string },
): CompactionResult {
	const { branchEntries, contextWindow, reserveTokens } = options;
	if (!branchEntries.some((entry) => entry.id === result.firstKeptEntryId)) {
		throw new CheckpointPersistenceError("Compaction retained context boundary is not on the active branch.");
	}
	const earlierArchives = new Set<string>();
	for (const entry of branchEntries) {
		if (entry.type !== "compaction" || !entry.details || typeof entry.details !== "object") continue;
		const archive = (entry.details as { checkpointArchive?: { path?: unknown } }).checkpointArchive;
		if (typeof archive?.path === "string") earlierArchives.add(archive.path);
	}
	if (earlierArchives.size > 0) {
		result = {
			...result,
			summary: `${result.summary}\n\nEarlier complete checkpoints (read in bounded line ranges):\n${[...earlierArchives].join("\n")}`,
		};
	}
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return result;
	const systemMessage = getCurrentSystemMessage(buildSessionProjection(branchEntries).messages);
	const boundary: CompactionEntry = {
		type: "compaction",
		id: randomUUID(),
		parentId: branchEntries.at(-1)?.id ?? null,
		timestamp: new Date().toISOString(),
		summary: "",
		firstKeptEntryId: result.firstKeptEntryId,
		tokensBefore: result.tokensBefore,
		...(systemMessage ? { systemMessage } : {}),
	};
	const projectedTokens = (summary: string) => {
		const entries = [...branchEntries, { ...boundary, summary }];
		return estimateProjectedContextTokens(buildSessionProjection(entries), entries).tokens;
	};
	const available = contextWindow - reserveTokens;
	const summaryBudget = Math.min(
		reserveTokens > 0 ? inlineSummaryTokens(reserveTokens) : available,
		available - projectedTokens(""),
	);
	if (summaryBudget <= 0) {
		throw new CheckpointPersistenceError(
			"Compaction cannot fit the retained context and a checkpoint in the target window.",
		);
	}
	if (charsToTokens(result.summary.length) <= summaryBudget && projectedTokens(result.summary) <= available)
		return result;
	if (!options.sessionFile) {
		// An in-memory session keeps nothing on disk: the summary stays inline, cut to fit, with a marker.
		let keep = Math.min(result.summary.length, summaryBudget * CHARS_PER_TOKEN);
		for (let attempt = 0; attempt < 8 && keep > 0; attempt++) {
			const summary = clipWithMarker(result.summary, keep);
			const over = projectedTokens(summary) - available;
			if (charsToTokens(summary.length) <= summaryBudget && over <= 0) return { ...result, summary };
			keep -= Math.max(CHARS_PER_TOKEN, Math.max(over, 0) * CHARS_PER_TOKEN);
		}
		throw new CheckpointPersistenceError(
			"Compaction cannot fit the retained context and a shortened checkpoint in the target window.",
		);
	}
	const file = persistCheckpointText(result.summary, options.sessionFile);
	const summary = `The complete context checkpoint is saved at ${file}. Search it and read only the relevant bounded line ranges before continuing; do not load the whole file into context. It preserves the summary, user messages, file lists and recovery information without truncation.`;
	if (charsToTokens(summary.length) > summaryBudget || projectedTokens(summary) > available) {
		throw new CheckpointPersistenceError(
			"Compaction cannot fit the retained context and its checkpoint reference in the target window.",
		);
	}
	const details =
		result.details !== null && typeof result.details === "object"
			? result.details
			: { originalDetails: result.details };
	return {
		...result,
		summary,
		details: { ...details, checkpointArchive: { path: file, summary: result.summary } },
	};
}
