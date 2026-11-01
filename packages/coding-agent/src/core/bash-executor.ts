/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 *
 * A result carries what the agent's `bash` tool returns: a header line and the output trimmed to the same budget.
 */

import { shortPath } from "../octocode/shared/format.ts";
import { splitIncompleteAnsiSuffix, stripAnsi } from "../utils/ansi.ts";
import { moveOutputFile } from "../utils/output-files.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations, BashResult } from "./tools/bash/types.ts";
import { bashBudget } from "./tools/bash/budget.ts";
import { type BashEnd, formatBashHeader } from "./tools/bash/header.ts";
import { OutputAccumulator } from "./tools/output-accumulator.ts";

// ============================================================================
// Types
// ============================================================================

interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Most bytes of the result that reach the model (the `bashOutputMaxBytes` setting). Default: 20 KB */
	maxOutputBytes?: number;
	/** Folder the full output moves to when the result is trimmed. Default: the OS temp folder it is written to */
	outputDir?: string;
}

export type { BashResult } from "./tools/bash/types.ts";

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const output = new OutputAccumulator({
		...bashBudget(options?.maxOutputBytes),
		tempFilePrefix: "octocode-bash",
		smartTrim: true,
	});
	const startedAt = performance.now();

	const decoder = new TextDecoder();
	// Unfinished escape sequence at the end of the previous chunk, completed by the next chunk.
	let pendingAnsi = "";

	const appendText = (rawText: string) => {
		// Strip ANSI and binary garbage; the accumulator keeps carriage returns to show a redrawn line's final state
		const text = sanitizeBinaryOutput(stripAnsi(rawText));
		if (!text) {
			return;
		}
		output.append(Buffer.from(text));

		const chunk = text.replace(/\r/g, "");
		if (chunk) {
			options?.onChunk?.(chunk);
		}
	};

	const onData = (data: Buffer) => {
		const { complete, pending } = splitIncompleteAnsiSuffix(pendingAnsi + decoder.decode(data, { stream: true }));
		pendingAnsi = pending;
		appendText(complete);
	};

	const flushOutput = () => {
		const rest = pendingAnsi + decoder.decode();
		pendingAnsi = "";
		appendText(rest);
	};

	let exitCode: number | null = null;
	try {
		({ exitCode } = await operations.exec(command, cwd, { onData, signal: options?.signal }));
	} catch (err) {
		// An aborted command still returns the output it produced so far
		if (!options?.signal?.aborted) {
			try {
				await output.closeTempFile();
			} catch {
				// Report the command failure rather than the cleanup failure
			}
			throw err;
		}
	}

	flushOutput();
	output.finish();
	const snapshot = output.snapshot({ persistIfTruncated: true });
	await output.closeTempFile();
	const cancelled = options?.signal?.aborted ?? false;
	const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
	const fullOutputPath =
		snapshot.truncation.truncated && snapshot.fullOutputPath && options?.outputDir
			? moveOutputFile(snapshot.fullOutputPath, options.outputDir)
			: snapshot.fullOutputPath;
	const end: BashEnd = cancelled
		? { kind: "aborted", seconds: wallTimeSeconds }
		: exitCode === null
			? { kind: "terminated", seconds: wallTimeSeconds }
			: { kind: "exit", code: exitCode, seconds: wallTimeSeconds };

	return {
		output: snapshot.content,
		exitCode: cancelled ? undefined : (exitCode ?? undefined),
		cancelled,
		truncated: snapshot.truncation.truncated,
		fullOutputPath,
		header: formatBashHeader(end, {
			totalLines: snapshot.truncation.totalLines,
			totalBytes: snapshot.truncation.totalBytes,
			truncation: snapshot.truncation,
			fullOutputPath: fullOutputPath && shortPath(fullOutputPath, cwd),
			lastLineBytes: output.getLastLineBytes(),
		}),
		totalLines: snapshot.truncation.totalLines,
		totalBytes: snapshot.truncation.totalBytes,
		wallTimeSeconds,
	};
}
