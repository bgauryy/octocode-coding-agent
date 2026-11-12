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
import { closeSharedAgentDb, DbWriterCommandError, sessions, transcripts } from "../../../db/src/api.ts";
import { sharedAgentDb, sharedAgentDbWriter } from "../../src/storage/database.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { sessionMirrorSettled } from "../../src/core/session-manager/mirror.ts";

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
/** The mirror is written by the database writer after the file: wait for its acknowledgements before reading rows. */
const settle = async () => expect(await sessionMirrorSettled()).toBe(true);

describe("durable workspace transcripts", () => {
	it("stores messages, branch edges and compactions in file order; a fork has independent entries", async () => {
		const manager = SessionManager.create(cwd);
		const first = manager.appendMessage(message("review"));
		manager.appendCompaction("retain findings", first, 1200);
		manager.branch(first);
		manager.appendCustomEntry("agent_report", { outcome: "done" });
		const file = manager.getSessionFile()!;
		expect(file).toContain(join(".octocode", "code", "sessions"));
		const id = manager.getSessionId();
		await settle();
		expect(records(id)).toEqual(jsonl(file));
		expect(transcripts.stamp(sharedAgentDb().db, id)?.workspace_id).toBe(
			readFileSync(join(cwd, ".octocode/code/workspace/id"), "utf8").trim(),
		);
		expect((await SessionManager.listAll()).some((s) => s.id === id)).toBe(true);

		const fork = SessionManager.forkFrom(file, cwd);
		await settle();
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

	it("follows the original file across a rename and rejects a different file claiming its historical ID", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage(message("original conversation"));
		const id = session.getSessionId();
		await settle();
		const original = records(id);
		const renamed = join(cwd, "moved.jsonl");
		renameSync(session.getSessionFile()!, renamed);
		SessionManager.open(renamed);
		await settle();
		expect(transcripts.stamp(sharedAgentDb().db, id)?.file).toBe(realpathSync(renamed));
		const forged = join(scratch, "forged.jsonl");
		writeFileSync(forged, JSON.stringify(session.getHeader()) + "\n");
		rmSync(renamed);
		const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			SessionManager.open(forged).appendMessage(message("spoofed conversation"));
			await settle();
			expect(records(id)).toEqual(original);
			expect(log.mock.calls.some(([line]) => String(line).includes("Another transcript"))).toBe(true);
		} finally {
			log.mockRestore();
		}
	});

	it("repairs a missed SQLite commit on reopen and includes entries appended by another writer", async () => {
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
		await settle();
		expect(records(a.getSessionId())).toEqual(jsonl(file));
		b.appendMessage(message("second writer"));
		a.appendMessage(message("original writer"));
		await settle();
		expect(records(a.getSessionId())).toEqual(jsonl(file));
	});

	it("keeps in-memory sessions and unopened conversations out of the database", async () => {
		const memory = SessionManager.inMemory(cwd);
		memory.appendMessage(message("private"));
		memory.appendCompaction("private summary", memory.getLeafId(), 4);
		expect(existsSync(join(cwd, ".octocode"))).toBe(false);
		const disk = SessionManager.create(cwd);
		disk.appendThinkingLevelChange("high");
		expect(existsSync(dbFile)).toBe(false);
		disk.materialize();
		await settle();
		expect(records(disk.getSessionId())).toEqual(jsonl(disk.getSessionFile()!));
	});

	it("keeps the file authoritative across a database failure and replays it on the next write", async () => {
		writeFileSync(dbFile, "unrelated file");
		const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
		try {
			const session = SessionManager.create(cwd);
			session.appendMessage(message("complete file first"));
			await settle();
			expect(log.mock.calls.some(([line]) => String(line).includes("Database mirror pending"))).toBe(true);
			closeSharedAgentDb();
			rmSync(dbFile);
			vi.setSystemTime(Date.now() + 10 * 60_000);
			session.appendMessage(message("recovered"));
			await settle();
			expect(records(session.getSessionId())).toEqual(jsonl(session.getSessionFile()!));
		} finally {
			vi.useRealTimers();
			log.mockRestore();
		}
	});

	it("backs off full rebuilds after one fails, while every append still reaches the file", async () => {
		const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const session = SessionManager.create(cwd);
		session.appendMessage(message("mirrored"));
		const file = session.getSessionFile()!;
		await settle();
		const writer = sharedAgentDbWriter();
		const submit = writer.submit.bind(writer);
		// A record the mirror never saw breaks the stamp, so while the database refuses commits each append needs a whole-file rebuild.
		appendFileSync(
			file,
			`${JSON.stringify({ type: "custom", customType: "direct", id: "direct01", parentId: session.getLeafId(), timestamp: new Date(0).toISOString() })}\n`,
		);
		let saves = 0;
		// A repair is a whole-file save, or a continuation from the stored rows, which re-sends the record they lack.
		const repairs = (command: Parameters<typeof submit>[0]) =>
			command.kind === "save" ||
			(command.kind === "sync" && command.entries?.some((entry) => entry.record.id === "direct01") === true);
		const refused = vi.spyOn(writer, "submit").mockImplementation((command) => {
			if (!repairs(command)) return submit(command);
			saves += 1;
			return Promise.reject(new DbWriterCommandError("database is busy", true));
		});
		const start = Date.now();
		vi.useFakeTimers({ now: start, toFake: ["Date"] });
		try {
			session.appendMessage(message("first attempt fails"));
			await settle();
			expect(saves).toBe(1);
			session.appendMessage(message("inside the backoff"));
			session.appendMessage(message("still inside it"));
			await settle();
			expect(saves).toBe(1);
			vi.setSystemTime(start + 6_000);
			session.appendMessage(message("after the backoff"));
			await settle();
			expect(saves).toBe(2);
			refused.mockRestore();
			vi.setSystemTime(start + 60_000);
			session.appendMessage(message("the database is back"));
			await settle();
			expect(records(session.getSessionId())).toEqual(jsonl(file));
		} finally {
			vi.useRealTimers();
			refused.mockRestore();
			log.mockRestore();
		}
		expect(jsonl(file).filter((record) => (record as { type: string }).type === "message")).toHaveLength(6);
	});

	it("sends a burst of appends in one turn as one command and leaves the mirror level", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage(message("first"));
		await settle();
		const writer = sharedAgentDbWriter();
		const submit = vi.spyOn(writer, "submit");
		try {
			for (let n = 0; n < 400; n++) session.appendMessage(message(`burst ${n}`));
			await settle();
			expect(submit).toHaveBeenCalledTimes(1);
			expect(submit.mock.calls[0][0]).toMatchObject({ kind: "sync" });
		} finally {
			submit.mockRestore();
		}
		expect(records(session.getSessionId())).toEqual(jsonl(session.getSessionFile()!));
	});

	it("forks a stored id from the file when it exists, not from a stale database copy", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage(message("mirrored"));
		const file = session.getSessionFile()!;
		const id = session.getSessionId();
		const late = {
			type: "message",
			id: "late0001",
			parentId: session.getLeafId(),
			timestamp: new Date().toISOString(),
			message: message("only in the file"),
		};
		await settle();
		appendFileSync(file, `${JSON.stringify(late)}\n`);
		expect(records(id).some((record) => (record as { id?: string }).id === "late0001")).toBe(false);
		const fork = SessionManager.forkFrom({ storedId: id }, cwd);
		expect(fork.getEntry("late0001")).toBeDefined();
		const gone = SessionManager.create(cwd);
		gone.appendMessage(message("the database keeps this"));
		const goneId = gone.getSessionId();
		await settle();
		rmSync(gone.getSessionFile()!);
		expect(SessionManager.forkFrom({ storedId: goneId }, cwd).buildSessionContext().messages).toHaveLength(1);
	});
});
