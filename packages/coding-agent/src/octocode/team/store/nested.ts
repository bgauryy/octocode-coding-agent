import path from "node:path";
import { type Db, leases } from "../../../../../db/src/api.ts";
import { leaseKey } from "../lease-key.ts";

/** Where a request lands in another checkout: that checkout, the matching key there, and what the request covers. */
export interface NestedCheck {
	workspace: string;
	key: string;
	kind: "file" | "tree";
}

/** `inner` is `outer` itself or lies below it, on component boundaries; the key of `inner` relative to `outer`. */
function below(outer: string, inner: string): string | undefined {
	if (inner !== outer && !inner.startsWith(`${outer}/`)) return undefined;
	return inner.slice(outer.length);
}

/**
 * Linked worktrees live inside the main checkout (`<main>/.octocode/worktrees/<name>`), so one file has a key in each
 * checkout that contains it. Leases are keyed per checkout, so the same file in two of them would never conflict. This
 * lists, for the request on `key` in `workspace`, the matching request in every other checkout of `team` that holds a
 * live lease and is nested with `workspace` (either one inside the other):
 *   - a checkout below `workspace`: a key inside it is the same file in there, and a tree request above it covers it all;
 *   - a checkout above `workspace`: the key gains the folder `workspace` has in it, so its trees above that folder cover it.
 * Checkouts that are neither (siblings, other repositories) are not nested and never conflict.
 */
export function nestedChecks(
	db: Db,
	team: string,
	workspace: string,
	key: string,
	kind: "file" | "tree",
	now: number,
): NestedCheck[] {
	const checks: NestedCheck[] = [];
	for (const other of leases.checkoutsInTeam(db, team, workspace, now)) {
		const inside = path.relative(workspace, other);
		const outside = path.relative(other, workspace);
		if (isNested(inside)) {
			const folder = leaseKey(inside.split(path.sep));
			const within = below(folder, key);
			if (within !== undefined) checks.push({ workspace: other, key: within, kind });
			else if (kind === "tree" && below(key, folder) !== undefined) checks.push({ workspace: other, key: "", kind });
		} else if (isNested(outside)) {
			checks.push({ workspace: other, key: leaseKey(outside.split(path.sep)) + key, kind });
		}
	}
	return checks;
}

/** A relative path from one checkout to another that stays below it (not the same checkout, not `..`, not on another drive). */
function isNested(relative: string): boolean {
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
