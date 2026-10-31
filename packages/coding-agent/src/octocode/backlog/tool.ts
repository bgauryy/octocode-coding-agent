import { EntityFields, type EntityInput } from "@octocodeai/octocode-contracts/backlogs";
import { STATES, type State } from "@octocodeai/octocode-contracts/snapshot";
import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import { resultBlock, toolHeader } from "../shared/render.ts";
import { storedText, visibleControls } from "../../../../common/src/sanitize.ts";
import { contentText, textResult } from "../shared/util.ts";
import { type Backlog, type BacklogOptions, openBacklog } from "./context.ts";
import { itemDetail, itemLine } from "./format.ts";
import { entityFields, type LinkArgument, linkInput } from "./tool-schema.ts";
import { COMPLETION_GUIDANCE, type Item, PRIORITIES } from "./store.ts";
import { clip, plural } from "../shared/render/text.ts";
import { timedTool, timingOf } from "../shared/render/rows.ts";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_STATES: State[] = ["ongoing", "todo"];

interface BacklogToolDetails {
	item?: Item;
	/** list: items shown and matched. */
	shown?: number;
	total?: number;
	/** remove: the removed item's ref. */
	removed?: string;
}

/** The `⎿` line: `B12 → done`, `Added B3`, `Removed B1`, `3 items`. */
function backlogSummary(op: unknown, details: BacklogToolDetails, text: string): string {
	const item = details.item;
	if (op === "list" && details.total !== undefined)
		return details.total === 0
			? "No items"
			: details.total > (details.shown ?? 0)
				? `${details.shown} of ${plural(details.total, "item")}`
				: plural(details.total, "item");
	if (op === "remove" && details.removed) return `Removed ${details.removed}`;
	if (item && op === "add") return `Added ${item.ref} · ${item.state}`;
	if (item && op === "update") return `${item.ref} → ${item.state}`;
	if (item) return `${item.ref} · ${item.state} · ${item.title}`;
	return text.split("\n", 1)[0] ?? "";
}

/**
 * What the model reads about `backlog`: the description says what it is, `op` owns the operations, the guidelines only
 * when to use it. The write rules (who may change what) live in `writes.ts`; this tool checks the shape of a call.
 */
function backlogPrompt(subagent: boolean): {
	description: string;
	ops: string;
	promptSnippet: string;
	promptGuidelines: string[];
} {
	const description =
		// The same text for every role, so parent and child declare identical bytes; a role's limits are stated when it hits them.
		"Repository work: backlog proposed, todo accepted, ongoing claimed, done completed. " +
		"An item another running session holds takes only notes. " +
		"Claiming (ongoing) needs why and goal; done needs completion.";
	const ops =
		"list/get: read; follow Next for more. " +
		(subagent
			? "add: propose; update: ongoing/done or notes"
			: "add: propose; update: edit, claim (ongoing) or add notes; remove: only duplicates or user-requested items without history");
	return {
		description,
		ops,
		promptSnippet: subagent
			? "Record progress on claimed items; propose follow-ups"
			: "Propose, claim and close repository tasks",
		promptGuidelines: subagent
			? [
					"If your task names a backlog item, note progress on it and close it after verifying its goal. Propose, never do, follow-ups and unfixed failures (trigger, evidence, fix) with from and links.",
				]
			: [
					"Add an item when the user asks to track something, work outlives this turn, or you leave a follow-up or failure (from; trigger, evidence, fix). Claim it before starting or delegating; before reporting, update items you touched.",
					`Give every item why, paths and links. Close only after verifying the goal; ${COMPLETION_GUIDANCE} Questions and one-step tasks need no item.`,
				],
	};
}

/** The states a subagent may set: claiming and closing items its parent holds. */
const SUBAGENT_STATES = ["ongoing", "done"] as const;

