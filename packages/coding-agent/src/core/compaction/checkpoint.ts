import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getCurrentSystemMessage } from "@octocodeai/octocode-ai";
import { buildSessionProjection, type CompactionEntry, type SessionEntry } from "../session-manager.ts";
import { type CompactionResult, estimateProjectedContextTokens } from "./compaction.ts";

export class CheckpointPersistenceError extends Error {}

export function persistCheckpointText(text: string, sessionFile?: string): string {
	if (!sessionFile) throw new CheckpointPersistenceError("Cannot persist the complete checkpoint without a session file.");
	const file = `${sessionFile}.checkpoint-${randomUUID()}.md`;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text, { flag: "wx", mode: 0o600, flush: true });
		return file;
	} catch (error) {
		throw new CheckpointPersistenceError(`Cannot persist the complete checkpoint: ${String(error)}`);
	}
}

export function finalizeCompactionResult(
	result: CompactionResult,
	options: { branchEntries: SessionEntry[]; contextWindow: number; reserveTokens: number; sessionFile?: string },
): CompactionResult {
	const { branchEntries, contextWindow, reserveTokens } = options;
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
	const summaryBudget = Math.min(reserveTokens > 0 ? Math.floor(reserveTokens * 0.8) : available, available - projectedTokens(""));
	if (summaryBudget <= 0) {
		throw new CheckpointPersistenceError("Compaction cannot fit the retained context and a checkpoint in the target window.");
	}
	if (Math.ceil(result.summary.length / 4) <= summaryBudget && projectedTokens(result.summary) <= available) return result;
	const file = persistCheckpointText(result.summary, options.sessionFile);
	const summary = `The complete context checkpoint is saved at ${file}. Search it and read only the relevant bounded line ranges before continuing; do not load the whole file into context. It preserves the summary, user messages, file lists and recovery information without truncation.`;
	if (Math.ceil(summary.length / 4) > summaryBudget || projectedTokens(summary) > available) {
		throw new CheckpointPersistenceError("Compaction cannot fit the retained context and its checkpoint reference in the target window.");
	}
	const details = result.details !== null && typeof result.details === "object"
		? result.details
		: { originalDetails: result.details };
	return {
		...result,
		summary,
		details: { ...details, checkpointArchive: { path: file, summary: result.summary } },
	};
}
