import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openAgentDb } from "../../src/storage/database.ts";
import { MemoryStore } from "../../src/octocode/memory/store.ts";
import { writeMemory } from "../../src/octocode/memory/write.ts";
import { memoryTemplate, registerMemoryCommand } from "../../src/octocode/memory/command.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("memory mutation revision", () => {
	it("rejects equal-clock edits and cannot target a recreated note with a stale id", () => {
		const db = openAgentDb(path.join(tmp(), "memory.db"));
		try {
			const store = new MemoryStore(db, "repo");
			const original = store.set({ title: "Repository rule", body: "Old rule", author: "user" }, 10).memory;
			const latest = store.set({ id: original.id, body: "New user rule", author: "user" }, 10).memory;
			expect(latest.updatedAt).toBeGreaterThan(original.updatedAt);
			expect(() =>
				store.set({ id: original.id, body: "Stale draft", author: "agent" }, 10, original.updatedAt),
			).toThrow(/changed.*read.*again/i);
			expect(store.get(original.id)).toEqual(latest);
			store.delete(latest.id, latest.updatedAt);
			const recreated = store.set({ title: "Repository rule", body: "Recreated user rule", author: "user" }, 10).memory;
			expect(recreated.id).toBeGreaterThan(original.id);
			expect(() => store.delete(original.id, original.updatedAt)).toThrow(/No memory/);
			expect(store.get(recreated.id)).toEqual(recreated);
		} finally {
			db.close();
		}
	});
	it("does not inherit a newly pinned scope after a no-approval decision", async () => {
		const db = openAgentDb(path.join(tmp(), "memory.db"));
		try {
			const store = new MemoryStore(db, "repo");
			const original = store.set({ title: "Repository rule", author: "user" }).memory;
			const permission = fakePermission();
			const check = vi.spyOn(permission, "check");
			const pending = writeMemory({
				toolCallId: "narrow",
				id: original.id,
				params: { op: "set", body: "Agent change" },
				store,
				permission,
				ctx: fakeCtx({ cwd: tmp() }),
				signal: undefined,
			});
			const latest = store.set({ id: original.id, pinned: true, author: "user" }).memory;
			await expect(pending).rejects.toThrow(/changed.*read.*again/i);
			expect(check).not.toHaveBeenCalled();
			expect(store.get(original.id)).toEqual(latest);
		} finally {
			db.close();
		}
	});

	it.each(["Edit", "Pin", "Move to global", "Delete"])(
		"preserves a newer user note during the %s picker action",
		async (action) => {
			const file = path.join(tmp(), "memory.db");
			const first = openAgentDb(file),
				second = openAgentDb(file);
			try {
				const a = new MemoryStore(first, "repo"),
					b = new MemoryStore(second, "repo");
				const original = a.set({ title: "Repository rule", body: "Original body", author: "user" }).memory;
				const commands = new Subcommands();
				registerMemoryCommand(commands, { store: () => a, autoEnv: () => true });
				const ctx = fakeCtx({ cwd: tmp(), mode: "rpc" });
				let calls = 0;
				let latest = original;
				vi.spyOn(ctx.ui, "select").mockImplementation(async (_title, options) => {
					calls++;
					if (calls === 1) return options[0];
					if (calls === 2) {
						latest = b.set({ id: original.id, body: "Newer user body", author: "user" }).memory;
						return action;
					}
					return action === "Delete" && calls === 3 ? "Delete" : undefined;
				});
				const draft = memoryTemplate({ ...original, body: "Stale user draft" });
				const editor = vi.fn().mockResolvedValueOnce(draft).mockResolvedValue(undefined);
				Object.assign(ctx.ui, { editor });
				await commands.get("memory")!.handler("", ctx);
				expect(a.get(original.id)).toEqual(latest);
				expect(ctx.ui.notes.some((note) => /changed.*read.*again/i.test(note.message))).toBe(true);
				if (action === "Edit") expect(editor).toHaveBeenNthCalledWith(2, expect.any(String), draft);
			} finally {
				second.close();
				first.close();
			}
		},
	);
	it.each(["set", "delete"] as const)("refuses %s after another connection changes the approved memory", async (op) => {
		const file = path.join(tmp(), "memory.db");
		const first = openAgentDb(file);
		const second = openAgentDb(file);
		const approval = deferred();
		try {
			const a = new MemoryStore(first, "repo");
			const b = new MemoryStore(second, "repo");
			const original = a.set({
				title: "Database ownership",
				body: "Original rule",
				pinned: true,
				author: "user",
			}).memory;
			const asking = deferred();
			const permission = fakePermission();
			const check = vi.spyOn(permission, "check").mockImplementation(async () => {
				asking.resolve();
				await approval.promise;
				return { allowed: true, via: "user", lasts: "call" };
			});
			const pending = writeMemory({
				toolCallId: "approved-old-version",
				id: original.id,
				params: { op, ...(op === "set" ? { body: "Approved old change" } : {}) },
				store: a,
				permission,
				ctx: fakeCtx({ cwd: tmp() }),
				signal: undefined,
			});
			await asking.promise;
			const latest = b.set({ id: original.id, scope: "global", body: "Newer user rule", author: "user" }).memory;
			const rejected = expect(pending).rejects.toThrow(/changed.*read.*again/i);
			approval.resolve();
			await rejected;
			expect(check).toHaveBeenCalledTimes(1);
			expect(a.get(original.id)).toEqual(latest);
		} finally {
			approval.resolve();
			second.close();
			first.close();
		}
	});

	it("refuses an unknown id before asking about a wide save", async () => {
		const db = openAgentDb(path.join(tmp(), "memory.db"));
		try {
			const store = new MemoryStore(db, "repo");
			const permission = fakePermission();
			const check = vi.spyOn(permission, "check").mockResolvedValue({ allowed: true, via: "user", lasts: "call" });
			await expect(
				writeMemory({
					toolCallId: "missing",
					id: 999,
					params: { op: "set", title: "Unknown note", pinned: true },
					store,
					permission,
					ctx: fakeCtx({ cwd: tmp() }),
					signal: undefined,
				}),
			).rejects.toThrow(/No memory M999/);
			expect(check).not.toHaveBeenCalled();
			expect(store.count()).toBe(0);
		} finally {
			db.close();
		}
	});
});
