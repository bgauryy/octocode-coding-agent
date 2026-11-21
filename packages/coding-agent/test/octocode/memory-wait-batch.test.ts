import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateToolArguments } from "../../../ai/src/utils/validation.ts";
import { type AgentDb, openDatabase } from "../../../db/src/api.ts";
import type { ToolContext } from "../../src/core/features/index.ts";
import { MemoryStore } from "../../src/octocode/memory/store.ts";
import { createMemoryTool } from "../../src/octocode/native/tools/memory/tool.ts";
import { registerTimers } from "../../src/octocode/timer/register.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const textOf = (result: { content: unknown }) => (result.content as Array<{ text: string }>)[0].text;

describe("memory batched writes", () => {
	it("saves and deletes several memories per call, and reports a refused entry without stopping the rest", async () => {
		const db = openAgentDb(path.join(tmp(), "memory.db"));
		try {
			const store = new MemoryStore(db, "repo");
			const tool = createMemoryTool(() => store, { isSubagent: false, permission: fakePermission() });
			const ctx = { ...fakeCtx({ cwd: tmp() }), tools: [] } as unknown as ToolContext;
			const run = (params: Record<string, unknown>) =>
				tool.execute("c", params as never, undefined, undefined, ctx).then(textOf);
			const saved = await run({
				op: "set",
				items: [
					{ title: "Run yarn in the root", body: "one lockfile" },
					{ body: "no title" },
					{ title: "Format with oxfmt", body: "only changed files" },
				],
			});
			expect(saved.split("\n")[0]).toMatch(/2 of 3/);
			const ids = store.list().map((memory) => `M${memory.id}`);
			expect(ids).toHaveLength(2);
			expect(await run({ op: "delete", items: ids.map((id) => ({ id })) })).toMatch(/2 of 2/);
			expect(store.list()).toHaveLength(0);
			await expect(run({ op: "set", title: "beside", items: [{ title: "x", body: "y" }] })).rejects.toThrow(/items/);
		} finally {
			db.close();
		}
	});

	it("types each entry in the validation schema as a single write and keeps it out of a subagent's schema", () => {
		const db = openAgentDb(path.join(tmp(), "memory.db"));
		try {
			const store = new MemoryStore(db, "repo");
			const main = createMemoryTool(() => store, { isSubagent: false, permission: fakePermission() });
			const check = (args: Record<string, unknown>) =>
				validateToolArguments(
					{ name: "memory", description: "", parameters: main.validationParameters ?? main.parameters },
					{ type: "toolCall", id: "c", name: "memory", arguments: { reason: "r", ...args } },
				);
			expect(() => check({ op: "set", items: [{ title: "a", body: "b" }] })).not.toThrow();
			expect(() => check({ op: "set", items: [{ title: "a", query: "b" }] })).toThrow();
			const sub = createMemoryTool(() => store, { isSubagent: true, permission: fakePermission() });
			expect(Object.keys(sub.parameters.properties)).not.toContain("items");
		} finally {
			db.close();
		}
	});
});

describe("wait batched writes", () => {
	let root: string;
	let file: string;
	let agent: AgentDb;
	beforeEach(() => {
		root = tmp();
		file = path.join(root, "workspaces.db");
		agent = openDatabase({
			file,
			mirrorFile: `${file}.transcripts`,
			archiveDir: path.join(root, "archive"),
			privateParent: false,
		});
	});
	afterEach(() => {
		agent.close();
		vi.useRealTimers();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("sets and cancels several waits per call, and reports a refused entry on its own line", async () => {
		const host = fakeHost();
		registerTimers(host.api, {
			reservation: () => "held",
			agent: () => undefined,
			env: { ...process.env, OCTOCODE_AGENT_DB: file },
		});
		const ctx = { ...fakeCtx({ cwd: root }), sessionManager: { getSessionId: () => "s1", getBranch: () => [] } };
		await host.fire("session_start", { reason: "startup" }, ctx);
		const tool = host.tools.get("wait");
		const run = (params: Record<string, unknown>) => tool.execute("c", params, undefined, undefined, ctx).then(textOf);
		const set = await run({
			op: "set",
			items: [{ after: 600, note: "look again" }, { after: 600 }, { every: 300, note: "poll" }],
		});
		expect(set.split("\n")).toHaveLength(4);
		expect(set.split("\n")[0]).toMatch(/2 of 3/);
		const active = (await tool.execute("c", { op: "list" }, undefined, undefined, ctx)).details as {
			shown?: number;
		};
		expect(active.shown).toBe(2);
		const off = await run({ op: "off", items: [{ all: true }] });
		expect(off).toMatch(/1 of 1/);
		await expect(run({ op: "off", id: 1, items: [{ id: 2 }] })).rejects.toThrow(/items/);
		const check = (args: Record<string, unknown>) =>
			validateToolArguments(
				{ name: "wait", description: "", parameters: tool.validationParameters ?? tool.parameters },
				{ type: "toolCall", id: "c", name: "wait", arguments: { reason: "r", ...args } },
			);
		expect(() => check({ op: "set", items: [{ after: 60, note: "n" }] })).not.toThrow();
		expect(() => check({ op: "set", items: [{ after: 60, note: "n", op: "off" }] })).toThrow();
		await host.fire("session_shutdown", {}, ctx);
	});
});
