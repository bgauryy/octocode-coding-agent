import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { openAgentDb, sharedAgentDb } from "../../src/storage/database.ts";
import { registerMemory } from "../../src/octocode/memory/register.ts";
import { memoryStore, MemoryStore } from "../../src/octocode/memory/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

afterEach(() => {
	closeSharedAgentDb();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("memory retrieval and write boundaries", () => {
	it("bounds public list/search pages and reaches every record with cursors", async () => {
		const cwd = tmp();
		vi.stubEnv("OCTOCODE_AGENT_DB", path.join(tmp(), "agent.db"));
		const db = sharedAgentDb();
		const store = memoryStore(cwd);
		const insert = db.db.prepare(
			"INSERT INTO memories(scope, repo_key, kind, title, body, keywords, pinned, author, created_at, updated_at) VALUES ('project', ?, 'fact', ?, '', '', 0, 'test', 1, 1)",
		);
		for (let i = 0; i < 105; i++) insert.run(store.repoKey, `retrieval item ${i}`);
		const fake = fakeHost();
		registerMemory(fake.api, { commands: new Subcommands(), isSubagent: false, permission: fakePermission() });
		const tool = fake.tools.get("memory");
		for (const op of ["list", "search"]) {
			let cursor: string | undefined;
			const ids: string[] = [];
			do {
				const result = await tool.execute(
					"call",
					{ goal: "Recall", reason: "saved facts", op, query: "retrieval", limit: 100_000, cursor },
					undefined,
					undefined,
					fakeCtx({ cwd }),
				);
				expect(result.details.hits).toBeLessThanOrEqual(50);
				ids.push(...(result.content[0].text.match(/^M\d+$/gm) ?? []));
				cursor = result.details.nextCursor;
			} while (cursor);
			expect(ids).toHaveLength(105);
			expect(new Set(ids).size).toBe(105);
		}
	});

	it("holds the write reservation before duplicate lookup across two database connections", () => {
		const file = path.join(tmp(), "shared.db");
		const first = openAgentDb(file);
		const second = openAgentDb(file);
		try {
			second.db.exec("PRAGMA busy_timeout=0");
			const a = new MemoryStore(first, "repo");
			const b = new MemoryStore(second, "repo");
			const input = { title: "Use isolated configuration for tests", author: "test" };
			const original = a.search.bind(a);
			const search = vi.spyOn(a, "search").mockImplementationOnce((...args) => {
				// Interleave at the first duplicate read, before a can insert anything.
				expect(() => b.set(input)).toThrow(/locked|busy/i);
				return original(...args);
			});
			a.set(input);
			expect(search).toHaveBeenCalled();
			expect(() => b.set(input)).toThrow(/Similar memory M1/);
			expect(b.count()).toBe(1);
		} finally {
			second.close();
			first.close();
		}
	});

	it("refuses an update that moves a memory into a scope where it repeats one", () => {
		const db = openAgentDb(path.join(tmp(), "agent.db"));
		try {
			const a = new MemoryStore(db, "repo-a");
			const b = new MemoryStore(db, "repo-b");
			const global = b.set({ title: "Prefers tabs for indentation", scope: "global", author: "test" }).memory;
			// The same title is refused outright in another visible scope; a distinct one is saved, then cannot be moved onto it.
			expect(() => a.set({ title: "Prefers tabs for indentation", author: "test" })).toThrow(
				new RegExp(`Similar memory M${global.id}`),
			);
			const local = a.set({ title: "Spaces are banned in source files", author: "test" }).memory;
			expect(local.scope).toBe("project");
			expect(() =>
				a.set({ id: local.id, scope: "global", title: "Prefers tabs for indentation", author: "test" }),
			).toThrow(new RegExp(`Similar memory M${global.id}`));
			expect(a.get(local.id)?.scope).toBe("project");
			// An update within the memory's own scope is not compared with itself.
			expect(a.set({ id: local.id, body: "in every file", author: "test" }).memory.body).toBe("in every file");
		} finally {
			db.close();
		}
	});

	it("warns once per failed session, and warns again after recovery", async () => {
		const root = tmp();
		const broken = path.join(root, "broken.db");
		fs.writeFileSync(broken, "not sqlite");
		const env = { OCTOCODE_AGENT_DB: broken, OCTOCODE_MEMORY_AUTO: "1" };
		const fake = fakeHost();
		registerMemory(fake.api, { commands: new Subcommands(), isSubagent: false, permission: fakePermission(), env });
		const ctx = fakeCtx({ cwd: root });
		Object.assign(ctx.sessionManager, { getBranch: () => [] });
		for (let i = 0; i < 2; i++) expect(await fake.fire("before_agent_start", { prompt: "test" }, ctx)).toBeUndefined();
		expect(ctx.ui.notes).toHaveLength(1);
		expect(ctx.ui.notes[0]).toMatchObject({
			message: expect.stringContaining("Memory injection failed"),
			type: "warning",
		});
		env.OCTOCODE_AGENT_DB = path.join(root, "valid.db");
		expect(await fake.fire("before_agent_start", { prompt: "test" }, ctx)).toBeUndefined();
		env.OCTOCODE_AGENT_DB = broken;
		expect(await fake.fire("before_agent_start", { prompt: "test" }, ctx)).toBeUndefined();
		expect(ctx.ui.notes).toHaveLength(2);
	});
});

describe("memory search over the whole scope", () => {
	it("finds a regex match that is not among the newest memories, in the first call", async () => {
		const cwd = tmp();
		vi.stubEnv("OCTOCODE_AGENT_DB", path.join(tmp(), "agent.db"));
		const store = memoryStore(cwd);
		// 30 memories; in list order (newest first) the one that matches is the 25th.
		for (let i = 0; i < 30; i++)
			store.set(
				{ title: i === 5 ? "Wrap the upload in a retry" : `alpha${i}x beta${i}y`, body: "note", author: "user" },
				i + 1,
			);
		const newest = { id: Number.MAX_SAFE_INTEGER, pinned: 2, updated: Number.MAX_SAFE_INTEGER };
		expect(store.scan("all", newest, 30)[24].title).toBe("Wrap the upload in a retry");
		const fake = fakeHost();
		registerMemory(fake.api, { commands: new Subcommands(), isSubagent: false, permission: fakePermission() });
		const run = (params: object) =>
			fake.tools.get("memory").execute("call", { reason: "recall", ...params }, undefined, undefined, fakeCtx({ cwd }));
		const found = await run({ op: "search", query: "retry" });
		expect(found.content[0].text).toContain("memories: 1 matches in 30 scanned records");
		expect(found.content[0].text).toContain("Wrap the upload in a retry");
		expect(found.details).toMatchObject({ mode: "search", hits: 1 });
		expect(found.details.nextCursor).toBeUndefined();
		// With keywords too, the filter keeps only matching memories and the cursor reaches the rest of them.
		const both = { op: "search", keywords: "note upload", query: "retry|alpha1\\dx" };
		const ranked = await run(both);
		expect(ranked.content[0].text).toContain("memories: 10 matches");
		expect(ranked.details.nextCursor).toBeDefined();
		const rest = await run({ ...both, cursor: ranked.details.nextCursor });
		expect(rest.content[0].text).toContain("memories: 1 matches");
		expect(rest.details.nextCursor).toBeUndefined();
		// A search counts what it returned as used; the others were only tested.
		expect(store.list("all", 50).filter((memory) => memory.useCount > 0)).toHaveLength(11);
		await expect(run({ op: "search", query: "(" })).rejects.toThrow(
			/query is a regular expression, and this one is invalid/,
		);
		await expect(run({ op: "list", cursor: "not-a-cursor" })).rejects.toThrow("Invalid memory cursor");
	});
});
