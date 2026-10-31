import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb, sharedAgentDb } from "../../src/octocode/agentdb/db.ts";
import octocode from "../../src/octocode/index.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	const home = tmp();
	process.env.OCTOCODE_HOME = home;
	process.env.OCTOCODE_AGENT_DB = path.join(home, "team.sqlite");
	delete process.env.OCTOCODE_SUBAGENT;
	closeSharedAgentDb();
});
afterEach(() => {
	closeSharedAgentDb();
	process.env = saved;
});

const usable = (handle: ReturnType<typeof sharedAgentDb>): boolean => {
	try {
		handle.db.prepare("select 1").get();
		return true;
	} catch {
		return false;
	}
};

describe("the composed extension on session_shutdown", () => {
	it.each(["quit", "reload", "new", "resume", "fork"])(
		"preserves the shared agent database on %s until process cleanup",
		async (reason) => {
			const fake = fakeHost();
			Object.assign(fake.api, { getSessionName: () => undefined });
			await octocode(fake.api);
			const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
			const before = sharedAgentDb();
			expect(usable(before)).toBe(true);
			await fake.fire("session_shutdown", { type: "session_shutdown", reason }, ctx);
			expect(usable(before)).toBe(true);
			expect(sharedAgentDb()).toBe(before);
			closeSharedAgentDb();
			expect(usable(before)).toBe(false);
			const after = sharedAgentDb();
			expect(after).not.toBe(before);
			expect(usable(after)).toBe(true);
		},
	);
});
