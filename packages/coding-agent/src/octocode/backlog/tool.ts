import { displayText, textResultDisplay } from "../render/display.ts";
import {
	EntityFields,
	type EntityInput,
	isItemType,
	ITEM_TYPES,
	type CloseInput,
} from "@octocodeai/octocode-contracts/backlogs";
import { LIST_STATES, type State } from "@octocodeai/octocode-contracts/snapshot";
import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { resultBlock, toolHeader } from "../render/tool.ts";
import { storedText, visibleControls } from "../../../../common/src/sanitize.ts";
import { contentText, textResult } from "../shared/util.ts";
import { BACKLOG_ITEM_ENV } from "../../../../common/src/env.ts";
import { type Backlog, type BacklogOptions, openBacklog } from "./context.ts";
import { itemLine } from "./format.ts";
import {
	checkedEntry,
	closeField,
	entityFields,
	ITEM_ENTRY_FIELDS,
	type LinkArgument,
	itemsField,
	legacyEntityFields,
	linkInput,
	stateField,
	updatesField,
} from "./tool-schema.ts";
import { batchAdd, batchGet, batchUpdate } from "./tool-batch.ts";
import { endedNotice } from "./graph-notice.ts";
import { epicCompletion, parseJsonStrings, splitIds } from "./tool-arguments.ts";
import { getResult } from "./tool-get.ts";
import { entities, keyed, replayText } from "./tool-support.ts";
import { withReason } from "../shared/reason.ts";
import { PRIORITIES } from "./store.ts";
import { type BacklogToolDetails, backlogPrompt, backlogSummary } from "./tool-text.ts";
import { itemTitle, withItemTitles } from "../render/item-titles.ts";
import { styleBacklogLines } from "./tool-style.ts";
import { clip } from "../shared/text.ts";
import { timedTool, timingOf } from "../render/rows.ts";
import {
	DEFAULT_LIST_LIMIT,
	legacyListFields,
	listFields,
	type ListParams,
	MAX_LIST_LIMIT,
	runList,
} from "./tool-list.ts";

