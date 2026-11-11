import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { pendingReportsDir, savePendingReport } from "../../src/octocode/subagents/handoff/pending.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A saved session (its file exists once a reply is recorded) that a later session replaces. */
function savedSession(id: string): string {
	const session = SessionManager.create(tmp(), tmp(), { id });
	session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	return session.getSessionFile()!;
}

const saveReport = (sessionId: string, id: string): string | undefined =>
	savePendingReport(pendingReportsDir(sessionId), id, {
		content: `Background subagent ${id} stopped by session shutdown`,
		details: { id, status: "stopped", summary: "Stopped" },
		wake: false,
	});

function newSession() {
	const f = fakeHost();
	registerAgentTool(f.api, {
		profiles: () => new Map(),
		team: new Team(f.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") }),
		permission: fakePermission(),
	});
	const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
	const notes = () => ctx.ui.notes.filter((note) => note.message.includes("background agent report"));
	return { f, ctx, notes };
}

describe("children the previous session stopped", () => {
	it("tells the session that replaces it where their reports are, without taking them", async () => {
		const previousFile = savedSession("old-session-a");
		const first = saveReport("old-session-a", "general-1");
		saveReport("old-session-a", "general-2");
		const { f, ctx, notes } = newSession();
		await f.emit("session_start", { type: "session_start", reason: "new", previousSessionFile: previousFile }, ctx);
		await vi.waitFor(() => expect(notes()).toHaveLength(1), { timeout: 5_000 });
		expect(notes()[0].message).toBe(
			"2 background agent reports are saved with session old-session-a; /resume it to read them",
		);
		// Still the old session's: this one never asked for them.
		expect(fs.existsSync(first!)).toBe(true);
		expect(f.sent.filter((entry) => String(entry.message.content).includes("general-"))).toEqual([]);
		await f.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	});

	it("says nothing when the previous session left nothing, on a reload, or at startup", async () => {
		const previousFile = savedSession("old-session-b");
		const { f, ctx, notes } = newSession();
		await f.emit("session_start", { type: "session_start", reason: "new", previousSessionFile: previousFile }, ctx);
		saveReport("old-session-b", "general-3");
		await f.emit("session_start", { type: "session_start", reason: "reload", previousSessionFile: previousFile }, ctx);
		await f.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(notes()).toEqual([]);
		await f.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	});
});
