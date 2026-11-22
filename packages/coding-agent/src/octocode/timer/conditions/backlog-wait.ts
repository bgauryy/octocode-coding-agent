import { clipText } from "@octocodeai/octocode-common/clip";
import { renderPrompt } from "../../../core/prompt-template.ts";
import type { BacklogChange } from "../../shared/backlog-change.ts";
import { sharedPaths } from "../../shared/path-overlap.ts";
import type { BacklogDeps, ConditionDeps, RunEnv } from "./types.ts";

/** The refs of a comma or space separated `ref` field. */
export const splitList = (value: string | undefined): string[] => (value ?? "").split(/[\s,]+/).filter(Boolean);

/** The backlog deps of a host that has a backlog, or the refusal a wait on it answers with. */
export function needBacklog(deps: ConditionDeps): BacklogDeps {
	if (!deps.backlog) throw new Error("this session has no backlog to read: the request cannot be checked.");
	return deps.backlog;
}

/**
 * The event source of a backlog wait: the change feed, poked only for the changes `relevant` accepts. A host without a
 * feed (a subagent) pokes from the database file instead, which any write by anyone moves. `alsoDatabase` adds the file
 * for facts the feed does not carry (a released reservation, an ended agent).
 */
export function watchBacklog(
	deps: ConditionDeps,
	relevant: (change: BacklogChange) => boolean,
	poke: () => void,
	alsoDatabase = false,
): () => void {
	const subscribe = deps.backlog?.subscribe;
	if (!subscribe) return deps.watchDatabase(poke);
	const stopFeed = subscribe((change) => {
		if (relevant(change)) poke();
	});
	if (!alsoDatabase) return stopFeed;
	const stopFile = deps.watchDatabase(poke);
	return () => {
		stopFeed();
		stopFile();
	};
}

/** One change in a few words: `B661 note by agent-a: halfway there`. */
export const describeChange = (change: BacklogChange): string =>
	`${change.ref} ${change.kind} by ${clipText(change.by, 24)}${change.text ? `: ${clipText(change.text.replace(/\s+/g, " "), 160)}` : ""}`;

/** What narrows the changes a wait hears of; every field given must hold. */
export interface ChangeScope {
	refs: string[];
	epic?: string;
	path?: string;
	kinds: string[];
}

/**
 * Whether `change` belongs to the scope: its item is one of `refs`, under `epic` (`under` is the epic's items), or on a
 * path that overlaps `path` (the change's paths, or the item's own for a note, step or link, which carry none); and its
 * kind is one of `kinds` when any is named.
 */
export function inScope(
	change: BacklogChange,
	scope: ChangeScope,
	reads: { under: ReadonlySet<string> | undefined; paths(ref: string): string[] },
): boolean {
	if (scope.kinds.length > 0 && !scope.kinds.includes(change.kind)) return false;
	if (scope.refs.length > 0 && !scope.refs.includes(change.ref)) return false;
	if (scope.epic !== undefined && !reads.under?.has(change.ref)) return false;
	if (scope.path !== undefined) {
		const own = [...change.paths, ...change.beforePaths];
		const paths = own.length > 0 ? own : reads.paths(change.ref);
		if (sharedPaths([scope.path], paths).length === 0) return false;
	}
	return true;
}

/**
 * The expiry hint of a wait on an item a peer still holds: at the deadline, a not-met wait on an `ongoing` item whose
 * owner is not this session names the owner and the question to ask it. `quiet` says nothing changed since the wait began.
 */
export function staleHint(refs: readonly string[], env: RunEnv, since: number | undefined): string | undefined {
	const backlog = env.deps.backlog;
	if (!env.expiring || !backlog) return undefined;
	const lines: string[] = [];
	for (const ref of refs) {
		const detail = backlog.detail(ref);
		const owner = detail?.assignee;
		if (detail?.state !== "ongoing" || !owner || owner === env.row?.sessionId || backlog.own(owner)) continue;
		const quiet =
			since !== undefined &&
			(() => {
				const read = backlog.since(since);
				return !read.resync && !read.changes.some((change) => change.ref === ref && !backlog.own(change.by));
			})();
		lines.push(renderPrompt("notices/timer/stale-peer.md", { ref, owner, quiet }));
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}
