import { stateFolderRefusal } from "../../permission/file-access.ts";
import { memoryFileRefusal } from "../../permission/memory-files.ts";

/**
 * Why `file` (canonical) is never changed by the file tool, in every mode and before any dialog: a curated memory file,
 * or a path in Octocode's state folder. Undefined when neither applies.
 */
export function protectedFileRefusal(file: string, shown: string, cwd: string): string | undefined {
	return memoryFileRefusal(file, shown, "the file tool", cwd) ?? stateFolderRefusal(file, shown, "the file tool", cwd);
}