export function registerBacklogTool(
	api: ExtensionAPI,
	options: BacklogOptions & { changed?: (ctx: ExtensionContext) => void },
): void {
	const subagent = options.isSubagent;
	const { ops, ...prompt } = backlogPrompt(subagent);
	// A field without an op prefix is an item field add and update write; a subagent only proposes with them.
	const write = subagent ? "add: " : "";
	const parameters = Type.Object(
		{
			...entityFields(subagent),
			...listFields,
			op: StringEnum(["list", "get", "add", "update"] as const, { description: ops }),
			id: Type.Optional(
				Type.String({
					description: "get/update/list: item id",
				}),
			),
			updates: updatesField(),
			...(subagent ? {} : { items: itemsField() }),
			title: Type.Optional(Type.String({ description: `${write}one-line summary; list: words in the title` })),
			goal: Type.Optional(
				Type.String({ description: `${write}Definition of Done, checkable${subagent ? "" : "; add needs it"}` }),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description: `${write}files, dirs or components affected; list: items touching any file or folder`,
				}),
			),
			why: Type.Optional(Type.String({ description: `${write}why it matters; required for add` })),
			evidence: Type.Optional(
				Type.Array(Type.String(), {
					description: `${write}observations with source (path:line, command); paths and URLs become links`,
				}),
			),
			plan: Type.Optional(Type.String({ description: `${write}approach and steps; blast radius, before -> after` })),
			state: stateField(subagent),
			priority: Type.Optional(
				StringEnum(PRIORITIES, {
					description: `${write}p0 urgent … p3 someday (default p2); list: this or more urgent`,
				}),
			),
			tags: Type.Optional(
				Type.Array(Type.String(), {
					description: `${write}short labels; list: any of these`,
				}),
			),
			from: Type.Optional(
				Type.String({
					description: `Origin ID${subagent ? "" : '; update "" clears'}; list: items derived from it`,
				}),
			),
			close: Type.Optional(closeField),
			note: Type.Optional(
				Type.String({
					description: `${subagent ? "update" : "update, or add with state ongoing/done"}: append progress or findings`,
				}),
			),
			query: Type.Optional(Type.String({ description: "list: text in any field, or a whole tag" })),
			states: Type.Optional(
				Type.Array(StringEnum(LIST_STATES), {
					description: "list: states to show (default ongoing, todo, backlog)",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					description: `list/get: page size ≤${MAX_LIST_LIMIT} (default 15; ${DEFAULT_LIST_LIMIT} with states or ids; get notes 10)`,
				}),
			),
			offset: Type.Optional(Type.Integer({ description: "list/get: skip; copy from Next" })),
			changes: Type.Optional(Type.Boolean({ description: "get: also show logged changes" })),
		},
		{ additionalProperties: false },
	);
	// What a call may carry: the declared fields plus what older calls still send (`legacyListFields`, `legacyEntityFields`).
	const accepted = Type.Object(
		{ ...parameters.properties, ...legacyListFields, ...legacyEntityFields },
		{ additionalProperties: false },
	);
	const validationParameters = withReason(accepted);
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
				validationParameters,
				async execute(_id, params, signal, _onUpdate, ctx) {
					signal?.throwIfAborted();
					// `reason` is every native call's purpose (`shared/reason.ts`), never the item's why.
					const {
						reason: _reason,
						links,
						...rest
					} = parseJsonStrings(params as Params & { reason?: string; links?: LinkArgument[] });
					const unknown = Object.keys(rest).filter(
						(key) => !Object.hasOwn(accepted.properties, key) && !Object.hasOwn(EntityFields, key),
					);
					if (unknown.length) throw new Error(`Unknown backlog fields: ${unknown.join(", ")}.`);
					if (rest.type !== undefined && !isItemType(rest.type))
						throw new Error(`Unknown item type ${visibleControls(rest.type)}: use ${ITEM_TYPES.join(", ")}.`);
					const backlog = openBacklog(ctx, options);
					const single = {
						...rest,
						...(links !== undefined ? { links: linkInput(links, backlog.store.repo) } : {}),
					};
					const result = batched(backlog, single) ?? run(backlog, single);
					if (params.op !== "list" && params.op !== "get") options.changed?.(ctx);
					return result;
				},
				display(input) {
					const { args } = input;
					const summary = [
						args.op,
						args.id,
						args.state ? `→ ${args.state}` : "",
						/* oxlint-disable typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders */
						args.from ? `from ${String(args.from)}` : "",
						args.title ? `"${String(args.title)}"` : "",
						args.query ? `"${String(args.query)}"` : "",
						/* oxlint-enable typescript/no-unnecessary-type-conversion */
					]
						.filter(Boolean)
						.join(" ");
					const head = { title: "Backlog", summary, kind: "other" as const, blocks: [] };
					if (!input.result || input.status === "failed") return textResultDisplay(head, input);
					const text = displayText(input.result);
					const listing = args.op === "list" || args.op === "get";
					const body = (listing ? text : text.split("\n").slice(1).join("\n")).trim();
					return {
						...head,
						outcome: { text: backlogSummary(args.op, (input.result.details ?? {}) as BacklogToolDetails, text) },
						blocks: body ? [{ type: "text" as const, text: body }] : [],
					};
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
					return toolHeader(theme, context, "Backlog", withItemTitles(target, itemTitle));
				},
				renderResult(result, _options, theme, context) {
					const text = contentText(result.content);
					const details = (result.details ?? {}) as BacklogToolDetails;
					const summary = context.isError
						? (text.split("\n", 1)[0] ?? "")
						: withItemTitles(backlogSummary(context.args?.op, details, text), itemTitle);
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

	/**
	 * A `get` of several ids (`ids`, or an `id` of ids joined by commas or spaces), an `add` with `items` or an `update` with
	 * `updates`: each runs as the single form, a refusal stays on its row.
	 */
	function batched(backlog: Backlog, args: Params) {
		const { updates, items, ...single } = args;
		if (items !== undefined) {
			if (args.op !== "add" || args.title !== undefined)
				throw new Error("items goes with op add and no title: each entry carries its own title.");
			return batchAdd(items, ITEM_ENTRY_FIELDS, "items", (entry, earlier) =>
				run(
					backlog,
					earlier({ ...single, ...(checkedEntry(validationParameters, parseJsonStrings(entry), "add") as Params) }),
				),
			);
		}
		if (updates !== undefined) {
			if (args.op !== "update" || args.id !== undefined)
				throw new Error("updates goes with op update and no id: each entry carries its own id.");
			return batchUpdate(updates, (entry) =>
				run(backlog, {
					...single,
					...(checkedEntry(validationParameters, parseJsonStrings(entry), "update") as Params),
				}),
			);
		}
		if (args.op !== "get") return undefined;
		const { ids: listed, ...one } = single;
		const ids = [...splitIds(args.id ?? ""), ...(listed ?? []).flatMap(splitIds)];
		if (ids.length === 1) return run(backlog, { ...one, id: ids[0] });
		return ids.length > 1 ? batchGet(ids, (id) => run(backlog, { ...one, id })) : undefined;
	}

	type Params = EntityInput &
		Omit<ListParams, keyof EntityInput> & {
			op: "list" | "get" | "add" | "update";
			id?: string;
			updates?: Array<Record<string, unknown>>;
			items?: Array<Record<string, unknown>>;
			close?: CloseInput;
			goal?: string;
			why?: string;
			evidence?: string[];
			plan?: string;
			state?: State;
			note?: string;
			changes?: boolean;
		};

	/** The descriptive fields a call sets, only those it names. */
	const text = ({ paths, why, evidence, plan }: Params) => ({
		...(paths !== undefined ? { paths } : {}),
		...(why !== undefined ? { why } : {}),
		...(evidence !== undefined ? { evidence } : {}),
		...(plan !== undefined ? { plan } : {}),
	});

	/** A plain `state: done` on an epic whose items are all done or closed carries the completion built from them. */
	function closingEpic(backlog: Backlog, args: Params): Params {
		if (args.op !== "update" || args.state !== "done" || args.completion !== undefined || args.close !== undefined)
			return args;
		const epic = args.id ? backlog.store.get(args.id) : undefined;
		if (epic?.type !== "epic" || epic.state === "done" || backlog.store.epicState(epic) !== "done") return args;
		return { ...args, completion: epicCompletion(backlog.store.list({ parentId: epic.ref }).items) as never };
	}

	function run(backlog: Backlog, args: Params) {
		if (args.op === "list") return runList(backlog, args);
		const given: Params = keyed(closingEpic(backlog, args));
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
		if (!params.id?.trim())
			throw new Error(
				params.op === "get"
					? 'get needs an id, e.g. "B12", or ids, e.g. ["B12", "B14"].'
					: `${params.op} needs an id, e.g. "B12".`,
			);
		if (params.op === "update" && splitIds(params.id).length > 1)
			throw new Error("update takes one id: use updates for several, e.g. updates [{id, state}, ...].");
		if (params.op === "get") return getResult(backlog, { ...params, id: params.id });
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
			params.close === undefined &&
			Object.values(fields).every((value) => value === undefined)
		)
			throw new Error(
				"update needs something to change: state, note, close, completion, title, goal, paths, why, evidence, plan, links, priority, tags or from.",
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
				...(params.close !== undefined ? { close: params.close } : {}),
			},
			actor,
		);
		// The store accepted a retry of a recorded completion (same key, content and actor) without writing anything.
		if (replayed)
			return textResult(`${replayText(item, replayed)}\n${itemLine(item, actor.id, actor.owners)}`, { item });
		const note = kept.length
			? `\n(${kept.join("/")} kept: your coordinator owns ${kept.length > 1 ? "them" : "it"}.)`
			: "";
		// Reopening is allowed (a regression turns up after the fact); the done items that waited on this one are named.
		const review = reopened ? store.reviewNeeded(item) : [];
		const flagged = review.length ? `\nNeeds review (done): ${review.join(", ")}.` : "";
		const graph = subagent ? "" : endedNotice(backlog, item, before); // a child's report carries it instead
		return textResult(`Updated ${itemLine(item, actor.id, actor.owners)}${note}${flagged}${graph}`, { item });
	}
}
