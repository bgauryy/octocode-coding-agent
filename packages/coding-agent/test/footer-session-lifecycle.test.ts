import { EventEmitter } from "node:events";
import { type FSWatcher, mkdirSync, mkdtempSync, rmSync, type WatchListener, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { callbacks, lookup, resolveBranch } = vi.hoisted(() => ({
	callbacks: new Map<string, WatchListener<string>>(),
	lookup: vi.fn(),
	resolveBranch: vi.fn(() => ({ status: 0, stdout: "old-main\n", stderr: "" })),
}));
vi.mock("child_process", () => ({ execFile: lookup, spawnSync: resolveBranch }));
vi.mock("../src/utils/fs-watch.ts", () => ({
	FS_WATCH_RETRY_DELAY_MS: 5000,
	closeWatcher: (watcher: FSWatcher | null) => watcher?.close(),
	watchWithErrorHandler: (path: string, callback: WatchListener<string>) => {
		callbacks.set(path, callback);
		return Object.assign(new EventEmitter(), { close: () => callbacks.delete(path) });
	},
}));

import { FooterDataProvider } from "../src/core/footer-data-provider.ts";

let temporary: string;
let provider: FooterDataProvider;
beforeEach(() => {
	vi.useFakeTimers();
	temporary = mkdtempSync(join(tmpdir(), "footer-session-lifecycle-"));
	lookup.mockReset();
	callbacks.clear();
});
afterEach(() => {
	provider?.dispose();
	vi.useRealTimers();
	rmSync(temporary, { recursive: true, force: true });
});

function repo(name: string, branch: string) {
	const path = join(temporary, name);
	mkdirSync(join(path, ".git", "reftable"), { recursive: true });
	writeFileSync(join(path, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
	return path;
}

it("ignores an old repository's async branch result after changing directories", async () => {
	const previous = repo("old", ".invalid");
	const next = repo("new", "new-main");
	provider = new FooterDataProvider(previous);
	expect(provider.getGitBranch()).toBe("old-main");
	callbacks.get(join(previous, ".git", "reftable"))!("change", "tables.list");
	await vi.advanceTimersByTimeAsync(500);
	expect(lookup).toHaveBeenCalledOnce();
	const complete = lookup.mock.calls[0][3] as (error: Error | null, stdout: string) => void;
	provider.setCwd(next);
	expect(provider.getGitBranch()).toBe("new-main");
	const changed = vi.fn();
	provider.onBranchChange(changed);
	complete(null, "stale-branch\n");
	await vi.advanceTimersByTimeAsync(0);
	expect(provider.getGitBranch()).toBe("new-main");
	expect(changed).not.toHaveBeenCalled();
});

it("does not cache an old async branch result before the new repository is first read", async () => {
	const previous = repo("old", ".invalid");
	const next = repo("new", "new-main");
	provider = new FooterDataProvider(previous);
	callbacks.get(join(previous, ".git", "reftable"))!("change", "tables.list");
	await vi.advanceTimersByTimeAsync(500);
	const complete = lookup.mock.calls[0][3] as (error: Error | null, stdout: string) => void;
	provider.setCwd(next);
	complete(null, "stale-branch\n");
	await vi.advanceTimersByTimeAsync(0);
	expect(provider.getGitBranch()).toBe("new-main");
});
