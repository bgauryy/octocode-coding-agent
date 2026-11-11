import path from "node:path";
import { archiveSearch, LIBRARY_FILE } from "../history/archive.ts";
import { shortPath } from "../../utils/display-path.ts";
import { rebasePath } from "../worktree-paths/prompt-root.ts";
import { reportContract } from "./report.ts";
import { renderInstruction } from "../../core/prompt-template.ts";

/** The facts that identify one child to itself; the coordinator sets them at spawn and may change the assignment on resume. */
export interface ChildIdentity {
	id: string;
	role?: string;
	goal?: string;
	/** Why the coordinator started this run: the `reason` of the agent call that started or resumed it. */
	why?: string;
	parentId?: string;
	scratch?: string;
	isolation?: { path: string; repo: string; cwd: string };
	/** The backlog item the coordinator started it for: the only one it may update. */
	item?: string;
	/** Paths the coordinator reserved for it until it reports. */
	reservedPaths?: readonly string[];
	/** The run mode: true for a background run, false for a foreground run; omitted, the identity names none. */
	background?: boolean;
}

/**
 * The facts only this child has, and the report contract (`report.ts`), rendered from `subagent/identity.md` after the
 * optional worktree note (`subagent/worktree.md`) and why it was started (`subagent/why.md`). It is the exact text `withIdentity` appends to a task, so it can be
 * sent again on its own (after a compaction) without a second template. `archive` is the library of the parent's
 * compacted history (`history/archive.ts`), given only when the parent has one; the child reads it with the `archive`
 * tool, nothing may change it.
 */
export function identityBlock(identity: ChildIdentity, archive?: { library: string }): string {
	const you = renderInstruction("subagent/identity.md", {
		id: identity.id,
		role: identity.role,
		goal: identity.goal,
		parentId: identity.parentId,
		scratch: identity.scratch ? shortPath(identity.scratch) : undefined,
		item: identity.item,
		reserved: identity.reservedPaths?.map((entry) => `\`${entry}\``).join(", "),
		runMode: identity.background !== undefined,
		background: identity.background === true,
		archive: Boolean(archive),
		archiveDir: archive ? path.dirname(archive.library) : undefined,
		libraryFile: LIBRARY_FILE,
		archiveSearch: archive ? archiveSearch() : undefined,
		report: reportContract(),
	});
	const why = sentence(identity.why);
	return [worktreeNote(identity.isolation), why ? renderInstruction("subagent/why.md", { why }) : "", you]
		.filter(Boolean)
		.join("\n\n");
}

/** `text` on one line, ending as a sentence ends; undefined when blank. */
function sentence(text: string | undefined): string | undefined {
	const line = text?.replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	return /[.!?]$/.test(line) ? line : `${line}.`;
}

/**
 * A child's task followed by its identity (`identityBlock`). The identity rides in the task, not the system prompt, so
 * every child of one profile shares a cached prompt prefix.
 */
export function withIdentity(task: string, identity: ChildIdentity, archive?: { library: string }): string {
	return `${task}\n\n${identityBlock(identity, archive)}`;
}

/**
 * The worktree an isolated child works in (`subagent/worktree.md`). Its system prompt shows the main checkout's paths,
 * which are the same for every child, so the real location rides in the task.
 */
function worktreeNote(isolation: { path: string; repo: string; cwd: string } | undefined): string {
	if (!isolation) return "";
	const shown = rebasePath(isolation.cwd, { worktree: isolation.path, root: isolation.repo });
	return renderInstruction("subagent/worktree.md", { cwd: isolation.cwd, shown });
}

/**
 * The message an external runner (a vendor CLI over ACP) receives: the task, where it works and the report contract.
 * It has none of Octocode's tools or team, so the identity and worktree notes of a native child do not apply.
 */
export function runnerTask(task: string, cwd: string): string {
	return renderInstruction("subagent/runner.md", { task, cwd, report: reportContract() });
}
