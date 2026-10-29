import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb, openAgentDb } from "../../src/octocode/agentdb/db.ts";
import { registerMemory } from "../../src/octocode/memory/register.ts";
import { MemoryStore } from "../../src/octocode/memory/store.ts";
import { registerMemoryTool } from "../../src/octocode/memory/tool.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

afterEach(() => {
	closeSharedAgentDb();
	vi.restoreAllMocks();
});

describe("memory retrieval and write boundaries", () => {
	it("caps list and search results at 100", async () => {
		const db = openAgentDb(path.join(tmp(), "agent.db"));
		try {
			const store = new MemoryStore(db, "repo");
			const insert = db.db.prepare(
				"INSERT INTO memories(scope, repo_key, kind, title, body, keywords, pinned, author, created_at, updated_at) VALUES ('project', 'repo', 'fact', ?, '', '', 0, 'test', 1, 1)",
			);
			for (let i = 0; i < 105; i++) insert.run(`retrieval item ${i}`);
			const fake = fakeHost();
			registerMemoryTool(fake.api, () => store, { isSubagent: false, permission: fakePermission() });
			const tool = fake.tools.get("memory");
			const ctx = fakeCtx({ cwd: tmp() });
			Object.assign(ctx, { isProjectTrusted: () => true });
			for (const op of ["list", "search"]) {
				const result = await tool.execute(
					"call",
					{ op, query: "retrieval", limit: 100_000 },
					undefined,
					undefined,
					ctx,
				);
				expect(result.details.ids).toHaveLength(100);
				expect(result.content[0].text).not.toContain("raise limit");
			}
		} finally {
			db.close();
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
