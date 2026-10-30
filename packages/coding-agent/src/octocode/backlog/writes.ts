import { isDeepStrictEqual } from "node:util";
import { STATES, type NoteKind } from "@octocodeai/octocode-contacts/snapshot";
import { USER_AUTHOR } from "../agentdb/author.ts";
import type { AgentDb } from "../agentdb/db.ts";
import { type Db, backlog, meta } from "../agentdb/api.ts";
import { storedText } from "../shared/sanitize.ts";
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
import { applyEntities, validateEntityInput } from "./entity-write.ts";
import { evidenceLink, mergeLinks, splitEvidence } from "./evidence-links.ts";
import { derived, getItem, list, liveHolder, origin } from "./reads.ts";

/** What closing an item takes; the tool guideline, the hand-over prompts and the refusal all say it with these words. */
export const COMPLETION_GUIDANCE = "Done needs completion: summary, files, verification, operationKey.";

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
] as const;

/** The fields a subagent may not change on its parent's items: it changes state, notes and completion only. */
const SUBAGENT_FIXED_FIELDS = CHANGED_FIELDS.filter((field) => field !== "state" && field !== "completion");

const tagText = (tags: readonly string[]) => (tags.length ? tags.map((tag) => `#${tag}`).join(" ") : "none");
const listText = (entries: readonly string[]) => (entries.length ? entries.join(", ") : "none");

/** A text field's change: the old text is kept in full, so a replacement loses nothing. */
const replaced = (name: string, before: string) => (before ? `${name} replaced; it was:\n${before}` : `${name} added`);

