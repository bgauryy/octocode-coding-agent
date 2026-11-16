import fs from "node:fs";
import { sha256 } from "../../../../common/src/atomic-file.ts";
import { canonicalPath } from "../../../../common/src/canonical-path.ts";
import { stripBom } from "../../../../common/src/text.ts";
import type { FileGuard } from "../files/tool/guard.ts";

/**
 * The project context files (AGENTS.md and the like) whose text the system prompt carries whole and that are on disk
 * exactly as loaded. The prompt already shows them, so a compaction does not read them back; they count as read for
 * the file guard, which still refuses a change made on disk after this call. A file edited since it was loaded, or cut
 * when it was loaded (the prompt's copy differs from the file), is not returned: it restores like any other file.
 */
export function recordContextFiles(
	guard: Pick<FileGuard, "record">,
	contextFiles: ReadonlyArray<{ path: string; content: string }>,
): Set<string> {
	const held = new Set<string>();
	for (const { path, content } of contextFiles) {
		let raw: Buffer;
		try {
			raw = fs.readFileSync(path);
		} catch {
			// A context file that is gone has nothing to restore or record.
			continue;
		}
		if (stripBom(raw.toString("utf8")) !== content) continue;
		guard.record(path, { sha256: sha256(raw), size: raw.length });
		held.add(canonicalPath(path));
	}
	return held;
}
