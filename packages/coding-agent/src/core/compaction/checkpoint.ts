import { renderPrompt } from "../prompt-template.ts";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CHARS_PER_TOKEN, charsToTokens } from "@octocodeai/octocode-ai/utils/estimate";
import type { CompactionEntry, SessionEntry } from "../session-manager.ts";
import { buildPathProjection, getCompactionBoundarySystem } from "../session-manager/context.ts";
import type { CompactionResult } from "./types.ts";
import { clipWithMarker } from "./inline.ts";
import { GOAL_HEADING, summarySection, TLDR_HEADING } from "./summary-format.ts";
import { RECOVERY_HEADING, splitSummary, USER_HEADING } from "./summary-view.ts";
import { estimateProjectedContextTokens } from "./tokens.ts";

export class CheckpointPersistenceError extends Error {}

/**
 * Tokens a compaction summary may take inline: 80% of the reserve, so the reply after it still has room. A longer
 * summary is saved whole and the context gets a reference to it instead.
 */
export function inlineSummaryTokens(reserveTokens: number): number {
	return Math.floor(reserveTokens * 0.8);
}

/**
 * The size an updated summary is asked to stay under: half of what fits inline, since code appends the user's messages
 * and the rest after it. Without a target each update only adds, until the next one no longer fits.
 */
export function summaryTargetTokens(capTokens: number): number {
	return Math.floor(capTokens / 2);
}

/**
 * The most characters of one file list kept in a summary (about 750 tokens, some 25 paths). The lists are a union over
 * every compaction, so they only grow; a longer one goes to a checkpoint file and the summary names that file.
 */
const FILE_LIST_INLINE_CHARS = 3_000;

/** The most earlier checkpoint files a summary names; the newest of them names the ones before it. */
const EARLIER_CHECKPOINTS_LISTED = 5;

const FILE_LIST_BLOCK = /(\n\n<(read-files|modified-files)>\n)([\s\S]*?)(\n<\/\2>)/g;

