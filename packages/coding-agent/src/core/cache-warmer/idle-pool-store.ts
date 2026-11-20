import { meta } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import type { IdleGapStore } from "./idle-pool.ts";

/** The `meta` key holding pooled idle gaps (milliseconds, oldest first), shared by every session on this machine. */
const KEY = "cache_idle_gaps";

/** The stored gaps; undefined when the value is not a JSON list of numbers. */
function parse(value: string | undefined): number[] | undefined {
	if (value === undefined) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	return Array.isArray(parsed) && parsed.every((gap) => typeof gap === "number") ? parsed : undefined;
}

/**
 * The agent database's pool of idle gaps. An append reads, extends and writes the list in one transaction, so
 * sessions in other processes do not lose each other's gaps; a stored value that is not a list of numbers is reported
 * by `read` and replaced by the next append, which starts the pool again.
 */
export function agentDbIdleGapStore(env: NodeJS.ProcessEnv = process.env): IdleGapStore {
	return {
		read: () => {
			const gaps = parse(meta.read(sharedAgentDb(env).db, KEY));
			if (!gaps) throw new Error(`meta ${KEY} is not a list of numbers; the next idle gap starts it again`);
			return gaps;
		},
		append: (gapMs, keep) => {
			const agent = sharedAgentDb(env);
			return agent.transaction(() => {
				const gaps = parse(meta.read(agent.db, KEY)) ?? [];
				gaps.push(gapMs);
				const kept = gaps.slice(-keep);
				meta.write(agent.db, KEY, JSON.stringify(kept));
				return kept;
			});
		},
	};
}
