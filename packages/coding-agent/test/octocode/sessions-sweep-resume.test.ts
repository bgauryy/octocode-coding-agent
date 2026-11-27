import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentEvents } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { SessionIndex } from "../../src/octocode/sessions/store.ts";
import { applySweep } from "../../src/octocode/sessions/sweep-apply.ts";
import { planSweep } from "../../src/octocode/sessions/sweep-plan.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

describe("resuming row-only sessions after a sweep plan", () => {
	it.each(["running", "current", "during-removal"] as const)("keeps %s session rows and old events", async (mode) => {
		const root = tmp();
		const db = openAgentDb(path.join(root, "agent.db"));
		const index = new SessionIndex(db);
		try {
			const ws = registeredWorkspace(root, db);
			const id = "resumed-without-files";
			index.start(id);
			index.end(id);
			agentEvents.append(db.db, ws.id, {
				id: "old-event",
				time: "2020-01-01T00:00:00.000Z",
				name: "agent",
				parentId: null,
				sessionId: id,
				type: "create",
				data: {},
				version: 1,
			});
			const env = { ...process.env, OCTOCODE_HOME: path.join(root, "home") };
			const plan = await planSweep(index, undefined, {
				env,
				listed: async () => new Set<string>(),
				retention: { days: 30, sessionDays: 0 },
			});
			expect(plan.candidates.filter((candidate) => candidate.session === id)).toEqual([]);
			expect(plan.forgets.map((entry) => entry.id)).toContain(id);
			expect(plan.orphans).toContain(id);
			if (mode === "running") index.start(id);
			if (mode === "during-removal") {
				const scratch = path.join(root, "scratch");
				fs.writeFileSync(scratch, "old scratch");
				plan.candidates.push({ kind: "scratch", root, path: scratch, bytes: 11, reason: "old" });
				const remove = fs.promises.rm.bind(fs.promises);
				vi.spyOn(fs.promises, "rm").mockImplementation(async (file, options) => {
					await remove(file, options);
					if (file === scratch) index.start(id);
				});
			}
			const result = await applySweep(index, plan, { env, ...(mode === "current" ? { current: id } : {}) });
			expect(result.failed).toEqual([]);
			expect(result.forgotten).not.toContain(id);
			expect(result.expired.events).toBe(0);
			expect(result.skipped).toContainEqual({
				path: `session ${id}`,
				reason: mode === "current" ? "became the current session" : "is running",
			});
			expect(index.get(id)).toBeDefined();
			expect(agentEvents.list(db.db, ws.id, undefined, 50, { sessionId: id })).toHaveLength(1);
			if (mode !== "current") expect(index.get(id)?.pid).toBe(process.pid);
		} finally {
			db.close();
		}
	});
});
