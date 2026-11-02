import { HistoryRepair } from "../../src/octocode/archive/repair.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../src/octocode/agentdb/db.ts";
import { sharedAgentDb, compactions, agentEvents } from "../../src/octocode/agentdb/api.ts";
import { registerArchiveTool } from "../../src/octocode/archive/tool.ts";
import { saveCompaction } from "../../src/octocode/archive/summaries.ts";
import { expireArchiveDetails, mayRemoveArchive } from "../../src/octocode/archive/retention.ts";
import { registerMemory } from "../../src/octocode/memory/register.ts";
import { memoryStore, MemoryStore } from "../../src/octocode/memory/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { archiveFolder, setSessionLineage } from "../../src/octocode/shared/archive.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { planningRefusal } from "../../src/octocode/plan/gate.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { readRecords } from "../../src/octocode/archive/reads.ts";
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
	setCurrentSession("session-a");
	setSessionLineage([]);
});
afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

it("shares workspace notes while preserving legacy ids and hiding them from old repository readers", () => {
	const db = sharedAgentDb();
	const legacy = new MemoryStore(db, root);
	const old = legacy.set({ title: "legacy shared decision", author: "user" }).memory;
	const workspace = memoryStore(root);
	const note = workspace.set({ title: "workspace-only preference", author: "user" }).memory;
	const other = path.join(root, "other");
	fs.mkdirSync(other);
	expect(note.scope).toBe("workspace");
	expect(workspace.get(old.id)?.scope).toBe("project");
	expect(memoryStore(root).get(note.id)?.title).toBe(note.title);
	expect(memoryStore(other).get(note.id)).toBeUndefined();
	expect(legacy.get(note.id)).toBeUndefined();
	expect(() => legacy.delete(note.id)).toThrow("No memory");
});

it("exposes one tool and retains scoped write checks and plan classification", async () => {
	const fake = fakeHost();
	const memory = registerMemory(fake.api, {
		commands: new Subcommands(),
		isSubagent: false,
		permission: fakePermission(),
	});
	registerArchiveTool(fake.api, memory);
	expect([...fake.tools.keys()]).toEqual(["archive"]);
	const tool = fake.tools.get("archive");
	const ctx = fakeCtx({ cwd: root });
	const run = (input: object) =>
		tool.execute("call", { goal: "remember", reason: "user preference", ...input }, undefined, undefined, ctx);
	await expect(run({ op: "set", source: "events", title: "bad" })).rejects.toThrow("Only source memories");
	expect((await run({ op: "set", source: "memories", title: "remember amber" })).content[0].text).toMatch(
		/Saved M1 \(workspace/,
	);
	const broken = path.join(root, "broken.jsonl");
	fs.writeFileSync(broken, "invalid old transcript");
	Object.assign(ctx.sessionManager, { getSessionFile: () => broken });
	expect((await run({ op: "get", source: "memories", id: "M1" })).content[0].text).toContain("remember amber");
	const definition = { sourceInfo: { owner: "native" } } as Parameters<typeof planningRefusal>[1];
	expect(planningRefusal({ toolName: "archive", input: { op: "get" } }, definition)).toBeUndefined();
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
	expect(compactions.get(db.db, "session-a", entry.id)).toMatchObject({
		summary: entry.summary,
		detailState: "expired",
	});
	saveCompaction(db, root, "session-a", entry, { recovered: true });
	expect(compactions.get(db.db, "session-a", entry.id)?.detailState).toBe("expired");
	expect(agentEvents.list(db.db, root).filter((row) => row.type === "compaction")).toHaveLength(1);
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
	await new HistoryRepair(db).transcript(fork);
	await new HistoryRepair(db).transcript(fork);
	expect(compactions.forSession(db.db, "parent")).toHaveLength(1);
	expect(compactions.forSession(db.db, "fork")).toHaveLength(0);
	expect(agentEvents.list(db.db, root)).toHaveLength(1);
});

it("finds old lifecycle events beyond 50 and filters them without treating a partial page as the whole corpus", async () => {
	const db = sharedAgentDb();
	for (let i = 0; i < 65; i++)
		db.transaction(() =>
			agentEvents.append(db.db, root, {
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
	let cursor: string | undefined;
	const texts: string[] = [];
	do {
		const result = await readRecords(root, {
			source: "events",
			op: "search",
			query: "oldest-needle",
			agentId: "agent",
			cursor,
			limit: 10,
		});
		texts.push(result.text);
		cursor = result.cursor;
	} while (cursor);
	expect(texts).toHaveLength(7);
	expect(texts.at(-1)).toContain("event:event-0");
	expect((await readRecords(root, { source: "events", agentId: "another" })).hits).toBe(0);
});

it("lists pins first, pages every memory and does not count a list as use", async () => {
	const store = memoryStore(root);
	const pin = store.set({ title: "Pinned policy", pinned: true, author: "user" }, 1).memory;
	store.set({ title: "Unpinned preference", author: "user" }, 2);
	const first = await readRecords(root, { source: "memories", op: "list", limit: 1 });
	expect(first.text).toContain(`M${pin.id}\n`);
	expect(first.cursor).toBeDefined();
	const next = await readRecords(root, { source: "memories", op: "list", limit: 1, cursor: first.cursor });
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
	const memory = await readRecords(root, { source: "memories", op: "search", keywords: "cobalt", limit: 1 });
	expect(memory.text).toContain("Ancient cobalt decision");
	const summaries = await readRecords(root, { source: "compactions", op: "search", keywords: "cobalt", limit: 1 });
	expect(summaries.text).toContain("old cobalt summary");
	const sessions = await readRecords(root, { source: "sessions", op: "list" });
	expect(sessions.text).toContain("session:session-a");
});

it("keeps retention repair and its library in the explicitly configured home", async () => {
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
	expect(fs.existsSync(archiveFolder("configured-home"))).toBe(false);
});

it("uses the configured memory store for both archive writes and reads", async () => {
	const fake = fakeHost();
	registerArchiveTool(
		fake.api,
		registerMemory(fake.api, {
			commands: new Subcommands(),
			isSubagent: false,
			permission: fakePermission(),
			env: { ...process.env, OCTOCODE_AGENT_DB: path.join(root, "configured.db") },
		}),
	);
	const run = (params: object) =>
		fake.tools.get("archive").execute(
			"call",
			{
				goal: "Remember a rule",
				reason: "User preference",
				source: "memories",
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
	const db = sharedAgentDb();
	for (const [id, time] of [
		["before", "2025-12-31T22:59:59.999Z"],
		["start", "2025-12-31T23:00:00.000Z"],
		["middle", "2025-12-31T23:30:00.000Z"],
		["end", "2026-01-01T00:00:00.000Z"],
		["after", "2026-01-01T00:00:00.001Z"],
	])
		agentEvents.append(db.db, root, {
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
	const open = fs.createReadStream;
	const spy = vi.spyOn(fs, "createReadStream").mockImplementation((...args) => {
		const stream = open(...args);
		queueMicrotask(() => controller.abort());
		return stream;
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
