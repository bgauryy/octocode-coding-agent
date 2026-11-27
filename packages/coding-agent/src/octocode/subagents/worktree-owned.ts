import fs from "node:fs";
import path from "node:path";
import { getOctocodeHome } from "../../config.ts";
import { ID_PATTERN, ownersOf, worktreesDir } from "./worktree-base.ts";

/**
 * The isolated worktrees made for backlog item `ref` that this process still owns and that still exist: the agent ids
 * whose owner record (`worktree-create.ts`) names the item. Reads the repository's shared worktrees folder only; a record
 * that cannot be read is another session's to judge (`worktree-prune.ts`), not this one's.
 */
export function worktreesMadeFor(cwd: string, ref: string, pid = process.pid, home = getOctocodeHome()): string[] {
	const dir = worktreesDir(cwd, home);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).flatMap((entry) => {
		if (!entry.endsWith(".json")) return [];
		const agentId = entry.slice(0, -".json".length);
		if (!ID_PATTERN.test(agentId) || !fs.existsSync(path.join(dir, agentId))) return [];
		let record: { item?: unknown; owners?: unknown };
		try {
			record = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")) as typeof record;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return [];
			throw error;
		}
		return record.item === ref && ownersOf(record).some((owner) => owner.pid === pid) ? [agentId] : [];
	});
}
