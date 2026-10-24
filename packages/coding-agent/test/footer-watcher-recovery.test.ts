import { EventEmitter } from "node:events";
import type * as Fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, type Stats, type WatchListener, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type PollListener = (current: Stats, previous: Stats) => void;
const { watch, watchFile, unwatchFile, polls } = vi.hoisted(() => ({
	watch: vi.fn(),
	watchFile: vi.fn(),
	unwatchFile: vi.fn(),
	polls: new Map<string, Set<PollListener>>(),
}));
vi.mock("node:fs", async (original) => ({
	...(await original<typeof Fs>()),
	watch,
	watchFile,
	unwatchFile,
}));
vi.mock("fs", async (original) => ({ ...(await original<typeof Fs>()), watch, watchFile, unwatchFile }));

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
	watchFile.mockImplementation((path: string, _options: unknown, listener: PollListener) => {
		const listeners = polls.get(path) ?? new Set<PollListener>();
		listeners.add(listener);
		polls.set(path, listeners);
	});
	unwatchFile.mockImplementation((path: string, listener?: PollListener) => {
		if (listener) polls.get(path)?.delete(listener);
		else polls.delete(path);
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

it("disposing one footer preserves another footer's reftable polling listener", async () => {
	const path = repo("shared");
	const first = provider(path);
	const second = provider(path);
	expect(second.getGitBranch()).toBe("main");
	const changed = vi.fn();
	second.onBranchChange(changed);
	const tables = join(path, ".git", "reftable", "tables.list");
	expect(polls.get(tables)?.size).toBe(2);
	first.dispose();
	expect(polls.get(tables)?.size).toBe(1);
	writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/next\n");
	for (const listener of polls.get(tables) ?? []) listener({ mtimeMs: 2 } as Stats, { mtimeMs: 1 } as Stats);
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
	const replacements = watchers.slice(3);
	expect(replacements).toHaveLength(3);
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
	expect(watch).toHaveBeenCalledTimes(4);
	watchers[0].watcher.emit("error", new Error("Resource temporarily unavailable"));
	current.dispose();
	await vi.advanceTimersByTimeAsync(10000);
	expect(watch).toHaveBeenCalledTimes(4);
});

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
	for (const listener of polls.get(head) ?? []) listener({ mtimeMs: 2 } as Stats, { mtimeMs: 1 } as Stats);
	await vi.advanceTimersByTimeAsync(501);
	expect(current.getGitBranch()).toBe("next");
	expect(watch).toHaveBeenCalledOnce();
});
