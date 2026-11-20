import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile, ChangedOnDiskError, sha256 } from "@octocodeai/octocode-common/atomic-file";
import { createTwoFilesPatch } from "diff";
import { MemoryError } from "../errors.ts";
import { type AppliedOps, applyMemoryOps, evictToFit, type MemoryOp } from "./consolidate.ts";
import { memoryDate, type MemoryLine, parseMemoryFile, serializeMemoryFile, validateMemoryLines } from "./format.ts";
import { ensureMemoryDir, trackedByGit } from "./paths.ts";
import { type MemoryFileRef, protectedFromTests } from "../../permission/memory-files.ts";

/**
 * The one writer of a MEMORY.md: read the file and its SHA-256, apply validated ops, evict to the cap, validate, then
 * `atomicWriteFile` against that SHA. A writer that loses a race (`ChangedOnDiskError`) reads the new file and applies
 * the same ops again, up to `MAX_TRIES` times. A hand edit is just the next base.
 */

const MAX_TRIES = 3;

/** A refused file change: the file is unchanged and the reason says what to fix. */
export class MemoryFileError extends MemoryError {}

/** The workspace file is tracked by git, so it is repository content: Octocode proposes `diff` instead of writing. */
export class MemoryFileTrackedError extends MemoryFileError {
	readonly diff: string;
	constructor(file: MemoryFileRef, diff: string) {
		super(`${file.path} is tracked by git, so Octocode does not write it. Proposed change:\n${diff}`);
		this.diff = diff;
	}
}

export interface MemoryFileUpdate extends Omit<AppliedOps, "lines"> {
	file: MemoryFileRef;
	/** The file before the change ("" when it did not exist) and after it. */
	before: string;
	after: string;
	/** Whether `after` differs from the file's lines as read (formatting alone does not count). */
	changed: boolean;
	lines: MemoryLine[];
	/** A unified diff from `before` to `after`; "" when unchanged. */
	diff: string;
}

interface MemoryUpdateOptions {
	/** When the change happens: its date stamps added and confirmed lines. */
	now?: Date | number;
	/** A lower cap than 30 (`memory.maxLines`); never a higher one. */
	maxLines?: number;
	/** The user approved changing pinned lines. */
	allowPinChanges?: boolean;
	/** What a new text repeats (`contextRepeats`): such an add or rewrite is skipped. */
	repeats?: (text: string) => string | undefined;
	signal?: AbortSignal;
	/** Plan and diff only; nothing is written. */
	dryRun?: boolean;
	/**
	 * Runs before the file is replaced, with the planned change (again on each retry): what must hold first, such as
	 * archiving the lines it evicts, so a failure there leaves the file as it was instead of losing them.
	 */
	beforeWrite?: (update: MemoryFileUpdate) => Promise<void>;
}

/** The file's text, undefined when it does not exist (or a test run must not read it: `protectedFromTests`). */
export async function readMemoryFile(
	file: MemoryFileRef,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
	if (protectedFromTests(file, env)) return undefined;
	try {
		return await fs.promises.readFile(file.path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * What `ops` make of `text` (the file as read; undefined when absent): applied, evicted to the cap and validated.
 * Throws `MemoryFileError` for a file with content it cannot place, or a result the validator refuses.
 */
function planMemoryUpdate(
	file: MemoryFileRef,
	text: string | undefined,
	ops: readonly MemoryOp[],
	options: MemoryUpdateOptions = {},
): MemoryFileUpdate {
	const before = text ?? "";
	const parsed = parseMemoryFile(before);
	if (parsed.problems.length > 0)
		throw new MemoryFileError(
			`${file.path} has content Octocode cannot place, so it is left unchanged: ${parsed.problems
				.slice(0, 3)
				.map((problem) => `line ${problem.line} (${problem.reason}): ${problem.text.slice(0, 60)}`)
				.join("; ")}. Fix it by hand.`,
		);
	const applied = applyMemoryOps(parsed.lines, ops, {
		date: memoryDate(options.now),
		...(options.allowPinChanges ? { allowPinChanges: true } : {}),
		...(options.repeats ? { repeats: options.repeats } : {}),
	});
	const fit = evictToFit(applied.lines, options.maxLines);
	const problems = validateMemoryLines(fit.lines, {
		previous: parsed.lines,
		...(options.maxLines !== undefined ? { maxLines: options.maxLines } : {}),
		...(options.allowPinChanges ? { allowPinChanges: true } : {}),
	});
	if (problems.length > 0)
		throw new MemoryFileError(`${file.path} left unchanged: ${problems.slice(0, 3).join("; ")}.`);
	const after = serializeMemoryFile(fit.lines);
	const changed = after !== serializeMemoryFile(parsed.lines);
	const name = path.basename(file.path);
	return {
		...applied,
		evicted: [...applied.evicted, ...fit.evicted],
		file,
		before,
		after,
		changed,
		lines: fit.lines,
		diff: changed ? createTwoFilesPatch(name, name, before, after, "", "", { context: 2 }) : "",
	};
}

/** Applies `ops` to the file and writes it (unless `dryRun` or nothing changed); see the module comment. */
export async function updateMemoryFile(
	file: MemoryFileRef,
	ops: readonly MemoryOp[],
	options: MemoryUpdateOptions = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<MemoryFileUpdate> {
	for (let attempt = 1; ; attempt++) {
		options.signal?.throwIfAborted();
		const text = await readMemoryFile(file, env);
		const update = planMemoryUpdate(file, text, ops, options);
		if (options.dryRun || !update.changed) return update;
		if (protectedFromTests(file, env))
			throw new Error(`A test tried to write ${file.path}, inside the real home; use a temporary checkout.`);
		if (trackedByGit(file)) throw new MemoryFileTrackedError(file, update.diff);
		await options.beforeWrite?.(update);
		ensureMemoryDir(file);
		try {
			await atomicWriteFile(file.path, update.after, text === undefined ? null : sha256(text), {
				...(text === undefined ? { mode: 0o600 } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			});
			return update;
		} catch (error) {
			if (!(error instanceof ChangedOnDiskError)) throw error;
			if (attempt >= MAX_TRIES)
				throw new MemoryFileError(`${file.path} kept changing while it was written (${MAX_TRIES} tries); try again.`);
		}
	}
}
