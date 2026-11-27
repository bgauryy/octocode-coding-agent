import type { FeatureContext } from "../../core/features/index.ts";
import { bookkeepingFailed, finishChildNotes } from "./child-tasks.ts";
import type { AgentRuns, Run } from "./claim.ts";
import { delegatedCostNote } from "./delegated-cost.ts";
import type { Isolation } from "./isolation.ts";
import type { ItemLink } from "./item-link.ts";
import type { SubagentOutcome } from "./process/outcome.ts";

export interface ChildFinishOptions {
	ctx: FeatureContext;
	runs: AgentRuns;
	run: Run;
	isolation: Isolation;
	linked?: ItemLink;
	current: () => boolean;
	isBackground: () => boolean;
	lateNote?: () => string;
	onFinally?: () => void;
}

/** Shared post-run finalizer for fresh, handed-over, and resumed child runs. */
export function createChildFinish(options: ChildFinishOptions) {
	const { ctx, runs, run, isolation, linked, current, isBackground, lateNote, onFinally } = options;
	let finalized: Promise<string> | undefined;
	return (outcome?: SubagentOutcome, lingers?: boolean, stopped?: boolean) =>
		(finalized ??= finishChildNotes(ctx, isolation, linked, outcome, run.identity.id, lingers, current, stopped)
			.then((note) => {
				runs.chain?.gate.refresh();
				if (isBackground() && linked?.notice) runs.graph?.mark(run.identity.id, linked.notice);
				const cost =
					outcome && current()
						? delegatedCostNote(runs, ctx, outcome.usage.cost.total, runs.live.get(run.identity.id))
						: "";
				return `${note}${lateNote?.() ?? ""}${cost}`;
			})
			.catch(bookkeepingFailed)
			.finally(() => {
				runs.live.delete(run.identity.id);
				run.release();
				onFinally?.();
			}));
}
