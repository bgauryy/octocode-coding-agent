import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb, sessions } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registerSessions } from "../../src/octocode/sessions/register.ts";
import { SessionIndex } from "../../src/octocode/sessions/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let saved: string | undefined;
beforeEach(() => {
	saved = process.env.OCTOCODE_HOME;
	process.env.OCTOCODE_HOME = tmp();
});
afterEach(() => {
	vi.restoreAllMocks();
	closeSharedAgentDb();
	setCurrentSession(undefined);
	if (saved === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = saved;
});

describe("session_start", () => {
	it("binds the session and records its pid in one transaction", async () => {
		const fake = fakeHost();
		registerSessions(fake.api, { commands: new Subcommands(), isSubagent: false, filesChanged: () => 0 });
		const file = path.join(tmp(), "s.jsonl");
		fs.writeFileSync(file, "{}\n");
		const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
		Object.assign(ctx, {
			sessionManager: {
				getSessionId: () => "atomic-1",
				getSessionFile: () => file,
				getSessionDir: () => path.dirname(file),
				getSessionName: () => undefined,
				getEntries: () => [],
				getBranch: () => [],
			},
		});
		setCurrentSession("atomic-1");
		vi.spyOn(SessionIndex.prototype, "start").mockImplementation(() => {
			throw new Error("database is locked");
		});
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		// Start failed: the bind rolled back, so no row exists without the pid that marks it running.
		expect(sessions.byId(sharedAgentDb().db, "atomic-1")).toBeUndefined();
		vi.restoreAllMocks();
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(sessions.byId(sharedAgentDb().db, "atomic-1")).toMatchObject({ pid: process.pid });
	});
});
