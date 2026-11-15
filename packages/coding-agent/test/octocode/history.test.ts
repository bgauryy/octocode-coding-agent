import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { listHistory } from "../../src/octocode/history/list.ts";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	archiveFolder,
	ownArchives,
	type Segment,
	setSessionLineage,
	writeSegment,
} from "../../src/octocode/history/archive.ts";
import { PARENT_SESSION_ENV } from "../../../common/src/env.ts";
import {
	historyFiles,
	historyScope,
	PAGE_CHARS,
	READ_LINES,
	readableHistory,
	readHistory,
	searchHistory,
} from "../../src/octocode/history/transcripts.ts";
import { sessionFolder, setCurrentSession } from "../../src/octocode/shared/home.ts";
import { tmp } from "./helpers.ts";
import { RECORD_FILE, type SessionRecord, writeSessionRecord } from "../../src/octocode/history/archive/record.ts";

function repo(): string {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	return cwd;
}

const segment = (session: string, tldr: string): Omit<Segment, "n"> => ({
	session,
	entry: `e-${session}`,
	tokensBefore: 1_000,
	method: "cache-shared",
	tldr,
	topics: [],
	readFiles: [],
	modifiedFiles: [],
	messages: 1,
});

const record = (session: string, cwd: string, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
	session,
	repository: registeredWorkspace(cwd).id,
	workspace: cwd,
	goal: { role: "user", text: `goal of ${session}` },
	ending: [{ role: "assistant", text: `${session} ended well` }],
	toolCalls: 0,
	...overrides,
});

/** Files `body` as a segment of `session`, and its record when `cwd` is given (`writeSegment` files under the current session). */
function session(
	id: string,
	options: { body?: string; tldr?: string; cwd?: string; record?: Partial<SessionRecord> } = {},
): void {
	setCurrentSession(id);
	if (options.body !== undefined) writeSegment(segment(id, options.tldr ?? `work of ${id}`), options.body);
	if (options.cwd) writeSessionRecord(record(id, options.cwd, options.record));
	setCurrentSession("me");
}