/** The change note for one update: every field that changed, old → new; a replaced text is kept in full. */
function changeText(before: Item, after: Item): string {
	const parts: string[] = [];
	if (after.state !== before.state) parts.push(`state ${before.state} → ${after.state}`);
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
 * a note (its parent has not claimed the item, so a later note would be refused too) and without hierarchy or dependencies.
 */
export function addItem(agentDb: AgentDb, repo: string, now: () => number, input: AddInput, actor: Actor): Item {
	validateEntityInput(input);
	if (input.completion && input.state !== "done") throw new BacklogError("A completion requires state done.");
	if (actor.owners) {
		const refused = SUBAGENT_REFUSED_ADD.filter((key) => input[key] !== undefined);
		if (refused.length)
			throw new BacklogError(
				`A subagent proposal cannot set ${refused.join(", ")}: name them in plan or ask your parent.`,
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
			});
			const item = getItem(agentDb.db, repo, seq)!;
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
 * started for an item (`actor.item`) only that item; it changes state, notes and completion, never the rest.
 */
export function updateItem(
	agentDb: AgentDb,
	repo: string,
	now: () => number,
	ref: string,
	input: UpdateInput,
	actor: Actor,
): Item {
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
					`${item.ref} is not claimed by your parent: a subagent updates only the items its parent has claimed.`,
				);
			}
			if (actor.item !== undefined && parseRef(actor.item) !== item.seq) {
				const own = `B${parseRef(actor.item) ?? actor.item}`;
				throw new BacklogError(
					`${item.ref} is not your item: your parent started you for ${own}, the only item you may update. Propose a follow-up with add (from: ${own}) or report to your parent.`,
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
					"A subagent changes only the state and notes of its parent's items (and the completion that closes one); report other changes to your parent.",
				);
			// Moving an item back to todo or backlog would release the parent's claim behind its back.
			if (actor.owners && (input.state === "todo" || input.state === "backlog"))
				throw new BacklogError(
					`A subagent sets only ongoing or done; ask your parent to move an item to ${input.state}.`,
				);
			const state = input.state ?? item.state;
			if (!STATES.includes(state)) throw new BacklogError("Unknown backlog state.");
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
			// The user may force a correction of a done item's why; its goal is recorded in the completion, so it stays.
			const whyFix = input.force && auditActor(actor).kind === "human";
			if (
				item.state === "done" &&
				state === "done" &&
				(input.goal !== undefined || (input.why !== undefined && !whyFix))
			)
				throw new BacklogError("Reopen before changing a completed goal or why.");
			if (state === "done" && item.state !== "done" && !input.completion) throw new BacklogError(COMPLETION_GUIDANCE);
			if (input.completion && state !== "done") throw new BacklogError("A completion requires state done.");

			let assignee = item.assignee;
			if (input.state === "ongoing" && item.assignee !== actor.id) {
				if (!actor.owners) assignee = actor.id;
			} else if (input.state === "backlog" || input.state === "todo") assignee = undefined;
			const note = input.note === undefined ? "" : storedText(input.note);
			const at = now();
			const title = input.title === undefined ? item.title : storedTitle(input.title);
			if (!title) throw new BacklogError("An item needs a title.");
			const doneAt = state === "done" ? (item.state === "done" ? (item.doneAt ?? at) : at) : null;
			// A claim (or a takeover) starts the clock; releasing the item clears it; done keeps it, so the cycle time stays.
			const claimed = state === "ongoing" && (item.state !== "ongoing" || assignee !== item.assignee);
			const startedAt = claimed ? at : state === "backlog" || state === "todo" ? null : (item.startedAt ?? null);
			// Path and URL evidence become links. A row stored before that keeps them in its evidence text (reads show them
			// as links), so any update writes them out as links before the text is saved without them.
			const evidence = input.evidence === undefined ? undefined : splitEvidence(cleanList(input.evidence), repo);
			const legacy = backlog
				.itemBySeq(agentDb.db, repo, item.seq)!
				.evidence.split("\n")
				.some((entry) => entry && evidenceLink(entry, repo));
			const added = evidence?.links ?? [];
			if (input.links !== undefined || legacy || added.length)
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
				title,
				goal: input.goal === undefined ? item.goal : storedText(input.goal),
				body: item.body,
				paths: (input.paths === undefined ? item.paths : cleanList(input.paths)).join("\n"),
				why: input.why === undefined ? item.why : storedText(input.why),
				evidence: (evidence?.text ?? item.evidence).join("\n"),
				plan: input.plan === undefined ? item.plan : storedText(input.plan),
				state,
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

/**
 * Deletes an item and its notes. With `actor` (the agent), an item another live session holds is refused; a subagent
 * never removes.
 */
export function removeItem(
	agentDb: AgentDb,
	repo: string,
	now: () => number,
	ref: string,
	version?: number,
	actor?: Actor,
): Item {
	if (actor?.owners) throw new BacklogError("A subagent cannot remove backlog items; report it to your parent.");
	return agentDb.withActor(auditActor(actor), () =>
		agentDb.transaction(() => {
			const item = getItem(agentDb.db, repo, ref);
			if (!item) throw new BacklogError(`No backlog item ${ref}.`);
			if (version !== undefined && version !== item.version)
				throw new BacklogError(`${item.ref} changed elsewhere — reload it.`, item);
			const holder =
				actor && item.state === "ongoing" && item.assignee && item.assignee !== actor.id
					? liveHolder(agentDb.db, item.assignee)
					: undefined;
			if (holder)
				throw new BacklogError(
					`${item.ref} is ongoing for ${holder}, which is still running: leave it or ask the user.`,
				);
			if (
				list(agentDb.db, repo).items.some(
					(other) => other.parentId === item.ref || other.dependsOn.some((r) => r.id === item.ref),
				)
			)
				throw new BacklogError("Reparent children and remove dependencies before deleting this item.");
			if (item.completions.length) throw new BacklogError("Items with completion history cannot be deleted.");
			// The items that came from it keep a trace of the link in their change log.
			const at = now();
			for (const child of derived(agentDb.db, repo, item)) {
				backlog.clearOrigin(agentDb.db, child.rowId, at);
				logNote(
					agentDb.db,
					child,
					at,
					actor?.id ?? USER_AUTHOR,
					"change",
					`from ${item.ref} → none (${item.ref} "${item.title}" was removed)`,
				);
			}
			backlog.deleteItem(agentDb.db, item.rowId);
			return item;
		}),
	);
}
