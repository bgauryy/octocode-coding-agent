import type { ExtensionContext } from "../../core/features/index.ts";
import { type Backlog, openBacklog } from "../backlog/context.ts";
import { attachReport, checkDelegable, claimDelegated } from "../backlog/delegation.ts";
import { graphNotice } from "../backlog/graph-notice.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { SubagentOutcome } from "./process/outcome.ts";
import { noteSavedRef } from "./ref-link.ts";
import { reportChecks } from "./report-outcome.ts";

/** A child's backlog item: its ref for the child's identity, and the note its report leaves on the item. */
export interface ItemLink {
	ref: string;
	/** The open prerequisites the item waits on, when it was checked for a queued start; else empty (a blocked item was refused). */
	waitsOn: readonly string[];
	/** Claims the item for this session when it was unheld (the footer says so); a no-op for a held item or a second call. */
	claim(): void;
	/**
	 * Notes the report on the item and, when the child's changes were saved on `ref`, links that ref there; the lines
	 * the parent's footer gets (never throws: the report itself still arrives). `lingers`: the child stays reachable after it.
	 */
	attach(outcome: SubagentOutcome | undefined, agent: string, ref?: string, patch?: string, lingers?: boolean): string;
	/** The graph line the last `attach` added (what became ready, or what waits on an item its child left open). */
	readonly notice: string | undefined;
}

/**
 * What the end of `agent`'s run means for the items that wait on `ref` (`graphNotice`): ready ones, or ones its child left
 * waiting. The report carries it and wakes the parent for it. Undefined when there is none or the backlog cannot be read.
 */
function itemGraphNotice(
	backlog: Backlog,
	ref: string,
	agent: string,
	lingers: boolean,
	queued: ReadonlySet<string>,
): string | undefined {
	try {
		return graphNotice(backlog, ref, agent, lingers, queued);
	} catch {
		return undefined;
	}
}

/**
 * Tracks a worktree child's saved change when the call named no item: a todo item linking the ref, so the unmerged
 * work has an owner and a merge gate (`backlog/merge-gate.ts`). The parent's footer line; never throws.
 */
export function trackSavedRef(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	agent: string,
	ref: string,
	patch?: string,
): string {
	try {
		const backlog = openBacklog(ctx, { isSubagent: false });
		const item = backlog.store.add(
			{
				title: `Land isolated change of ${agent}`,
				goal: "The change is merged into the tree (coordinate merge) and checked, or discarded and the item closed.",
				why: "A worktree child's change is not done until it lands.",
				state: "todo",
				tags: ["worktree"],
				createdBy: "agent",
			},
			backlog.actor,
		);
		noteSavedRef(backlog, item.ref, ref, patch);
		return `\nTracked ${ref} on ${item.ref}: done only after it is merged or discarded.`;
	} catch (error) {
		return `\nCould not track ${ref} on a backlog item: ${errorMessage(error)}`;
	}
}

/**
 * The item a call names (`agent` `item`), checked before anything waits or starts: this session holds it, or it is
 * unheld and claimable (`claim` claims it once the call is accepted, so a call refused later leaves it unclaimed), or
 * the call is refused with why. Reading the item and noting the report share one backlog handle.
 */
export function itemLink(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	ref: string | undefined,
	{ queue = false, queued }: { queue?: boolean; queued?: () => ReadonlySet<string> } = {},
): ItemLink | undefined {
	if (ref === undefined) return undefined;
	const backlog = openBacklog(ctx, { isSubagent: false });
	const checked = checkDelegable(backlog, ref.trim(), queue);
	const { ref: itemRef } = checked.item;
	let claimed = false;
	let notice: string | undefined;
	return {
		ref: itemRef,
		waitsOn: checked.waitsOn,
		get notice() {
			return notice;
		},
		claim() {
			if (!checked.claimable || claimed) return;
			// Checked again: the item may have changed since the first look (another session may hold it now).
			const now = checkDelegable(backlog, itemRef);
			if (now.claimable) claimDelegated(backlog, now.item);
			claimed = true;
		},
		attach(outcome, agent, ref, patch, lingers = false) {
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
			notice = itemGraphNotice(backlog, itemRef, agent, lingers, queued?.() ?? new Set());
			if (notice) lines.push(notice);
			return lines.map((line) => `\n${line}`).join("");
		},
	};
}
