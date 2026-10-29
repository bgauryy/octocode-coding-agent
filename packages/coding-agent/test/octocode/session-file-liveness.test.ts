import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closeSharedAgentDb, sharedAgentDb } from "../../src/octocode/agentdb/db.ts";
import { sessionFileRunningPid } from "../../src/octocode/agentdb/liveness.ts";
import { SessionIndex } from "../../src/octocode/sessions/store.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { tmp } from "./helpers.ts";

afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
});

it("reads a session file's live process through the shared index and clears after session end", () => {
	const root = tmp();
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
	const manager = SessionManager.create(root);
	manager.appendMessage({ role: "user", content: "live", timestamp: Date.now() });
	const index = new SessionIndex(sharedAgentDb());
	index.start(manager.getSessionId());
	const file = manager.getSessionFile()!;
	expect(sessionFileRunningPid(file)).toBe(process.pid);
	index.end(manager.getSessionId());
	expect(sessionFileRunningPid(file)).toBeUndefined();
});

it("returns undefined for an unavailable session file", () => {
	expect(sessionFileRunningPid(path.join(tmp(), "missing.jsonl"))).toBeUndefined();
});

it("reads only the header: never loads or rewrites the transcript another process may be appending to", () => {
	const root = tmp();
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
	const id = "01a1f000-0000-7000-8000-000000000002";
	const header = { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root };
	const file = path.join(root, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	// The last entry is mid-write (no newline yet): opening the session would end it with one.
	const entry = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "x", timestamp: 1 },
	};
	const text = `${JSON.stringify(header)}\n${JSON.stringify(entry)}`;
	fs.writeFileSync(file, text);
	new SessionIndex(sharedAgentDb()).start(id);
	const load = vi.spyOn(SessionManager, "open");
	expect(sessionFileRunningPid(file)).toBe(process.pid);
	expect(fs.readFileSync(file, "utf8")).toBe(text);
	expect(load).not.toHaveBeenCalled();
});
