import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFileSync, writeTargetSync } from "../../../common/src/atomic-file.ts";
import { canonicalizePath } from "../../../common/src/paths.ts";

/** Whether a write to `outputPath` would replace `sourceFile`: the same real path, or the same existing inode. */
function landsOn(sourceFile: string, outputPath: string): boolean {
	const target = writeTargetSync(outputPath);
	if (target === canonicalizePath(sourceFile)) return true;
	try {
		const [source, output] = [statSync(sourceFile), statSync(target)];
		return source.dev === output.dev && source.ino === output.ino;
	} catch {
		return false;
	}
}

/**
 * Write an export of `sourceFile` to `outputPath` crash-safely, creating its directory. Refuses a path that is, or
 * links to, the session file being exported: a branch-only JSONL or an HTML page written there would destroy it.
 */
export function writeSessionExport(outputPath: string, data: string, sourceFile: string | undefined): void {
	mkdirSync(dirname(outputPath), { recursive: true });
	if (sourceFile && landsOn(sourceFile, outputPath)) {
		throw new Error(`Refusing to export over the session file being exported: ${sourceFile}`);
	}
	atomicWriteFileSync(outputPath, data);
}