/** `summary` with each over-long file list moved to a file by `save`; a list that cannot be saved stays whole. */
export function spillFileLists(summary: string, save: (text: string) => string | undefined): string {
	return summary.replace(FILE_LIST_BLOCK, (block: string, open: string, _tag: string, list: string, close: string) => {
		if (list.length <= FILE_LIST_INLINE_CHARS) return block;
		let file: string | undefined;
		try {
			file = save(`${list}\n`);
		} catch {
			return block;
		}
		return file
			? `${open}${renderPrompt("notices/recovery/file-list.md", { count: list.split("\n").length, file })}${close}`
			: block;
	});
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

/** The `## Recovery` section at the end of a summary, whose lines are all bullets; empty when it has none. */
function recoverySection(summary: string): string {
	const at = summary.lastIndexOf(`\n\n${RECOVERY_HEADING}\n`);
	if (at < 0) return "";
	const lines = summary.slice(at + 2).split("\n");
	const end = lines.findIndex((line, index) => index > 0 && !line.startsWith("- "));
	const section = lines.slice(0, end < 0 ? undefined : end);
	return section.length > 1 ? `\n\n${section.join("\n")}` : "";
}

/**
 * What stays in the context when a summary goes to a file: the reference, then as much of what the next model must not
 * have to go looking for as `fits`. In order of what goes first: the Recovery section, the goal, the TL;DR and the newest
 * user messages, each whole or not at all, since the file holds the complete text. Everything here is also in the file.
 */
function archivedView(summary: string, file: string, fits: (text: string) => boolean): string {
	const reference = `The complete context checkpoint is saved at ${file}. Search it and read only the relevant bounded line ranges before continuing; do not load the whole file into context. It preserves the summary, user messages, file lists and recovery information without truncation.`;
	const { body, messages, omitted } = splitSummary(summary);
	const section = (heading: string): string => {
		const lines = summarySection(body, heading);
		return lines.length > 0 ? `\n\n${heading}\n${lines.join("\n")}` : "";
	};
	const view = { goal: "", tldr: "", recovery: "", newest: [] as string[] };
	const render = ({ goal, tldr, recovery, newest }: typeof view): string => {
		const left = omitted + messages.length - newest.length;
		const note = left > 0 ? `\nEarlier user messages not kept here: ${left} (the checkpoint file has them).` : "";
		const kept = newest.map((text) => `<user-message>\n${text}\n</user-message>`).join("\n");
		return `${reference}${goal}${tldr}${newest.length > 0 ? `\n\n${USER_HEADING}${note}\n${kept}` : ""}${recovery}`;
	};
	const add = (change: Partial<typeof view>): boolean => {
		if (!fits(render({ ...view, ...change }))) return false;
		Object.assign(view, change);
		return true;
	};
	add({ recovery: recoverySection(summary) });
	add({ goal: section(GOAL_HEADING) });
	add({ tldr: section(TLDR_HEADING) });
	for (const message of [...messages].reverse()) if (!add({ newest: [message, ...view.newest] })) break;
	return render(view);
}

/**
 * The estimated context after a compaction that keeps entries from `firstKeptEntryId`, as a function of its summary.
 * The boundary carries the prompt and tool state the saved entry will (`appendCompaction`), so the estimate counts the
 * same context the next request sends.
 */
export function projectAfterCompaction(
	branchEntries: SessionEntry[],
	firstKeptEntryId: string,
	tokensBefore = 0,
): (summary: string) => number {
	const timestamp = new Date();
	const boundary: CompactionEntry = {
		type: "compaction",
		id: randomUUID(),
		parentId: branchEntries.at(-1)?.id ?? null,
		timestamp: timestamp.toISOString(),
		summary: "",
		firstKeptEntryId,
		tokensBefore,
		...getCompactionBoundarySystem(branchEntries, undefined, undefined, firstKeptEntryId, timestamp.getTime()),
	};
	return (summary: string) => {
		const entries = [...branchEntries, { ...boundary, summary }];
		return estimateProjectedContextTokens(buildPathProjection(entries), entries).tokens;
	};
}

type FinalizeOptions = {
	branchEntries: SessionEntry[];
	contextWindow: number;
	reserveTokens: number;
	sessionFile?: string;
};

/**
 * The candidate as the session will keep it: file lists and an over-long summary moved to checkpoint files. Files
 * written for a compaction that then cannot fit are removed, so a failed compaction leaves none behind.
 */
export function finalizeCompactionResult(candidate: CompactionResult, options: FinalizeOptions): CompactionResult {
	const created: string[] = [];
	try {
		return finalizeWithFiles(candidate, options, created);
	} catch (error) {
		for (const file of created) fs.rmSync(file, { force: true });
		throw error;
	}
}

function finalizeWithFiles(candidate: CompactionResult, options: FinalizeOptions, created: string[]): CompactionResult {
	const persist = (text: string, sessionFile?: string): string => {
		const file = persistCheckpointText(text, sessionFile);
		created.push(file);
		return file;
	};
	let result = candidate;
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
		// Each listed checkpoint carries its own notice, so older ones stay reachable through the chain.
		const listed = [...earlierArchives].slice(-EARLIER_CHECKPOINTS_LISTED);
		const omitted = earlierArchives.size - listed.length;
		const omittedNote =
			omitted > 0 ? `${renderPrompt("notices/recovery/earlier-checkpoints-omitted.md", { omitted })}\n` : "";
		result = {
			...result,
			summary: `${result.summary}\n\n${renderPrompt("notices/recovery/earlier-checkpoints.md")}\n${omittedNote}${listed.join("\n")}`,
		};
	}
	const { sessionFile } = options;
	if (sessionFile) {
		const summary = spillFileLists(result.summary, (text) => persist(text, sessionFile));
		if (summary !== result.summary) result = { ...result, summary };
	}
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return result;
	const projectedTokens = projectAfterCompaction(branchEntries, result.firstKeptEntryId, result.tokensBefore);
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
	if (!sessionFile) {
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
	const file = persist(result.summary, sessionFile);
	const fits = (text: string) => charsToTokens(text.length) <= summaryBudget && projectedTokens(text) <= available;
	const summary = archivedView(result.summary, file, fits);
	if (!fits(summary)) {
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
