import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Backlog } from "./context.ts";
import { BacklogError, type Item } from "./item.ts";

/** Where isolated children's saved changes live: `REF_PREFIX` of `subagents/worktree-base.ts`, which sits above this layer. */
const REF_PREFIX = "refs/octocode/";

/** How long one `git rev-parse` may run; it answers in milliseconds, so a git that takes longer is stuck. */
const GIT_TIMEOUT_MS = 10_000;

const run = promisify(execFile);

/** The isolated-change refs `item` links as output (`subagents/ref-link.ts`), whether or not they still exist. */
function outputRefs(item: Item): string[] {
	const refs = item.links.flatMap((link) => {
		const target = link.target as { resource?: string; path?: string } | string;
		const ref = typeof target === "string" ? target : target.resource === "files" ? target.path : undefined;
		return link.relation === "output" && ref?.startsWith(REF_PREFIX) ? [ref] : [];
	});
	return [...new Set(refs)];
}

/** Whether git still has `ref`: saved, not merged or discarded. */
async function unmerged(repoRoot: string, item: Item, ref: string, signal?: AbortSignal): Promise<boolean> {
	try {
		await run("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", ref], { timeout: GIT_TIMEOUT_MS, signal });
		return true;
	} catch (error) {
		signal?.throwIfAborted();
		// `--verify --quiet` exits 1 for a ref that does not exist; any other failure (git missing or stuck, not a repository) says nothing about the ref.
		if ((error as { code?: unknown }).code === 1) return false;
		throw new BacklogError(
			`${item.ref} cannot be completed: git could not check whether its isolated change ${ref} is still unmerged (${errorMessage(error)}). Fix git, then retry.`,
		);
	}
}

/**
 * Refuses completing an item while an isolated child's change for it waits unmerged: the work is not in the tree yet.
 * Closing stays allowed (abandoned work), and a merge or discard deletes the ref, which lifts the gate. Git runs here,
 * before the write and outside any database transaction; the write refuses a ref linked since (`refuseUnchecked`).
 * Returns the refs it checked.
 */
export async function checkMerged(
	backlog: Pick<Backlog, "repoRoot">,
	item: Item,
	signal?: AbortSignal,
): Promise<string[]> {
	const refs = outputRefs(item);
	const found = await Promise.all(refs.map((ref) => unmerged(backlog.repoRoot, item, ref, signal)));
	const pending = refs.filter((_ref, index) => found[index]);
	if (!pending.length) return refs;
	const ids = pending.map((ref) => ref.slice(REF_PREFIX.length));
	throw new BacklogError(
		`${item.ref} is not done while its isolated change is unmerged (${pending.join(", ")}). Check live sessions with \`agent\` type \`coordinate\` action \`list\` and tell any that touch these files, then merge with action \`merge\` subagent \`${ids[0]}\` and verify; or ask the user to discard it (\`/agents discard ${ids[0]}\`), or close the item if the work is abandoned.`,
	);
}

/** Inside the completing write: refuses the output refs of `item` that `checkMerged` did not check (linked since it ran). */
export function refuseUnchecked(item: Item, checked: readonly string[] | undefined): void {
	const fresh = outputRefs(item).filter((ref) => !checked?.includes(ref));
	if (fresh.length)
		throw new BacklogError(
			`${item.ref} links isolated change ${fresh.join(", ")}, which was not checked for a merge: call done again.`,
		);
}
