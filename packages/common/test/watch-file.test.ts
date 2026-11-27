import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchFileChanges } from "../src/watch-file.ts";

const dirs: string[] = [];
const stops: Array<() => void> = [];
function tempDir(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-watch-file-")));
	dirs.push(dir);
	return dir;
}
function watch(file: string, options?: Parameters<typeof watchFileChanges>[2]) {
	const onChange = vi.fn();
	stops.push(watchFileChanges(file, onChange, options));
	return onChange;
}
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
/** What an atomic save does: write a sibling, rename it over the file (a new inode). */
function replace(file: string, content: string): void {
	const temp = `${file}.tmp-${Math.random().toString(36).slice(2)}`;
	fs.writeFileSync(temp, content);
	fs.renameSync(temp, file);
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const stop of stops.splice(0)) stop();
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("watchFileChanges", () => {
	it("sees a write and then repeated atomic replacements without polling, and stops when closed", async () => {
		const dir = tempDir();
		const file = path.join(dir, "auth.json");
		fs.writeFileSync(file, "{}");
		const polls = vi.spyOn(fs.promises, "stat");
		const onChange = watch(file);
		await settle();
		onChange.mockClear();

		fs.writeFileSync(file, '{"a":1}');
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 });
		// Each replacement swaps the inode: a watcher on the file itself would go deaf after the first one.
		for (const content of ['{"b":1}', '{"c":1}']) {
			onChange.mockClear();
			replace(file, content);
			await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 });
		}
		expect(polls).not.toHaveBeenCalled();

		stops.pop()?.();
		onChange.mockClear();
		replace(file, '{"d":1}');
		await settle();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("ignores other files in the folder and calls once per burst", async () => {
		const dir = tempDir();
		const file = path.join(dir, "settings.json");
		fs.writeFileSync(file, "{}");
		const onChange = watch(file);
		await settle();
		onChange.mockClear();
		fs.writeFileSync(path.join(dir, "other.json"), "{}");
		await settle();
		expect(onChange).not.toHaveBeenCalled();
		replace(file, '{"x":1}');
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 });
		await settle();
		expect(onChange).toHaveBeenCalledOnce();
	});

	it("polls while the folder is missing, then sees the file and re-arms the native watcher", async () => {
		const dir = path.join(tempDir(), "agent");
		const file = path.join(dir, "auth.json");
		const native = vi.spyOn(fs, "watch");
		const polls = vi.spyOn(fs.promises, "stat");
		const onChange = watch(file, { intervalMs: 20 });
		fs.mkdirSync(dir);
		replace(file, "{}");
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 });
		// The native watcher took over: polling stopped, and a later replacement is still seen.
		await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(2), { timeout: 3000 });
		const pollCount = polls.mock.calls.length;
		onChange.mockClear();
		replace(file, '{"a":1}');
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 });
		expect(polls).toHaveBeenCalledTimes(pollCount);
	});

	it.each([false, true])("sees creation included in the first async stat (forced polling: %s)", async (poll) => {
		const dir = path.join(tempDir(), "agent");
		const file = path.join(dir, "auth.json");
		vi.spyOn(fs.promises, "stat").mockImplementationOnce(async () => {
			// Force creation before the first async stat completes, regardless of thread-pool scheduling.
			fs.mkdirSync(dir);
			fs.writeFileSync(file, "{}");
			return fs.statSync(file);
		});
		const native = vi.spyOn(fs, "watch");
		const onChange = watch(file, { intervalMs: 20, poll });
		await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce(), { timeout: 3000 });
		expect(native).toHaveBeenCalledTimes(poll ? 0 : 2);
		onChange.mockClear();
		replace(file, '{"native":true}');
		await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce(), { timeout: 3000 });
	});

	it("keeps one stat in flight and ignores its completion after closing", async () => {
		vi.useFakeTimers();
		const file = path.join(tempDir(), "auth.json");
		fs.writeFileSync(file, "{}");
		const pending = Promise.withResolvers<fs.Stats>();
		const polls = vi.spyOn(fs.promises, "stat").mockReturnValue(pending.promise);
		const native = vi.spyOn(fs, "watch");
		const onChange = watch(file, { intervalMs: 20, poll: true });
		await vi.advanceTimersByTimeAsync(200);
		expect(polls).toHaveBeenCalledOnce();
		stops.pop()?.();
		pending.resolve(fs.statSync(file));
		await vi.advanceTimersByTimeAsync(200);
		expect(polls).toHaveBeenCalledOnce();
		expect(native).not.toHaveBeenCalled();
		expect(onChange).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops the missing-directory rearm retry when closed", async () => {
		const dir = path.join(tempDir(), "agent");
		const file = path.join(dir, "auth.json");
		const native = vi.spyOn(fs, "watch");
		const onChange = watch(file, { intervalMs: 20 });
		stops.pop()?.();
		native.mockClear();
		fs.mkdirSync(dir);
		fs.writeFileSync(file, "{}");
		await settle();
		expect(native).not.toHaveBeenCalled();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("polls from the start where the native watcher is unreliable, replacements included", async () => {
		const dir = tempDir();
		const file = path.join(dir, "HEAD");
		fs.writeFileSync(file, "ref: refs/heads/main\n");
		const native = vi.spyOn(fs, "watch");
		const onChange = watch(file, { poll: true, intervalMs: 20 });
		// The first stat is the baseline a change is measured against.
		await settle(100);
		onChange.mockClear();
		replace(file, "ref: refs/heads/next-branch\n");
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 });
		expect(native).not.toHaveBeenCalled();
	});

	it("falls back to polling when the native watcher reports an error", async () => {
		const dir = tempDir();
		const file = path.join(dir, "auth.json");
		fs.writeFileSync(file, "{}");
		const watchers: fs.FSWatcher[] = [];
		const real = fs.watch.bind(fs) as (...args: unknown[]) => fs.FSWatcher;
		vi.spyOn(fs, "watch").mockImplementation((...args: unknown[]) => {
			const watcher = real(...args);
			watchers.push(watcher);
			return watcher;
		});
		const polls = vi.spyOn(fs.promises, "stat");
		const onChange = watch(file, { intervalMs: 20 });
		watchers[0].emit("error", new Error("EIO"));
		expect(polls).toHaveBeenCalledOnce();
		await settle();
		onChange.mockClear();
		replace(file, '{"changed":true}');
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 });
		expect(watchers).toHaveLength(1);
	});
	describe("backstop for a silent native watcher", () => {
		function silentWatcher() {
			const closes: Array<() => void> = [];
			vi.spyOn(fs, "watch").mockImplementation((() => {
				const silent = Object.assign(new EventEmitter(), { close: vi.fn() });
				closes.push(silent.close);
				return silent;
			}) as unknown as typeof fs.watch);
			return closes;
		}

		it("adopts another process's save within two backstop intervals while the watcher delivers nothing", async () => {
			const file = path.join(tempDir(), "settings.json");
			fs.writeFileSync(file, "{}");
			silentWatcher();
			const onChange = watch(file, { backstopMs: 40 });
			replace(file, '{"disabled":true}');
			await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce(), { timeout: 40 * 2 + 400 });
			// Later saves are still caught, and an unchanged file is not reported again.
			onChange.mockClear();
			await settle(200);
			expect(onChange).not.toHaveBeenCalled();
			replace(file, '{"disabled":false}');
			await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce(), { timeout: 40 * 2 + 400 });
		});

		it("sees a file created or removed while silent", async () => {
			const file = path.join(tempDir(), "auth.json");
			silentWatcher();
			const onChange = watch(file, { backstopMs: 40 });
			replace(file, "{}");
			await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce(), { timeout: 800 });
			onChange.mockClear();
			fs.rmSync(file);
			await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce(), { timeout: 800 });
		});

		it("stays idle while native events arrive more often than the backstop interval", async () => {
			const file = path.join(tempDir(), "settings.json");
			fs.writeFileSync(file, "{}");
			const polls = vi.spyOn(fs.promises, "stat");
			const onChange = watch(file, { backstopMs: 400 });
			for (let n = 0; n < 6; n++) {
				replace(file, `{"n":${n}}`);
				await settle(120);
			}
			expect(onChange).toHaveBeenCalled();
			expect(polls).not.toHaveBeenCalled();
		});

		it("stops the backstop when closed", async () => {
			vi.useFakeTimers();
			const file = path.join(tempDir(), "settings.json");
			fs.writeFileSync(file, "{}");
			silentWatcher();
			const onChange = watch(file, { backstopMs: 40 });
			stops.pop()?.();
			expect(vi.getTimerCount()).toBe(0);
			replace(file, '{"x":1}');
			await vi.advanceTimersByTimeAsync(500);
			expect(onChange).not.toHaveBeenCalled();
		});
	});
});
