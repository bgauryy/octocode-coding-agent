import { isDeepStrictEqual } from "node:util";
import { DEFAULT_ITEM_TYPE } from "@octocodeai/octocode-contracts/backlogs";
import { STATES, type NoteKind } from "@octocodeai/octocode-contracts/snapshot";
import { type AgentDb, type Db, USER_AUTHOR, backlog, meta, splitEvidence } from "../../../../db/src/api.ts";
import { storedText, visibleControls } from "@octocodeai/octocode-common/sanitize";
import { refText } from "./row.ts";
import {
	type Actor,
	auditActor,
	type Item,
	BacklogError,
	cleanList,
	cleanTags,
	clampPriority,
	parseRef,
	priorityName,
	refuseSecrets,
	storedTitle,
} from "./item.ts";
import type { AddInput, UpdateInput } from "./inputs.ts";
import { applyEntities, entityColumns, validateEntityInput } from "./entity-write.ts";
import { checkEpicState } from "./hierarchy.ts";
import { mergeLinks } from "./evidence-links.ts";
import { getItem, handedTo, liveHolder, origin } from "./reads.ts";
import { closeRecord } from "./close.ts";

/** What closing an item takes; the tool guideline, the hand-over prompts and the refusal all say it with these words. */
export const COMPLETION_GUIDANCE = "Done needs completion: summary, files, verification.";

/** The fields a subagent proposal cannot set: hierarchy and dependencies belong to the parent. */
const SUBAGENT_REFUSED_ADD = ["parentId", "dependsOn"] as const;

/** The fields an update may change (a note is not a change); the live holder's are refused and a subagent's limited. */
const CHANGED_FIELDS = [
	"title",
	"goal",
	"paths",
	"why",
	"evidence",
	"plan",
	"state",
	"priority",
	"tags",
	"from",
	"type",
	"parentId",
	"dependsOn",
	"links",
	"completion",
	"close",
] as const;

/** The fields a subagent may not change on its coordinator's items; state, completion and close have their own refusals. */
const SUBAGENT_FIXED_FIELDS = CHANGED_FIELDS.filter(
	(field) => field !== "state" && field !== "completion" && field !== "close",
);

/** The refusal of a subagent's done or close: finishing is its coordinator's, after review and merge. */
const SUBAGENT_FINISH =
	"A subagent does not finish its coordinator's items: put the result (summary, files, checks) in your report; your coordinator reviews it, merges any isolated change and marks the item done or closes it.";

const tagText = (tags: readonly string[]) => (tags.length ? tags.map((tag) => `#${tag}`).join(" ") : "none");
const listText = (entries: readonly string[]) => (entries.length ? entries.join(", ") : "none");

/** A text field's change: the old text is kept in full, so a replacement loses nothing. */
const replaced = (name: string, before: string) => (before ? `${name} replaced; it was:\n${before}` : `${name} added`);

/** The change note for one update: every field that changed, old → new; a replaced text is kept in full. */
function changeText(before: Item, after: Item): string {
	const parts: string[] = [];
	const shown = (item: Item) => (item.closed ? "closed" : item.state);
	if (shown(after) !== shown(before)) parts.push(`state ${shown(before)} → ${shown(after)}`);
	if (after.closed && !before.closed)
		parts.push(`${after.closed.kind}${after.closed.of ? ` of ${after.closed.of}` : ""}: ${after.closed.text}`);
	if (after.assignee !== before.assignee)
		parts.push(`assignee ${before.assignee ?? "none"} → ${after.assignee ?? "none"}`);
	if (after.priority !== before.priority)
		parts.push(`priority ${priorityName(before.priority)} → ${priorityName(after.priority)}`);
	if (after.tags.join(" ") !== before.tags.join(" "))
		parts.push(`tags ${tagText(before.tags)} → ${tagText(after.tags)}`);
	if (after.from !== before.from) parts.push(`from ${refText(before.from)} → ${refText(after.from)}`);
	if (after.title !== before.title) parts.push(`title was "${before.title}"`);
	if (after.goal !== before.goal) parts.push(before.goal ? `goal was "${before.goal}"` : "goal added");
	if (after.paths.join("\n") !== before.paths.join("\n"))
		parts.push(`paths ${listText(before.paths)} → ${listText(after.paths)}`);
	if (after.why !== before.why) parts.push(replaced("why", before.why));
	if (after.evidence.join("\n") !== before.evidence.join("\n"))
		parts.push(replaced("evidence", before.evidence.join("\n")));
	if (after.plan !== before.plan) parts.push(replaced("plan", before.plan));
	return parts.join(" · ");
}

