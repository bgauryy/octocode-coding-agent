import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { renderInstruction } from "../../core/prompt-template.ts";
import type { Backlog } from "../backlog/context.ts";
import { heldNotice } from "../backlog/graph-notice.ts";
import { cutText } from "../../../../common/src/text.ts";
import type { ChainQueue } from "./chain.ts";
import { type Prerequisite, prerequisiteName } from "./prerequisites.ts";

/** One queued child's start, in order: its prerequisites end well, `prepare` claims what it needs, and only then it takes siblings' paths and a slot. */
export interface QueuedSpec {
	id: string;
	role: string;
	goal: string;
	item?: string | undefined;
	after: Prerequisite[];
	/** Checks the start against the policy of the moment, claims the child's item and plans its reservation again; throws the refusal when the start no longer passes. */
	prepare(): void | Promise<void>;
	/** The child became held (`why`) or stopped being held (undefined): the row's state. */
	onHeld(why: string | undefined): void;
}

/** How long a prerequisite's completion summary is quoted in a started child's task. */
const SUMMARY_CHARS = 600;

/**
 * Puts a child in the queue (`ChainQueue`). `wait` resolves when it may start: every prerequisite met, or the
 * coordinator started it while held. A failed prerequisite, or a start `prepare` refuses, holds it and tells the
 * coordinator once; the held child takes nothing and waits for `agent` `resume` or `coordinate` `stop`. `finish` leaves the queue.
 */
export function queueChild(chain: ChainQueue, tell: (notice: string) => void, spec: QueuedSpec) {
	const names = spec.after.map(prerequisiteName);
	let force: (() => void) | undefined;
	chain.add({
		id: spec.id,
		role: spec.role,
		goal: spec.goal,
		...(spec.item ? { item: spec.item } : {}),
		after: names,
		release: () => force?.(),
	});
	/** Holds the child for `why` and waits for the coordinator's start. */
	const hold = async (why: string, failed: string[], signal: AbortSignal): Promise<void> => {
		if (chain.hold(spec.id, why, failed)) {
			spec.onHeld(why);
			tell(heldNotice(spec.id, spec.item, why));
		}
		await new Promise<void>((resolve, reject) => {
			const abort = () => reject(signal.reason);
			force = () => {
				signal.removeEventListener("abort", abort);
				resolve();
			};
			signal.addEventListener("abort", abort, { once: true });
		});
		force = undefined;
		chain.unhold(spec.id);
		spec.onHeld(undefined);
	};
	return {
		async wait(signal: AbortSignal): Promise<{ seq?: number }> {
			let forced = false;
			for (;;) {
				let seq: number | undefined;
				let failure: { why: string; failed: string[] } | undefined;
				if (!forced) {
					const result = await chain.gate.wait(spec.after, signal);
					if (result.status === "met") seq = result.seq;
					else
						failure = {
							why: result.failed.map((each) => each.why).join("; "),
							failed: result.failed.map((each) => each.name),
						};
				}
				if (!failure) {
					try {
						await spec.prepare();
						chain.released(spec.id, seq);
						return seq === undefined ? {} : { seq };
					} catch (error) {
						failure = { why: `its start was refused: ${errorMessage(error)}`, failed: [] };
					}
				}
				await hold(failure.why, failure.failed, signal);
				forced = true;
			}
		},
		finish: () => chain.drop(spec.id),
	};
}

/**
 * The lines a started child's task gets for the prerequisites it waited for: each agent's report (as the `report:<id>`
 * reference the task text already supports) and each item's completion summary. Empty when there is nothing to add.
 */
export function handoffLines(
	after: readonly Prerequisite[],
	backlog: Backlog | undefined,
): { reports: string[]; text: string } {
	const reports: string[] = [];
	const lines: string[] = [];
	for (const each of after) {
		if (each.kind === "agent") {
			reports.push(`report:${each.id}`);
			continue;
		}
		const item = backlog?.store.get(each.ref);
		const summary = item?.completions.at(-1)?.summary;
		if (item && summary) lines.push(`- ${each.ref} (${item.title}) is done: ${cutText(summary, SUMMARY_CHARS)}`);
	}
	return {
		reports,
		text: lines.length ? renderInstruction("subagent/chain-handoff.md", { lines: lines.join("\n") }).trim() : "",
	};
}
