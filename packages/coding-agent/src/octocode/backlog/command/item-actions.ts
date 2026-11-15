import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../core/features/index.ts";
import { USER_AUTHOR } from "../../../../../db/src/api.ts";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import { keyText } from "../../../theme/theme-tui-helpers.ts";
import { say, type Subcommand } from "../../shared/commands.ts";
import { showCommandPage } from "../../shared/page.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { delegatePrompt, doItPrompt } from "../actions.ts";
import { type Backlog, type BacklogOptions, userActor } from "../context.ts";
import { CLOSE_KINDS, type CloseKind } from "@octocodeai/octocode-contracts/backlogs";
import { isState, itemDetail, itemLine } from "../format.ts";
import { refText } from "../row.ts";
import { type BacklogStore, type Item, PRIORITIES, priorityName, type UpdateInput } from "../store.ts";
import { createTaskActions } from "./task-actions.ts";
import { STATES } from "@octocodeai/octocode-contracts/snapshot";

/** The fields `Edit` changes, one per editor: the text shown for an item, and the store update for the text saved (a list has one entry per line). */
const EDITABLE: Record<string, { text(item: Item): string; patch(text: string): UpdateInput }> = {
	Type: { text: (item) => item.type, patch: (text) => ({ type: text as Item["type"] }) },
	Parent: { text: (item) => item.parentId ?? "", patch: (text) => ({ parentId: text || null }) },
	Dependencies: {
		text: (item) => item.dependsOn.map((r) => r.id).join("\n"),
		patch: (text) => ({ dependsOn: text.split(/[\s,]+/).filter(Boolean) }),
	},
	Title: { text: (item) => item.title, patch: (text) => ({ title: text }) },
	"Done when": { text: (item) => item.goal, patch: (text) => ({ goal: text }) },
	Paths: { text: (item) => item.paths.join("\n"), patch: (text) => ({ paths: text.split("\n") }) },
	Reason: { text: (item) => item.why, patch: (text) => ({ why: text }) },
	Evidence: { text: (item) => item.evidence.join("\n"), patch: (text) => ({ evidence: text.split("\n") }) },
	Plan: { text: (item) => item.plan, patch: (text) => ({ plan: text }) },
};

/** The full detail the user sees: origin, the items that came from it, and the latest notes and changes. */
export function detail(backlog: Backlog, item: Item, notes = 10): string {
	const origin = item.from === undefined ? undefined : backlog.store.get(item.from);
	const options = {
		self: backlog.session,
		version: true,
		...(origin ? { origin } : {}),
		derived: backlog.store.derived(item),
	};
	return itemDetail(item, backlog.store.notes(item, notes), backlog.store.noteCount(item), Date.now(), options);
}

export interface CommandDeps extends BacklogOptions {
	items(): Item[];
	/** Opens this session's own live board and resolves to its address; used when `web` has no command. */
	openView(ctx: ExtensionCommandContext, backlog: Backlog): Promise<string>;
	/** The `/web` command, when registered: `/backlog web` runs `/web backlogs`. */
	web?(): Subcommand | undefined;
	/** Opens a file in the default application; replaceable so a test opens nothing. */
	open?: (file: string) => Promise<void>;
	/** Repaint the footer counts after a change. */
	changed(ctx: ExtensionCommandContext): void;
}

