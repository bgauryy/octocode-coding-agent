import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../../src/core/features/index.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { MemoryStore } from "../../src/octocode/memory/store.ts";
import { createMemoryTool } from "../../src/octocode/memory/tool.ts";
import { fakeCtx, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const fields = { title: "", body: "", kind: "fact" as const, pinned: false };

function toolContext(): ExtensionToolContext {
	return {
		...fakeCtx({ cwd: tmp() }),
		tools: [],
		async executeTool(name) {
			return {
				toolCall: { type: "toolCall", id: "unavailable", name, arguments: {} },
				result: { content: [{ type: "text", text: "No nested tools available" }], details: undefined },
				isError: true,
			};
		},
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("memory write cancellation", () => {
	it.each(["set", "delete"] as const)("does not %s a memory after cancellation in the write queue", async (op) => {
		const db = openAgentDb(path.join(tmp(), "memory.db"));
		const approval = deferred();
		try {
			const store = new MemoryStore(db, "repo");
			const existing = store.set({ title: "Repository ownership", author: "user" }).memory;
			const permission = fakePermission();
			const asking = deferred();
			vi.spyOn(permission, "check").mockImplementation(async () => {
				asking.resolve();
				await approval.promise;
				return { allowed: true, via: "user", lasts: "call" };
			});
			const tool = createMemoryTool(() => store, { isSubagent: false, permission });
			const ctx = toolContext();
			const first = tool.execute(
				"holder",
				{ ...fields, op: "set", title: "Answer concisely", pinned: true },
				undefined,
				undefined,
				ctx,
			);
			await asking.promise;
			const controller = new AbortController();
			const pending = tool.execute(
				"cancelled",
				{ ...fields, ...(op === "delete" ? { op, id: `M${existing.id}` } : { op, title: "Cancelled procedure" }) },
				controller.signal,
				undefined,
				ctx,
			);
			const rejected = expect(pending).rejects.toThrow("Cancelled memory change");
			controller.abort(new Error("Cancelled memory change"));
			approval.resolve();
			await first;
			await rejected;
			expect(store.get(existing.id)).toBeDefined();
			expect(store.list().map((memory) => memory.title)).not.toContain("Cancelled procedure");
		} finally {
			approval.resolve();
			db.close();
		}
	});

	it.each(["set", "delete"] as const)("does not %s after cancellation while approval is pending", async (op) => {
		const db = openAgentDb(path.join(tmp(), "memory.db"));
		const approval = deferred();
		try {
			const store = new MemoryStore(db, "repo");
			const existing = store.set({ title: "Repository ownership", pinned: true, author: "user" }).memory;
			const permission = fakePermission();
			const asking = deferred();
			vi.spyOn(permission, "check").mockImplementation(async () => {
				asking.resolve();
				await approval.promise;
				return { allowed: true, via: "user", lasts: "call" };
			});
			const tool = createMemoryTool(() => store, { isSubagent: false, permission });
			const controller = new AbortController();
			const pending = tool.execute(
				"cancelled",
				{
					...fields,
					...(op === "delete" ? { op, id: `M${existing.id}` } : { op, title: "Cancelled procedure", pinned: true }),
				},
				controller.signal,
				undefined,
				toolContext(),
			);
			await asking.promise;
			const rejected = expect(pending).rejects.toThrow("Cancelled memory change");
			controller.abort(new Error("Cancelled memory change"));
			approval.resolve();
			await rejected;
			expect(store.get(existing.id)).toBeDefined();
			expect(store.list().map((memory) => memory.title)).not.toContain("Cancelled procedure");
		} finally {
			approval.resolve();
			db.close();
		}
	});
});
