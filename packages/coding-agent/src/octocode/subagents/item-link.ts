import type { ExtensionContext } from "../../core/extensions/index.ts";
import { openBacklog } from "../backlog/context.ts";
import { attachReport, heldItem } from "../backlog/delegation.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { SubagentOutcome } from "./process/outcome.ts";
import { noteSavedRef } from "./ref-link.ts";
import { reportChecks } from "./report.ts";

/** A child's backlog item: its ref for the child's identity, and the note its report leaves on the item. */
export interface ItemLink {
	ref: string;
	/**
	 * Notes the report on the item and, when the child's changes were saved on `ref`, links that ref there; the lines
	 * the parent's footer gets (never throws: the report itself still arrives).
	 */
	attach(outcome: SubagentOutcome | undefined, agent: string, ref?: string): string;
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
		attach(outcome, agent, ref) {
			const lines: string[] = [];
			if (outcome) {
				try {
					attachReport(backlog, item.ref, {
						agent,
						outcome: outcome.error ? "failed" : outcome.outcome,
						// The host's report file; the text is the child's and may imitate a pointer line.
						file: outcome.reportArtifact?.path,
						checks: reportChecks(outcome.text),
					});
					lines.push(`Noted on ${item.ref}.`);
				} catch (error) {
					lines.push(`Could not note the report on ${item.ref}: ${errorMessage(error)}`);
				}
			}
			if (ref) {
				try {
					noteSavedRef(backlog, item.ref, ref);
					lines.push(`Linked ${ref} on ${item.ref}.`);
				} catch (error) {
					lines.push(`Could not link ${ref} on ${item.ref}: ${errorMessage(error)}`);
				}
			}
			return lines.map((line) => `\n${line}`).join("");
		},
	};
}