let saved: string | undefined;
beforeEach(() => {
	saved = process.env.OCTOCODE_HOME;
	process.env.OCTOCODE_HOME = tmp();
	setCurrentSession("me");
});
afterEach(() => {
	setCurrentSession(undefined);
	setSessionLineage([]);
	vi.unstubAllEnvs();
	if (saved === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = saved;
});

describe("history scope", () => {
	it("is this session, its fork sources, its parent, then the repository's sessions by last activity; never another repository's", () => {
		const cwd = repo();
		const elsewhere = repo();
		session("me", { body: "mine", cwd });
		session("source", { body: "before the fork" });
		session("boss", { body: "parent work" });
		session("older", { cwd, record: { lastActive: "2026-01-01T00:00:00Z" } });
		session("newer", { body: "sibling work", cwd, record: { lastActive: "2026-02-01T00:00:00Z" } });
		session("far", { body: "secret", cwd: elsewhere });
		session("empty", {});
		setSessionLineage(["source"]);
		vi.stubEnv(PARENT_SESSION_ENV, "boss");
		const scope = historyScope(cwd);
		expect(scope.map((entry) => [entry.id, entry.relation])).toEqual([
			["me", "this session"],
			["source", "forked from"],
			["boss", "parent session"],
			["newer", "same repository"],
			["older", "same repository"],
		]);
		expect(scope[0].record).toMatchObject({ session: "me", goal: "goal of me", ended: "me ended well" });
		// The record comes first, then segments newest first.
		expect(historyFiles(scope.slice(0, 1)).map((file) => path.basename(file.file))).toEqual([
			RECORD_FILE,
			expect.stringMatching(/^1-/),
		]);
	});

	it("makes a fork source's archive this session's own history (B155)", () => {
		session("source", { body: "before the fork" });
		expect(ownArchives()).not.toContain(archiveFolder("source"));
		setSessionLineage(["source"]);
		expect(ownArchives()).toContain(archiveFolder("source"));
	});
});

describe("what reads without asking", () => {
	it("is history of this session's own and of its repository's sessions, not another repository's, nor other session files", () => {
		const cwd = repo();
		session("me", { body: "mine" });
		session("sib", { body: "sibling", cwd });
		session("far", { body: "secret", cwd: repo() });
		session("source", { body: "forked" });
		setSessionLineage(["source"]);
		for (const id of ["me", "sib", "source"])
			expect(readableHistory(path.join(archiveFolder(id), RECORD_FILE), cwd), id).toBe(true);
		expect(readableHistory(path.join(archiveFolder("far"), RECORD_FILE), cwd)).toBe(false);
		expect(readableHistory(path.join(sessionFolder("output"), "x.txt"), cwd)).toBe(false);
		expect(readableHistory(path.join(cwd, "a.ts"), cwd)).toBe(false);
	});
});

describe("search and read", () => {
	it("refuses a 64 MiB archive before allocating or reading its contents", async () => {
		const file = path.join(tmp(), "oversized.md");
		const fd = fs.openSync(file, "w");
		fs.ftruncateSync(fd, 64 * 1024 * 1024);
		fs.closeSync(fd);
		const handle = await fs.promises.open(file, "r");
		const open = vi.spyOn(fs.promises, "open").mockResolvedValue(handle);
		const read = vi.spyOn(handle, "read");
		try {
			await expect(readHistory(file)).rejects.toThrow("Archive read exceeds 32 MiB");
			expect(read).not.toHaveBeenCalled();
		} finally {
			open.mockRestore();
			read.mockRestore();
		}
	});

	it("shows every hit with context, marks it, names the file and the session, shows a long hit line whole and points to a long context line", async () => {
		const cwd = repo();
		session("me", {
			body: [
				"alpha",
				"one",
				"two",
				"needle here",
				"three",
				`${"x".repeat(600)} needle far`,
				"end",
				"z".repeat(900),
				"four",
				"five",
				"six",
				"last needle",
			].join("\n"),
			cwd,
		});
		const files = historyFiles(historyScope(cwd));
		const found = await searchHistory(files, /needle/i);
		expect(found).toMatchObject({ hits: 3, files: 1, page: 1, pages: 1 });
		expect(found.text).toMatch(/^## .*1-e-me\.md · me \(this session\) · segment 1 · work of me$/m);
		expect(found.text).toMatch(/^> +\d+│ needle here$/m);
		expect(found.text).toMatch(/^ +\d+│ two$/m);
		expect(found.text).toMatch(new RegExp(`^> +\\d+│ ${"x".repeat(600)} needle far$`, "m"));
		expect(found.text).toMatch(
			/^ +25│ \[a context line of 900 characters, not a hit: read it with file and line 25\]$/m,
		);
		expect(found.text).not.toContain("z".repeat(10));
		expect(found.text).not.toContain("cut");
	});

	it("pages a large result so every hit is reached exactly once", async () => {
		const cwd = repo();
		const body = Array.from({ length: 2_000 }, (_, index) => `line ${index} hit ${"y".repeat(40)}`).join("\n");
		session("me", { body, cwd });
		const files = historyFiles(historyScope(cwd));
		const first = await searchHistory(files, /hit/);
		expect(first.pages).toBeGreaterThan(1);
		const seen: string[] = [];
		for (let page = 1; page <= first.pages; page++) {
			const text = (await searchHistory(files, /hit/, page)).text;
			expect(text.length).toBeLessThanOrEqual(PAGE_CHARS + 200);
			seen.push(
				...text
					.split("\n")
					.filter((line) => line.startsWith(">"))
					.map((line) => line.replace(/^>\s*(\d+)│.*$/, "$1")),
			);
		}
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen.length).toBe(first.hits);
	});

	it("reads a window of whole lines and says where the next one starts", async () => {
		const cwd = repo();
		session("me", { body: Array.from({ length: 300 }, (_, index) => `row ${index}`).join("\n"), cwd });
		const file = historyFiles(historyScope(cwd)).find((entry) => entry.label.startsWith("segment"))!.file;
		const read = (await readHistory(file, 10))!;
		expect(read).toMatchObject({ first: 10, last: 10 + READ_LINES - 1, page: 1, pages: 1 });
		expect(read.text.split("\n")[0]).toMatch(/^ +10│ /);
		expect(await readHistory(path.join(archiveFolder(), "missing.md"))).toBeUndefined();
	});

	it("lists one line per session, with subagent sessions counted on their parent's line", () => {
		const cwd = repo();
		session("me", { body: "mine", tldr: "did the thing", cwd, record: { lastActive: "2026-03-01T00:00:00Z" } });
		session("lead", { body: "lead work", cwd, record: { lastActive: "2026-02-01T00:00:00Z" } });
		session("child-1", { body: "child work", cwd, record: { parent: "lead", lastActive: "2026-02-02T00:00:00Z" } });
		session("child-2", { cwd, record: { parent: "lead", lastActive: "2026-02-03T00:00:00Z" } });
		const listed = listHistory(historyScope(cwd));
		expect(listed.head).toContain(
			"4 sessions with history, nearest first; 2 subagent sessions counted on their parent's line",
		);
		expect(listed.text).toContain(
			"- me (this session) · last active 2026-03-01T00:00:00Z · goal: goal of me · 1 segment",
		);
		// The ending is in the session's own listing; the index pages by sessions.
		expect(listed.text).not.toContain("ended:");
		const paged = listHistory(historyScope(cwd), 2, undefined, 1);
		expect(paged).toMatchObject({ page: 2, pages: 2 });
		expect(paged.text).toMatch(/^- lead /);
		expect(listed.text).toMatch(/- lead \(same repository\) · .* · 1 segment · 2 subagent sessions$/m);
		expect(listed.text).not.toContain("child-1");
		// The index names no files: they are listed per session.
		expect(listed.text).not.toContain(RECORD_FILE);
	});

	it("lists one session's files and its subagent sessions by sessionId", () => {
		const cwd = repo();
		session("me", { body: "mine", tldr: "did the thing", cwd, record: { lastActive: "2026-03-01T00:00:00Z" } });
		session("child-1", { body: "child work", cwd, record: { parent: "me" } });
		const own = listHistory(historyScope(cwd), 1, "current");
		expect(own.text).toContain(`## me (this session) · ${archiveFolder()}`);
		expect(own.text).toContain("last active 2026-03-01T00:00:00Z · goal: goal of me · ended: me ended well");
		expect(own.text).toContain(`- ${RECORD_FILE} · record: goal and ending`);
		expect(own.text).toMatch(/- 1-e-me\.md · segment 1 · did the thing/);
		// A child of this session is a "same repository" session counted under it.
		expect(own.text).toMatch(/## Subagent sessions\n- child-1 \(same repository\)/);
		expect(() => listHistory(historyScope(cwd), 1, "nobody")).toThrow(/No session nobody/);
	});
});
