import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

const savedEnv = { ...process.env };

beforeAll(() => {
	const dir = tmp("octocode-lease-release-");
	resetOctocodeEnv();
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(dir, "home"),
		OCTOCODE_AGENT_DB: path.join(dir, "team", "team.sqlite"),
	});
});
afterAll(() => {
	process.env = savedEnv;
});

describe("releasing a child's reservations when the database cannot be written", () => {
	it("rejects for the caller to report, and still lets siblings waiting on the release go on", async () => {
		const cwd = fs.realpathSync(tmp("octocode-lease-release-cwd-"));
		const team = new Team(fakeHost().api);
		team.start(fakeCtx({ cwd, hasUI: true }));
		team.join();
		const store = TeamStore.open(cwd, process.env.OCTOCODE_AGENT_DB);
		try {
			expect(await team.childLeases.reserve({ id: "kid-one", role: "general", goal: "g" }, ["a.ts"])).toMatchObject({
				ok: true,
			});
			vi.spyOn(TeamStore.prototype, "remove").mockImplementation(() => {
				throw new Error("disk I/O error");
			});
			vi.spyOn(TeamStore.prototype, "unlock").mockImplementation(() => {
				throw new Error("disk I/O error");
			});
			const waiting = team.childLeases.released(["kid-one"]);
			await expect(team.childLeases.release("kid-one")).rejects.toThrow("disk I/O error");
			await expect(waiting).resolves.toBeUndefined();
			expect(team.childLeases.siblingsHolding([{ path: "a.ts", heldBy: { owner: "kid-one" } } as never])).toEqual([]);
		} finally {
			vi.restoreAllMocks();
			team.stop();
			for (const id of store.names()) store.remove(id);
			store.close();
		}
	});
});
