import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb, type TranscriptCommand, transcripts } from "../../../db/src/api.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { sessionMirrorSettled, setMirrorNoticeHandler } from "../../src/core/session-manager/mirror.ts";
import { sharedAgentDb, sharedTranscriptWriter } from "../../src/storage/database.ts";

let scratch: string;
let cwd: string;
let notices: string[];
let removeNotices: () => void;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "octocode-mirror-open-"));
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

const rows = (id: string) => transcripts.records(sharedAgentDb().mirror.db, id);
const checksum = (list: readonly string[]) => createHash("sha256").update(list.join("\n")).digest("hex");
const message = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
/** The lines a whole-file rebuild stores: blank and malformed lines are skipped. */
const kept = (file: string) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => {
			try {
				return JSON.parse(line) !== null;
			} catch {
				return false;
			}
		});

/** A session of `turns` messages whose mirror is level, then left behind by lines another process appended. */
async function behind(turns: number) {
	const session = SessionManager.create(cwd);
	for (let n = 0; n < turns; n++) session.appendMessage(message(`turn ${n}: café 日本`));
	expect(await sessionMirrorSettled()).toBe(true);
	const file = session.getSessionFile()!;
	const id = session.getSessionId();
	const custom = (n: number, spaced = false) => {
		const record = {
			type: "custom",
			customType: "direct",
			id: `direct-${n}`,
			parentId: n === 0 ? session.getLeafId() : `direct-${n - 1}`,
			timestamp: new Date(0).toISOString(),
		};
		return spaced ? JSON.stringify(record, null, 1).replace(/\n/g, "") : JSON.stringify(record);
	};
	// Another writer's records, with spacing JSON.stringify does not produce, a blank line and a torn record in between.
	appendFileSync(file, `${custom(0)}\n\n${custom(1, true)}\n{"type": "cust\n${custom(2)}\n`);
	return { session, file, id };
}

function recordCommands(): string[] {
	const writer = sharedTranscriptWriter();
	const sent: string[] = [];
	const submit = writer.submit.bind(writer);
	vi.spyOn(writer, "submit").mockImplementation((command: TranscriptCommand) => {
		sent.push(
			command.kind === "sync" && command.entries
				? `append@${command.entries[0]?.position}+${command.entries.length}`
				: command.kind,
		);
		return submit(command);
	});
	return sent;
}

describe("opening a session whose mirror holds a prefix of its file", () => {
	it("sends only the appended lines, and stores what a whole-file rebuild stores", async () => {
		const { file, id } = await behind(6);
		const sent = recordCommands();
		SessionManager.open(file);
		expect(await sessionMirrorSettled()).toBe(true);
		// Positions continue the stored rows (6 messages); the blank and the torn line are skipped.
		expect(sent).toEqual(["append@6+3"]);
		const continued = rows(id);
		expect(continued).toEqual(kept(file));

		// The same rows as a whole-file save into an empty mirror.
		sharedAgentDb().mirror.db.prepare("DELETE FROM session_entries WHERE session_id=?").run(id);
		sharedAgentDb().mirror.db.prepare("DELETE FROM session_transcripts WHERE session_id=?").run(id);
		SessionManager.open(file);
		expect(await sessionMirrorSettled()).toBe(true);
		expect(sent.at(-1)).toBe("save");
		expect(checksum(rows(id))).toBe(checksum(continued));
		expect(notices).toEqual([]);
	});

	it("rebuilds from the whole file when the file no longer holds the last stored row where the stamp ends", async () => {
		const session = SessionManager.create(cwd);
		for (let n = 0; n < 4; n++) session.appendMessage(message(`turn ${n}`));
		expect(await sessionMirrorSettled()).toBe(true);
		const file = session.getSessionFile()!;
		const id = session.getSessionId();
		// Rewritten in place (same file identity) with different bytes before the stored size, then grown.
		const text = readFileSync(file, "utf8").replace("turn 3", "TURN 3");
		writeFileSync(
			file,
			`${text}${JSON.stringify({ type: "custom", customType: "x", id: "late", parentId: null, timestamp: new Date(0).toISOString() })}\n`,
		);
		const sent = recordCommands();
		SessionManager.open(file);
		expect(await sessionMirrorSettled()).toBe(true);
		expect(sent).toEqual(["save"]);
		expect(rows(id)).toEqual(kept(file));
	});

	it("rebuilds everything when the mirror moved between the check and the write", async () => {
		const { file, id } = await behind(3);
		const sent = recordCommands();
		const writer = sharedTranscriptWriter();
		const submit = vi.mocked(writer.submit).getMockImplementation()!;
		let moved = false;
		vi.mocked(writer.submit).mockImplementation((command: TranscriptCommand) => {
			// Another process saved a newer stamp just before the continuation arrives: the writer replies `stale`.
			if (!moved && command.kind === "sync" && command.entries) {
				moved = true;
				sharedAgentDb().mirror.db.prepare("UPDATE session_transcripts SET mtime='0' WHERE session_id=?").run(id);
			}
			return submit(command);
		});
		SessionManager.open(file);
		expect(await sessionMirrorSettled()).toBe(true);
		expect(sent).toEqual(["append@3+3", "save"]);
		expect(rows(id)).toEqual(kept(file));
	});
});

describe("a session reopened after a writer stopped mid-append", () => {
	it("mirrors the recovery record and every later entry, skipping the sealed line as a rebuild does", async () => {
		const session = SessionManager.create(cwd);
		for (let n = 0; n < 4; n++) session.appendMessage(message(`turn ${n}`));
		expect(await sessionMirrorSettled()).toBe(true);
		const file = session.getSessionFile()!;
		const id = session.getSessionId();
		appendFileSync(file, '{"type":"message","id":"cut","message":{"role":"user","content":"tur');
		const reopened = SessionManager.open(file);
		reopened.appendMessage(message("after the crash"));
		reopened.appendMessage(message("and the next"));
		expect(await sessionMirrorSettled()).toBe(true);
		expect(rows(id)).toEqual(kept(file));
		const records = rows(id).map(
			(line) => JSON.parse(line) as { type: string; customType?: string; message?: { content?: string } },
		);
		expect(records.map((record) => record.customType ?? record.message?.content ?? record.type)).toEqual([
			"session",
			"turn 0",
			"turn 1",
			"turn 2",
			"turn 3",
			"octocode-session-recovery",
			"after the crash",
			"and the next",
		]);
		expect(notices).toEqual([]);
	});
});
