import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../db/src/api.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { sessionMirrorSettled, setMirrorNoticeHandler } from "../src/core/session-manager/mirror.ts";

let scratch: string;
let cwd: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "octocode-mirror-owner-"));
	cwd = join(scratch, "work");
	mkdirSync(cwd);
	// A database file that is not a database makes every mirror write fail.
	writeFileSync(join(scratch, "agent.db"), "unrelated file");
	vi.stubEnv("OCTOCODE_AGENT_DB", join(scratch, "agent.db"));
	vi.stubEnv("OCTOCODE_HOME", join(scratch, "home"));
});
afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(scratch, { recursive: true, force: true });
});

describe("database mirror notices", () => {
	it("go to the session that owns the problem, not to another session's or the process-wide handler", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const global: string[] = [];
		const remove = setMirrorNoticeHandler((message) => global.push(message));
		try {
			const owned: string[] = [];
			const session = SessionManager.create(cwd);
			session.setNoticeHandler((message) => owned.push(message));
			session.appendMessage({ role: "user", content: "mine", timestamp: Date.now() });
			expect(await sessionMirrorSettled()).toBe(true);
			expect(owned.some((line) => line.includes("Database mirror pending"))).toBe(true);
			expect(global.some((line) => line.includes(session.getSessionFile()!))).toBe(false);
			expect(stderr.mock.calls.some(([line]) => String(line).includes("Database mirror pending"))).toBe(false);
		} finally {
			remove();
		}
	});
});
