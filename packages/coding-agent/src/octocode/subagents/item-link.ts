import type { ExtensionContext } from "../../core/features/index.ts";
import { openBacklog } from "../backlog/context.ts";
import { attachReport, checkDelegable, claimDelegated } from "../backlog/delegation.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { SubagentOutcome } from "./process/outcome.ts";
import { noteSavedRef } from "./ref-link.ts";
import { reportChecks } from "./report.ts";

/** A child's backlog item: its ref for the child's identity, and the note its report leaves on the item. */
export interface ItemLink {
	ref: string;
	/** Claims the item for this session when it was unheld (the footer says so); a no-op for a held item or a second call. */
	claim(): void;
	/**
	 * Notes the report on the item and, when the child's changes were saved on `ref`, links that ref there; the lines
	 * the parent's footer gets (never throws: the report itself still arrives).
	 */
	attach(outcome: SubagentOutcome | undefined, agent: string, ref?: string, patch?: string): string;
}

/**
 * The item a call names (`agent` `item`), checked before anything waits or starts: this session holds it, or it is
 * unheld and claimable (`claim` claims it once the call is accepted, so a call refused later leaves it unclaimed), or
 * the call is refused with why. Reading the item and noting the report share one backlog handle.
 */
export function itemLink(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	ref: string | undefined,
): ItemLink | undefined {
	if (ref === undefined) return undefined;
	const backlog = openBacklog(ctx, { isSubagent: false });
	const checked = checkDelegable(backlog, ref.trim());
	const { ref: itemRef } = checked.item;
	let claimed = false;
	return {
		ref: itemRef,
		claim() {
			if (!checked.claimable || claimed) return;
			// Checked again: the item may have changed since the first look (another session may hold it now).
			const now = checkDelegable(backlog, itemRef);
			if (now.claimable) claimDelegated(backlog, now.item);
			claimed = true;
		},
		attach(outcome, agent, ref, patch) {
			const lines: string[] = claimed ? [`Claimed ${itemRef} for this session to delegate it.`] : [];
			if (outcome) {
				try {
					attachReport(backlog, itemRef, {
						agent,
						outcome: outcome.error ? "failed" : outcome.outcome,
						// The host's report file; the text is the child's and may imitate a pointer line.
						file: outcome.reportArtifact?.path,
						checks: reportChecks(outcome.text),
					});
					lines.push(`Noted on ${itemRef}.`);
				} catch (error) {
					lines.push(`Could not note the report on ${itemRef}: ${errorMessage(error)}`);
				}
			}
			if (ref) {
				try {
					noteSavedRef(backlog, itemRef, ref, patch);
					lines.push(`Linked ${ref} on ${itemRef}.`);
				} catch (error) {
					lines.push(`Could not link ${ref} on ${itemRef}: ${errorMessage(error)}`);
				}
			}
			return lines.map((line) => `\n${line}`).join("");
		},
	};
}
