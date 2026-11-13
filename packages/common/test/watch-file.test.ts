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
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("watchFileChanges", () => {
	it("sees a write and then repeated atomic replacements without polling, and stops when closed", async () => {
		const dir = tempDir();
		const file = path.join(dir, "auth.json");
		fs.writeFileSync(file, "{}");
		const polls = vi.spyOn(fs, "watchFile");
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
		const unwatch = vi.spyOn(fs, "unwatchFile");
		const onChange = watch(file, { intervalMs: 20 });
		fs.mkdirSync(dir);
		replace(file, "{}");
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 });
		// The native watcher took over: polling stopped, and a later replacement is still seen.
		await vi.waitFor(() => expect(unwatch).toHaveBeenCalled(), { timeout: 3000 });
		onChange.mockClear();
		replace(file, '{"a":1}');
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 });
	});

	it("polls from the start where the native watcher is unreliable, replacements included", async () => {
		const dir = tempDir();
		const file = path.join(dir, "HEAD");
		fs.writeFileSync(file, "ref: refs/heads/main\n");
		const native = vi.spyOn(fs, "watch");
		const onChange = watch(file, { poll: true, intervalMs: 20 });
		// The first stat is the baseline a change is measured against.
		await settle(100);
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
		const polls = vi.spyOn(fs, "watchFile");
		const onChange = watch(file, { intervalMs: 20 });
		watchers[0].emit("error", new Error("EIO"));
		expect(polls).toHaveBeenCalledOnce();
		await settle();
		onChange.mockClear();
		replace(file, '{"changed":true}');
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 });
		expect(watchers).toHaveLength(1);
	});
});
