import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb, DbWriterUnavailableError, transcripts } from "../../../db/src/api.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { sessionMirrorSettled, setMirrorNoticeHandler } from "../../src/core/session-manager/mirror.ts";
import { rebuild, transcriptOf } from "../../src/core/session-manager/mirror-writes.ts";
import type { SessionState } from "../../src/core/session-manager/state.ts";
import { sharedAgentDb, sharedAgentDbWriter } from "../../src/storage/database.ts";

let scratch: string;
let cwd: string;
let notices: string[];
let removeNotices: () => void;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "octocode-mirror-delivery-"));
	cwd = join(scratch, "work");
	mkdirSync(cwd);
	vi.stubEnv("OCTOCODE_AGENT_DB", join(scratch, "agent.db"));
	vi.stubEnv("OCTOCODE_HOME", join(scratch, "home"));
	notices = [];
	removeNotices = setMirrorNoticeHandler((message) => notices.push(message));
});
afterEach(async () => {
	await sessionMirrorSettled();
	removeNotices();
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(scratch, { recursive: true, force: true });
});

const rows = (id: string) => transcripts.records(sharedAgentDb().db, id);
const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n");
const message = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
const stateOf = (session: SessionManager) => (session as unknown as { state: SessionState }).state;
/** A record only the file has: the mirror's stamp no longer matches, so the next delta is `stale`. */
const foreignRecord = (session: SessionManager) =>
	appendFileSync(
		session.getSessionFile()!,
		`${JSON.stringify({ type: "custom", customType: "direct", id: `direct-${Date.now()}`, parentId: session.getLeafId(), timestamp: new Date(0).toISOString() })}\n`,
	);

describe("database mirror delivery", () => {
	it("stores each record as the line its file holds, whatever the entry contains, and keeps mirroring", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage(message("first"));
		session.appendCustomEntry("odd values", {
			stamp: { toJSON: () => "serialized by toJSON" },
			bytes: Buffer.from("abc"),
			callback: () => "functions are not data",
			symbol: Symbol("not data"),
		});
		expect(await sessionMirrorSettled()).toBe(true);
		const file = session.getSessionFile()!;
		expect(rows(session.getSessionId())).toEqual(lines(file));
		session.appendMessage(message("after"));
		expect(await sessionMirrorSettled()).toBe(true);
		expect(rows(session.getSessionId())).toEqual(lines(file));
		expect(notices).toEqual([]);
	});

	it("rebuilds from the file's own lines, skipping the lines a session read skips", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage(message("first with non-ASCII text: café 日本"));
		expect(await sessionMirrorSettled()).toBe(true);
		const file = session.getSessionFile()!;
		// Written by another tool: spacing JSON.stringify would not produce, a blank line and a torn record.
		const spaced = `{ "type": "custom", "customType": "direct", "id": "spaced", "parentId": ${JSON.stringify(session.getLeafId())}, "timestamp": "${new Date(0).toISOString()}" }`;
		appendFileSync(file, `${spaced}\n\n{"type": "cust\n`);
		const kept = lines(file).filter((line) => line.trim() && !line.startsWith('{"type": "cust'));
		// What an open does when the mirror is behind the file.
		rebuild(transcriptOf(stateOf(session), file), "open");
		expect(await sessionMirrorSettled()).toBe(true);
		expect(rows(session.getSessionId())).toEqual(kept);
		expect(rows(session.getSessionId())).toContain(spaced);
		expect(notices).toEqual([]);
	});

	it("repairs a transcript the state has left: a stale reply after /new still rebuilds the old session", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage(message("first"));
		expect(await sessionMirrorSettled()).toBe(true);
		const oldId = session.getSessionId();
		const oldFile = session.getSessionFile()!;
		foreignRecord(session);
		session.appendMessage(message("last of the old session"));
		// The reply to that append comes after the state already shows another session.
		session.newSession();
		expect(await sessionMirrorSettled()).toBe(true);
		expect(rows(oldId)).toEqual(lines(oldFile));
	});

	it("records a fork edge when the first try is lost with the worker", async () => {
		const root = SessionManager.create(cwd);
		root.materialize();
		expect(await sessionMirrorSettled()).toBe(true);
		const writer = sharedAgentDbWriter();
		const submit = writer.submit.bind(writer);
		let lost = 0;
		vi.spyOn(writer, "submit").mockImplementation((command) => {
			if (command.kind === "fork" && lost++ === 0)
				return Promise.reject(new DbWriterUnavailableError("Database writer stopped before acknowledging"));
			return submit(command);
		});
		const fork = SessionManager.forkFrom(root.getSessionFile()!, cwd);
		expect(await sessionMirrorSettled()).toBe(true);
		expect(lost).toBe(2);
		const workspace = transcripts.stamp(sharedAgentDb().db, fork.getSessionId())?.workspace_id;
		expect(
			transcripts.lineage(
				sharedAgentDb().db,
				fork.getSessionId(),
				realpathSync(fork.getSessionFile()!),
				workspace ?? "",
			),
		).toEqual([root.getSessionId()]);
		expect(notices.some((line) => line.includes("Could not record the fork origin"))).toBe(false);
	});

	it("sends appends still waiting before a rebuild of the same transcript", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage(message("first"));
		expect(await sessionMirrorSettled()).toBe(true);
		const writer = sharedAgentDbWriter();
		const sent: string[] = [];
		const submit = writer.submit.bind(writer);
		vi.spyOn(writer, "submit").mockImplementation((command) => {
			sent.push(command.kind === "sync" && command.entries ? "append" : command.kind);
			return submit(command);
		});
		session.appendMessage(message("waiting in its batch"));
		const state = stateOf(session);
		rebuild(transcriptOf(state, session.getSessionFile()!), "append");
		expect(sent).toEqual(["append", "save"]);
		expect(await sessionMirrorSettled()).toBe(true);
		expect(rows(session.getSessionId())).toEqual(lines(session.getSessionFile()!));
	});

	it("lets a disposing runtime finish queued mirror writes before the process may exit", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage(message("first"));
		expect(await sessionMirrorSettled()).toBe(true);
		for (let n = 0; n < 50; n++) session.appendMessage(message(`queued ${n}`));
		const runtime = Object.create(AgentSessionRuntime.prototype) as AgentSessionRuntime;
		Object.assign(runtime, { teardownCurrent: async () => undefined });
		await runtime.dispose();
		// What `process.exit` would leave: no further waiting.
		expect(rows(session.getSessionId())).toEqual(lines(session.getSessionFile()!));
	});
});
