import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { shellHistory } from "../../../db/src/api.ts";
import { ShellHistoryStore } from "../../src/octocode/terminal/history.ts";

const root = mkdtempSync(join(tmpdir(), "octocode-shell-history-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("ShellHistoryStore", () => {
	it("reads the history again after a run, before the next `!` key asks for it, with the same entries", async () => {
		const env = { ...process.env, OCTOCODE_AGENT_DB: join(root, "history.db") };
		const store = new ShellHistoryStore(env);
		store.record("/w", "git status", 1000);
		store.record("/w", "ls", 2000);
		await tick();
		const recent = vi.spyOn(shellHistory, "recent");
		// The first key after the run: answered from the entries read while the command ran.
		const prefetched = store.entries();
		expect(recent).not.toHaveBeenCalled();
		recent.mockRestore();
		expect(prefetched).toEqual(new ShellHistoryStore(env).entries());
		expect(prefetched.map((entry) => entry.command)).toEqual(["ls", "git status"]);

		store.setExit("/w", "ls", 2);
		await tick();
		expect(store.entries().find((entry) => entry.command === "ls")?.lastExit).toBe(2);
	});

	it("reads at once when a key comes before the prefetch", () => {
		const env = { ...process.env, OCTOCODE_AGENT_DB: join(root, "early.db") };
		const store = new ShellHistoryStore(env);
		store.record("/w", "make", 1000);
		expect(store.entries().map((entry) => entry.command)).toEqual(["make"]);
	});
});
