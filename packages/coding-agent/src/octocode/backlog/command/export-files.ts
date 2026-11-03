import path from "node:path";
import { atomicWriteFileSync } from "../../../../../common/src/atomic-file.ts";
import { ensureWorkspaceStateDir } from "../../../config/workspace.ts";
import type { Backlog } from "../context.ts";
import { exportMarkdown } from "../format.ts";
import { renderBacklogHtml } from "@octocodeai/octocode-webview";
import { backlogSnapshot } from "../snapshot.ts";

/** Writes `content` atomically to `<repo>/.octa/code/<name>` (the folder is made when missing) and returns the path. */
function writeSnapshot(cwd: string, name: string, content: string): string {
	const dir = ensureWorkspaceStateDir(cwd, "");
	const file = path.join(dir, name);
	atomicWriteFileSync(file, content);
	return file;
}

/** Writes `<repo>/.octa/code/backlog.md` (refused, like the HTML page, when any text it carries looks like a secret) and returns its path. */
export const exportBacklog = (backlog: Backlog, cwd: string, now = Date.now()): string =>
	writeSnapshot(cwd, "backlog.md", exportMarkdown(backlog.store, backlog.repoName, now));

/** Writes `<repo>/.octa/code/backlog.html` (every item and note, refused when any text looks like a secret) and returns its path. */
export const exportBacklogHtml = (backlog: Backlog, cwd: string, now = Date.now()): string =>
	writeSnapshot(
		cwd,
		"backlog.html",
		renderBacklogHtml(backlogSnapshot(backlog.store, backlog.repoName, now, backlog.session)),
	);
