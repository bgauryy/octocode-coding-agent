import {
	type Completion,
	EntityFields,
	type EntityInput,
	isItemType,
	ITEM_TYPES,
} from "@octocodeai/octocode-contracts/backlogs";
import { STATES, type State } from "@octocodeai/octocode-contracts/snapshot";
import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { resultBlock, toolHeader } from "../shared/render.ts";
import { storedText, visibleControls } from "../../../../common/src/sanitize.ts";
import { contentText, textResult } from "../shared/util.ts";
import { BACKLOG_ITEM_ENV } from "../../../../common/src/env.ts";
import { type Backlog, type BacklogOptions, openBacklog } from "./context.ts";
import { itemDetail, itemLine } from "./format.ts";
import { withOperationKey, type CompletionArgument } from "./completion-key.ts";
import { acceptTargetShorthand, entityFields, type LinkArgument, linkInput } from "./tool-schema.ts";
import { withReason } from "../shared/reason.ts";
import { type Item, PRIORITIES } from "./store.ts";
import { type BacklogToolDetails, backlogPrompt, backlogSummary } from "./tool-text.ts";
import { styleBacklogLines } from "./tool-style.ts";
import { clip } from "../shared/render/text.ts";
import { timedTool, timingOf } from "../shared/render/rows.ts";
import { DEFAULT_LIST_LIMIT, listFields, type ListParams, MAX_LIST_LIMIT, runList } from "./tool-list.ts";

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
			...listFields,
			op: StringEnum(
				subagent ? (["list", "get", "add", "update"] as const) : (["list", "get", "add", "update", "remove"] as const),
				{ description: ops },
			),
			id: Type.Optional(Type.String({ description: `${subagent ? "get/update" : "get/update/remove"}: item id` })),
			title: Type.Optional(
				Type.String({
					description: `${subagent ? "add" : "add/update"}: one-line summary; list: words in the title`,
				}),
			),
			goal: Type.Optional(
				Type.String({
					description: subagent
						? "add: Definition of Done, checkable"
						: "add/update: Definition of Done, checkable; add needs it",
				}),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description: `${subagent ? "add" : "add/update"}: files, dirs or components affected; list: any as path prefix`,
				}),
			),
			why: Type.Optional(Type.String({ description: `${subagent ? "add" : "add/update"}: why it matters` })),
			evidence: Type.Optional(
				Type.Array(Type.String(), {
					description: `${subagent ? "add" : "add/update"}: observations with source (path:line, command)`,
				}),
			),
			plan: Type.Optional(
				Type.String({
					description: `${subagent ? "add" : "add/update"}: approach and steps; blast radius, before -> after`,
				}),
			),
			state: Type.Optional(
				subagent
					? StringEnum(SUBAGENT_STATES, { description: "update: ongoing or done" })
					: StringEnum(STATES, { description: "add: initial (default backlog); update: new" }),
			),
			priority: Type.Optional(
				StringEnum(PRIORITIES, {
					description: `${subagent ? "add" : "add/update"}: p0 urgent … p3 someday (default p2); list: this or more urgent`,
				}),
			),
			tags: Type.Optional(
				Type.Array(Type.String(), {
					description: `${subagent ? "add" : "add/update"}: short labels; list: any of these`,
				}),
			),
			from: Type.Optional(
				Type.String({
					description: `Origin ID${subagent ? "" : '; update "" clears'}; list: items derived from it`,
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
				// A child declares `backlog` only when its task names the item it may update (BACKLOG_ITEM_ENV, set by the parent):
				// without one it has nothing to update and puts follow-ups in its report. Registered either way, so the store
				// rules and RPC callers are unchanged; the main session always declares it.
				defaultActive: !subagent || Boolean((options.env ?? process.env)[BACKLOG_ITEM_ENV]),
				parameters,
				// One release still takes the old item type `task`: it is mapped in `execute`, which says so.
				validationParameters: withReason(acceptTargetShorthand(parameters)),
				async execute(_id, params, signal, _onUpdate, ctx) {
					signal?.throwIfAborted();
					// `reason` is every native call's purpose (`shared/reason.ts`), never the item's why.
					const { reason: _reason, links, ...rest } = params as Params & { reason?: string; links?: LinkArgument[] };
					const unknown = Object.keys(rest).filter(
						(key) => !Object.hasOwn(parameters.properties, key) && !Object.hasOwn(EntityFields, key),
					);
					if (unknown.length) throw new Error(`Unknown backlog fields: ${unknown.join(", ")}.`);
					if (rest.type !== undefined && !isItemType(rest.type))
						throw new Error(`Unknown item type ${visibleControls(rest.type)}: use ${ITEM_TYPES.join(", ")}.`);
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
						/* oxlint-disable typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders */
						args.from ? `from ${clip(String(args.from), 20)}` : "",
						args.title ? `"${clip(String(args.title), 80)}"` : "",
						args.query ? `"${clip(String(args.query), 80)}"` : "",
						/* oxlint-enable typescript/no-unnecessary-type-conversion */
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
					const body = firstIsSummary ? text.split("\n").slice(1).join("\n") : text;
					return resultBlock(theme, context, {
						summary,
						// Item and task lines get the board's colours; the text is the one the model read.
						...(context.isError ? { body } : { lines: body ? styleBacklogLines(theme, body) : [] }),
						...timingOf(result.details),
					});
				},
			},
			{ exclusive: true },
		),
	);

	type Params = EntityInput &
		Omit<ListParams, keyof EntityInput> & {
			op: "list" | "get" | "add" | "update" | "remove";
			id?: string;
			goal?: string;
			why?: string;
			evidence?: string[];
			plan?: string;
			state?: State;
			note?: string;
		};

	/** The descriptive fields a call sets, only those it names. */
	const text = ({ paths, why, evidence, plan }: Params) => ({
		...(paths !== undefined ? { paths } : {}),
		...(why !== undefined ? { why } : {}),
		...(evidence !== undefined ? { evidence } : {}),
		...(plan !== undefined ? { plan } : {}),
	});

	function run(backlog: Backlog, args: Omit<Params, "completion"> & { completion?: CompletionArgument }) {
		if (args.op === "list") return runList(backlog, args);
		const given: Params = keyed(args);
		const { store, actor, session } = backlog;
		// The description tells every role that a claim needs why and goal. A subagent's items have both, set by the
		// parent, which `updateItem` keeps: drop the child's copies here and say so, rather than refuse a claim the
		// description asked for. Only beside a state, note or completion: alone they change nothing a child may change,
		// and the store's refusal says what it may.
		const beside = given.state !== undefined || given.note !== undefined || given.completion !== undefined;
		const held = actor.owners && beside && given.op === "update" && given.id ? store.get(given.id) : undefined;
		const kept = (["goal", "why"] as const).filter((key) => given[key] !== undefined && held?.[key].trim());
		const params: Params = kept.length
			? { ...given, ...Object.fromEntries(kept.map((key) => [key, undefined])) }
			: given;
		const priority =
			params.priority === undefined ? undefined : PRIORITIES.indexOf(params.priority as (typeof PRIORITIES)[number]);
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
			const derived = store.derived(item);
			const children = item.type === "epic" ? store.list({ parentId: item.ref }).items : [];
			const detail = itemDetail(item, notes, total, Date.now(), {
				self: actor.id,
				version: true,
				noteOffset: offset,
				...(actor.owners ? { parents: actor.owners } : {}),
				...(origin ? { origin } : {}),
				derived,
				children,
				marks: store.marks([item, ...(origin ? [origin] : []), ...derived, ...children], actor.id, actor.owners),
				tasks: store.tasks.list({ item: item.ref }),
				runs: store.runs(item),
				epicState: store.epicState(item),
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
		const before = store.get(params.id);
		const reopened = params.state !== undefined && params.state !== "done" && before?.state === "done";
		const key = params.completion?.operationKey;
		const replayed = key === undefined ? undefined : before?.completions.find((c) => c.operationKey === key);
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
		// The store accepted a retry of a recorded completion (same key, content and actor) without writing anything.
		if (replayed)
			return textResult(`${replayText(item, replayed)}\n${itemLine(item, actor.id, actor.owners)}`, { item });
		const note = kept.length ? `\n(${kept.join("/")} kept: your parent owns ${kept.length > 1 ? "them" : "it"}.)` : "";
		// Reopening is allowed (a regression turns up after the fact); the done items that waited on this one are named.
		const review = reopened ? store.reviewNeeded(item) : [];
		const flagged = review.length ? `\nNeeds review (done): ${review.join(", ")}.` : "";
		return textResult(`Updated ${itemLine(item, actor.id, actor.owners)}${note}${flagged}`, { item });
	}
}

/** An operationKey names one completion: its replay says it was applied before, and whether the item moved on since. */
function replayText(item: Item, done: Completion): string {
	const head = `Completion ${visibleControls(done.operationKey)} of ${item.ref} was already recorded (${new Date(done.at).toISOString()}); nothing was written.`;
	if (item.state !== "done")
		return `${head} ${item.ref} has changed since: it is now ${item.state}. Close it with a new operationKey.`;
	const latest = item.completions.at(-1);
	return latest && latest.id !== done.id ? `${head} A later completion (${latest.id}) replaced it.` : head;
}

/** The call with its completion's retry key filled in: an explicit one wins, else derived from item and content. */
function keyed<P extends { id?: string; completion?: CompletionArgument }>(
	p: P,
): Omit<P, "completion"> & { completion?: NonNullable<EntityInput["completion"]> } {
	const { completion, ...rest } = p;
	return completion ? { ...rest, completion: withOperationKey(completion, p.id) } : rest;
}

function entities(p: EntityInput): EntityInput {
	return Object.fromEntries(
		Object.keys(EntityFields)
			.filter((key) => p[key as keyof EntityInput] !== undefined)
			.map((key) => [key, p[key as keyof EntityInput]]),
	);
}
