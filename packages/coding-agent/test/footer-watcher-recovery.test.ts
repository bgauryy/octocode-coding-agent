import { EventEmitter } from "node:events";
import type * as Fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, type WatchListener, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type PollListener = () => void;
const { watch, watchFileChanges, polls } = vi.hoisted(() => ({
	watch: vi.fn(),
	watchFileChanges: vi.fn(),
	polls: new Map<string, Set<PollListener>>(),
}));
vi.mock("node:fs", async (original) => ({ ...(await original<typeof Fs>()), watch }));
vi.mock("fs", async (original) => ({ ...(await original<typeof Fs>()), watch }));
vi.mock("@octocodeai/octocode-common/watch-file", () => ({ watchFileChanges }));

import { FooterDataProvider } from "../src/core/footer-data-provider.ts";
import * as gitPaths from "../src/core/footer-data-provider/git.ts";

const watchers: Array<{ path: string; watcher: EventEmitter; close: ReturnType<typeof vi.fn> }> = [];
const providers: FooterDataProvider[] = [];
let temporary: string;
beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	polls.clear();
	watchers.length = 0;
	temporary = mkdtempSync(join(tmpdir(), "footer-watcher-recovery-"));
	watch.mockImplementation((path: string, listener: WatchListener<string>) => {
		const close = vi.fn();
		const watcher = Object.assign(new EventEmitter(), { close });
		watcher.on("change", listener);
		watchers.push({ path, watcher, close });
		return watcher;
	});
	watchFileChanges.mockImplementation((path: string, listener: PollListener) => {
		const listeners = polls.get(path) ?? new Set<PollListener>();
		listeners.add(listener);
		polls.set(path, listeners);
		return () => polls.get(path)?.delete(listener);
	});
});
afterEach(() => {
	for (const provider of providers.splice(0)) provider.dispose();
	vi.restoreAllMocks();
	vi.useRealTimers();
	rmSync(temporary, { recursive: true, force: true });
});

function repo(name: string) {
	const path = join(temporary, name);
	mkdirSync(join(path, ".git", "reftable"), { recursive: true });
	writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(path, ".git", "reftable", "tables.list"), "table\n");
	return path;
}
function provider(path: string) {
	const result = new FooterDataProvider(path);
	providers.push(result);
	return result;
}

it("disposing one footer preserves another footer's reftable directory watcher, and polls nothing", async () => {
	const path = repo("shared");
	const first = provider(path);
	const second = provider(path);
	expect(second.getGitBranch()).toBe("main");
	const changed = vi.fn();
	second.onBranchChange(changed);
	const reftable = join(path, ".git", "reftable");
	// Git replaces tables.list by a rename, which the directory watcher sees: no watcher or stat poll on the file.
	expect(watchers.map((entry) => entry.path)).toEqual([join(path, ".git"), reftable, join(path, ".git"), reftable]);
	expect(watchFileChanges).not.toHaveBeenCalled();
	first.dispose();
	expect(watchers.slice(0, 2).every(({ close }) => close.mock.calls.length === 1)).toBe(true);
	writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/next\n");
	watchers[3].watcher.emit("change", "rename", "tables.list");
	await vi.advanceTimersByTimeAsync(501);
	expect(second.getGitBranch()).toBe("next");
	expect(changed).toHaveBeenCalledOnce();
});

it.each(["directory switch", "watcher retry"])("ignores errors from an old watcher after a %s", async (operation) => {
	const previous = repo("previous");
	const current = provider(previous);
	const old = watchers[0];
	if (operation === "directory switch") current.setCwd(repo("next"));
	else {
		old.watcher.emit("error", new Error("Resource temporarily unavailable"));
		await vi.advanceTimersByTimeAsync(5000);
	}
	const replacements = watchers.slice(2);
	expect(replacements).toHaveLength(2);
	const calls = watch.mock.calls.length;
	old.watcher.emit("error", new Error("Late error from a closed watcher"));
	expect(replacements.every(({ close }) => close.mock.calls.length === 0)).toBe(true);
	await vi.advanceTimersByTimeAsync(5000);
	expect(watch).toHaveBeenCalledTimes(calls);
});