export function registerBacklogTool(
	api: ExtensionAPI,
	options: BacklogOptions & { changed?: (ctx: ExtensionContext) => void },
): void {
	const subagent = options.isSubagent;
	const { ops, ...prompt } = backlogPrompt(subagent);
	const parameters = Type.Object(
		{
			...entityFields(subagent),
			op: StringEnum(
				subagent ? (["list", "get", "add", "update"] as const) : (["list", "get", "add", "update", "remove"] as const),
				{ description: ops },
			),
			id: Type.Optional(Type.String({ description: `${subagent ? "get/update" : "get/update/remove"}: item id` })),
			title: Type.Optional(Type.String({ description: `${subagent ? "add" : "add/update"}: one-line summary` })),
			goal: Type.Optional(
				Type.String({
					description: subagent
						? "add: Definition of Done, checkable"
						: "add/update: Definition of Done, checkable; add needs it",
				}),
			),
			paths: Type.Optional(Type.Array(Type.String(), { description: "files, dirs or components affected" })),
			why: Type.Optional(Type.String({ description: "why it matters" })),
			evidence: Type.Optional(
				Type.Array(Type.String(), { description: "observations with source (path:line, command)" }),
			),
			plan: Type.Optional(Type.String({ description: "approach and steps; blast radius, before -> after" })),
			state: Type.Optional(
				subagent
					? StringEnum(SUBAGENT_STATES, { description: "update: ongoing or done" })
					: StringEnum(STATES, { description: "add: initial (default backlog); update: new" }),
			),
			priority: Type.Optional(
				StringEnum(PRIORITIES, {
					description: `${subagent ? "add" : "add/update"}: p0 urgent … p3 someday (default p2)`,
				}),
			),
			tags: Type.Optional(
				Type.Array(Type.String(), { description: `${subagent ? "add" : "add/update"}: short labels` }),
			),
			from: Type.Optional(
				Type.String({
					description: `Origin ID; list filters derived items${subagent ? "" : '; update "" clears'}`,
				}),
			),
			note: Type.Optional(
				Type.String({
					description: `${subagent ? "update" : "update, or add with state ongoing/done"}: append progress or findings`,
				}),
			),
			query: Type.Optional(Type.String({ description: "list: text in any field, or a whole tag" })),
			states: Type.Optional(
				Type.Array(StringEnum(STATES), { description: "list: states to show (default ongoing, todo)" }),
			),
			limit: Type.Optional(
				Type.Integer({
					description: `list/get: page size, capped at ${MAX_LIST_LIMIT} (items ${DEFAULT_LIST_LIMIT}, notes 10)`,
				}),
			),
			offset: Type.Optional(Type.Integer({ description: "list/get: skip; copy from Next" })),
		},
		{ additionalProperties: false },
	);
	api.registerTool(
		timedTool(
			{
				name: "backlog",
				label: "Backlog",
				...prompt,
				parameters,
				async execute(_id, params, signal, _onUpdate, ctx) {
					signal?.throwIfAborted();
					// `reason` is every native call's purpose (`shared/reason.ts`), never the item's why.
					const { reason: _reason, links, ...rest } = params as Params & { reason?: string; links?: LinkArgument[] };
					const unknown = Object.keys(rest).filter(
						(key) => !Object.hasOwn(parameters.properties, key) && !Object.hasOwn(EntityFields, key),
					);
					if (unknown.length) throw new Error(`Unknown backlog fields: ${unknown.join(", ")}.`);
					const backlog = openBacklog(ctx, options);
					const result = run(backlog, {
						...rest,
						...(links !== undefined ? { links: linkInput(links, backlog.store.repo) } : {}),
					});
					if (params.op !== "list" && params.op !== "get") options.changed?.(ctx);
					return result;
				},
				renderCall(args, theme, context) {
					const target = [
						args.op,
						args.id,
						args.state ? `→ ${args.state}` : "",
						args.from ? `from ${clip(String(args.from), 20)}` : "",
						args.title ? `"${clip(String(args.title), 80)}"` : "",
						args.query ? `"${clip(String(args.query), 80)}"` : "",
					]
						.filter(Boolean)
						.join(" ");
					return toolHeader(theme, context, "Backlog", target);
				},
				renderResult(result, _options, theme, context) {
					const text = contentText(result.content);
					const details = (result.details ?? {}) as BacklogToolDetails;
					const summary = context.isError
						? (text.split("\n", 1)[0] ?? "")
						: backlogSummary(context.args?.op, details, text);
					const firstIsSummary = context.isError || (context.args?.op !== "list" && context.args?.op !== "get");
					return resultBlock(theme, context, {
						summary,
						body: firstIsSummary ? text.split("\n").slice(1).join("\n") : text,
						...timingOf(result.details),
					});
				},
			},
			{ exclusive: true },
		),
	);

	type Params = EntityInput & {
		op: "list" | "get" | "add" | "update" | "remove";
		id?: string;
		title?: string;
		goal?: string;
		paths?: string[];
		why?: string;
		evidence?: string[];
		plan?: string;
		state?: State;
		priority?: string;
		tags?: string[];
		from?: string;
		note?: string;
		query?: string;
		states?: State[];
		limit?: number;
		offset?: number;
	};

	/** The descriptive fields a call sets, only those it names. */
	const text = ({ paths, why, evidence, plan }: Params) => ({
		...(paths !== undefined ? { paths } : {}),
		...(why !== undefined ? { why } : {}),
		...(evidence !== undefined ? { evidence } : {}),
		...(plan !== undefined ? { plan } : {}),
	});

	function run({ store, actor, session }: Backlog, params: Params) {
		const priority =
			params.priority === undefined ? undefined : PRIORITIES.indexOf(params.priority as (typeof PRIORITIES)[number]);
		if (params.op === "list") {
			const states = params.states?.length ? params.states : DEFAULT_LIST_STATES;
			const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(params.limit ?? DEFAULT_LIST_LIMIT)));
			const offset = Math.max(0, Math.floor(params.offset ?? 0));
			const filters = {
				...(params.query ? { query: params.query } : {}),
				...(params.from ? { from: params.from } : {}),
			};
			const { items, total } = store.list({ states, ...filters, limit, offset });
			const lines = items.map((item) => itemLine(item, actor.id, actor.owners));
			if (lines.length === 0)
				lines.push(
					`No ${states.join("/")} items${params.query ? ` matching "${visibleControls(params.query)}"` : ""}${params.from ? ` from ${visibleControls(params.from)}` : ""}.`,
				);
			if (total > offset + items.length)
				lines.push(
					`Next: backlog ${JSON.stringify({ op: "list", states, ...filters, limit, offset: offset + items.length })}`,
				);
			const triage = states.includes("backlog") ? 0 : store.counts().backlog;
			if (triage > 0) lines.push(`${triage} proposed item(s) await triage (list with states: ["backlog"]).`);
			return textResult(lines.join("\n"), { shown: items.length, total });
		}
		if (params.op === "add") {
			if (!params.title?.trim()) throw new Error("add needs a title.");
			if (!params.why?.trim())
				throw new Error("add needs why: the reason for the work (user request, failure found, follow-up of an item).");
			// Creation, initial claim/completion and notes commit together in the store, which applies the write rules.
			const item = store.add(
				{
					...entities(params),
					note: params.note,
					title: params.title,
					...(params.goal !== undefined ? { goal: params.goal } : {}),
					...text(params),
					...(params.state !== undefined ? { state: params.state } : {}),
					...(priority !== undefined ? { priority } : {}),
					...(params.tags ? { tags: params.tags } : {}),
					...(params.from ? { from: params.from } : {}),
					createdBy: subagent ? `agent:${actor.id}` : "agent",
					sourceSession: session,
				},
				actor,
			);
			return textResult(`Added ${itemLine(item, actor.id, actor.owners)}`, { item });
		}
		if (!params.id?.trim()) throw new Error(`${params.op} needs an id, e.g. "B12".`);
		if (params.op === "get") {
			const item = store.get(params.id);
			if (!item) throw new Error(`No backlog item ${visibleControls(params.id)}.`);
			const offset = Math.max(0, Math.floor(params.offset ?? 0));
			const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(params.limit ?? 10)));
			const notes = store.notes(item, limit, offset);
			const total = store.noteCount(item);
			const origin = item.from === undefined ? undefined : store.get(item.from);
			const detail = itemDetail(item, notes, total, Date.now(), {
				self: actor.id,
				version: true,
				noteOffset: offset,
				...(actor.owners ? { parents: actor.owners } : {}),
				...(origin ? { origin } : {}),
				derived: store.derived(item),
			});
			const next =
				offset + notes.length < total
					? `\nNext: backlog ${JSON.stringify({ op: "get", id: item.ref, limit, offset: offset + notes.length })}`
					: "";
			return textResult(`${detail}${next}`, { item });
		}
		if (params.op === "remove") {
			const item = store.remove(params.id, params.version, actor);
			return textResult(`Removed ${item.ref} "${visibleControls(item.title)}" and its notes.`, {
				removed: item.ref,
			});
		}
		const fields = {
			type: params.type,
			parentId: params.parentId,
			dependsOn: params.dependsOn,
			links: params.links,
			title: params.title,
			goal: params.goal,
			...text(params),
			priority,
			tags: params.tags,
			from: params.from,
		};
		if (
			params.state === undefined &&
			params.note === undefined &&
			params.completion === undefined &&
			Object.values(fields).every((value) => value === undefined)
		)
			throw new Error(
				"update needs something to change: state, note, completion, title, goal, paths, why, evidence, plan, links, priority, tags or from.",
			);
		// The goal is the done criterion an agent's items always have (`store.add`): an update may change it, not blank it.
		if (params.goal !== undefined && !storedText(params.goal))
			throw new Error("update cannot clear the goal: give the new done criterion, a check someone else can run.");
		const item = store.update(
			params.id,
			{
				...entities(params),
				...(params.title !== undefined ? { title: params.title } : {}),
				...(params.goal !== undefined ? { goal: params.goal } : {}),
				...text(params),
				...(params.state !== undefined ? { state: params.state } : {}),
				...(priority !== undefined ? { priority } : {}),
				...(params.tags !== undefined ? { tags: params.tags } : {}),
				...(params.from !== undefined ? { from: params.from.trim() === "" ? null : params.from } : {}),
				...(params.note !== undefined ? { note: params.note } : {}),
			},
			actor,
		);
		return textResult(`Updated ${itemLine(item, actor.id, actor.owners)}`, { item });
	}
}

function entities(p: EntityInput): EntityInput {
	return Object.fromEntries(
		Object.keys(EntityFields)
			.filter((key) => p[key as keyof EntityInput] !== undefined)
			.map((key) => [key, p[key as keyof EntityInput]]),
	);
}
