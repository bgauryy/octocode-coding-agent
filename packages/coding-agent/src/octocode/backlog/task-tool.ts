import { renderInstruction } from "../../core/prompt-template.ts";
import { type BacklogTask, TASK_STATES, type TaskState } from "@octocodeai/octocode-contracts/backlogs";
import { StringEnum } from "@octocodeai/octocode-ai";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { resultBlock, toolHeader } from "../shared/render.ts";
import { timedTool, timingOf } from "../shared/render/rows.ts";
import { itemTitle, withItemTitles } from "../shared/render/item-titles.ts";
import { clip, plural } from "../shared/render/text.ts";
import { contentText, textResult } from "../shared/util.ts";
import { visibleControls } from "../../../../common/src/sanitize.ts";
import { type Backlog, type BacklogOptions, openBacklog } from "./context.ts";
import { taskLine, taskWhy } from "./task-format.ts";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from "./tool-list.ts";
import type { Item } from "./store.ts";

const OPEN: TaskState[] = ["todo", "ongoing"];

interface TaskToolDetails {
	task?: BacklogTask;
	/** list: tasks shown, and how many matched. */
	shown?: number;
	total?: number;
}

interface Params {
	op: "list" | "add" | "update";
	id?: string;
	goal?: string;
	why?: string;
	item?: string;
	state?: TaskState;
	result?: string;
	limit?: number;
	offset?: number;
}

/** Ops and fields earlier versions accepted; a call or replayed session that still names one learns it is gone. */
const REMOVED_OPS = ["move", "promote"];

function assertCurrentOp(op: unknown): void {
	if (typeof op === "string" && REMOVED_OPS.includes(op))
		throw new Error(
			`The steps op "${op}" was removed: steps take list, add and update. Ask the user to reorder or promote a step on the backlog board.`,
		);
}

/**
 * What the model reads about `steps` (stored as tasks, `T<n>`): when work gets steps (the quick-work threshold, for every
 * role that has the tool), how a step is used and what happens to the steps left open. `backlog`'s guidelines say when
 * work is an item.
 */
function taskPrompt(subagent: boolean) {
	return {
		promptSnippet: renderInstruction("tools/steps/snippet.md"),
		description:
			"Tracked steps of one piece of work, kept under the backlog item you hold (not as separate items) or on this session. add uses the one item this session holds; with several, it needs item.",
		promptGuidelines: [renderInstruction("tools/steps/guidelines.md", { subagent })],
	};
}

/** The items whose tasks this actor tracks by default: its child item, or the items the session holds (epics group items and take no tasks). */
function heldItems({ store, actor, session }: Backlog): Item[] {
	if (actor.item) {
		const item = store.get(actor.item);
		return item ? [item] : [];
	}
	if (actor.owners) return [];
	return store
		.list({ states: ["ongoing"], limit: 200 })
		.items.filter((item) => item.assignee === session && item.type !== "epic")
		.sort((a, b) => a.seq - b.seq);
}

/** The items whose tasks `list` shows for `ref`: the item, or an epic's items (an epic takes no tasks of its own). */
function itemScopes({ store }: Backlog, ref: string): string[] {
	const item = store.get(ref);
	if (!item) throw new Error(`No backlog item ${visibleControls(ref)}.`);
	return item.type === "epic" ? store.list({ parentId: item.ref }).items.map((child) => child.ref) : [item.ref];
}

const taskSummary = (op: unknown, details: TaskToolDetails, text: string): string => {
	const { task } = details;
	if (op === "list") return plural(details.shown ?? 0, "step");
	const goal = task ? ` · ${clip(visibleControls(task.goal), 80)}` : "";
	if (task && op === "add") return `Added ${task.ref} · ${task.state}${goal}`;
	if (task && op === "update") return `${task.ref} → ${task.state}${goal}`;
	if (task) return `${task.ref} · ${task.state}${goal}`;
	return text.split("\n", 1)[0] ?? "";
};

