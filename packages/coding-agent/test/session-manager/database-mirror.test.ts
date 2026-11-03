import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb, sessions, transcripts } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/config/database.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

let scratch: string;
let cwd: string;
let dbFile: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "octocode-transcripts-"));
	cwd = join(scratch, "work");
	mkdirSync(cwd);
	dbFile = join(scratch, "agent.db");
	vi.stubEnv("OCTOCODE_AGENT_DB", dbFile);
	vi.stubEnv("OCTOCODE_HOME", join(scratch, "home"));
});
afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	rmSync(scratch, { recursive: true, force: true });
});

const records = (id: string) => transcripts.records(sharedAgentDb().db, id).map((line) => JSON.parse(line) as unknown);
const jsonl = (file: string) =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as unknown);
const message = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });

describe("durable workspace transcripts", () => {
	it("stores messages, branch edges and compactions in file order; a fork has independent entries", async () => {
		const manager = SessionManager.create(cwd);
		const first = manager.appendMessage(message("review"));
		manager.appendCompaction("retain findings", first, 1200);
		manager.branch(first);
		manager.appendCustomEntry("agent_report", { outcome: "done" });
		const file = manager.getSessionFile()!;
		expect(file).toContain(join(".octa", "code", "sessions"));
		const id = manager.getSessionId();
		expect(records(id)).toEqual(jsonl(file));
		expect(transcripts.stamp(sharedAgentDb().db, id)?.workspace_id).toBe(
			readFileSync(join(cwd, ".octa/code/workspace/id"), "utf8").trim(),
		);
		expect((await SessionManager.listAll()).some((s) => s.id === id)).toBe(true);

		const fork = SessionManager.forkFrom(file, cwd);
		expect(records(fork.getSessionId())).toEqual(jsonl(fork.getSessionFile()!));
		rmSync(file);
		sessions.forget(sharedAgentDb().db, id);
		expect(records(id)).toHaveLength(4);
		// The historical pathname can now contain an unrelated file. An ID-based fork reads the saved rows.
		writeFileSync(file, JSON.stringify({ ...manager.getHeader(), id: "replacement" }) + "\n");
		const recovered = SessionManager.forkFrom({ storedId: id }, cwd);
		expect(recovered.getEntries()).toEqual(manager.getEntries());
		expect(recovered.getHeader()).toMatchObject({ parentSession: file, parentSessionId: id });
	});

	it("follows the original file across a rename and rejects a different file claiming its historical ID", () => {
		const session = SessionManager.create(cwd);
		session.appendMessage(message("original conversation"));
		const id = session.getSessionId();
		const original = records(id);
		const renamed = join(cwd, "moved.jsonl");
		renameSync(session.getSessionFile()!, renamed);
		SessionManager.open(renamed);
		expect(transcripts.stamp(sharedAgentDb().db, id)?.file).toBe(realpathSync(renamed));
		const forged = join(scratch, "forged.jsonl");
		writeFileSync(forged, JSON.stringify(session.getHeader()) + "\n");
		rmSync(renamed);
		const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			SessionManager.open(forged).appendMessage(message("spoofed conversation"));
			expect(records(id)).toEqual(original);
			expect(log.mock.calls.some(([line]) => String(line).includes("Another transcript"))).toBe(true);
		} finally {
			log.mockRestore();
		}
	});

	it("repairs a missed SQLite commit on reopen and includes entries appended by another writer", () => {
		const a = SessionManager.create(cwd);
		const first = a.appendMessage(message("start"));
		const file = a.getSessionFile()!;
		// A writer committed this JSONL record and exited before updating SQLite.
		appendFileSync(
			file,
			JSON.stringify({
				type: "custom",
				id: "foreign",
				parentId: first,
				timestamp: new Date().toISOString(),
				customType: "report",
			}) + "\n",
		);
		const b = SessionManager.open(file);
		expect(records(a.getSessionId())).toEqual(jsonl(file));
		b.appendMessage(message("second writer"));
		a.appendMessage(message("original writer"));
		expect(records(a.getSessionId())).toEqual(jsonl(file));
	});

	it("keeps in-memory sessions and unopened conversations out of the database", () => {
		const memory = SessionManager.inMemory(cwd);
		memory.appendMessage(message("private"));
		memory.appendCompaction("private summary", memory.getLeafId(), 4);
		expect(existsSync(join(cwd, ".octa"))).toBe(false);
		const disk = SessionManager.create(cwd);
		disk.appendThinkingLevelChange("high");
		expect(existsSync(dbFile)).toBe(false);
		disk.materialize();
		expect(records(disk.getSessionId())).toEqual(jsonl(disk.getSessionFile()!));
	});

	it("keeps the file authoritative across a database failure and replays it on the next write", () => {
		writeFileSync(dbFile, "unrelated file");
		const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const session = SessionManager.create(cwd);
			session.appendMessage(message("complete file first"));
			expect(log.mock.calls.some(([line]) => String(line).includes("Database mirror pending"))).toBe(true);
			closeSharedAgentDb();
			rmSync(dbFile);
			session.appendMessage(message("recovered"));
			expect(records(session.getSessionId())).toEqual(jsonl(session.getSessionFile()!));
		} finally {
			log.mockRestore();
		}
	});
});
