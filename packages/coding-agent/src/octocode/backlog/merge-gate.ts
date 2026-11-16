import { execFileSync } from "node:child_process";
import type { Backlog } from "./context.ts";
import { BacklogError, type Item } from "./item.ts";

/** Where isolated children's saved changes live: `REF_PREFIX` of `subagents/worktree-base.ts`, which sits above this layer. */
const REF_PREFIX = "refs/octocode/";

/** The isolated-change refs `item` links as output (`subagents/ref-link.ts`) that still exist: saved, not merged or discarded. */
function unmergedRefs(backlog: Pick<Backlog, "repoRoot">, item: Item): string[] {
	const refs = item.links.flatMap((link) => {
		const target = link.target as { resource?: string; path?: string } | string;
		const ref = typeof target === "string" ? target : target.resource === "files" ? target.path : undefined;
		return link.relation === "output" && ref?.startsWith(REF_PREFIX) ? [ref] : [];
	});
	return [...new Set(refs)].filter((ref) => {
		try {
			execFileSync("git", ["-C", backlog.repoRoot, "rev-parse", "--verify", "--quiet", ref], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	});
}

/**
 * Refuses completing an item while an isolated child's change for it waits unmerged: the work is not in the tree yet.
 * Closing stays allowed (abandoned work), and a merge or discard deletes the ref, which lifts the gate.
 */
export function checkMerged(backlog: Pick<Backlog, "repoRoot">, item: Item): void {
	const pending = unmergedRefs(backlog, item);
	if (!pending.length) return;
	const ids = pending.map((ref) => ref.slice(REF_PREFIX.length));
	throw new BacklogError(
		`${item.ref} is not done while its isolated change is unmerged (${pending.join(", ")}). Check live sessions with \`agent\` type \`coordinate\` action \`list\` and tell any that touch these files, then merge with action \`merge\` subagent \`${ids[0]}\` and verify; or ask the user to discard it (\`/agents discard ${ids[0]}\`), or close the item if the work is abandoned.`,
	);
}
