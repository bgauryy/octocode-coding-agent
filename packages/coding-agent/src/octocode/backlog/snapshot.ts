import { storedSecret } from "../../../../common/src/sanitize.ts";
import { DAY_MS } from "../shared/util.ts";
import { refuseExportSecrets } from "./export-secrets.ts";
import { refText } from "./row.ts";
import { BacklogError, type BacklogStore, type Item, priorityName } from "./store.ts";

/** An item idle for longer than this (and not done) is listed under Attention in the page. */
const IDLE_MS = 7 * DAY_MS;

import { type BacklogTask, isOpenTask } from "@octocodeai/octocode-contracts/backlogs";
import type { Snapshot, SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import { STATES } from "@octocodeai/octocode-contracts/snapshot";

function snapshotItem(
	store: BacklogStore,
	item: Item,
	self: string | undefined,
	tasks: readonly BacklogTask[],
): SnapshotItem {
	return {
		tasks: [...tasks],
		...(item.type === "epic" ? { epicState: store.epicState(item) } : {}),
		ref: item.ref,
		comments: store.comments(item.ref),
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
 * Refuses a snapshot with a credential-looking string in any of its text: what both exports carry
 * (`refuseExportSecrets`), plus the page's comments and tasks. Audit rows are not part of it: the page loads an item's
 * history from the audit route when its panel opens, so a large backlog's board stays small enough to send.
 */
function refuseSecrets(snapshot: Snapshot): void {
	refuseExportSecrets(snapshot.repo, snapshot.items, "/backlog html", (item) => ({
		comments: item.comments,
	}));
	for (const task of [...snapshot.items.flatMap((item) => item.tasks ?? []), ...(snapshot.sessionTasks ?? [])]) {
		const hit = storedSecret({ goal: task.goal, reason: task.reason, result: task.result });
		if (hit) throw new BacklogError(`Not written: the ${hit.name} of ${task.ref} ${hit.problem.replace(/^it /, "")}.`);
	}
}

/** The closed session tasks the page lists (the newest); open ones always show, and older closed ones are history. */
const CLOSED_SESSION_TASKS_SHOWN = 20;

/** Every item of the store, in board order, with its notes and derivation links; throws when any text looks like a secret. */
export function backlogSnapshot(store: BacklogStore, repo: string, now: number, self?: string): Snapshot {
	const tasks = store.tasks.list();
	const byItem = new Map<string, BacklogTask[]>();
	const session: BacklogTask[] = [];
	for (const task of tasks) {
		if (task.owner.kind === "session") session.push(task);
		else byItem.set(task.owner.ref, [...(byItem.get(task.owner.ref) ?? []), task]);
	}
	const recentClosed = new Set(
		session
			.filter((task) => !isOpenTask(task.state))
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, CLOSED_SESSION_TASKS_SHOWN),
	);
	const snapshot: Snapshot = {
		repo,
		generatedAt: now,
		states: STATES,
		idleMs: IDLE_MS,
		items: store.list().items.map((item) => snapshotItem(store, item, self, byItem.get(item.ref) ?? [])),
		sessionTasks: session.filter((task) => isOpenTask(task.state) || recentClosed.has(task)),
	};
	const byRef = new Map(snapshot.items.map((item) => [item.ref, item]));
	const childrenOf = new Map<string, SnapshotItem[]>();
	for (const item of snapshot.items)
		if (item.parentId)
			(childrenOf.get(item.parentId) ?? childrenOf.set(item.parentId, []).get(item.parentId)!).push(item);
	for (const item of snapshot.items) {
		item.children = (childrenOf.get(item.ref) ?? []).map((child) => child.ref);
		item.blockedBy = (item.dependsOn ?? []).filter((ref) => byRef.get(ref.id)?.state !== "done").map((ref) => ref.id);
		const openDescendant = (parent: string, seen = new Set<string>()): boolean => {
			if (seen.has(parent)) return false;
			seen.add(parent);
			return (childrenOf.get(parent) ?? []).some((child) => child.state !== "done" || openDescendant(child.ref, seen));
		};
		item.needsReview = item.state === "done" && (item.blockedBy.length > 0 || openDescendant(item.ref));
	}
	refuseSecrets(snapshot);
	return snapshot;
}
