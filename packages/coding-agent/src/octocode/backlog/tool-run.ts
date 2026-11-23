import type { CloseInput, EntityInput } from "@octocodeai/octocode-contracts/backlogs";
import type { State, BacklogAudit } from "@octocodeai/octocode-contracts/snapshot";
import { storedText } from "@octocodeai/octocode-common/sanitize";
import { textResult } from "../shared/util.ts";
import type { Backlog } from "./context.ts";
import { itemHead, itemLine } from "./format.ts";
import { BacklogError } from "./item.ts";
import { refuseUnchecked } from "./merge-gate.ts";
import { endedNotice } from "./graph-notice.ts";
import { PRIORITIES } from "./store.ts";
import { epicCompletion, splitIds } from "./tool-arguments.ts";
import { getResult } from "./tool-get.ts";
import { withEvidence } from "./receipts.ts";
import { entities, keyed, replayText } from "./tool-support.ts";

/**
 * One write or read of an item as both tools hand it to the store: `backlog` maps its work operations (claim, note,
 * done, close) and `backlogPlan` its `add` and `edit` onto `add` and `update` here, so the checks exist once.
 */
export type RunParams = EntityInput & {
	op: "get" | "add" | "update";
	id?: string;
	title?: string;
	goal?: string;
	why?: string;
	paths?: string[];
	evidence?: string[];
	plan?: string;
	state?: State;
	priority?: string;
	tags?: string[];
	from?: string;
	close?: CloseInput;
	note?: string;
	limit?: number;
	offset?: number;
	changes?: boolean;
};

interface RunOptions {
	subagent: boolean;
	/** The operation as the caller named it (`claim`, `edit`), for messages; the store operation otherwise. */
	word?: string;
	audits?: BacklogAudit[];
	/** The items queued children start once the one a write completed is done (`endedNotice`). */
	queued?: (ref: string) => ReadonlySet<string>;
	/** A done's isolated-change refs that git found merged before this write (`checkMerged`); any other is refused. */
	merged?: readonly string[];
}

/** The descriptive fields a call sets, only those it names. */
const text = ({ paths, why, evidence, plan }: RunParams) => ({
	...(paths !== undefined ? { paths } : {}),
	...(why !== undefined ? { why } : {}),
	...(evidence !== undefined ? { evidence } : {}),
	...(plan !== undefined ? { plan } : {}),
});

/** A plain done on an epic whose items are all done or closed carries the completion built from them. */
function closingEpic(backlog: Backlog, args: RunParams): RunParams {
	if (args.op !== "update" || args.state !== "done" || args.completion !== undefined || args.close !== undefined)
		return args;
	const epic = args.id ? backlog.store.get(args.id) : undefined;
	if (epic?.type !== "epic" || epic.state === "done" || backlog.store.epicState(epic) !== "done") return args;
	return { ...args, completion: epicCompletion(backlog.store.list({ parentId: epic.ref }).items) as never };
}

/** `store.update`, with a version conflict (the error carries the stored copy) answered by what to call next. */
function updated(
	store: Backlog["store"],
	id: string,
	input: Parameters<Backlog["store"]["update"]>[1],
	actor: Backlog["actor"],
) {
	try {
		return store.update(id, input, actor);
	} catch (error) {
		if (!(error instanceof BacklogError) || !error.current) throw error;
		const { ref, version } = error.current;
		throw new BacklogError(`${ref} changed elsewhere (now version ${version}): get it, then retry.`, error.current);
	}
}

export function runBacklog(backlog: Backlog, args: RunParams, options: RunOptions): ReturnType<typeof textResult> {
	const { subagent } = options;
	const word = options.word ?? args.op;
	const { completion: cited, ...keyedRest } = keyed(closingEpic(backlog, args));
	const given: RunParams = {
		...keyedRest,
		...(cited
			? {
					completion: withEvidence(
						cited,
						backlog.receipts,
						args.note,
						args.id ? backlog.store.get(args.id)?.completions : undefined,
					),
				}
			: {}),
	};
	const { store, actor, session } = backlog;
	// Every role is told that a claim needs why and goal. A subagent's items have both, set by the parent, which
	// `updateItem` keeps: drop the child's copies here and say so, rather than refuse a claim the description asked
	// for. Only beside a state, note or completion: alone they change nothing a child may change, and the store's
	// refusal says what it may.
	const beside = given.state !== undefined || given.note !== undefined || given.completion !== undefined;
	const held = actor.owners && beside && given.op === "update" && given.id ? store.get(given.id) : undefined;
	const kept = (["goal", "why"] as const).filter((key) => given[key] !== undefined && held?.[key].trim());
	const params: RunParams = kept.length
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
				? 'get needs an id, e.g. "B12", or several, e.g. "B12, B14".'
				: `${word} needs an id, e.g. "B12".`,
		);
	if (params.op === "update" && splitIds(params.id).length > 1)
		throw new Error(
			word === "edit"
				? "edit takes one id: use items for several, e.g. items [{id, priority}, ...]."
				: `${word} takes one id: call it once per item.`,
		);
	if (params.op === "get") return getResult(backlog, { ...params, id: params.id }, options.audits);
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
			`${word} needs something to change: title, goal, why, paths, evidence, plan, state, type, parentId, dependsOn, priority, tags or from.`,
		);
	// The goal is the done criterion an agent's items always have (`store.add`): a change may replace it, not blank it.
	if (params.goal !== undefined && !storedText(params.goal))
		throw new Error(`${word} cannot clear the goal: give the new done criterion, a check someone else can run.`);
	const before = store.get(params.id);
	if (before && params.state === "done" && params.close === undefined && before.state !== "done")
		refuseUnchecked(before, options.merged);
	const reopened = params.state !== undefined && params.state !== "done" && before?.state === "done";
	const key = params.completion?.operationKey;
	const replayed = key === undefined ? undefined : before?.completions.find((c) => c.operationKey === key);
	const item = updated(
		store,
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
	if (replayed) return textResult(`${replayText(item, replayed)}\n${itemLine(item, actor.id, actor.owners)}`, { item });
	const note = kept.length
		? `\n(${kept.join("/")} kept: your coordinator owns ${kept.length > 1 ? "them" : "it"}.)`
		: "";
	// Reopening is allowed (a regression turns up after the fact); the done items that waited on this one are named.
	const review = reopened ? store.reviewNeeded(item) : [];
	const flagged = review.length ? `\nNeeds review (done): ${review.join(", ")}.` : "";
	const graph = subagent ? "" : endedNotice(backlog, item, before, options.queued); // a child's report carries it instead
	// The caller named the item: the head and the version a later write's `version` needs are enough.
	return textResult(`Updated ${itemHead(item)} v${item.version}${note}${flagged}${graph}`, { item });
}
