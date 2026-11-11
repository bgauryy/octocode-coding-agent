import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../db/src/api.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { setMirrorNoticeHandler } from "../src/core/session-manager/mirror.ts";

let scratch: string;
let cwd: string;
let dbFile: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "octocode-mirror-notice-"));
	cwd = join(scratch, "work");
	mkdirSync(cwd);
	dbFile = join(scratch, "agent.db");
	vi.stubEnv("OCTOCODE_AGENT_DB", dbFile);
	vi.stubEnv("OCTOCODE_HOME", join(scratch, "home"));
});
afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(scratch, { recursive: true, force: true });
});

describe("database mirror failures", () => {
	it("reach a registered notice handler instead of stderr, and the file stays complete", () => {
		writeFileSync(dbFile, "unrelated file");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const notices: string[] = [];
		const remove = setMirrorNoticeHandler((message) => notices.push(message));
		try {
			const session = SessionManager.create(cwd);
			session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
			expect(notices.some((line) => line.includes("Database mirror pending"))).toBe(true);
			expect(stderr.mock.calls.some(([line]) => String(line).includes("Database mirror pending"))).toBe(false);
			expect(readFileSync(session.getSessionFile()!, "utf8")).toContain("kept");
		} finally {
			remove();
		}
	});

	it("do not hold up a save while another process holds the database", async () => {
		const notices: string[] = [];
		const remove = setMirrorNoticeHandler((message) => notices.push(message));
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "before", timestamp: Date.now() });
		const holder = spawn(
			process.execPath,
			[
				"-e",
				`const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(dbFile)});
				 db.exec("BEGIN IMMEDIATE"); process.stdout.write("held\\n"); setTimeout(() => db.exec("COMMIT"), 2000);`,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		try {
			await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
			const started = performance.now();
			session.appendMessage({ role: "user", content: "while held", timestamp: Date.now() });
			expect(performance.now() - started).toBeLessThan(1000);
			expect(notices.some((line) => line.includes("database is locked"))).toBe(true);
			expect(readFileSync(session.getSessionFile()!, "utf8")).toContain("while held");
		} finally {
			remove();
			holder.kill();
			await new Promise((resolve) => holder.once("exit", resolve));
		}
	});
});
