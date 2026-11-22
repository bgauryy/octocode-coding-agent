import fs from "node:fs";
import path from "node:path";
import type { ToolResultEvent } from "../../core/features/index.ts";
import { sessionTempRoot } from "../shared/home.ts";
import { contentText } from "../shared/util.ts";
import { expiredReply, savedHandle } from "../shared/heap-index.ts";
import type { SessionHeap } from "../shared/session-heap.ts";

/** A handle as a call may carry it: `file:<12 hex>` (optionally `@A-B`) or `saved:<8 hex>`. */
const HANDLE = /\b(?:file:[0-9a-f]{12}(?:@\d+-\d+)?|saved:[0-9a-f]{8})\b/g;
/** An error that says a file is not there. */
const MISSING = /no such file|not found|ENOENT|does not exist/i;
const SAVED_PATH = /[^\s"'`()<>]+[\\/](?:output|bash)[\\/][\w.-]*\w/g;

/** The path a `saved:` handle names, found among the files Octocode saved for any session. */
function savedPathOf(handle: string): string | undefined {
	const root = sessionTempRoot();
	for (const session of safeList(root))
		for (const folder of ["output", "bash"]) {
			const dir = path.join(root, session, folder);
			for (const name of safeList(dir)) if (savedHandle(path.join(dir, name)) === handle) return path.join(dir, name);
		}
	return undefined;
}

function safeList(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
			return [];
		throw error;
	}
}

/**
 * What a failed call that named a heap handle, or a saved file the sweep already removed, gets instead of the tool's
 * bare "not found": a handle that still names a file says where to read it; one that does not says it expired.
 */
export function expiredHandleReply(event: ToolResultEvent, heap: SessionHeap | undefined): string | undefined {
	if (!event.isError || event.parentToolCallId) return undefined;
	const asked = [...JSON.stringify(event.input).matchAll(HANDLE)].map((match) => match[0]);
	if (asked.length > 0) {
		return [...new Set(asked)]
			.map((handle) => {
				const named = heap?.index.pathOf(handle) ?? heap?.parent?.resolve(handle);
				const file = typeof named === "string" ? named : named?.status === "ok" ? named.path : undefined;
				const found = file ?? (handle.startsWith("saved:") ? savedPathOf(handle) : undefined);
				return found && fs.existsSync(found)
					? `[Handle ${handle} names ${found}: read that path.]`
					: expiredReply(handle);
			})
			.join("\n");
	}
	const text = contentText(event.content);
	if (!MISSING.test(text)) return undefined;
	const root = `${sessionTempRoot()}${path.sep}`;
	const gone = (text.match(SAVED_PATH) ?? [])
		.map((spelling) => path.resolve(spelling))
		.find((file) => file.startsWith(root));
	return gone && !fs.existsSync(gone) ? expiredReply(savedHandle(gone)) : undefined;
}
