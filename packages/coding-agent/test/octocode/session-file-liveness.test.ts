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
