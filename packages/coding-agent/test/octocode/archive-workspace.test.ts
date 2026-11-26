import { registeredWorkspace, workspaceDb } from "../../src/storage/workspace-database.ts";
import { HistoryRepair } from "../../src/octocode/archive/repair.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeSharedAgentDb, compactions, agentEvents } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registerArchiveTool } from "../../src/octocode/native/tools/archive/tool.ts";
import { saveCompaction } from "../../src/octocode/archive/summaries.ts";
import { expireArchiveDetails, mayRemoveArchive } from "../../src/octocode/archive/retention.ts";
import { registerMemory } from "../../src/octocode/memory/register.ts";
import { memoryStore, MemoryStore } from "../../src/octocode/memory/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { archiveFolder, setSessionLineage, writeSegment } from "../../src/octocode/history/archive.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { planningRefusal } from "../../src/octocode/plan/gate.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { readRecords } from "../../src/octocode/archive/reads.ts";
import { readMemories } from "../../src/octocode/memory/reads.ts";
import type { CompactionEntry } from "../../src/core/session-manager.ts";

let root: string;
const entry: CompactionEntry = {
	id: "compact-1",
	type: "compaction",
	parentId: null,
	timestamp: "2025-01-01T00:00:00.000Z",
	summary: "Keep the complete indigo recovery decision",
	firstKeptEntryId: "kept",
	tokensBefore: 100,
};
beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "archive-workspace-")));
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
	setCurrentSession("session-a", root);
	setSessionLineage([]);
});
afterEach(() => {
	setCurrentSession(undefined);
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

it("shares explicit project notes and isolates default workspace notes", async () => {
	const db = sharedAgentDb();
	const project = new MemoryStore(db, root);
	const old = project.set({ title: "shared project decision", author: "user" }).memory;
	const workspace = memoryStore(root);
	const note = workspace.set({ title: "workspace-only preference", author: "user" }).memory;
	const other = path.join(root, "other");
	fs.mkdirSync(path.join(other, ".git"), { recursive: true });
	expect(note.scope).toBe("workspace");
	expect(workspace.get(old.id)?.scope).toBe("project");
	expect(memoryStore(root).get(note.id)?.title).toBe(note.title);
	const sibling = memoryStore(other);
	expect(sibling.get(note.id)).toBeUndefined();
	expect(sibling.updatedAt([note.id])).toEqual(new Map());
	await sibling.markUsed([note.id]);
	expect(workspace.get(note.id)?.useCount).toBe(0);
	expect(project.get(note.id)).toBeUndefined();
	expect(() => project.delete(note.id)).toThrow("No memory");
});

it("exposes two tools and retains scoped write checks and plan classification", async () => {
	const fake = fakeHost();
	registerMemory(fake.api, {
		commands: new Subcommands(),
		isSubagent: false,
		permission: fakePermission(),
	});
	registerArchiveTool(fake.api);
	expect([...fake.tools.keys()]).toEqual(["memory", "archive"]);
	const ctx = fakeCtx({ cwd: root });
	const run = (name: string, input: object) =>
		fake.tools
			.get(name)
			.execute("call", { goal: "remember", reason: "user preference", ...input }, undefined, undefined, ctx);
	// A memory operation sent to `archive` is refused with the `memory` call to make, whatever source it names.
	await expect(run("archive", { op: "set", source: "events", title: "bad" })).rejects.toThrow(
		'archive no longer reads or writes memories: call the memory tool with op "set".',
	);
	expect(memoryStore(root).count()).toBe(0);
	expect((await run("memory", { op: "set", title: "remember amber" })).content[0].text).toMatch(/Saved M1 \(workspace/);
	const broken = path.join(root, "broken.jsonl");
	fs.writeFileSync(broken, "invalid old transcript");
	Object.assign(ctx.sessionManager, { getSessionFile: () => broken });
	expect((await run("memory", { op: "get", id: "M1" })).content[0].text).toContain("remember amber");
	const definition = { sourceInfo: { owner: "native" } } as Parameters<typeof planningRefusal>[1];
	expect(planningRefusal({ toolName: "archive", input: { op: "get" } }, definition)).toBeUndefined();
	for (const op of ["get", "list", "search"])
		expect(planningRefusal({ toolName: "memory", input: { op } }, definition)).toBeUndefined();
	for (const input of [{ op: "set" }, { op: "delete" }, {}])
		expect(planningRefusal({ toolName: "memory", input }, definition)).toContain("blocks memory");
	expect(planningRefusal({ toolName: "archive", input: { op: "set", source: "memories" } }, definition)).toContain(
		"blocks archive",
	);
});

it("retains searchable complete summaries after expiry and does not resurrect detail copies", async () => {
	const db = sharedAgentDb();
	const folder = archiveFolder("session-a");
	fs.mkdirSync(folder, { recursive: true });
	const detail = path.join(folder, "1-compact-1.md");
	fs.writeFileSync(detail, "detailed messages");
	saveCompaction(db, root, "session-a", entry);
	await expireArchiveDetails(db, { ...process.env, OCTOCODE_CLEANUP_DAYS: "0" }, Date.parse("2026-01-01"));
	expect(fs.existsSync(detail)).toBe(true);
	await expireArchiveDetails(db, { ...process.env, OCTOCODE_CLEANUP_DAYS: "30" }, Date.parse("2026-01-01"));
	expect(fs.existsSync(detail)).toBe(false);
	expect(compactions.get(db.mirror.db, "session-a", entry.id)).toMatchObject({
		summary: entry.summary,
		detailState: "expired",
	});
	saveCompaction(db, root, "session-a", entry, { recovered: true });
	expect(compactions.get(db.mirror.db, "session-a", entry.id)?.detailState).toBe("expired");
	expect(
		agentEvents
			.list(workspaceDb(root).agent.db, workspaceDb(root).workspace.id)
			.filter((row) => row.type === "compaction"),
	).toHaveLength(1);
	expect(await mayRemoveArchive(db, folder, process.env, Date.parse("2026-01-01"))).toBe(false);
	const fake = fakeHost();
	registerArchiveTool(fake.api);
	const result = await fake.tools
		.get("archive")
		.execute(
			"call",
			{ goal: "recover", reason: "past decision", op: "search", source: "compactions", query: "indigo" },
			undefined,
			undefined,
			fakeCtx({ cwd: root }),
		);
	expect(result.content[0].text).toContain("complete indigo recovery decision");
	expect(result.content[0].text).toContain("expired");
});

it("indexes inherited compactions at their origin without duplicate fork events", async () => {
	const parent = path.join(root, "parent.jsonl"),
		fork = path.join(root, "fork.jsonl");
	const header = { type: "session", version: 3, id: "parent", cwd: root, timestamp: entry.timestamp };
	fs.writeFileSync(parent, [header, entry].map((row) => JSON.stringify(row)).join("\n") + "\n");
	fs.writeFileSync(
		fork,
		[{ ...header, id: "fork", parentSession: parent }, entry].map((row) => JSON.stringify(row)).join("\n") + "\n",
	);
	const db = sharedAgentDb();
	registeredWorkspace(root, db);
	await new HistoryRepair(db).transcript(fork);
	await new HistoryRepair(db).transcript(fork);
	expect(compactions.forSession(db.mirror.db, "parent")).toHaveLength(1);
	expect(compactions.forSession(db.mirror.db, "fork")).toHaveLength(0);
	expect(agentEvents.list(workspaceDb(root).agent.db, workspaceDb(root).workspace.id)).toHaveLength(1);
});

it("does not create a workspace in the directory named by an imported transcript", async () => {
	const other = fs.mkdtempSync(path.join(root, "unregistered-"));
	fs.mkdirSync(path.join(other, ".git"));
	const file = path.join(root, "imported.jsonl");
	const header = { type: "session", id: "imported", cwd: other };
	fs.writeFileSync(file, [header, entry].map((record) => JSON.stringify(record)).join("\n") + "\n");
	const db = sharedAgentDb();
	await new HistoryRepair(db).transcript(file);
	expect(fs.existsSync(path.join(other, ".octocode"))).toBe(false);
	expect(compactions.forSession(db.mirror.db, header.id)).toEqual([]);
});

it("refuses foreign transcript pointers in an archive record and fork header", async () => {
	const db = sharedAgentDb();
	const current = registeredWorkspace(root, db);
	const foreign = fs.mkdtempSync(path.join(root, "worktree-"));
	fs.mkdirSync(path.join(foreign, ".git"));
	registeredWorkspace(foreign, db);
	const named = path.join(foreign, "foreign.jsonl");
	const imported = { type: "session", id: "victim", cwd: foreign };
	fs.writeFileSync(named, [imported, entry].map((row) => JSON.stringify(row)).join("\n") + "\n");
	const folder = archiveFolder("victim", process.env, root);
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(
		path.join(folder, "SESSION.md"),
		["- Session: victim", `- Repository: ${current.id}`, `- Workspace: ${root}`, `- Transcript: ${named}`].join("\n"),
	);
	const repair = new HistoryRepair(db);
	await repair.archive(folder);
	const child = path.join(root, "child.jsonl");
	fs.writeFileSync(
		child,
		[
			{ ...imported, id: "child", cwd: root, parentSession: named },
			{ ...entry, id: "local" },
		]
			.map((row) => JSON.stringify(row))
			.join("\n") + "\n",
	);
	await repair.transcript(child);
	expect(compactions.forSession(db.mirror.db, "victim")).toEqual([]);
	expect(compactions.get(db.mirror.db, "child", "local")?.originVerified).toBe(false);
});

it("finds an old lifecycle event beyond 50 in one search, since a query tests every record", async () => {
	for (let i = 0; i < 65; i++)
		workspaceDb(root).agent.transaction(() =>
			agentEvents.append(workspaceDb(root).agent.db, workspaceDb(root).workspace.id, {
				id: `event-${i}`,
				time: entry.timestamp,
				name: "agent",
				parentId: null,
				sessionId: "session-a",
				type: "init",
				data: { agentId: "agent", note: i === 0 ? "oldest-needle" : "recent" },
				version: 1,
			}),
		);
	const found = await readRecords(root, {
		source: "events",
		op: "search",
		query: "oldest-needle",
		agentId: "agent",
		limit: 10,
	});
	expect(found.text).toContain("event:event-0");
	expect(found.text).toContain("events: 1 match in 65 records searched (every record)");
	// Every record was searched: no cursor promises more.
	expect(found.cursor).toBeUndefined();
	const many = await readRecords(root, { source: "events", op: "search", query: "recent", agentId: "agent", limit: 3 });
	expect(many.text).toContain("events: 3 matches in ");
	// A listing still pages: 10 of 65, then a cursor.
	const listed = await readRecords(root, { source: "events", op: "list", agentId: "agent", limit: 10 });
	expect(listed.hits).toBe(10);
	expect(listed.cursor).toBeDefined();
	expect((await readRecords(root, { source: "events", agentId: "another" })).hits).toBe(0);
});

it("lists pins first, pages every memory and does not count a list as use", async () => {
	const store = memoryStore(root);
	const pin = store.set({ title: "Pinned policy", pinned: true, author: "user" }, 1).memory;
	store.set({ title: "Unpinned preference", author: "user" }, 2);
	const first = await readMemories(store, { op: "list", limit: 1 });
	expect(first.text).toContain(`M${pin.id}\n`);
	expect(first.cursor).toBeDefined();
	const next = await readMemories(store, { op: "list", limit: 1, cursor: first.cursor });
	expect(next.text).toContain("Unpinned preference");
	expect(next.cursor).toBeUndefined();
	expect(store.get(pin.id)?.useCount).toBe(0);
});

it("preserves details with an unknown committed time and obeys configured retention", async () => {
	const db = sharedAgentDb();
	const folder = archiveFolder("session-a");
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(path.join(folder, "1-unknown.md"), "unknown time");
	saveCompaction(db, root, "session-a", { ...entry, id: "unknown", timestamp: "unknown" });
	const file = path.join(folder, "2-known.md");
	fs.writeFileSync(file, "known time");
	saveCompaction(db, root, "session-a", { ...entry, id: "known" });
	const now = Date.parse(entry.timestamp) + 40 * 86_400_000;
	await expireArchiveDetails(db, { ...process.env, OCTOCODE_CLEANUP_DAYS: "60" }, now);
	expect(fs.existsSync(file)).toBe(true);
	await expireArchiveDetails(db, { ...process.env, OCTOCODE_CLEANUP_DAYS: "30" }, now);
	expect(fs.existsSync(file)).toBe(false);
	expect(fs.existsSync(path.join(folder, "1-unknown.md"))).toBe(true);
});

it("uses the full memory index and summary corpus for keyword search, including old matches", async () => {
	const db = sharedAgentDb();
	const store = memoryStore(root);
	store.set({ title: "Ancient cobalt decision", author: "user" }, 1);
	for (let i = 0; i < 55; i++) {
		store.set({ title: `Unique r${i}z policy`, author: "user" }, i + 2);
		saveCompaction(
			db,
			root,
			"session-a",
			{ ...entry, id: `entry-${i}`, summary: i === 0 ? "old cobalt summary" : `Unrelated material ${i}` },
			{ detail: null },
		);
	}
	const memory = await readMemories(store, { op: "search", keywords: "cobalt", limit: 1 });
	expect(memory.text).toContain("Ancient cobalt decision");
	const summaries = await readRecords(root, { source: "compactions", op: "search", keywords: "cobalt", limit: 1 });
	expect(summaries.text).toContain("old cobalt summary");
	const sessions = await readRecords(root, { source: "sessions", op: "list" });
	expect(sessions.text).toContain("session:session-a");
	// The index holds sessions with a compaction, not every session the history part counts: its line says so.
	expect(sessions.text).toMatch(/^sessions with a compaction: 1 record/);
	const found = await readRecords(root, { source: "sessions", op: "search", keywords: "session-a" });
	expect(found.text).toMatch(/^sessions with a compaction: 1 match in 1 record searched/);
});

it("repairs archive files in their workspace when another home or workspace is active", async () => {
	const db = sharedAgentDb();
	const env = { ...process.env, OCTOCODE_HOME: path.join(root, "alternate-home"), OCTOCODE_CLEANUP_DAYS: "1" };
	const folder = archiveFolder("configured-home", env);
	fs.mkdirSync(folder, { recursive: true });
	const detail = path.join(folder, `1-${entry.id}.md`);
	fs.writeFileSync(detail, "old detail");
	saveCompaction(db, root, "configured-home", entry, { env });
	await expireArchiveDetails(db, env, Date.parse("2026-01-01"));
	expect(fs.existsSync(detail)).toBe(false);
	expect(fs.readFileSync(path.join(folder, "LIBRARY.md"), "utf8")).toContain("detail: expired");
	const other = fs.mkdtempSync(path.join(root, "other-"));
	fs.mkdirSync(path.join(other, ".git"));
	setCurrentSession("other", other);
	expect(fs.existsSync(archiveFolder("configured-home"))).toBe(false);
	expect(fs.existsSync(path.join(env.OCTOCODE_HOME, "agent", "sessions", "configured-home"))).toBe(false);
});

it("uses the configured memory store for both memory writes and reads", async () => {
	const fake = fakeHost();
	registerMemory(fake.api, {
		commands: new Subcommands(),
		isSubagent: false,
		permission: fakePermission(),
		env: { ...process.env, OCTOCODE_AGENT_DB: path.join(root, "configured.db") },
	});
	const run = (params: object) =>
		fake.tools.get("memory").execute(
			"call",
			{
				goal: "Remember a rule",
				reason: "User preference",
				...params,
			},
			undefined,
			undefined,
			fakeCtx({ cwd: root }),
		);
	await run({ op: "set", title: "Configured cobalt rule" });
	expect((await run({ op: "get", id: "M1" })).content[0].text).toContain("Configured cobalt rule");
	expect((await run({ op: "search", keywords: "cobalt" })).content[0].text).toContain("Configured cobalt rule");
	expect(memoryStore(root).count()).toBe(0);
});

it("compares event time filters as instants, with inclusive timezone boundaries", async () => {
	for (const [id, time] of [
		["before", "2025-12-31T22:59:59.999Z"],
		["start", "2025-12-31T23:00:00.000Z"],
		["middle", "2025-12-31T23:30:00.000Z"],
		["end", "2026-01-01T00:00:00.000Z"],
		["after", "2026-01-01T00:00:00.001Z"],
	])
		agentEvents.append(workspaceDb(root).agent.db, workspaceDb(root).workspace.id, {
			id,
			time,
			name: "agent",
			parentId: null,
			sessionId: "session-a",
			type: "init",
			data: {},
			version: 1,
		});
	const result = await readRecords(root, {
		source: "events",
		since: "2026-01-01T01:00:00+02:00",
		until: "2025-12-31T19:00:00-05:00",
	});
	expect(result.hits).toBe(3);
	for (const id of ["start", "middle", "end"]) expect(result.text).toContain(`event:${id}`);
	for (const id of ["before", "after"]) expect(result.text).not.toContain(`event:${id}`);
});

it("propagates cancellation during the final recovery read before returning a record", async () => {
	const transcript = path.join(root, "cancel.jsonl");
	fs.writeFileSync(transcript, JSON.stringify({ type: "session", id: "session-a", version: 3, cwd: root }) + "\n");
	saveCompaction(sharedAgentDb(), root, "session-a", entry);
	const fake = fakeHost();
	registerArchiveTool(fake.api);
	const controller = new AbortController();
	const open = fs.promises.open.bind(fs.promises);
	const spy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
		const handle = await open(...args);
		queueMicrotask(() => controller.abort());
		return handle;
	});
	const ctx = fakeCtx({ cwd: root });
	Object.assign(ctx.sessionManager, { getSessionFile: () => transcript });
	try {
		await expect(
			fake.tools
				.get("archive")
				.execute(
					"cancel",
					{ goal: "recover", reason: "prior decision", op: "get", id: "compaction:session-a:compact-1" },
					controller.signal,
					undefined,
					ctx,
				),
		).rejects.toThrow(/abort/i);
		expect(spy).toHaveBeenCalledTimes(1);
	} finally {
		spy.mockRestore();
	}
});

it("says in the text of a paged get which page it is and how to read the next", async () => {
	const long = { ...entry, id: "long", summary: "indigo ".repeat(4_300) };
	saveCompaction(sharedAgentDb(), root, "session-a", long, { detail: null });
	saveCompaction(sharedAgentDb(), root, "session-a", entry, { detail: null });
	const fake = fakeHost();
	registerArchiveTool(fake.api);
	const get = async (id: string, cursor?: string) => {
		const result = await fake.tools
			.get("archive")
			.execute(
				"call",
				{ reason: "past decision", op: "get", id, cursor },
				undefined,
				undefined,
				fakeCtx({ cwd: root }),
			);
		return { text: result.content[0].text as string, cursor: result.details.nextCursor as string | undefined };
	};
	const first = await get("compaction:session-a:long");
	expect(first.text).toMatch(
		/\n\nPage 1 of 3\.\n\nMore remains: call again with cursor a2\.\S+ and the same other arguments\.$/,
	);
	const second = await get("compaction:session-a:long", first.cursor);
	expect(second.text).toContain("Page 2 of 3.");
	const last = await get("compaction:session-a:long", second.cursor);
	expect(last.text).toMatch(/\n\nPage 3 of 3\.$/);
	expect(last.cursor).toBeUndefined();
	// A record that fits one page says nothing about pages.
	expect((await get(`compaction:session-a:${entry.id}`)).text).not.toMatch(/Page \d/);
});

it("gives one cursor when records and session history both continue, and neither repeats", async () => {
	const db = sharedAgentDb();
	for (const id of ["first", "second", "third"])
		saveCompaction(db, root, "session-a", { ...entry, id, summary: `needle summary ${id}` }, { detail: null });
	writeSegment(
		{
			session: "session-a",
			entry: "e-session-a",
			tokensBefore: 1_000,
			method: "cache-shared",
			tldr: "work",
			topics: [],
			readFiles: [],
			modifiedFiles: [],
			messages: 1,
		},
		Array.from({ length: 3_000 }, (_, index) => `needle line ${index} ${"z".repeat(300)}`).join("\n"),
	);
	const fake = fakeHost();
	registerArchiveTool(fake.api);
	const search = async (cursor?: string) => {
		const result = await fake.tools
			.get("archive")
			.execute(
				"call",
				{ reason: "past decision", op: "search", source: "all", query: "needle", limit: 1, cursor },
				undefined,
				undefined,
				fakeCtx({ cwd: root }),
			);
		return { text: result.content[0].text as string, cursor: result.details.nextCursor as string | undefined };
	};
	const first = await search();
	// Both parts stopped early: the result names one cursor, once, on its last line.
	expect(first.cursor).toMatch(/^a2\./);
	expect(first.text).not.toMatch(/cursor h1\./);
	expect(first.text).not.toMatch(/page 2|with page/i);
	expect(first.text.split(first.cursor!).length - 1).toBe(1);
	expect(first.text.endsWith(`cursor ${first.cursor} and the same other arguments.`)).toBe(true);
	expect(first.text).toContain("needle summary third");
	expect(first.text).toContain("needle line 0 ");
	const second = await search(first.cursor);
	expect(second.text).toContain("needle summary second");
	expect(second.text).not.toContain("needle summary third");
	expect(second.text).not.toContain("needle line 0 ");
	// Every page until the end shows each compaction once.
	const seen = [first.text, second.text];
	let cursor = second.cursor;
	for (let guard = 0; cursor && guard < 200; guard++) {
		const next = await search(cursor);
		seen.push(next.text);
		cursor = next.cursor;
	}
	expect(cursor).toBeUndefined();
	for (const id of ["first", "second", "third"])
		expect(seen.filter((text) => text.includes(`needle summary ${id}`))).toHaveLength(1);
});
