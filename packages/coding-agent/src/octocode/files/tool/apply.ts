import {
	applyEditsToNormalizedContent,
	applyReplacementsToOriginal,
	generateDiffString,
	normalizeToLF,
} from "../../../core/tools/edit-diff.ts";
import { withFileMutationQueue } from "../../../core/tools/file-mutation-queue.ts";
import { dirname } from "node:path";
import { splitBom } from "@octocodeai/octocode-common/text";

/** The `file` tool's edit and write engines: exact-match replacement and whole-file writes behind the per-file mutation queue. */

/** The filesystem the engines act on; `runQuery` supplies guarded operations that check content and reservations. */
export interface ChangeOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Throws unless the file is readable and writable. */
	access: (absolutePath: string) => Promise<void>;
	mkdir: (dir: string) => Promise<void>;
}

/** What an applied change reports: the line of text for the outcome and, for an edit, its display diff. */
interface AppliedChange {
	message: string;
	diff?: string;
}

/**
 * Do not reject from an abort event listener: that would release the mutation queue while an in-flight filesystem
 * operation may still finish. Checking the signal after each await sees the same aborts and keeps the queue held until
 * the current operation has settled.
 */
function abortCheck(signal: AbortSignal | undefined): () => void {
	return () => {
		if (signal?.aborted) throw new Error("Operation aborted");
	};
}

/** Replace each `edits[].oldText` of the existing file with its `newText`; all are matched against the original content. */
export function applyEdit(
	file: string,
	display: string,
	edits: ReadonlyArray<{ oldText: string; newText: string; replaceAll?: boolean }>,
	ops: ChangeOperations,
	signal?: AbortSignal,
): Promise<AppliedChange> {
	return withFileMutationQueue(file, async () => {
		const throwIfAborted = abortCheck(signal);
		throwIfAborted();
		try {
			await ops.access(file);
		} catch (error: unknown) {
			throwIfAborted();
			const detail = error instanceof Error && "code" in error ? `Error code: ${String(error.code)}` : String(error);
			throw new Error(`Could not edit file: ${display}. ${detail}.`, { cause: error });
		}
		throwIfAborted();
		const buffer = await ops.readFile(file);
		throwIfAborted();
		// The model does not include an invisible BOM in oldText, so match without it.
		const { bom, text } = splitBom(buffer.toString("utf-8"));
		const { baseContent, newContent, replacements } = applyEditsToNormalizedContent(
			normalizeToLF(text),
			[...edits],
			display,
		);
		throwIfAborted();
		// No abort check after the write: once it commits, the change is done and must be reported as done.
		await ops.writeFile(file, bom + applyReplacementsToOriginal(text, replacements));
		return {
			message: `Successfully replaced ${edits.length} block(s) in ${display}.`,
			diff: generateDiffString(baseContent, newContent).diff,
		};
	});
}

/** Write `content` to `file`, creating missing parent directories. */
export function applyWrite(
	file: string,
	display: string,
	content: string,
	ops: ChangeOperations,
	signal?: AbortSignal,
): Promise<AppliedChange> {
	return withFileMutationQueue(file, async () => {
		const throwIfAborted = abortCheck(signal);
		throwIfAborted();
		await ops.mkdir(dirname(file));
		throwIfAborted();
		// No abort check after the write: once it commits, the change is done and must be reported as done.
		await ops.writeFile(file, content);
		return { message: `Successfully wrote to ${display}` };
	});
}
