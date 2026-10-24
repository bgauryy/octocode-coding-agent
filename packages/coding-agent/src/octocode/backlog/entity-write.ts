import { Value } from "typebox/value";
import type { DatabaseSync } from "node:sqlite";
import { EntityFieldsSchema, type EntityInput, type BacklogRef } from "@octocodeai/octocode-contacts/backlogs";
import type { State } from "@octocodeai/octocode-contacts/snapshot";
import { entityInput } from "./entities.ts";
import { type Actor, type Item, BacklogError, refuseSecrets } from "./item.ts";
import { getItem, list } from "./reads.ts";

/** Validates an input's entity fields (version, links, completions and their files) before anything is stored. */
export function validateEntityInput(input: EntityInput): void {
	if (input.version !== undefined && (!Number.isInteger(input.version) || input.version < 1))
		throw new BacklogError("Invalid item version.");
	const fields = entityInput(input);
	if (!Value.Check(EntityFieldsSchema, fields)) {
		const first = Value.Errors(EntityFieldsSchema, fields)[0];
		throw new BacklogError(
			`Invalid backlog entity fields${first ? ` at ${first.instancePath || "/"}: ${first.message}` : ""}.`,
		);
	}
	if (input.completion && !input.completion.operationKey.trim())
		throw new BacklogError("Completion needs an operationKey.");
	refuseSecrets({
		reason: input.reason,
		links: input.links === undefined ? undefined : JSON.stringify(input.links),
		completion: input.completion === undefined ? undefined : JSON.stringify(input.completion),
	});
	for (const link of input.links ?? []) {
		if (link.target.resource === "external") {
			const url = new URL(link.target.url);
			if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
				throw new BacklogError("External links need an HTTP(S) URL without credentials.");
		}
	}
	for (const file of [
		...(input.completion?.files ?? []),
		...(input.links ?? []).flatMap((l) => (l.target.resource === "files" ? [l.target] : [])),
	]) {
		if (/^(?:[\\/]|[a-z]:)/i.test(file.path) || file.path.split(/[\\/]/).includes("..") || !file.path.trim())
			throw new BacklogError("Files need repository-relative paths without traversal.");
	}
}

/** Writes an item's entities: type, parent, dependencies and links, then checks the board for cycles and blocked work. */
export function applyEntities(
	db: DatabaseSync,
	repo: string,
	before: Item,
	input: EntityInput & { state?: State },
	actor: Actor,
	at: number,
): void {
	if (input.parentId !== undefined && input.parentId !== (before.parentId ?? null)) {
		const parent = input.parentId === null ? undefined : getItem(db, repo, input.parentId);
		if (input.parentId !== null && !parent) throw new BacklogError("Parent does not exist in this repository.");
		if (parent?.state === "done") throw new BacklogError("Reopen the parent before adding children.");
		db.prepare("UPDATE backlog SET parent_id = ? WHERE id = ?").run(parent?.rowId ?? null, before.rowId);
	}
	if (input.type !== undefined) db.prepare("UPDATE backlog SET type = ? WHERE id = ?").run(input.type, before.rowId);
	if (input.dependsOn !== undefined) {
		const refs = input.dependsOn.map((value): BacklogRef => {
			const ref = typeof value === "string" ? { resource: "backlogs" as const, repositoryKey: repo, id: value } : value;
			const target = ref.repositoryKey === repo ? getItem(db, repo, ref.id) : undefined;
			if (!target) throw new BacklogError("Dependencies must exist in the same repository.");
			return { resource: "backlogs", repositoryKey: repo, id: target.ref };
		});
		db.prepare("DELETE FROM backlog_links WHERE item = ? AND relation = 'depends_on'").run(before.rowId);
		for (const ref of refs)
			db.prepare("INSERT OR IGNORE INTO backlog_links VALUES (?, 'depends_on', ?)").run(
				before.rowId,
				JSON.stringify(ref),
			);
	}
	if (input.links !== undefined) {
		db.prepare("DELETE FROM backlog_links WHERE item = ? AND relation != 'depends_on'").run(before.rowId);
		for (const link of input.links)
			db.prepare("INSERT OR IGNORE INTO backlog_links VALUES (?, ?, ?)").run(
				before.rowId,
				link.relation,
				JSON.stringify(link.target),
			);
	}
	const items = list(db, repo).items;
	const current = items.find((i) => i.rowId === before.rowId)!;
	const byRef = new Map(items.map((i) => [i.ref, i]));
	const edges = new Map(
		items.map((i) => [
			i.ref,
			[...i.dependsOn.map((r) => r.id), ...items.filter((child) => child.parentId === i.ref).map((child) => child.ref)],
		]),
	);
	const active = new Set<string>();
	const visited = new Set<string>();
	const visit = (ref: string): void => {
		if (active.has(ref)) throw new BacklogError("Hierarchy and dependencies would create a waiting cycle.");
		if (visited.has(ref)) return;
		active.add(ref);
		for (const next of edges.get(ref) ?? []) visit(next);
		active.delete(ref);
		visited.add(ref);
	};
	for (const item of items) visit(item.ref);
	const unresolved = current.dependsOn.filter((r) => byRef.get(r.id)?.state !== "done");
	const closing = current.state === "done" && (before.state !== "done" || input.completion !== undefined);
	const starting = input.state === "ongoing" && (before.state !== "ongoing" || before.assignee !== current.assignee);
	const addedPrerequisite = unresolved.some(
		(ref) => !before.dependsOn.some((old) => old.id === ref.id && old.repositoryKey === ref.repositoryKey),
	);
	if (["ongoing", "done"].includes(current.state) && unresolved.length && (closing || starting || addedPrerequisite))
		throw new BacklogError(`Blocked by ${unresolved.map((r) => r.id).join(", ")}.`);

	const descendants = (parent: string): Item[] =>
		items.filter((i) => i.parentId === parent).flatMap((child) => [child, ...descendants(child.ref)]);
	if (closing && descendants(current.ref).some((i) => i.state !== "done"))
		throw new BacklogError("Finish child items before completing their parent.");
	if (input.completion && current.state === "done") {
		const c = input.completion;
		if (!c.summary.trim() || !c.verification.summary.trim())
			throw new BacklogError("Completion needs a summary and verification explanation.");
		if (actor.kind !== "human" && !["passed", "not_applicable"].includes(c.verification.status))
			throw new BacklogError("Agents must verify the goal before completing it.");
		if (before.state === "done" && c.replaces !== before.completions.at(-1)?.id)
			throw new BacklogError("A correction must replace the latest completion.");
		if (c.replaces !== undefined && !before.completions.some((old) => old.id === c.replaces))
			throw new BacklogError("Completion to replace does not exist.");
		db.prepare("INSERT INTO backlog_completions (item, operation_key, payload) VALUES (?, ?, ?)").run(
			before.rowId,
			c.operationKey,
			JSON.stringify({ ...c, actor: actor.id, at, version: current.version, goal: current.goal }),
		);
	}
}
