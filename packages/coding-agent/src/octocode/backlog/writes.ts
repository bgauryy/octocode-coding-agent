import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { STATES, type NoteKind } from "@octocodeai/octocode-contacts/snapshot";
import { USER_AUTHOR } from "../agentdb/author.ts";
import type { AgentDb } from "../agentdb/db.ts";
import { readMeta, writeMeta } from "../agentdb/meta.ts";
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
	priorityName,
	refuseSecrets,
	storedTitle,
} from "./item.ts";
import type { AddInput, UpdateInput } from "./inputs.ts";
import { applyEntities, validateEntityInput } from "./entity-write.ts";
import { derived, getItem, list, liveHolder, origin } from "./reads.ts";

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
	if (after.body !== before.body) parts.push(replaced("body", before.body));
	return parts.join(" · ");
}

/** `reason` and `why` are one field under two names: they must agree, and `reason` fills `why` when only it is given. */
function reasonInput<T extends { reason?: string; why?: string }>(input: T): T {
	if (input.reason !== undefined && input.why !== undefined && input.reason !== input.why)
		throw new BacklogError("reason and why must agree.");
	return input.reason === undefined ? input : { ...input, why: input.reason };
}

function logNote(db: DatabaseSync, item: Item, at: number, author: string, kind: NoteKind, text: string): void {
	db.prepare("INSERT INTO backlog_notes (item, at, author, kind, text) VALUES (?, ?, ?, ?, ?)").run(
		item.rowId,
		at,
		author,
		kind,
		text,
	);
}

