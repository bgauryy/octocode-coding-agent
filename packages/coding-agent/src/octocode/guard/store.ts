import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { type AgentDb, guard, meta, type ReviewRow } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { isUnderPath } from "@octocodeai/octocode-common/paths";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { repoKey } from "../../utils/git-repository.ts";
import { parseSnapshot, snapshotOf } from "./diff.ts";
import { scan } from "./scan.ts";
import type { Review, ReviewItem, ReviewKind } from "./types.ts";

/**
 * The review records and the one question loaders ask: "is this exact content approved?". A decision is matched by
 * kind, identity and scope, and applies to one content hash. Only the user's own action records `approved` or `denied`:
 * the `/security` page and command, `octocode security` outside a session's shell, the web page, and the one-time
 * import of the user's global items present when the guard first ran.
 */

export interface GuardOptions {
	/** An open agent database (tests); the process's shared connection by default. */
	db?: AgentDb;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}

const guardDb = (options: GuardOptions): AgentDb => options.db ?? sharedAgentDb(options.env);

/** `global` for a file outside the repository of `cwd`, else the repository's key (shared by its worktrees). */
export function scopeFor(file: string, cwd: string): string {
	const repo = repoKey(cwd);
	// Resolve workspace aliases, but keep a project-owned link scoped to its project even when its target is outside.
	for (let location = file; ; location = path.dirname(location)) {
		if (isUnderPath(canonicalPath(location), repo.root)) return repo.key;
		if (path.dirname(location) === location) return "global";
	}
}

const rowKey = (kind: string, identity: string, scope: string) => JSON.stringify([kind, identity, scope]);

function reviewOf(item: ReviewItem, row: ReviewRow | undefined, snapshot: string | undefined): Review {
	const { hash, rating, findings } = scan(item);
	const same = item.unreadable === undefined && row?.contentHash === hash;
	const changed = row !== undefined && !same && row.decision === "approved";
	const approved = changed && snapshot !== undefined ? parseSnapshot(snapshot) : undefined;
	const word = same && row.decision !== "seen" ? row.decision : "not checked";
	return {
		item,
		hash,
		rating,
		findings,
		word,
		changed,
		...(row ? { rowId: row.id } : {}),
		...(changed && approved ? { approved } : {}),
	};
}

/** The review state of each item, from the stored rows of their scopes. Throws when the store cannot be read. */
export function resolveReviews(items: readonly ReviewItem[], options: GuardOptions = {}): Review[] {
	if (items.length === 0) return [];
	const agent = guardDb(options);
	const rows = guard.list(agent.db, [...new Set(items.map((item) => item.scope))]);
	const byKey = new Map(rows.map((row) => [rowKey(row.kind, row.identity, row.scope), row]));
	const stored = guard.snapshots(agent.db, [...new Set(items.map((item) => item.scope))]);
	return items.map((item) =>
		reviewOf(
			item,
			byKey.get(rowKey(item.kind, item.identity, item.scope)),
			stored.get(rowKey(item.kind, item.identity, item.scope)),
		),
	);
}

export interface GateResult {
	reviews: Review[];
	/** Items that load: approved ones, and all of them when the kind is not enforced or the store failed. */
	allowed: Set<string>;
	/** Global items recorded as approved by the one-time import that ran now. */
	imported: number;
	/** Set when the store could not be read: everything loads and the user is told. */
	warning?: string;
}

const importKey = (kind: ReviewKind) => `guard.imported.${kind}`;

/**
 * Records the user's global items of `kind` that exist the first time the guard sees that kind, so an upgrade does not
 * switch off what already ran (the owner's choice for existing setups). Project items are never imported: a fresh clone
 * must not be approved by being present. A CRITICAL item is not imported. Runs once per kind and database.
 */
function importOnce(kind: ReviewKind, reviews: Review[], agent: AgentDb, now: number): number {
	if (meta.read(agent.db, importKey(kind)) !== undefined) return 0;
	let count = 0;
	agent.transaction(() => {
		for (const review of reviews) {
			if (review.item.scope !== "global" || review.rowId !== undefined || review.rating === "CRITICAL") continue;
			if (review.item.unreadable) continue;
			guard.record(agent.db, rowInput(review, "approved", "import"), now);
			review.word = "approved";
			count += 1;
		}
		meta.write(agent.db, importKey(kind), String(now));
	});
	return count;
}

function rowInput(review: Review, decision: "approved" | "denied", via: string) {
	return {
		kind: review.item.kind,
		identity: review.item.identity,
		scope: review.item.scope,
		contentHash: review.hash,
		decision,
		rating: review.rating,
		findings: JSON.stringify(review.findings),
		label: review.item.label,
		path: review.item.path,
		decidedVia: via,
		snapshot: snapshotOf(review.item.files),
	};
}

/**
 * The loaders' question for a batch of one kind. With `enforce` off the kind only reports: everything loads. A store
 * fault never switches items off: they load and `warning` says so.
 */
export function gate(
	kind: ReviewKind,
	items: readonly ReviewItem[],
	options: GuardOptions & { enforce: boolean },
): GateResult {
	const everything = new Set(items.map((item) => item.id));
	try {
		const reviews = resolveReviews(items, options);
		const imported = importOnce(kind, reviews, guardDb(options), (options.now ?? Date.now)());
		const allowed = options.enforce
			? new Set(reviews.filter((review) => review.word === "approved").map((review) => review.item.id))
			: everything;
		return { reviews, allowed, imported };
	} catch (error) {
		return {
			reviews: [],
			allowed: everything,
			imported: 0,
			warning: `Octocode could not read its security review records (${errorMessage(error)}), so ${kind} items load unchecked this session.`,
		};
	}
}

/** Why a decision was refused: the item cannot be approved as it is. */
export class ReviewRefusedError extends Error {}

/**
 * Records the user's decision about the content the review shows. `via` names the surface (`page`, `command`, `cli`,
 * `web`). An item that could not be read in full cannot be approved.
 */
export function decide(review: Review, decision: "approved" | "denied", via: string, options: GuardOptions = {}): void {
	if (decision === "approved" && review.item.unreadable)
		throw new ReviewRefusedError(
			`${review.item.id} was not read in full (${review.item.unreadable}), so it cannot be approved.`,
		);
	guard.record(guardDb(options).db, rowInput(review, decision, via), (options.now ?? Date.now)());
}

/** Deletes the stored decision; the item is reviewed as new at the next load. False when there was none. */
export function forget(review: Review, options: GuardOptions = {}): boolean {
	return review.rowId !== undefined && guard.forget(guardDb(options).db, review.rowId);
}
