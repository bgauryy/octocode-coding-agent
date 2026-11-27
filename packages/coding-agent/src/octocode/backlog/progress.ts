import type { BacklogTask, TaskTally } from "@octocodeai/octocode-contracts/backlogs";
import type { BacklogStore } from "./store.ts";
import { sessionTaskTally } from "./format.ts";

/** The step shown beside the count: its goal and, for an item's step, the item (`B12`). */
export interface CurrentStep {
	goal: string;
	item?: string;
}

/** Cells of the progress bar; a checklist shorter than this gets one cell per step. */
const BAR_CELLS = 6;
/** The step's goal is cut to this many characters, so the count and bar keep their room in the footer. */
const GOAL_CHARS = 48;

/**
 * The step this session works on: the first ongoing one, else the next to do, among its own steps and those of the
 * items it holds (ongoing, assigned to it), its own first.
 */
export function currentStep(store: BacklogStore, self: string): CurrentStep | undefined {
	const held = store.list({ states: ["ongoing"], assignees: [self] }).items;
	const open = [
		...store.tasks.list({ session: self, states: ["ongoing", "todo"] }),
		...held.flatMap((item) => store.tasks.list({ item: item.ref, states: ["ongoing", "todo"] })),
	];
	const step: BacklogTask | undefined = open.find((task) => task.state === "ongoing") ?? open[0];
	if (!step) return undefined;
	return { goal: step.goal, ...(step.owner.kind === "item" ? { item: step.owner.ref } : {}) };
}

function bar(done: number, total: number): string {
	const cells = Math.min(total, BAR_CELLS);
	const filled = Math.round((done / total) * cells);
	return "▰".repeat(filled) + "▱".repeat(cells - filled);
}

/** Separates the count from the step, so the footer can drop the step first (`footer/rows.ts`). */
export const STEP_SEPARATOR = " · ▶ ";

/**
 * `▰▰▱▱ 2/4 steps · 1 dropped · ▶ B12 Run the focused tests`. Dropped steps stay in the denominator and are named
 * separately; an empty checklist has no chip.
 */
export function progressText(tally: TaskTally, current?: CurrentStep): string | undefined {
	const total = tally.todo + tally.ongoing + tally.done + tally.dropped;
	if (!total) return undefined;
	const count = `${bar(tally.done + tally.dropped, total)} ${tally.done}/${total} steps${tally.dropped ? ` · ${tally.dropped} dropped` : ""}`;
	if (!current) return count;
	const goal = current.goal.replace(/\s+/g, " ").trim();
	const shown = goal.length > GOAL_CHARS ? `${goal.slice(0, GOAL_CHARS - 1)}…` : goal;
	return `${count}${STEP_SEPARATOR}${current.item ? `${current.item} ` : ""}${shown}`;
}

/** The footer's step chip for this session. */
export const sessionProgressText = (store: BacklogStore, self: string): string | undefined =>
	progressText(sessionTaskTally(store, self), currentStep(store, self));
