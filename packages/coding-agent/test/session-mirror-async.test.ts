import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb, transcripts } from "../../db/src/api.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { sessionMirrorSettled, setMirrorNoticeHandler } from "../src/core/session-manager/mirror.ts";
import { sharedAgentDb, sharedAgentDbWriter } from "../src/storage/database.ts";

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
	it("reach a registered notice handler instead of stderr, and the file stays complete", async () => {
		writeFileSync(dbFile, "unrelated file");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const notices: string[] = [];
		const remove = setMirrorNoticeHandler((message) => notices.push(message));
		try {
			const session = SessionManager.create(cwd);
			session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
			expect(await sessionMirrorSettled()).toBe(true);
			expect(notices.some((line) => line.includes("Database mirror pending"))).toBe(true);
			expect(stderr.mock.calls.some(([line]) => String(line).includes("Database mirror pending"))).toBe(false);
			expect(readFileSync(session.getSessionFile()!, "utf8")).toContain("kept");
		} finally {
			remove();
		}
	});

	it("do not hold up a save or the event loop while another process holds the database", async () => {
		const notices: string[] = [];
		const remove = setMirrorNoticeHandler((message) => notices.push(message));
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "before", timestamp: Date.now() });
		expect(await sessionMirrorSettled()).toBe(true);
		const holder = spawn(
			process.execPath,
			[
				"-e",
				`const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(dbFile)});
				 db.exec("BEGIN IMMEDIATE"); process.stdout.write("held\\n"); setTimeout(() => db.exec("COMMIT"), 1000);`,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		try {
			await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
			const started = performance.now();
			const timer = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - started), 10));
			session.appendMessage({ role: "user", content: "while held", timestamp: Date.now() });
			expect(performance.now() - started).toBeLessThan(100);
			// The database writer waits for the lock on its own thread: a 10 ms timer here still fires on time.
			expect(await timer).toBeLessThan(200);
			expect(await sessionMirrorSettled()).toBe(true);
			expect(performance.now() - started).toBeGreaterThan(500);
			expect(notices).toEqual([]);
			expect(readFileSync(session.getSessionFile()!, "utf8")).toContain("while held");
			const rows = transcripts.records(sharedAgentDb().db, session.getSessionId()).join("\n");
			expect(rows).toContain("while held");
		} finally {
			remove();
			// The holder exits by itself after its commit.
			if (holder.exitCode === null && holder.signalCode === null) {
				holder.kill();
				await new Promise((resolve) => holder.once("exit", resolve));
			}
		}
	});

	it("keep every acknowledged record in the file when the writer dies, and rebuild the mirror at the next append", async () => {
		const notices: string[] = [];
		const remove = setMirrorNoticeHandler((message) => notices.push(message));
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		expect(await sessionMirrorSettled()).toBe(true);
		const holder = spawn(
			process.execPath,
			[
				"-e",
				`const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(dbFile)});
				 db.exec("BEGIN IMMEDIATE"); process.stdout.write("held\\n"); setTimeout(() => db.exec("COMMIT"), 500);`,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		try {
			await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
			session.appendMessage({ role: "user", content: "while the writer dies", timestamp: Date.now() });
			await new Promise((resolve) => setTimeout(resolve, 50));
			// The mirror command waits in the worker for the lock when the worker dies.
			await (sharedAgentDbWriter() as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
			expect(await sessionMirrorSettled()).toBe(true);
			expect(notices.some((line) => line.includes("Database writer stopped"))).toBe(true);
			if (holder.exitCode === null && holder.signalCode === null)
				await new Promise((resolve) => holder.once("exit", resolve));
			session.appendMessage({ role: "user", content: "after the restart", timestamp: Date.now() });
			expect(await sessionMirrorSettled()).toBe(true);
			const file = readFileSync(session.getSessionFile()!, "utf8").trim().split("\n");
			expect(file.join("\n")).toContain("while the writer dies");
			expect(transcripts.records(sharedAgentDb().db, session.getSessionId())).toEqual(file);
		} finally {
			remove();
			if (holder.exitCode === null && holder.signalCode === null) holder.kill();
		}
	});
});
