import { Value } from "typebox/value";
import { EntityFieldsSchema, type EntityInput, type BacklogRef } from "@octocodeai/octocode-contracts/backlogs";
import type { State } from "@octocodeai/octocode-contracts/snapshot";
import { type Db, backlog } from "../../../../db/src/api.ts";
import { entityInput } from "./entities.ts";
import { checkHierarchy, openTasksRefusal } from "./hierarchy.ts";
import { type Actor, type Item, BacklogError, refuseSecrets } from "./item.ts";
import { getItem, list } from "./reads.ts";

/** Why a file path is not repository-relative, naming it, or undefined when it is. */
function pathRefusal(path: string): string | undefined {
	if (!path.trim()) return "an empty file path is not a path";
	if (/^(?:[\\/]|[a-z]:)/i.test(path)) return `\`${path}\` is absolute`;
	if (path.split(/[\\/]/).includes("..")) return `\`${path}\` is outside the repository`;
	return undefined;
}

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
	const refused = [
		...(input.completion?.files ?? []),
		...(input.links ?? []).flatMap((l) => (l.target.resource === "files" ? [l.target] : [])),
	].flatMap((file) => {
		const why = pathRefusal(file.path);
		return why ? [why] : [];
	});
	if (refused.length) throw new BacklogError(`${refused.join("; ")}; give a repository-relative path.`);
}

/**
 * The parent and type an input changes, checked against the depth rules; the caller writes them with the item's own
 * update, so one write leaves one audit row. Unchanged ones are left out.
 */
export function entityColumns(db: Db, repo: string, before: Item, input: EntityInput): backlog.EntityColumns {
	checkHierarchy(db, repo, before, input);
	const columns: backlog.EntityColumns = {};
	if (input.parentId !== undefined && input.parentId !== (before.parentId ?? null)) {
		const parent = input.parentId === null ? undefined : getItem(db, repo, input.parentId);
		if (input.parentId !== null && !parent) throw new BacklogError("Parent does not exist in this repository.");
		if (parent?.state === "done") throw new BacklogError("Reopen the parent before adding children.");
		columns.parent = { rowId: parent?.rowId ?? null };
	}
	if (input.type !== undefined && input.type !== before.type) columns.type = input.type;
	return columns;
}

/** Writes an item's dependencies and links (after `entityColumns`), then checks the board for cycles and blocked work. */
export function applyEntities(
	db: Db,
	repo: string,
	before: Item,
	input: EntityInput & { state?: State },
	actor: Actor,
	at: number,
): void {
	if (input.dependsOn !== undefined) {
		const refs = input.dependsOn.map((value): BacklogRef => {
			const ref = typeof value === "string" ? { resource: "backlogs" as const, repositoryKey: repo, id: value } : value;
			const target = ref.repositoryKey === repo ? getItem(db, repo, ref.id) : undefined;
			if (!target) throw new BacklogError("Dependencies must exist in the same repository.");
			return { resource: "backlogs", repositoryKey: repo, id: target.ref };
		});
		backlog.clearLinks(db, before.rowId, true);
		for (const ref of refs) backlog.addLink(db, before.rowId, "depends_on", JSON.stringify(ref));
	}
	if (input.links !== undefined) {
		backlog.clearLinks(db, before.rowId, false);
		for (const link of input.links) backlog.addLink(db, before.rowId, link.relation, JSON.stringify(link.target));
	}
	const items = list(db, repo).items;
	const current = items.find((i) => i.rowId === before.rowId)!;
	const byRef = new Map(items.map((i) => [i.ref, i]));
	// One pass for every item's children, so the edge map stays linear in the board's size.
	const children = new Map<string, Item[]>();
	for (const i of items)
		if (i.parentId) (children.get(i.parentId) ?? children.set(i.parentId, []).get(i.parentId)!).push(i);
	const edges = new Map(
		items.map((i) => [i.ref, [...i.dependsOn.map((r) => r.id), ...(children.get(i.ref) ?? []).map((c) => c.ref)]]),
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
		(children.get(parent) ?? []).flatMap((child) => [child, ...descendants(child.ref)]);
	if (closing && descendants(current.ref).some((i) => i.state !== "done"))
		throw new BacklogError("Finish child items before completing their parent.");
	const openTasks =
		current.state === "done" && before.state !== "done" ? openTasksRefusal(db, repo, current) : undefined;
	if (openTasks) throw new BacklogError(openTasks);
	if (input.completion && current.state === "done") {
		// On a done item a completion corrects the latest one: `replaces` defaults to it and may only name it.
		const latest = before.completions.at(-1)?.id;
		const c =
			before.state === "done" && input.completion.replaces === undefined && latest !== undefined
				? { ...input.completion, replaces: latest }
				: input.completion;
		if (!c.summary.trim() || !c.verification.summary.trim())
			throw new BacklogError("Completion needs a summary and verification explanation.");
		if (actor.kind !== "human" && !["passed", "not_applicable"].includes(c.verification.status))
			throw new BacklogError(
				`An agent closes an item only with verification passed or not_applicable, not ${c.verification.status}: keep ${before.ref} ongoing, add a note saying what failed, and close it after a passing check.`,
			);
		if (before.state === "done" && c.replaces !== latest)
			throw new BacklogError(
				`${before.ref} is done: a correction replaces the latest completion, ${latest}; omit completion.replaces or set it to ${latest}, with a new operationKey.`,
			);
		if (c.replaces !== undefined && !before.completions.some((old) => old.id === c.replaces))
			throw new BacklogError("Completion to replace does not exist.");
		backlog.addCompletion(
			db,
			before.rowId,
			c.operationKey,
			JSON.stringify({ ...c, actor: actor.id, at, version: current.version, goal: current.goal }),
		);
	}
}
