import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentDb } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import type * as Meta from "../../../db/src/queries/meta.ts";
import { claimSweep } from "../../src/octocode/sessions/sweep.ts";
import { tmp } from "./helpers.ts";

/** Runs once inside the next `last_sweep` read: what another process does between a claim's read and its write. */
const between = vi.hoisted(() => ({ run: undefined as (() => void) | undefined }));

vi.mock("../../../db/src/queries/meta.ts", async (original) => {
	const meta = await original<typeof Meta>();
	return {
		...meta,
		read: (...args: Parameters<typeof meta.read>) => {
			const value = meta.read(...args);
			const run = between.run;
			between.run = undefined;
			run?.();
			return value;
		},
	};
});

const opened: AgentDb[] = [];
afterEach(() => {
	between.run = undefined;
	for (const db of opened.splice(0)) db.close();
});

describe("sweep claim", () => {
	it("lets exactly one of two handles on one database claim the sweep, however their reads and writes interleave", () => {
		const file = path.join(tmp(), "octocode.db");
		const [first, second] = [openAgentDb(file), openAgentDb(file)];
		opened.push(first, second);
		// The second process gives up at once instead of waiting out the busy timeout on the first one's lock.
		second.db.exec("PRAGMA busy_timeout=0");
		const now = Date.now();
		const winners: string[] = [];
		const claim = (name: string, agent: AgentDb) => {
			try {
				if (claimSweep(agent, now, false) !== undefined) winners.push(name);
			} catch {
				// Locked out: another sweep holds the claim.
			}
		};
		between.run = () => claim("second", second);
		claim("first", first);
		expect(winners).toHaveLength(1);
		// Claimed: neither handle sweeps again within the period.
		claim("first", first);
		claim("second", second);
		expect(winners).toHaveLength(1);
	});
});
