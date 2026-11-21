import type { CommandContext } from "../../../core/features/index.ts";
import { USER_AUTHOR } from "../../../../../db/src/api.ts";
import { say } from "../../shared/commands.ts";
import { TASK_STATES, type BacklogTask, type TaskState, isOpenTask } from "@octocodeai/octocode-contracts/backlogs";
import type { Backlog } from "../context.ts";
import type { Item } from "../store.ts";
import { taskLine } from "../task-format.ts";

/** Where a new task goes: an item (`B12`), or this session. */
export type TaskOwnerChoice = { item: string } | { session: true };

/** What the user does to tasks from the board: add, change the state, edit the goal, promote a session task. The user acts as the human actor. */
export function createTaskActions(
	applyAndSay: (ctx: CommandContext, backlog: Backlog, change: () => void, done?: string) => Promise<void>,
	apply: (ctx: CommandContext, backlog: Backlog, change: () => void) => Promise<string | undefined>,
) {
	const human = (backlog: Backlog) => ({ ...backlog.actor, kind: "human" as const });

	/** Asks for a goal, then adds the task under `owner`; nothing when the prompt is cancelled or empty. */
	const add = async (ctx: CommandContext, backlog: Backlog, owner: TaskOwnerChoice): Promise<void> => {
		const where = "item" in owner ? owner.item : "this session";
		const goal = (await ctx.ui.input(`New task for ${where}`, "goal"))?.trim();
		if (!goal) return;
		const target = "item" in owner ? { item: owner.item } : { session: backlog.session };
		let added: BacklogTask | undefined;
		await applyAndSay(ctx, backlog, () => {
			added = backlog.store.tasks.add({ goal, ...target }, human(backlog));
		});
		if (added) say(ctx, `Added ${taskLine(added)}`);
	};

	/** Moves a task to `state`; done and dropped ask for an optional result. Returns the refusal, if any. */
	const setState = async (
		ctx: CommandContext,
		backlog: Backlog,
		task: BacklogTask,
		state: TaskState,
	): Promise<string | undefined> => {
		let result: string | undefined;
		if (state === "done" || state === "dropped") {
			result = await ctx.ui.input(state === "done" ? "What was done? (optional)" : "Why dropped? (optional)");
			if (result === undefined) return "Cancelled.";
		}
		return apply(ctx, backlog, () => {
			backlog.store.tasks.update(
				task.ref,
				{ state, version: task.version, ...(result?.trim() ? { result: result.trim() } : {}) },
				human(backlog),
			);
		});
	};

	/** The board's ←/→ step: no prompts, so a task moves between todo, ongoing and done in one key. */
	const step = (ctx: CommandContext, backlog: Backlog, task: BacklogTask, state: TaskState) =>
		apply(ctx, backlog, () => {
			backlog.store.tasks.update(task.ref, { state, version: task.version }, human(backlog));
		});

	/** The action menu for one task. */
	const actions = async (ctx: CommandContext, backlog: Backlog, ref: string): Promise<void> => {
		const task = backlog.store.tasks.get(ref);
		if (!task) return say(ctx, `No task ${ref}.`, "warning");
		const choices: Array<{ label: string; run(): void | Promise<void> }> = [
			...TASK_STATES.filter((state) => state !== task.state).map((state) => ({
				label: `Mark ${state}`,
				run: async () => {
					const refused = await setState(ctx, backlog, task, state);
					if (refused) say(ctx, refused, "warning");
				},
			})),
			{
				label: "Edit goal",
				run: async () => {
					const goal = (await ctx.ui.editor(`Edit the goal of ${task.ref}`, task.goal))?.trim();
					if (!goal) return;
					await applyAndSay(ctx, backlog, () => {
						backlog.store.tasks.update(task.ref, { goal, version: task.version }, human(backlog));
					});
				},
			},
			{
				label: task.owner.kind === "item" ? `Add a task to ${task.owner.ref}` : "Add a session task",
				run: () => add(ctx, backlog, task.owner.kind === "item" ? { item: task.owner.ref } : { session: true }),
			},
		];
		if (task.owner.kind === "session" && isOpenTask(task.state))
			choices.push({
				label: "Promote to a backlog item",
				run: async () => {
					let promoted: Item | undefined;
					await applyAndSay(ctx, backlog, () => {
						// The new item is the user's own, as one added with `a` is.
						promoted = backlog.store.tasks.promote(
							task.ref,
							{ version: task.version },
							{ id: USER_AUTHOR, kind: "human" },
						).item;
					});
					if (promoted) say(ctx, `Promoted ${task.ref} to ${promoted.ref} (in the backlog, to triage).`);
				},
			});
		const choice = await ctx.ui.select(
			taskLine(task),
			choices.map(({ label }) => label),
		);
		await choices.find(({ label }) => label === choice)?.run();
	};

	return { add, actions, step };
}
