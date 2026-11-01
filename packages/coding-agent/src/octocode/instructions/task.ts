import path from "node:path";
import { archiveSearch, LIBRARY_FILE } from "../shared/archive.ts";
import { shortPath } from "../shared/format.ts";
import { rebasePath } from "../shared/prompt-root.ts";
import { reportContract } from "./report.ts";
import { renderInstruction } from "../../core/prompt-template.ts";

/** The task a collaborating subagent receives: its own task plus who else is on the team (`name`: `role: goal`) and how to reach them (`subagent/team.md`). */
export function teamTask(task: string, parentId: string, others: Array<[string, string]>): string {
	const teammates = others.map(([id, line]) => `- \`${id}\`: ${line}`).join("\n");
	return `${task}\n\n${renderInstruction("subagent/team.md", { parentId, teammates })}`;
}

/**
 * The facts only this child has, and the report contract (`report.ts`), rendered from `subagent/identity.md`. They ride
 * in its task, not its system prompt, so every child of one profile shares a cached prompt prefix. `archive` is the
 * library of the parent's compacted history (`shared/archive.ts`), given only when the parent has one; the child reads
 * it with the `archive` tool, nothing may change it.
 */
export function withIdentity(
	task: string,
	identity: {
		id: string;
		role?: string;
		goal?: string;
		parentId?: string;
		scratch?: string;
		isolation?: { path: string; repo: string; cwd: string };
		/** The backlog item the parent started it for: the only one it may update. */
		item?: string;
	},
	archive?: { library: string },
): string {
	const you = renderInstruction("subagent/identity.md", {
		id: identity.id,
		role: identity.role,
		goal: identity.goal,
		parentId: identity.parentId,
		scratch: identity.scratch ? shortPath(identity.scratch) : undefined,
		item: identity.item,
		archive: Boolean(archive),
		archiveDir: archive ? path.dirname(archive.library) : undefined,
		libraryFile: LIBRARY_FILE,
		archiveSearch: archive ? archiveSearch() : undefined,
		report: reportContract(),
	});
	return `${task}${worktreeNote(identity.isolation)}\n\n${you}`;
}

/**
 * The worktree an isolated child works in (`subagent/worktree.md`). Its system prompt shows the main checkout's paths,
 * which are the same for every child, so the real location rides in the task.
 */
function worktreeNote(isolation: { path: string; repo: string; cwd: string } | undefined): string {
	if (!isolation) return "";
	const shown = rebasePath(isolation.cwd, { worktree: isolation.path, root: isolation.repo });
	return `\n\n${renderInstruction("subagent/worktree.md", { cwd: isolation.cwd, shown })}`;
}
