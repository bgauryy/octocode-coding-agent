import type { ExtensionContext } from "../../core/extensions/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { openBacklog } from "../backlog/context.ts";
import type { ItemLink } from "./item-link.ts";
import type { SubagentOutcome } from "./process/outcome.ts";

type Ctx = Pick<ExtensionContext, "cwd" | "sessionManager">;

/**
 * Hands the open session tasks a finished child tracked (its `steps` calls key them to its agent id) to this session, so
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

/** The lines a finished run adds to the parent's footer: the report noted on its item, then its open tasks moved here. */
export function reportNotes(
	ctx: Ctx,
	linked: ItemLink | undefined,
	outcome: SubagentOutcome | undefined,
	agent: string,
	ref: string | undefined,
): string {
	return `${linked?.attach(outcome, agent, ref) ?? ""}${adoptChildTasks(ctx, agent)}`;
}