/** What the user does to backlog items from `/backlog`: add, edit, move, close, and hand one to the agent. */
export function createItemActions(api: ExtensionAPI, deps: CommandDeps) {
	/** Runs one store change and repaints; returns the refusal text instead of throwing. */
	const apply = (ctx: ExtensionCommandContext, change: () => void): string | undefined => {
		try {
			change();
			deps.changed(ctx);
			return undefined;
		} catch (error) {
			return errorMessage(error);
		}
	};
	/** `apply`, telling the user the outcome (`done` on success, the refusal as a warning). */
	const applyAndSay = (ctx: ExtensionCommandContext, change: () => void, done?: string): void => {
		const refused = apply(ctx, change);
		if (refused) say(ctx, refused, "warning");
		else if (done) say(ctx, done);
	};

	const tasks = createTaskActions(applyAndSay, apply);

	/**
	 * The two answers an item needs before it can be claimed or closed, asked when missing (the same questions for every
	 * route to ongoing). Returns the fields to set, or the reason the user did not answer.
	 */
	const askWhyGoal = async (
		ctx: ExtensionCommandContext,
		item: Item,
	): Promise<{ fields: Pick<UpdateInput, "why" | "goal"> } | { refused: string }> => {
		const fields: Pick<UpdateInput, "why" | "goal"> = {};
		if (!item.why) {
			const why = await ctx.ui.input("Why does this matter?");
			if (!why) return { refused: "Move cancelled: reason needed." };
			fields.why = why;
		}
		if (!item.goal) {
			const goal = await ctx.ui.input("What result means done?");
			if (!goal) return { refused: "Move cancelled: goal needed." };
			fields.goal = goal;
		}
		return { fields };
	};

	/** Mark `item` ongoing for this session and hand it to the agent, now or after the current run. */
	const handOff = async (
		ctx: ExtensionCommandContext,
		backlog: Backlog,
		item: Item,
		prompt: (item: Item, store: BacklogStore) => string,
	): Promise<boolean> => {
		const asked = await askWhyGoal(ctx, item);
		if ("refused" in asked) {
			say(ctx, asked.refused, "warning");
			return false;
		}
		let claimed!: Item;
		try {
			backlog.store.dispatch(
				item.ref,
				item.version,
				userActor(backlog),
				(next) => {
					claimed = next;
					api.sendUserMessage(prompt(next, backlog.store), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
				},
				asked.fields,
			);
		} catch (error) {
			say(ctx, errorMessage(error), "warning");
			return false;
		}
		deps.changed(ctx);
		if (!ctx.isIdle()) say(ctx, `${claimed.ref} is queued: the agent starts it after the current run.`);
		return true;
	};

	// The user's own move: may override another live session's hold (claiming it as ongoing is still refused).
	const move = async (
		ctx: ExtensionCommandContext,
		backlog: Backlog,
		item: Item,
		state: (typeof STATES)[number],
	): Promise<string | undefined> => {
		const patch: UpdateInput = { state, version: item.version, force: true };
		if (state === "ongoing" || state === "done") {
			const asked = await askWhyGoal(ctx, item);
			if ("refused" in asked) return asked.refused;
			Object.assign(patch, asked.fields);
		}
		if (state === "done" && item.state !== "done") {
			const summary = await ctx.ui.input("What changed?");
			if (!summary) return "Completion cancelled.";
			const files = await ctx.ui.input("Related files (comma separated; empty for none)");
			if (files === undefined) return "Completion cancelled.";
			patch.completion = {
				summary,
				files: files
					.split(",")
					.map((p) => p.trim())
					.filter(Boolean)
					.map((path) => ({ path, role: "changed" })),
				verification: { status: "not_run", summary: "Manually completed without recorded verification." },
				operationKey: randomUUID(),
			};
		}
		if (item.state === "done" && state !== "done") {
			const note = await ctx.ui.input("Why reopen?");
			if (!note) return "Reopen cancelled.";
			patch.note = note;
		}
		return apply(ctx, () => backlog.store.update(item.ref, patch, userActor(backlog)));
	};

	/** Closes `item` (never deletes): asks the kind, the reason and for a duplicate its original; the item keeps its history. */
	const closeItem = async (ctx: ExtensionCommandContext, backlog: Backlog, item: Item): Promise<void> => {
		const kind = await ctx.ui.select(`Close ${item.ref}: why is it not needed?`, [...CLOSE_KINDS]);
		if (!kind || !CLOSE_KINDS.includes(kind as CloseKind)) return;
		const of = kind === "duplicate" ? (await ctx.ui.input("Duplicate of which item?", "B12"))?.trim() : undefined;
		if (kind === "duplicate" && !of) return;
		const text = (await ctx.ui.input("Reason", "why this item is closed"))?.trim();
		if (!text) return;
		const close = { kind: kind as CloseKind, text, ...(of ? { of } : {}) };
		applyAndSay(
			ctx,
			() => backlog.store.update(item.ref, { close, version: item.version, force: true }, userActor(backlog)),
			`Closed ${item.ref}.`,
		);
	};

	const add = async (ctx: ExtensionCommandContext, backlog: Backlog, given: string): Promise<void> => {
		const title = given || (ctx.hasUI ? ((await ctx.ui.input("New backlog item", "title"))?.trim() ?? "") : "");
		if (!title) return say(ctx, "Usage: /backlog add <title>", given || !ctx.hasUI ? "warning" : "info");
		let item: Item;
		try {
			item = backlog.store.add({
				title,
				state: "todo",
				createdBy: USER_AUTHOR,
				sourceSession: backlog.session,
			});
		} catch (error) {
			return say(ctx, `Not added: ${errorMessage(error)}`, "warning");
		}
		deps.changed(ctx);
		say(ctx, `Added ${itemLine(item, backlog.session)}`);
	};

	const edit = async (ctx: ExtensionCommandContext, backlog: Backlog, item: Item): Promise<void> => {
		const name = await ctx.ui.select(`Edit which field of ${item.ref}?`, Object.keys(EDITABLE));
		const field = name === undefined ? undefined : EDITABLE[name];
		if (!name || !field) return;
		const hint = name === "Paths" || name === "Evidence" ? " (one per line)" : "";
		const text = await ctx.ui.editor(`Edit the ${name.toLowerCase()} of ${item.ref}${hint}`, field.text(item));
		if (text === undefined) return;
		const patch = field.patch(text.trim());
		if (name === "Title" && !patch.title) return say(ctx, "Not saved: the title is empty.", "warning");
		applyAndSay(ctx, () =>
			backlog.store.update(item.ref, { ...patch, version: item.version, force: true }, userActor(backlog)),
		);
	};

	/** The action menu for one item; returns true when the item went to the agent (the board then closes). */
	const actions = async (ctx: ExtensionCommandContext, backlog: Backlog, ref: string): Promise<boolean> => {
		const item = backlog.store.get(ref);
		if (!item) {
			say(ctx, `No backlog item ${ref}.`, "warning");
			return false;
		}
		// Octocode's select returns a label. Keep that label and its behavior together, with one dispatch at the UI boundary.
		const choices: Array<{ label: string; run(): boolean | undefined | Promise<boolean | undefined> }> = [
			{ label: "Do it now", run: () => handOff(ctx, backlog, item, doItPrompt) },
			{ label: "Delegate to a subagent", run: () => handOff(ctx, backlog, item, delegatePrompt) },
			{
				label: "Move to…",
				run: async () => {
					const state = await ctx.ui.select(
						`Move ${item.ref} to`,
						STATES.filter((state) => state !== item.state),
					);
					const refused = state && isState(state) ? await move(ctx, backlog, item, state) : undefined;
					if (refused) say(ctx, refused, "warning");
				},
			},
			{
				label: "Edit",
				run: async () => {
					await edit(ctx, backlog, item);
					return undefined;
				},
			},
			...(item.type === "epic"
				? []
				: [
						{
							label: "Add a task",
							run: async () => {
								await tasks.add(ctx, backlog, { item: item.ref });
								return undefined;
							},
						},
					]),
			{
				label: "Add a session task",
				run: async () => {
					await tasks.add(ctx, backlog, { session: true });
					return undefined;
				},
			},
			{
				label: "Priority…",
				run: async () => {
					const priority = await ctx.ui.select(`Priority of ${item.ref}`, [...PRIORITIES]);
					const index = (PRIORITIES as readonly string[]).indexOf(priority ?? "");
					if (index >= 0)
						applyAndSay(ctx, () =>
							backlog.store.update(
								item.ref,
								{ priority: index, version: item.version, force: true },
								userActor(backlog),
							),
						);
				},
			},
			{
				label: "Came from…",
				run: async () => {
					const ref = await ctx.ui.input(
						`${item.ref} came from (empty clears)`,
						item.from === undefined ? "B12" : refText(item.from),
					);
					if (ref !== undefined)
						applyAndSay(ctx, () =>
							backlog.store.update(
								item.ref,
								{ from: ref.trim() === "" ? null : ref.trim(), version: item.version, force: true },
								userActor(backlog),
							),
						);
				},
			},
			{
				label: "Show notes and changes",
				run: () => {
					say(ctx, detail(backlog, item, 50));
					return undefined;
				},
			},
			{
				label: "Close",
				run: async () => {
					await closeItem(ctx, backlog, item);
					return undefined;
				},
			},
		];
		const labels = choices.map(({ label }) => label);
		const choice =
			ctx.mode === "tui"
				? (
						await showCommandPage(ctx.ui, {
							title: `${item.ref} ${sanitizeTerminalText(item.title)}`,
							facts: [
								{ label: "State", value: item.state },
								{ label: "Priority", value: priorityName(item.priority) },
							],
							sections: [{ heading: "Actions", rows: labels.map((name) => ({ id: name, name })) }],
							hints: [
								[keyText("tui.select.confirm"), "run", 0],
								[keyText("tui.select.cancel"), "back", 1],
							],
						})
					)?.id
				: await ctx.ui.select(itemLine(item, backlog.session), labels);
		return (await choices.find(({ label }) => label === choice)?.run()) === true;
	};
	return { apply, handOff, move, closeItem, add, actions, tasks };
}
