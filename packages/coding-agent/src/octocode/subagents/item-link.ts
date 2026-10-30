import type { ExtensionContext } from "../../core/extensions/index.ts";
import { openBacklog } from "../backlog/context.ts";
import { attachReport, heldItem } from "../backlog/delegation.ts";
import { errorMessage } from "../../utils/guards.ts";
import type { SubagentOutcome } from "./process/outcome.ts";
import { reportChecks, reportFilePath } from "./report.ts";

/** A child's backlog item: its ref for the child's identity, and the note its report leaves on the item. */
export interface ItemLink {
	ref: string;
	/** Notes the report on the item; the line the parent's footer gets (never throws: the report itself still arrives). */
	attach(outcome: SubagentOutcome | undefined, agent: string): string;
}

/**
 * The item a call names (`agent` `item`), checked before anything waits or starts: this session must hold it, or the
 * call is refused with why. Reading the item and noting the report share one backlog handle.
 */
export function itemLink(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	ref: string | undefined,
): ItemLink | undefined {
	if (ref === undefined) return undefined;
	const backlog = openBacklog(ctx, { isSubagent: false });
	const item = heldItem(backlog, ref.trim());
	return {
		ref: item.ref,
		attach(outcome, agent) {
			if (!outcome) return "";
			try {
				attachReport(backlog, item.ref, {
					agent,
					outcome: outcome.error ? "failed" : outcome.outcome,
					file: reportFilePath(outcome.text),
					checks: reportChecks(outcome.text),
				});
				return `\nNoted on ${item.ref}.`;
			} catch (error) {
				return `\nCould not note the report on ${item.ref}: ${errorMessage(error)}`;
			}
		},
	};
}
