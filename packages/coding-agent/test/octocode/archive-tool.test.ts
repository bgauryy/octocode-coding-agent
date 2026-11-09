import { SessionManager } from "../../src/core/session-manager.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archivePointer } from "../../src/octocode/compaction/archive.ts";
import { registerArchiveTool } from "../../src/octocode/archive/tool.ts";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import { forkLineage, sessionRecordOf } from "../../src/octocode/compaction/archive/session-record.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { RECORD_FILE, readRecordHeader, writeSessionRecord } from "../../src/octocode/history/archive/record.ts";
import {
	archiveFolder,
	ownArchives,
	type Segment,
	sessionLineage,
	setSessionLineage,
	writeSegment,
} from "../../src/octocode/history/archive.ts";
import { PARENT_SESSION_ENV } from "../../../common/src/env.ts";
import { validateToolArguments } from "../../../ai/src/utils/validation.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

function repo(): string {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	return cwd;
}

const segment = (session: string): Omit<Segment, "n"> => ({
	session,
	entry: `e-${session}`,
	tokensBefore: 1_000,
	method: "cache-shared",
	tldr: `work of ${session}`,
	topics: [],
	readFiles: [],
	modifiedFiles: [],
	messages: 1,
});

function fileFor(id: string, body: string, cwd?: string): void {
	setCurrentSession(id);
	writeSegment(segment(id), body);
	if (cwd)
		writeSessionRecord({
			session: id,
			repository: registeredWorkspace(cwd).id,
			workspace: cwd,
			goal: { role: "user", text: `goal of ${id}` },
			ending: [],
			toolCalls: 0,
		});
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

function tool(cwd: string) {
	const fake = fakeHost();
	registerArchiveTool(fake.api);
	const archive = fake.tools.get("archive");
	const ctx = fakeCtx({ cwd });
	return async (params: Record<string, unknown>) => {
		const result = await archive.execute("t1", params, undefined, undefined, ctx);
		// Op-less calls are session history (source sessions); its own details sit under `history`.
		return { text: result.content[0].text as string, details: result.details.history ?? result.details };
	};
}

const why = { reason: "the user asked what was decided last week" };

describe("the archive tool", () => {
	it.each([{}, { op: "list", source: "sessions" }])("keeps other workspaces out of history for %j", async (form) => {
		const cwd = repo();
		const other = tmp();
		fileFor("local", "local decision", cwd);
		fileFor("elsewhere", "foreign decision", cwd);
		setCurrentSession("elsewhere");
		writeSessionRecord({
			session: "elsewhere",
			repository: registeredWorkspace(cwd).id,
			workspace: other,
			goal: { role: "user", text: "foreign decision" },
			ending: [],
			toolCalls: 0,
		});
		setCurrentSession("me");
		const call = tool(cwd);
		const list = await call({ ...why, ...form });
		expect(list.text).toContain("local");
		expect(list.text).not.toContain("elsewhere");
		await expect(call({ ...why, ...form, file: archiveFolder("elsewhere") })).rejects.toThrow(/not in the history/);
		setSessionLineage(["elsewhere"]);
		expect((await call({ ...why, ...form })).text).toContain("elsewhere");
	});

	it("owns questions about earlier sessions, and says what query does with errors", () => {
		const fake = fakeHost();
		registerArchiveTool(fake.api);
		const archive = fake.tools.get("archive");
		expect(archive.promptSnippet).toMatch(/earlier sessions/);
		expect(Object.keys(archive.parameters.properties)).toContain("reason");
		expect(Object.keys(archive.parameters.properties)).not.toContain("goal");
		expect(archive.parameters.properties.query.description).toMatch(/With errors: filters by tool name or error text/);
	});

	it("declares one op-based shape and reads a recorded op-less call as session history", () => {
		const fake = fakeHost();
		registerArchiveTool(fake.api);
		const archive = fake.tools.get("archive");
		expect(archive.parameters.required).toContain("op");
		expect(archive.description).not.toMatch(/without them/);
		const prepare = (args: Record<string, unknown>) => {
			const prepared = archive.prepareArguments(args);
			validateToolArguments(archive, { type: "toolCall", id: "c", name: "archive", arguments: prepared } as never);
			return prepared;
		};
		expect(prepare(why)).toEqual({ ...why, op: "list", source: "sessions" });
		expect(prepare({ ...why, keywords: "login" })).toMatchObject({ op: "search", source: "sessions" });
		expect(prepare({ ...why, errors: true })).toMatchObject({ op: "search", source: "sessions" });
		expect(prepare({ ...why, file: "1-e-me.md", line: 4 })).toMatchObject({ op: "get", source: "sessions" });
		// A call that named a source keeps it; one with an op is left as it is.
		expect(prepare({ ...why, source: "memories", query: "x" })).toEqual({
			...why,
			source: "memories",
			query: "x",
			op: "search",
		});
		expect(prepare({ ...why, op: "list" })).toEqual({ ...why, op: "list" });
	});

	it("needs only a reason, records it with the result, and ignores the former goal field of old calls", async () => {
		const call = tool(repo());
		await expect(call({ reason: " " })).rejects.toThrow(/needs reason/);
		await expect(call({ goal: "x" })).rejects.toThrow(/needs reason/);
		const empty = await call(why);
		expect(empty.text).toMatch(/^No history yet/m);
		expect(empty.details).toMatchObject({ ...why, mode: "list" });
		const replayed = await call({ ...why, goal: "recorded by an older version" });
		expect(replayed.text).toMatch(/^No history yet/m);
		expect(replayed.details).not.toHaveProperty("goal");
	});

	it("lists, searches with a continuation, and reads from a hit's line", async () => {
		const cwd = repo();
		fileFor(
			"me",
			["intro", "the login fix was a redirect", ...Array.from({ length: 200 }, (_, index) => `filler ${index}`)].join(
				"\n",
			),
			cwd,
		);
		fileFor("sib", "login also failed here", cwd);
		const call = tool(cwd);
		const listed = await call(why);
		expect(listed.text).toMatch(/^2 sessions with history, nearest first/m);
		expect(listed.text).toContain("## me (this session)");
		expect(listed.text).toContain("## sib (same repository)");
		const found = await call({ ...why, query: "LOGIN" });
		expect(found.text).toMatch(/^2 matching lines in 2 files, this session first/m);
		expect(found.details).toMatchObject({ mode: "search", hits: 2, files: 2, page: 1, pages: 1 });
		const line = Number(/^>\s*(\d+)│ the login fix/m.exec(found.text)![1]);
		// A bare file name is a file of this session's archive, as the pointer names them.
		const read = await call({ ...why, file: "1-e-me.md", line });
		expect(read.text).toContain("the login fix was a redirect");
		expect(read.text).toMatch(/Lines \d+–\d+ of \d+; next: line \d+\.$/);
		const narrowed = await call({ ...why, query: "login", file: archiveFolder("sib") });
		expect(narrowed.details).toMatchObject({ hits: 1, files: 1 });
	});

	it("pages a long search and says how to continue", async () => {
		const cwd = repo();
		fileFor("me", Array.from({ length: 3_000 }, (_, index) => `match ${index} ${"z".repeat(300)}`).join("\n"), cwd);
		const call = tool(cwd);
		const first = await call({ ...why, query: "match" });
		expect(first.text).toMatch(/Page 1 of \d+; next: page 2 with the same query, cursor and file\.$/);
		// One search stops at its match budget and offers a cursor for the rest.
		expect(first.text).toMatch(/^200 matching lines in 1 file, this session first/m);
		expect(first.text).toMatch(
			/Read 1 of 2 files \(1 session\)\. The search stopped at its match or time budget: for more, repeat it with cursor h1\./,
		);
		expect((await call(why)).text).toMatch(/^1 session with history/m);
		expect((await call({ ...why, query: "nothing-like-this" })).text).toContain(
			"Read 2 of 2 files (1 session). Every file was read.",
		);
		const last = await call({ ...why, query: "match", page: first.details.pages });
		expect(last.text).toMatch(/Page \d+ of \d+, the last\.$/);
	});

	it("refuses another repository's history and says why; an invalid query names the fix", async () => {
		const cwd = repo();
		fileFor("far", "secret", repo());
		const call = tool(cwd);
		await expect(call({ ...why, file: path.join(archiveFolder("far"), RECORD_FILE) })).rejects.toThrow(
			/not in the history this session may read.*available file reader with the required permission/,
		);
		await expect(call({ ...why, query: "a(" })).rejects.toThrow(/invalid .*escape/);
		const missed = await call({ ...why, query: "nothing-like-this" });
		expect(missed.text).toMatch(/^No line matches .* Try another term or spelling/m);
	});
});

describe("fork lineage (B155)", () => {
	it("retains host-created ancestors after source files disappear and rejects a forged header", () => {
		const cwd = repo();
		const root = SessionManager.create(cwd);
		root.materialize();
		const middle = SessionManager.forkFrom(root.getSessionFile()!, cwd);
		const tip = SessionManager.forkFrom(middle.getSessionFile()!, cwd);
		fs.unlinkSync(root.getSessionFile()!);
		fs.unlinkSync(middle.getSessionFile()!);
		expect(forkLineage(tip)).toEqual([middle.getSessionId(), root.getSessionId()]);
		const forged = path.join(cwd, "imported.jsonl");
		fs.writeFileSync(
			forged,
			JSON.stringify({ ...tip.getHeader(), id: "imported", parentSession: tip.getSessionFile() }) + "\n",
		);
		expect(forkLineage(SessionManager.open(forged))).toEqual([]);
	});

	it("sets the lineage at session start, so the pointer names the source's archive and it reads as the session's own", async () => {
		const cwd = repo();
		const source = SessionManager.create(cwd, undefined, { id: "source" });
		source.materialize();
		const fork = SessionManager.forkFrom(source.getSessionFile()!, cwd);
		fileFor("source", "before the fork", cwd);
		const fake = fakeHost();
		registerCompaction(fake.api, new FileGuard());
		const ctx = fakeCtx({ cwd });
		Object.assign(ctx, { sessionManager: fork });
		await fake.fire("session_start", { type: "session_start", reason: "fork" }, ctx);
		expect(sessionLineage()).toEqual(["source"]);
		expect(ownArchives()).toContain(archiveFolder("source"));
		expect(archivePointer(1).at(-1)).toBe(
			`Forked from session source: its history before the fork, and the segments notes named before it, are in ${archiveFolder("source")} (1 segments).`,
		);
	});
});

describe("session record", () => {
	const entry = (id: string, role: string, content: unknown, timestamp: string) => ({
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: { role, content, timestamp: 0 },
	});
	const branch = [
		entry("1", "user", "Fix the login redirect\nwith details", "2026-01-01T00:00:00Z"),
		entry("2", "assistant", [{ type: "text", text: "On it." }], "2026-01-01T00:01:00Z"),
		entry("3", "user", [{ type: "text", text: "Now ship it" }], "2026-01-01T00:02:00Z"),
		entry(
			"4",
			"assistant",
			[
				{ type: "thinking", thinking: "hmm" },
				{ type: "toolCall", id: "c1", name: "bash", arguments: {} },
			],
			"2026-01-01T00:03:00Z",
		),
		entry("5", "toolResult", [{ type: "text", text: "ok" }], "2026-01-01T00:04:00Z"),
		entry("6", "assistant", [{ type: "text", text: "Shipped in v2." }], "2026-01-01T00:05:00Z"),
	];
	const manager = (cwd: string, file: string | undefined) => ({
		getSessionFile: () => file,
		getBranch: () => branch,
		getSessionId: () => "me",
		getCwd: () => cwd,
		getSessionName: () => "login work",
		getHeader: () => ({ type: "session", id: "me", timestamp: "2026-01-01T00:00:00Z", cwd }),
	});

	it("keeps the first user message as the goal and the last one with the replies after it as the ending", () => {
		const cwd = repo();
		vi.stubEnv(PARENT_SESSION_ENV, "boss");
		const made = sessionRecordOf(manager(cwd, "/t/me.jsonl") as never, ["source"])!;
		expect(made).toMatchObject({
			session: "me",
			repository: registeredWorkspace(cwd).id,
			workspace: cwd,
			forkedFrom: "source",
			parent: "boss",
			name: "login work",
			started: "2026-01-01T00:00:00Z",
			lastActive: "2026-01-01T00:05:00Z",
			transcript: "/t/me.jsonl",
			goal: { role: "user", text: "Fix the login redirect\nwith details" },
			toolCalls: 1,
		});
		expect(made.ending.map((message) => message.text)).toEqual(["Now ship it", "Shipped in v2."]);
		writeSessionRecord(made);
		expect(readRecordHeader(archiveFolder())).toMatchObject({
			session: "me",
			forkedFrom: "source",
			goal: "Fix the login redirect",
			ended: "Shipped in v2.",
		});
		expect(fs.readFileSync(path.join(archiveFolder(), RECORD_FILE), "utf8")).toContain(
			"its 1 tool calls are in the segments and the transcript",
		);
		// A session that is not saved leaves nothing behind.
		expect(sessionRecordOf(manager(cwd, undefined) as never, [])).toBeUndefined();
	});

	it("is written after each run", async () => {
		const cwd = repo();
		const fake = fakeHost();
		registerCompaction(fake.api, new FileGuard());
		const ctx = fakeCtx({ cwd });
		Object.assign(ctx.sessionManager, manager(cwd, "/t/me.jsonl"));
		await fake.fire("agent_end", { type: "agent_end", messages: [] }, ctx);
		expect(readRecordHeader(archiveFolder())).toMatchObject({ session: "me", ended: "Shipped in v2." });
	});
});