function logNote(db: Db, item: Item, at: number, author: string, kind: NoteKind, text: string): void {
	backlog.addNote(db, item.rowId, at, author, kind, text);
}

/**
 * Creates an item. A subagent (`actor.owners`) proposes: its item lands in `backlog` whatever state it asked for, without
 * a note (its parent has not claimed the item, so a later note would be refused too), a completion, hierarchy or dependencies.
 */
export function addItem(agentDb: AgentDb, repo: string, now: () => number, request: AddInput, actor: Actor): Item {
	let input = request;
	validateEntityInput(input);
	if (input.completion && input.state !== "done") throw new BacklogError("A completion requires state done.");
	if (actor.owners) {
		const refused = SUBAGENT_REFUSED_ADD.filter((key) => input[key] !== undefined);
		if (refused.length)
			throw new BacklogError(
				`A subagent proposal cannot set ${refused.join(", ")}: name them in plan or ask your coordinator.`,
			);
		if (input.completion)
			throw new BacklogError(
				"A subagent proposal lands in backlog and cannot carry a completion: put the result in your report; your coordinator can claim and close the item.",
			);
	}
	refuseSecrets({ note: input.note });
	if (input.note !== undefined && actor.owners)
		throw new BacklogError("A subagent adds without a note: put the details in plan or evidence.");
	const wanted = actor.owners ? "backlog" : (input.state ?? "backlog");
	if (input.note !== undefined && wanted !== "ongoing" && wanted !== "done")
		throw new BacklogError(
			"add takes a note only with state ongoing or done; put details in plan or evidence, or add then update with the note.",
		);
	const title = storedTitle(input.title);
	if (!title) throw new BacklogError("An item needs a title.");
	// A person may jot a bare title; whatever an agent adds says how to tell it is done.
	if (input.createdBy !== USER_AUTHOR && !storedText(input.goal))
		throw new BacklogError("add needs a goal: the done criterion, a check someone else can run.");
	refuseSecrets({
		title: input.title,
		goal: input.goal,
		paths: input.paths,
		why: input.why,
		evidence: input.evidence,
		plan: input.plan,
		tags: input.tags,
	});
	const evidence = splitEvidence(cleanList(input.evidence ?? []), repo);
	if (evidence.links.length) input = { ...input, links: mergeLinks(input.links ?? [], evidence.links) };
	return agentDb.withActor(auditActor(actor), () =>
		agentDb.transaction(() => {
			// Numbers are never reused, even after the newest item is deleted: the high-water mark lives in `meta`.
			const key = `backlog_seq:${repo}`;
			const mark = Number(meta.read(agentDb.db, key) ?? 0);
			const max = backlog.maxSeq(agentDb.db, repo);
			const seq = Math.max(mark, max) + 1;
			meta.write(agentDb.db, key, String(seq));
			const from = input.from === undefined ? null : origin(agentDb.db, repo, input.from);
			const at = now();
			const state = wanted === "ongoing" || wanted === "done" ? "todo" : wanted;
			backlog.insertItem(agentDb.db, {
				repo,
				seq,
				title,
				goal: storedText(input.goal),
				body: "",
				paths: cleanList(input.paths ?? []).join("\n"),
				why: storedText(input.why),
				evidence: evidence.text.join("\n"),
				plan: storedText(input.plan),
				state,
				priority: clampPriority(input.priority),
				tags: cleanTags(input.tags ?? []).join(" "),
				createdBy: input.createdBy,
				sourceSession: input.sourceSession ?? null,
				at,
				fromItem: from,
				type: DEFAULT_ITEM_TYPE,
			});
			const item = getItem(agentDb.db, repo, seq)!;
			const columns = entityColumns(agentDb.db, repo, item, input);
			if (columns.parent || columns.type) backlog.setEntityColumns(agentDb.db, item.rowId, columns);
			applyEntities(agentDb.db, repo, item, input, actor, at);
			if (input.note?.trim()) logNote(agentDb.db, item, at, actor.id, "note", storedText(input.note));
			if (item.from !== undefined)
				logNote(agentDb.db, item, at, input.createdBy, "change", `created from ${refText(item.from)}`);
			return wanted === "ongoing" || wanted === "done"
				? updateItem(agentDb, repo, now, item.ref, { state: wanted, completion: input.completion }, actor)
				: getItem(agentDb.db, repo, seq)!;
		}),
	);
}

