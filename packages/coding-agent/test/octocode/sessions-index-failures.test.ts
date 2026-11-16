import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { readProblems } from "../../src/core/diagnostics-log.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { registerSessions } from "../../src/octocode/sessions/register.ts";
import { SessionIndex } from "../../src/octocode/sessions/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = { OCTOCODE_HOME: process.env.OCTOCODE_HOME, OCTOCODE_AGENT_DB: process.env.OCTOCODE_AGENT_DB };
	process.env.OCTOCODE_HOME = tmp();
	delete process.env.OCTOCODE_AGENT_DB;
});

afterEach(() => {
	vi.restoreAllMocks();
	closeSharedAgentDb();
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function session(hasUI: boolean) {
	const cwd = tmp();
	const manager = SessionManager.create(cwd, path.join(tmp(), "sessions"));
	manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	const fake = fakeHost();
	const ctx = Object.assign(fakeCtx({ cwd, hasUI }), { sessionManager: manager });
	registerSessions(fake.api, { commands: new Subcommands(), isSubagent: false });
	return { fake, ctx };
}

describe("session index write failures", () => {
	it("records every failure on stderr when nobody can see a warning", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(SessionIndex.prototype, "statsLater").mockRejectedValue(new Error("stats down"));
		vi.spyOn(SessionIndex.prototype, "endLater").mockRejectedValue(new Error("end down"));
		const { fake, ctx } = session(false);
		await fake.fire("agent_end", { type: "agent_end", messages: [] }, ctx);
		await fake.fire("session_shutdown", { type: "session_shutdown" }, ctx);
		const lines = stderr.mock.calls.map(([text]) => String(text));
		expect(lines.filter((line) => line.includes("stats down"))).toHaveLength(1);
		expect(lines.filter((line) => line.includes("end down"))).toHaveLength(1);
		expect(lines.every((line) => line.startsWith("Octocode session index unavailable: "))).toBe(true);
		const recorded = readProblems().map((problem) => `${problem.source}|${problem.message}`);
		expect(recorded).toEqual([
			"sessions|Octocode session index unavailable: stats down",
			"sessions|Octocode session index unavailable: end down",
		]);
	});

	it("keeps a single UI warning and stays off stderr when a UI is attached", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(SessionIndex.prototype, "statsLater").mockRejectedValue(new Error("stats down"));
		vi.spyOn(SessionIndex.prototype, "endLater").mockRejectedValue(new Error("end down"));
		const { fake, ctx } = session(true);
		await fake.fire("agent_end", { type: "agent_end", messages: [] }, ctx);
		await fake.fire("session_shutdown", { type: "session_shutdown" }, ctx);
		expect(ctx.ui.notes.filter((note) => note.type === "warning")).toHaveLength(1);
		expect(stderr).not.toHaveBeenCalled();
	});
});
