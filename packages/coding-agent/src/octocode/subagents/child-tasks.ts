import type { ExtensionContext } from "../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { openBacklog } from "../backlog/context.ts";
import { readWorkspaceIdentity } from "../../storage/workspace.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { tasks } from "../../../../db/src/api.ts";
import { redactSecrets, visibleControls } from "../../../../common/src/sanitize.ts";
import { cutText } from "../../../../common/src/text.ts";
import { type ItemLink, trackSavedRef } from "./item-link.ts";
import type { SubagentOutcome } from "./process/outcome.ts";

type Ctx = Pick<ExtensionContext, "cwd" | "sessionManager">;

/** Preserve a child's open steps in its report before an isolated worktree is removed. Reads never declare a workspace. */
export function isolatedChildSteps(cwd: string, agent: string): string {
	try {
		const workspace = readWorkspaceIdentity(cwd);
		if (!workspace) return "";
		const open = tasks.listTasks(sharedAgentDb().db, {
			repo: workspace.id,
			sessionId: agent,
			states: ["todo", "ongoing"],
		});
		if (!open.length) return "";
		const shown = open.slice(0, 20).map((step) => {
			const goal = visibleControls(redactSecrets(step.goal.replace(/\s+/g, " ").trim()));
			return `- T${step.seq}: ${cutText(goal, 200, { chars: true })}`;
		});
		return `\nOpen steps remain in isolated workspace ${workspace.id}; they were not transferred to the coordinator. Recreate them there if needed:\n${shown.join("\n")}${open.length > shown.length ? `\n...and ${open.length - shown.length} more.` : ""}`;
	} catch {
		// A failed read cannot prevent delivery of the child's report or cleanup of its worktree.
		return "\nCould not read the isolated child's open steps before worktree cleanup.";
	}
}

/**
 * Capture worktree-local steps before cleanup; the usual item report and same-workspace adoption follow cleanup.
 * `lingers`: the child stays reachable after its report (the item's graph line says so).
 */
export async function finishChildNotes(
	ctx: Ctx,
	isolation: { worktree?: { cwd: string }; finish(): Promise<string>; ref?: string; patch?: string },
	linked: ItemLink | undefined,
	outcome: SubagentOutcome | undefined,
	agent: string,
	lingers = false,
	current: () => boolean = () => true,
): Promise<string> {
	const steps = isolation.worktree && !linked ? isolatedChildSteps(isolation.worktree.cwd, agent) : "";
	const note = await isolation.finish();
	const item = linked
		? linked.attach(outcome, agent, isolation.ref, isolation.patch, lingers)
		: isolation.ref
			? trackSavedRef(ctx, agent, isolation.ref, isolation.patch)
			: "";
	return `${note}${item}${current() ? adoptChildTasks(ctx, agent) : ""}${steps}`;
}

/**
 * Hands the open session tasks a finished child still has (keyed to its agent id; the user adds them on the board, the removed `steps` tool did) to this session, so
 * the resume brief shows them and nothing is orphaned. Returns the footer line for the parent (empty when the child left
 * none); never throws: the child's report still arrives.
 */
export function adoptChildTasks(ctx: Ctx, agent: string): string {
	try {
		const backlog = openBacklog(ctx, { isSubagent: false });
		const moved = backlog.store.tasks.adopt(agent, backlog.session, backlog.actor);
		return moved.length
			? `\nMoved ${moved.length} open task${moved.length === 1 ? "" : "s"} of ${agent} to this session: ${moved.map((task) => task.ref).join(", ")}.`
			: "";
	} catch (error) {
		return `\nCould not move the open tasks of ${agent} to this session: ${errorMessage(error)}`;
	}
}