it("does not recreate watchers if a late directory update arrives after disposal", async () => {
	const current = provider(repo("previous"));
	current.dispose();
	const calls = watch.mock.calls.length;
	current.setCwd(repo("next"));
	await vi.advanceTimersByTimeAsync(10000);
	expect(watch).toHaveBeenCalledTimes(calls);
	expect([...polls.values()].every((listeners) => listeners.size === 0)).toBe(true);
});

it("retries a synchronous watcher failure once and cancels the retry on disposal", async () => {
	watch.mockImplementationOnce(() => {
		throw new Error("Resource temporarily unavailable");
	});
	const current = provider(repo("retry"));
	expect(watch).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(4999);
	expect(watch).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(1);
	expect(watch).toHaveBeenCalledTimes(3);
	watchers[0].watcher.emit("error", new Error("Resource temporarily unavailable"));
	current.dispose();
	await vi.advanceTimersByTimeAsync(10000);
	expect(watch).toHaveBeenCalledTimes(3);
});

it.each([false, true])(
	"refreshes branch changes missed during watcher recovery (still failing: %s)",
	async (stillFailing) => {
		const path = repo("missed-change");
		const current = provider(path);
		expect(current.getGitBranch()).toBe("main");
		const changed = vi.fn();
		current.onBranchChange(changed);
		watchers[0].watcher.emit("error", new Error("Resource temporarily unavailable"));
		if (stillFailing) {
			watch.mockImplementation(() => {
				throw new Error("Resource temporarily unavailable");
			});
		}
		// No watcher can report this write; a successful re-arm does not replay it either.
		writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/next\n");
		await vi.advanceTimersByTimeAsync(5501);
		expect(current.getGitBranch()).toBe("next");
		expect(changed).toHaveBeenCalledOnce();
	},
);

it("keeps the WSL HEAD polling fallback active while native watcher recovery is pending", async () => {
	vi.spyOn(gitPaths, "shouldPollGitHead").mockReturnValue(true);
	watch.mockImplementationOnce(() => {
		throw new Error("Resource temporarily unavailable");
	});
	const path = repo("polling");
	const current = provider(path);
	expect(current.getGitBranch()).toBe("main");
	const head = join(path, ".git", "HEAD");
	expect(polls.get(head)?.size).toBe(1);
	writeFileSync(head, "ref: refs/heads/next\n");
	expect(watchFileChanges).toHaveBeenCalledWith(head, expect.any(Function), { poll: true, intervalMs: 5000 });
	for (const listener of polls.get(head) ?? []) listener();
	await vi.advanceTimersByTimeAsync(501);
	expect(current.getGitBranch()).toBe("next");
	expect(watch).toHaveBeenCalledOnce();
	current.dispose();
	expect(polls.get(head)?.size).toBe(0);
});

it("polls WSL reftable changes when HEAD stays unchanged and native watchers stay silent", async () => {
	vi.spyOn(gitPaths, "shouldPollGitHead").mockReturnValue(true);
	vi.spyOn(gitPaths, "resolveBranchWithGitSync").mockReturnValue("main");
	vi.spyOn(gitPaths, "resolveBranchWithGitAsync").mockResolvedValue("next");
	const path = repo("wsl-reftable");
	writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
	const current = provider(path);
	expect(current.getGitBranch()).toBe("main");
	const tables = join(path, ".git", "reftable", "tables.list");
	expect(polls.get(tables)?.size).toBe(1);
	writeFileSync(tables, "next-table\n");
	for (const listener of polls.get(tables) ?? []) listener();
	await vi.advanceTimersByTimeAsync(501);
	expect(current.getGitBranch()).toBe("next");
	current.dispose();
	expect(polls.get(tables)?.size).toBe(0);
});