export function addItem(agentDb: AgentDb, repo: string, now: () => number, input: AddInput, actor: Actor): Item {
	validateEntityInput(input);
	input = reasonInput(input);
	if (input.completion && input.state !== "done") throw new BacklogError("A completion requires state done.");
	refuseSecrets({ note: input.note });
	const title = storedTitle(input.title);
	if (!title) throw new BacklogError("An item needs a title.");
	// A person may jot a bare title; whatever an agent adds says how to tell it is done.
	if (input.createdBy !== USER_AUTHOR && !storedText(input.goal))
		throw new BacklogError("add needs a goal: the done criterion, a check someone else can run.");
	refuseSecrets({
		title: input.title,
		goal: input.goal,
		body: input.body,
		paths: input.paths,
		why: input.why,
		evidence: input.evidence,
		plan: input.plan,
		tags: input.tags,
	});
	return agentDb.withActor(auditActor(actor), () =>
		agentDb.transaction(() => {
			// Numbers are never reused, even after the newest item is deleted: the high-water mark lives in `meta`.
			const key = `backlog_seq:${repo}`;
			const mark = Number(readMeta(agentDb.db, key) ?? 0);
			const max =
				(
					agentDb.db.prepare("SELECT MAX(seq) AS n FROM backlog WHERE repo_key = ?").get(repo) as {
						n: number | null;
					}
				).n ?? 0;
			const seq = Math.max(mark, max) + 1;
			writeMeta(agentDb.db, key, String(seq));
			const from = input.from === undefined ? null : origin(agentDb.db, repo, input.from);
			const at = now();
			const wanted = input.state ?? "backlog";
			const state = wanted === "ongoing" || wanted === "done" ? "todo" : wanted;
			agentDb.db
				.prepare(
					`INSERT INTO backlog (repo_key, seq, title, goal, body, paths, why, evidence, plan, state, priority, tags, assignee, created_by, source_session, created_at, updated_at, started_at, done_at, from_item)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					repo,
					seq,
					title,
					storedText(input.goal),
					storedText(input.body),
					cleanList(input.paths ?? []).join("\n"),
					storedText(input.why),
					cleanList(input.evidence ?? []).join("\n"),
					storedText(input.plan),
					state,
					clampPriority(input.priority),
					cleanTags(input.tags ?? []).join(" "),
					input.createdBy,
					input.sourceSession ?? null,
					at,
					at,
					null,
					null,
					from,
				);
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
 * others may only add a note (the user may force an edit). A subagent may only touch items its parent holds.
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
	input = reasonInput(input);
	refuseSecrets({
		title: input.title,
		goal: input.goal,
		body: input.body,
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
					if (!isDeepStrictEqual(payload, input.completion))
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
			const holder =
				!actor.owners && item.state === "ongoing" && item.assignee && item.assignee !== actor.id
					? liveHolder(agentDb.db, item.assignee)
					: undefined;
			const changes = (
				[
					"title",
					"goal",
					"body",
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
				] as const
			).some((field) => input[field] !== undefined);
			if (holder && (input.state === "ongoing" || (changes && !input.force))) {
				throw new BacklogError(
					`${item.ref} is ongoing for ${holder}, which is still running: add a note, leave it, or ask the user.`,
				);
			}
			if (
				actor.owners &&
				[
					"title",
					"goal",
					"body",
					"paths",
					"why",
					"evidence",
					"plan",
					"priority",
					"tags",
					"from",
					"type",
					"parentId",
					"dependsOn",
					"links",
				].some((key) => input[key as keyof UpdateInput] !== undefined)
			)
				throw new BacklogError("A subagent changes only state, notes and completion of its parent's items.");
			if (actor.owners && (input.state === "todo" || input.state === "backlog"))
				throw new BacklogError("A subagent cannot release its parent's claim.");
			const state = input.state ?? item.state;
			if (!STATES.includes(state)) throw new BacklogError("Unknown backlog state.");
			if (
				(state === "ongoing" || state === "done") &&
				(input.state !== undefined ||
					input.completion !== undefined ||
					input.goal !== undefined ||
					input.why !== undefined)
			) {
				if (!(input.goal ?? item.goal).trim() || !(input.why ?? item.why).trim())
					throw new BacklogError("Starting or completing work needs a reason and goal.");
			}
			if (item.state === "done" && state !== "done" && !input.note?.trim())
				throw new BacklogError("Reopening needs a note explaining why.");
			if (item.state === "done" && state === "done" && (input.goal !== undefined || input.why !== undefined))
				throw new BacklogError("Reopen before changing a completed goal or reason.");
			if (state === "done" && item.state !== "done" && !input.completion)
				throw new BacklogError("Done needs a completion: summary, files, verification and operationKey.");
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
			const fromItem =
				input.from === undefined
					? item.from === undefined
						? null
						: getItem(agentDb.db, repo, item.from)!.rowId
					: input.from === null
						? null
						: origin(agentDb.db, repo, input.from, item);
			agentDb.db
				.prepare(
					"UPDATE backlog SET title = ?, goal = ?, body = ?, paths = ?, why = ?, evidence = ?, plan = ?, state = ?, priority = ?, tags = ?, assignee = ?, updated_at = ?, started_at = ?, done_at = ?, from_item = ?, version = version + 1 WHERE id = ?",
				)
				.run(
					title,
					input.goal === undefined ? item.goal : storedText(input.goal),
					input.body === undefined ? item.body : storedText(input.body),
					(input.paths === undefined ? item.paths : cleanList(input.paths)).join("\n"),
					input.why === undefined ? item.why : storedText(input.why),
					(input.evidence === undefined ? item.evidence : cleanList(input.evidence)).join("\n"),
					input.plan === undefined ? item.plan : storedText(input.plan),
					state,
					input.priority === undefined ? item.priority : clampPriority(input.priority),
					input.tags === undefined ? item.tags.join(" ") : cleanTags(input.tags).join(" "),
					assignee ?? null,
					at,
					startedAt,
					doneAt,
					fromItem,
					item.rowId,
				);
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

/** Deletes an item and its notes. With `actor` (the agent), an item another live session holds is refused. */
export function removeItem(
	agentDb: AgentDb,
	repo: string,
	now: () => number,
	ref: string,
	version?: number,
	actor?: Actor,
): Item {
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
				agentDb.db
					.prepare("UPDATE backlog SET from_item = NULL, updated_at = ?, version = version + 1 WHERE id = ?")
					.run(at, child.rowId);
				logNote(
					agentDb.db,
					child,
					at,
					actor?.id ?? USER_AUTHOR,
					"change",
					`from ${item.ref} → none (${item.ref} "${item.title}" was removed)`,
				);
			}
			agentDb.db.prepare("DELETE FROM backlog WHERE id = ?").run(item.rowId);
			return item;
		}),
	);
}
