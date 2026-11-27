import type { backlog } from "../../../../db/src/api.ts";
import type { BacklogChange } from "../shared/backlog-change.ts";
import { sharedPaths } from "../shared/path-overlap.ts";
import type { Item } from "./item.ts";

/** How a recipient stands to the changed item. */
type Relation = "dependent" | "dependency" | "sibling" | "overlap" | "reservation" | "watcher";

/** One agent that should hear of a change, and why. A session is told by the assignee it holds (or waits with), an agent by its reservation. */
export interface Related {
	relation: Relation;
	/** The item that makes it related (the dependent, the sibling, the overlapping one, the prerequisite); the changed item for a watcher or reservation. */
	ref: string;
	/** The holder's session id (item assignee, or the session of a `wait`). */
	session?: string;
	/** The holding agent's team id (a reservation). */
	agent?: string;
	/** The paths shared, for an overlap or a reservation. */
	paths?: string[];
}

/** What `related` reads of the board, the waits and the reservations; each call is one listing. */
export interface RelatedView {
	item(ref: string): Item | undefined;
	/** Items whose `dependsOn` names `ref`. */
	dependents(ref: string): Item[];
	/** The items of epic `parent`. */
	children(parent: string): Item[];
	/** Every ongoing item. */
	ongoing(): Item[];
	/** The sessions with an active `wait` on any of `refs`. */
	watchers(refs: readonly string[], notifiedState?: string): backlog.ItemWatcher[];
	/** The paths each live agent reserves. */
	reservations(): Array<{ agent: string; paths: readonly string[] }>;
}

const OPEN = new Set(["backlog", "todo", "ongoing"]);
/** Whether the change puts the item's paths in use: a claim, a new item already claimed, or paths edited on a claimed item. */
export const claimsPaths = (change: BacklogChange): boolean =>
	change.kind === "claimed" ||
	((change.kind === "created" || change.kind === "paths_changed") && change.state === "ongoing");

/**
 * Who is related to the change, by relation, never the actor and never the holder of the changed item itself (that
 * holder hears of it as an event on its own item). Dependents and watchers hear of an item ending or being released;
 * paths overlaps and reservations of a claim; a blocker's holder of a new `dependsOn`; epic siblings of a claim or an
 * end; watchers also of a note or a step.
 */
export function related(change: BacklogChange, view: RelatedView): Related[] {
	const item = view.item(change.ref);
	const found: Related[] = [];
	const holder = (other: Item, relation: Relation, paths?: string[]) => {
		if (other.assignee && OPEN.has(other.state) && !other.closed)
			found.push({ relation, ref: other.ref, session: other.assignee, ...(paths?.length ? { paths } : {}) });
	};
	const ended = change.kind === "done" || change.kind === "closed";
	if (ended || change.kind === "released")
		for (const dependent of view.dependents(change.ref)) if (dependent.type !== "epic") holder(dependent, "dependent");
	if (ended || change.kind === "claimed") {
		const parent = change.parent ?? item?.parentId;
		if (parent) for (const sibling of view.children(parent)) if (sibling.ref !== change.ref) holder(sibling, "sibling");
	}
	if (claimsPaths(change)) {
		const paths = change.paths.length > 0 ? change.paths : (item?.paths ?? []);
		for (const other of view.ongoing()) {
			if (other.ref === change.ref || other.type === "epic") continue;
			holder(other, "overlap", sharedPaths(paths, other.paths));
		}
		for (const reserved of view.reservations()) {
			const shared = sharedPaths(paths, reserved.paths);
			if (shared.length > 0)
				found.push({ relation: "reservation", ref: change.ref, agent: reserved.agent, paths: shared });
		}
	}
	if (change.kind === "blocked" && change.target) {
		const blocker = view.item(change.target);
		if (blocker) holder(blocker, "dependency");
	}
	if (ended || change.kind === "released" || change.kind === "note" || change.kind === "step")
		for (const watcher of view.watchers([change.ref], ended ? change.kind : undefined))
			found.push({ relation: "watcher", ref: change.ref, session: watcher.session });
	const own = new Set([change.by, item?.assignee, change.assignee, change.beforeAssignee].filter(Boolean));
	const seen = new Set<string>();
	return found.filter((each) => {
		if ((each.session && own.has(each.session)) || (each.agent && own.has(each.agent))) return false;
		if (each.relation === "overlap" && !each.paths?.length) return false;
		const key = `${each.relation}|${each.session ?? each.agent}|${each.ref}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
