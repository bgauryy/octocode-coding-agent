import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { type AgentDb, meta } from "../../../../db/src/api.ts";
import { expireArchiveDetails } from "../archive/retention.ts";
import { resolveRetention } from "../../storage/retention.ts";
import { HOUR_MS } from "../shared/util.ts";
import type { SessionIndex } from "./store.ts";
import { applySweep, summarizeSweep } from "./sweep-apply.ts";
import { type PlanOptions, planSweep } from "./sweep-plan.ts";

export { planSweep };

/** The sweep runs at most this often across all sessions and workspaces (meta `last_sweep`). */
const SWEEP_EVERY_MS = 6 * HOUR_MS;

/**
 * Claims this sweep in the meta `last_sweep`: unless `force`, only when the last one is `SWEEP_EVERY_MS` old. The read and
 * the write share one write transaction, so of two processes starting at once only one claims. Returns the previous
 * claim (to give back), or undefined when another sweep holds it; throws when the database stays locked.
 */
export function claimSweep(agent: AgentDb, now: number, force: boolean, key = "last_sweep"): number | undefined {
	return agent.transaction(() => {
		const last = Number(meta.read(agent.db, key) ?? 0);
		if (!force && now - last < SWEEP_EVERY_MS) return undefined;
		meta.write(agent.db, key, String(now));
		return last;
	});
}

/**
 * One global cleanup pass over every known root (`planSweep` lists them, `applySweep` removes), at most once per
 * `SWEEP_EVERY_MS` (unless `force`) whatever the workspace: the retention is `resolveRetention` (days for output, temp
 * and session data, `sessionDays` for transcripts; `0` keeps). The current session, running sessions, unreadable
 * directories and live bash jobs are kept. When Octocode's session listing fails nothing is removed and the claim is
 * given back. One summary line per pass that removed or failed something goes to `report`. Returns the session folder
 * names removed. Never rejects.
 */
export async function sweepSessions(
	index: SessionIndex,
	current: string | undefined,
	options: PlanOptions & { force?: boolean; report?: (line: string) => void } = {},
): Promise<string[]> {
	const now = options.now ?? Date.now();
	const env = options.env ?? process.env;
	const retention = options.retention ?? resolveRetention(env);
	const removed: string[] = [];
	if (retention.days === 0 && retention.sessionDays === 0) return removed;
	const report = (line: string) => {
		try {
			options.report?.(line);
		} catch {
			// A reporter that throws must not break session start.
		}
	};
	let last: number | undefined;
	try {
		// Claimed before the work, so concurrent session starts do not sweep twice; a failed listing gives the claim back.
		last = claimSweep(index.agent, now, options.force ?? false);
		if (last === undefined) return removed;
		// Archive retention spans the database. Visiting several workspaces must not replay every old transcript each time.
		if (claimSweep(index.agent, now, options.force ?? false, "last_archive_sweep") !== undefined)
			await expireArchiveDetails(index.agent, env, now);
		let plan;
		try {
			plan = await planSweep(index, current, { ...options, now, env, retention });
		} catch (error) {
			meta.write(index.agent.db, "last_sweep", String(last));
			report(`Octocode cleanup skipped: session listing failed (${errorMessage(error)}).`);
			return removed;
		}
		const result = await applySweep(index, plan, { ...(current ? { current } : {}), env });
		for (const candidate of result.removed)
			if (candidate.kind === "session-folder") removed.push(path.basename(candidate.path));
		const line = summarizeSweep(result);
		if (line) report(line);
	} catch (error) {
		report(`Octocode cleanup failed: ${errorMessage(error)}.`);
	}
	return [...new Set(removed)];
}