export function registerTaskTool(
	api: ExtensionAPI,
	options: BacklogOptions & { changed?: (ctx: ExtensionContext) => void },
): void {
	const subagent = options.isSubagent;
	const parameters = Type.Object(
		{
			op: StringEnum(["list", "add", "update"] as const, {
				description: "list: open steps of item, else of this session and its items",
			}),
			id: Type.Optional(Type.String({ description: "update: e.g. T7; list: only this step" })),
			goal: Type.Optional(Type.String({ description: "add/update: what done means" })),
			why: Type.Optional(Type.String({ description: "add/update: why" })),
			item: Type.Optional(
				Type.String({
					description: "list/add: e.g. B12; add: not an epic (epics hold no steps); list: an epic covers its items",
				}),
			),
			state: Type.Optional(StringEnum(TASK_STATES, { description: "list: filter; add: todo/ongoing; update: new" })),
			result: Type.Optional(Type.String({ description: "update: outcome" })),
			limit: Type.Optional(
				Type.Integer({ description: `list: page size, capped at ${MAX_LIST_LIMIT} (default ${DEFAULT_LIST_LIMIT})` }),
			),
			offset: Type.Optional(Type.Integer({ description: "list: skip; copy from Next" })),
		},
		{ additionalProperties: false },
	);

	function run(backlog: Backlog, params: Params) {
		const { store, actor } = backlog;
		const { tasks } = store;
		if (params.op === "list") {
			if (params.id?.trim()) {
				const task = tasks.get(params.id);
				if (!task) throw new Error(`No step ${visibleControls(params.id)}.`);
				return textResult([taskLine(task), ...taskWhy(task)].join("\n"), { shown: 1 });
			}
			const states = params.state ? [params.state] : OPEN;
			const scopes = params.item ? itemScopes(backlog, params.item) : heldItems(backlog).map((item) => item.ref);
			const found = [
				...(params.item ? [] : tasks.list({ session: actor.id, states })),
				...scopes.flatMap((item) => tasks.list({ item, states })),
			];
			// One page, as `backlog list` pages items: done steps accumulate for as long as a session or item lives.
			const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(params.limit ?? DEFAULT_LIST_LIMIT)));
			const offset = Math.max(0, Math.floor(params.offset ?? 0));
			const page = found.slice(offset, offset + limit);
			const lines = page.length ? page.map((task) => taskLine(task)) : [`No ${params.state ?? "open"} steps.`];
			if (found.length > offset + page.length) {
				const next = {
					op: "list",
					...(params.item ? { item: params.item } : {}),
					...(params.state ? { state: params.state } : {}),
				};
				lines.push(`Next: steps ${JSON.stringify({ ...next, limit, offset: offset + page.length })}`);
			}
			return textResult(lines.join("\n"), { shown: page.length, total: found.length });
		}
		if (params.op === "add") {
			if (!params.goal?.trim()) throw new Error("add needs a goal: one line, what done means.");
			const held = params.item ? [] : heldItems(backlog);
			if (held.length > 1)
				throw new Error(
					`You hold ${held.map((item) => item.ref).join(", ")}: pass item to say which one the step goes under.`,
				);
			const owner = params.item ?? held[0]?.ref;
			const task = tasks.add(
				{
					goal: params.goal,
					...(params.why?.trim() ? { reason: params.why.trim() } : {}),
					...(owner ? { item: owner } : {}),
					...(params.state === "todo" || params.state === "ongoing" ? { state: params.state } : {}),
				},
				actor,
			);
			return textResult(`Added ${taskLine(task)}`, { task });
		}
		if (!params.id?.trim()) throw new Error(`${params.op} needs an id, e.g. "T7".`);
		if (
			params.goal === undefined &&
			params.why === undefined &&
			params.result === undefined &&
			params.state === undefined
		)
			throw new Error("update needs something to change: goal, why, result or state.");
		const task = tasks.update(
			params.id,
			{
				...(params.goal !== undefined ? { goal: params.goal } : {}),
				...(params.why !== undefined ? { reason: params.why } : {}),
				...(params.result !== undefined ? { result: params.result } : {}),
				...(params.state !== undefined ? { state: params.state } : {}),
			},
			actor,
		);
		return textResult(`Updated ${taskLine(task)}`, { task });
	}

	api.registerTool(
		timedTool(
			{
				name: "steps",
				label: "Steps",
				...taskPrompt(subagent),
				parameters,
				// A removed op fails the schema's enum with a bare list; this says it is gone.
				prepareArguments(args) {
					assertCurrentOp((args as { op?: unknown } | null)?.op);
					return args as Static<typeof parameters>;
				},
				async execute(_id, params, signal, _onUpdate, ctx) {
					signal?.throwIfAborted();
					assertCurrentOp(params.op);
					const result = run(openBacklog(ctx, options), params);
					if (params.op !== "list") options.changed?.(ctx);
					return result;
				},
				renderCall(args, theme, context) {
					const target = [
						args.op,
						args.id,
						args.item ? `in ${args.item}` : "",
						args.state ? `→ ${args.state}` : "",
						// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders
						args.goal ? `"${clip(String(args.goal), 80)}"` : "",
					]
						.filter(Boolean)
						.join(" ");
					return toolHeader(theme, context, "Steps", withItemTitles(target, itemTitle));
				},
				renderResult(result, _options, theme, context) {
					const text = contentText(result.content);
					const details = (result.details ?? {}) as TaskToolDetails;
					const op = context.args?.op;
					const summary = withItemTitles(
						context.isError ? (text.split("\n", 1)[0] ?? "") : taskSummary(op, details, text),
						itemTitle,
					);
					// A write's first line repeats its summary; a list shows every line.
					const body = context.isError || op !== "list" ? text.split("\n").slice(1).join("\n") : text;
					return resultBlock(theme, context, {
						summary,
						body: withItemTitles(body, itemTitle),
						...timingOf(result.details),
					});
				},
			},
			{ exclusive: true },
		),
	);
}
