import { storedSecret } from "../shared/sanitize.ts";
import { DAY_MS } from "../shared/util.ts";
import { refText } from "./row.ts";
import { BacklogError, type BacklogStore, type Item, priorityName, STATES } from "./store.ts";

/** An item idle for longer than this (and not done) is listed under Attention in the page. */
const IDLE_MS = 7 * DAY_MS;

import type { Snapshot, SnapshotItem } from "@octocodeai/octocode-contacts/snapshot";
export type { Snapshot, SnapshotItem } from "@octocodeai/octocode-contacts/snapshot";

function snapshotItem(store: BacklogStore, item: Item, self: string | undefined): SnapshotItem {
	return {
		ref: item.ref,
		comments: store.comments(item.ref),
		audits: store.audit(item.ref, 50),
		type: item.type,
		parentId: item.parentId,
		dependsOn: item.dependsOn,
		links: item.links,
		completions: item.completions,
		title: item.title,
		goal: item.goal,
		body: item.body,
		paths: item.paths,
		why: item.why,
		evidence: item.evidence,
		plan: item.plan,
		state: item.state,
		priority: priorityName(item.priority),
		tags: item.tags,
		...(item.assignee
			? {
					assignee: item.assignee,
					assigneeLive: item.assignee === self || store.liveHolder(item.assignee) !== undefined,
				}
			: {}),
		createdBy: item.createdBy,
		...(item.sourceSession ? { sourceSession: item.sourceSession } : {}),
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		...(item.startedAt ? { startedAt: item.startedAt } : {}),
		...(item.doneAt ? { doneAt: item.doneAt } : {}),
		version: item.version,
		...(item.from === undefined ? {} : { from: refText(item.from) }),
		derived: store.derived(item).map((child) => child.ref),
		// A negative limit is no limit: the page keeps every note in full.
		notes: store.notes(item, -1),
	};
}

/**
 * Refuses a snapshot with a credential-looking string in any of its text, naming the item. Writes are already refused
 * (`refuseSecrets`); this checks again what the page will carry, so text stored before that check, or by another
 * build, never lands in a file that is easy to share.
 */
function refuseSecrets(snapshot: Snapshot): void {
	const found = storedSecret({ repository: snapshot.repo });
	if (found) throw new BacklogError(`Not written: the repository name ${found.problem.replace(/^it /, "")}.`);
	for (const item of snapshot.items) {
		const extra = storedSecret({
			entities: JSON.stringify({
				links: item.links,
				completions: item.completions,
				comments: item.comments,
				audits: item.audits,
			}),
		});
		const { title, goal, body, paths, why, evidence, plan, tags, assignee, createdBy, sourceSession, notes } = item;
		const noteFields = notes.flatMap(
			(note, index) =>
				[
					[`note ${index + 1}`, note.text],
					[`note ${index + 1} author`, note.author],
				] as const,
		);
		const hit = storedSecret({
			title,
			goal,
			body,
			paths,
			why,
			evidence,
			plan,
			tags,
			assignee,
			createdBy,
			sourceSession,
			...Object.fromEntries(noteFields),
		});
		if (hit)
			throw new BacklogError(
				`Not written: the ${hit.name} of ${item.ref} ${hit.problem.replace(/^it /, "")}. Remove it from the item, or delete the item, and run /backlog html again.`,
			);
		if (extra) throw new BacklogError(`Not written: ${item.ref} contains unsafe entity text.`);
	}
}

/** Every item of the store, in board order, with its notes and derivation links; throws when any text looks like a secret. */
export function backlogSnapshot(store: BacklogStore, repo: string, now: number, self?: string): Snapshot {
	const snapshot: Snapshot = {
		repo,
		generatedAt: now,
		states: STATES,
		idleMs: IDLE_MS,
		items: store.list().items.map((item) => snapshotItem(store, item, self)),
	};
	const byRef = new Map(snapshot.items.map((item) => [item.ref, item]));
	for (const item of snapshot.items) {
		item.children = snapshot.items.filter((child) => child.parentId === item.ref).map((child) => child.ref);
		item.blockedBy = (item.dependsOn ?? []).filter((ref) => byRef.get(ref.id)?.state !== "done").map((ref) => ref.id);
		const openDescendant = (parent: string, seen = new Set<string>()): boolean => {
			if (seen.has(parent)) return false;
			seen.add(parent);
			return snapshot.items.some(
				(child) => child.parentId === parent && (child.state !== "done" || openDescendant(child.ref, seen)),
			);
		};
		item.needsReview = item.state === "done" && (item.blockedBy.length > 0 || openDescendant(item.ref));
	}
	refuseSecrets(snapshot);
	return snapshot;
}