/**
 * Changes an item. `ongoing` claims it for `actor` (refused while another live assignee holds it); leaving
 * `ongoing` for `backlog`/`todo` releases it; `done` stamps `done_at`. While another live session holds an item,
 * others may only add a note (the user may force an edit). A subagent may only touch items its parent holds, and one
 * started for an item (`actor.item`) only that item; it adds notes and never finishes or closes one: it reports, and its
 * coordinator completes the item after review and merge.
 */
export function updateItem(
	agentDb: AgentDb,
	repo: string,
	now: () => number,
	ref: string,
	request: UpdateInput,
	actor: Actor,
): Item {
	let input = request;
	validateEntityInput(input);
	refuseSecrets({
		title: input.title,
		goal: input.goal,
		paths: input.paths,
		why: input.why,
		evidence: input.evidence,
		plan: input.plan,
		note: input.note,
		tags: input.tags,
	});
	return agentDb.withActor(auditActor(actor), () =>
		agentDb.transaction(() => {
			const item = getItem(agentDb.db, repo, ref);
			if (!item) throw new BacklogError(`No backlog item ${ref}.`);
			if (input.completion) {
				const previous = item.completions.find((c) => c.operationKey === input.completion!.operationKey);
				if (previous) {
					const { id: _id, actor: _actor, at: _at, version: _version, goal: _goal, ...payload } = previous;
					// A correction that omitted `replaces` was stored with the latest completion's id filled in.
					const { replaces: given, ...rest } = input.completion;
					const replaces = given ?? payload.replaces;
					const retried = replaces === undefined ? rest : { ...rest, replaces };
					if (!isDeepStrictEqual(payload, retried))
						throw new BacklogError("Completion operation key was already used with different content.");
					if (previous.actor !== actor.id || (actor.owners && !(item.assignee && actor.owners.has(item.assignee))))
						throw new BacklogError("Completion belongs to another actor.");
					return item;
				}
			}
			if (input.version !== undefined && input.version !== item.version)
				throw new BacklogError(`${item.ref} changed elsewhere — reload it.`, item);
			if (actor.owners && !(item.assignee && actor.owners.has(item.assignee))) {
				throw new BacklogError(
					`${item.ref} is not claimed by your coordinator: a subagent updates only the items its coordinator has claimed. Ask your coordinator to claim it (agent message, to: "parent"), or put the finding in your report.`,
				);
			}
			if (actor.item !== undefined && parseRef(actor.item) !== item.seq && !handedTo(agentDb.db, actor, item)) {
				const own = `B${parseRef(actor.item) ?? actor.item}`;
				throw new BacklogError(
					`${item.ref} is not your item: your coordinator started you for ${own} and may hand you more (agent message with item); you update only those. Propose a follow-up with add (from: ${own}) or report to your coordinator.`,
				);
			}
			const holder =
				!actor.owners && item.state === "ongoing" && item.assignee && item.assignee !== actor.id
					? liveHolder(agentDb.db, item.assignee)
					: undefined;
			const changes = CHANGED_FIELDS.some((field) => input[field] !== undefined);
			if (holder && (input.state === "ongoing" || (changes && !input.force))) {
				throw new BacklogError(
					`${item.ref} is ongoing for ${holder}, which is still running: add a note, leave it, or ask the user.`,
				);
			}
			if (actor.owners && SUBAGENT_FIXED_FIELDS.some((key) => input[key] !== undefined))
				throw new BacklogError(
					"A subagent changes only the state and notes of its coordinator's items; report other changes to your coordinator.",
				);
			// A child's done or close would skip the coordinator's QA review and merge gate.
			if (actor.owners && (input.state === "done" || input.completion !== undefined || input.close !== undefined))
				throw new BacklogError(SUBAGENT_FINISH);
			// Moving an item back to todo or backlog would release the parent's claim behind its back.
			if (actor.owners && (input.state === "todo" || input.state === "backlog"))
				throw new BacklogError(
					`A subagent leaves the state to its coordinator; ask it to move the item to ${input.state}.`,
				);
			const state = input.state ?? item.state;
			if (!STATES.includes(state))
				throw new BacklogError(`Unknown backlog state ${visibleControls(state)}: use ${STATES.join(", ")}.`);
			checkEpicState(agentDb.db, repo, item, input);
			if (
				(state === "ongoing" || state === "done") &&
				(input.state !== undefined ||
					input.completion !== undefined ||
					input.goal !== undefined ||
					input.why !== undefined)
			) {
				const missing = [
					!(input.goal ?? item.goal).trim() && "goal (the done criterion)",
					!(input.why ?? item.why).trim() && "why (the reason for the work)",
				].filter(Boolean);
				if (missing.length)
					throw new BacklogError(
						`${item.ref} needs ${missing.join(" and ")} to be claimed or closed: set it in the same update.`,
					);
			}
			if (item.state === "done" && state !== "done" && !input.note?.trim())
				throw new BacklogError("Reopening needs a note explaining why.");
			// A close is the other way to end an item: `done` underneath, no completion, a recorded reason.
			const closed = input.close ? closeRecord(agentDb.db, repo, item, input, actor, now()) : undefined;
			if (item.closed && input.state === "done")
				throw new BacklogError(`${item.ref} is closed: reopen it (state todo, with a note) before completing it.`);
			// The user may force a correction of a done item's why; its goal is recorded in the completion, so it stays.
			const whyFix = input.force && auditActor(actor).kind === "human";
			if (
				item.state === "done" &&
				state === "done" &&
				(input.goal !== undefined || (input.why !== undefined && !whyFix))
			)
				throw new BacklogError("Reopen before changing a completed goal or why.");
			if (state === "done" && item.state !== "done" && !input.completion && !closed)
				throw new BacklogError(COMPLETION_GUIDANCE);
			if (input.completion && (state !== "done" || closed)) throw new BacklogError("A completion requires state done.");

			let assignee = item.assignee;
			if (input.state === "ongoing" && item.assignee !== actor.id) {
				if (!actor.owners) assignee = actor.id;
			} else if (input.state === "backlog" || input.state === "todo" || closed) assignee = undefined;
			const note = input.note === undefined ? "" : storedText(input.note);
			const at = now();
			const title = input.title === undefined ? item.title : storedTitle(input.title);
			if (!title) throw new BacklogError("An item needs a title.");
			const stored = closed ? "done" : state;
			const doneAt = stored === "done" ? (item.state === "done" ? (item.doneAt ?? at) : at) : null;
			// A claim (or a takeover) starts the clock; releasing the item clears it; done keeps it, so the cycle time stays.
			const claimed = state === "ongoing" && (item.state !== "ongoing" || assignee !== item.assignee);
			const startedAt = claimed ? at : state === "backlog" || state === "todo" ? null : (item.startedAt ?? null);
			// Path and URL evidence become links, added to the item's current ones.
			const evidence = input.evidence === undefined ? undefined : splitEvidence(cleanList(input.evidence), repo);
			const added = evidence?.links ?? [];
			if (input.links !== undefined || added.length)
				input = { ...input, links: mergeLinks(input.links ?? item.links, added) };
			const fromItem =
				input.from === undefined
					? item.from === undefined
						? null
						: getItem(agentDb.db, repo, item.from)!.rowId
					: input.from === null
						? null
						: origin(agentDb.db, repo, input.from, item);
			backlog.saveItem(agentDb.db, item.rowId, {
				...entityColumns(agentDb.db, repo, item, input),
				title,
				goal: input.goal === undefined ? item.goal : storedText(input.goal),
				body: item.body,
				paths: (input.paths === undefined ? item.paths : cleanList(input.paths)).join("\n"),
				why: input.why === undefined ? item.why : storedText(input.why),
				evidence: (evidence?.text ?? item.evidence).join("\n"),
				plan: input.plan === undefined ? item.plan : storedText(input.plan),
				state: stored,
				closed: closed
					? JSON.stringify(closed)
					: state === "done"
						? item.closed
							? JSON.stringify(item.closed)
							: null
						: null,
				priority: input.priority === undefined ? item.priority : clampPriority(input.priority),
				tags: input.tags === undefined ? item.tags.join(" ") : cleanTags(input.tags).join(" "),
				assignee: assignee ?? null,
				at,
				startedAt,
				doneAt,
				fromItem,
			});
			applyEntities(agentDb.db, repo, item, input, actor, at);
			const updated = getItem(agentDb.db, repo, item.seq)!;
			// What changed first, then why: notes at one time read in insertion order.
			const change = [
				changeText(item, updated),
				...(["type", "parentId", "dependsOn", "links"] as const)
					.filter((key) => JSON.stringify(item[key]) !== JSON.stringify(updated[key]))
					.map((key) => `${key}: ${JSON.stringify(item[key] ?? null)} → ${JSON.stringify(updated[key] ?? null)}`),
				...(input.completion ? ["completion recorded"] : []),
			]
				.filter(Boolean)
				.join(" · ");
			if (change) logNote(agentDb.db, item, at, actor.id, "change", change);
			if (note) logNote(agentDb.db, item, at, actor.id, "note", note);
			return updated;
		}),
	);
}
