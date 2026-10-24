import path from "node:path";
import { archiveSearch, LIBRARY_FILE } from "../shared/archive.ts";
import { shortPath } from "../shared/format.ts";
import { rebasePath } from "../shared/prompt-root.ts";

/** The task a collaborating subagent receives: its own task plus who else is on the team (`name`: `role: goal`) and how to reach them. */
export function teamTask(task: string, parentId: string, others: Array<[string, string]>): string {
	const list =
		others.length > 0
			? others.map(([id, line]) => `- \`${id}\`: ${line}`).join("\n")
			: "- none yet; `agent` type `coordinate`, action `list` shows teammates that start later.";
	return `${task}\n\n## Teammates\nYou collaborate with the other subagents that ${parentId} started for the same goal. Running now:\n${list}`;
}

/**
 * The facts only this child has. They ride in its task, not its system prompt, so every child of one profile shares a
 * cached prompt prefix. `archive` is the library of the parent's compacted history (`shared/archive.ts`), given only
 * when the parent has one; the child reads it with the `archive` tool, nothing may change it.
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
	},
	archive?: { library: string },
): string {
	const parent = identity.parentId ? `\`${identity.parentId}\`` : "another agent";
	const scratch = identity.scratch ? `\`${shortPath(identity.scratch)}\`` : "`.octocode/tmp/` in the repository";
	const role = identity.role ? ` (${identity.role})` : "";
	const goal = identity.goal ? ` Your goal: ${identity.goal}.` : "";
	return `${task}${worktreeNote(identity.isolation)}\n\n## You\nYour name is \`${identity.id}\`${role}.${goal} You work for ${parent}. Your scratch folder, for handoff files and a long report, is ${scratch}.${archive ? `\nEarlier history of your parent session, compacted out of its context, is archived in ${path.dirname(archive.library)} (read-only; ${LIBRARY_FILE} indexes it; the repository shows today's state, the archive what was said and found then). ${archiveSearch()}` : ""}`;
}

/**
 * The worktree an isolated child works in. Its system prompt shows the main checkout's paths, which are the same for
 * every child, so the real location rides in the task. Files under the main checkout are not its copy.
 */
function worktreeNote(isolation: { path: string; repo: string; cwd: string } | undefined): string {
	if (!isolation) return "";
	const shown = rebasePath(isolation.cwd, { worktree: isolation.path, root: isolation.repo });
	return `\n\n## Worktree\nYou work in the isolated git worktree \`${isolation.cwd}\` (your working directory). The working directory and project instruction paths in your system prompt name the main checkout \`${shown}\`; read and change files under \`${isolation.cwd}\` instead, not under the main checkout.`;
}
