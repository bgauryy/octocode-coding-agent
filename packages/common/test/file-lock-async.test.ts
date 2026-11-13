import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicWriteFileUnlocked } from "../src/atomic-file.ts";
import { withFileLock, withFileLockSync, withFileWriteLock } from "../src/file-write-lock.ts";
import { recordLockOwner } from "../src/lock-owner.ts";

const dirs: string[] = [];
function tempFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-lock-async-"));
	dirs.push(dir);
	return path.join(dir, "view.txt");
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("withFileLock", () => {
	it.each(["projection", "mutation"] as const)(
		"publishes %s lock ownership before the update without synchronous writes",
		async (kind) => {
			const file = tempFile();
			const syncWrite = vi.spyOn(fs, "writeFileSync");
			const inspect = async () => {
				const [owner] = (await fs.promises.readdir(path.dirname(file))).filter((name) => name.endsWith(".owner"));
				expect(owner).toBeDefined();
				expect(JSON.parse(await fs.promises.readFile(path.join(path.dirname(file), owner), "utf8"))).toMatchObject({
					pid: process.pid,
				});
			};
			if (kind === "projection") await withFileLock(file, inspect);
			else await withFileWriteLock(file, inspect);
			expect(syncWrite).not.toHaveBeenCalled();
			expect(await fs.promises.readdir(path.dirname(file))).toEqual([]);
		},
	);

	it("replaces an orphaned prior owner's sidecar with the acquired directory's owner", async () => {
		const file = tempFile();
		const lock = `${file}.lock`;
		fs.mkdirSync(lock);
		recordLockOwner(lock);
		const previous = fs.readFileSync(`${lock}.owner`, "utf8");
		fs.renameSync(lock, `${lock}.old`);
		await withFileLock(file, async () => {
			const current = fs.readFileSync(`${lock}.owner`, "utf8");
			expect(current).not.toBe(previous);
			const stat = fs.statSync(lock, { bigint: true });
			expect(JSON.parse(current).dir).toBe(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`);
		});
		expect(fs.existsSync(`${lock}.owner`)).toBe(false);
	});

	it("preserves a matching owner record published while its own publication was pending", async () => {
		const file = tempFile();
		const lock = `${file}.lock`;
		const link = fs.promises.link;
		let current = "";
		let forget = () => {};
		vi.spyOn(fs.promises, "link").mockImplementation(async (...args) => {
			forget = recordLockOwner(lock);
			current = fs.readFileSync(`${lock}.owner`, "utf8");
			return link(...args);
		});
		await withFileLock(file, async () => {
			expect(fs.readFileSync(`${lock}.owner`, "utf8")).toBe(current);
		});
		expect(fs.readFileSync(`${lock}.owner`, "utf8")).toBe(current);
		forget();
	});

	it("leaves a successor's metadata and lock intact when the old asynchronous holder releases", async () => {
		const file = tempFile();
		const lock = `${file}.lock`;
		let forgetSuccessor = () => {};
		let successor = "";
		await withFileLock(file, async () => {
			fs.rmdirSync(lock);
			fs.mkdirSync(lock);
			forgetSuccessor = recordLockOwner(lock);
			successor = fs.readFileSync(`${lock}.owner`, "utf8");
		});
		expect(fs.readFileSync(`${lock}.owner`, "utf8")).toBe(successor);
		expect(fs.statSync(lock).isDirectory()).toBe(true);
		forgetSuccessor();
	});

	it("cancels before mutation and releases ownership when aborted during asynchronous publication", async () => {
		const file = tempFile();
		const controller = new AbortController();
		const writeFile = fs.promises.writeFile;
		let resume = () => {};
		const held = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let publishing = () => {};
		const started = new Promise<void>((resolve) => {
			publishing = resolve;
		});
		vi.spyOn(fs.promises, "writeFile").mockImplementation(async (...args) => {
			if (String(args[0]).includes(".owner.pending-")) {
				publishing();
				await held;
			}
			return writeFile(...args);
		});
		const mutate = vi.fn(async () => "written");
		const pending = withFileWriteLock(file, mutate, controller.signal);
		await started;
		controller.abort(new Error("cancelled during publication"));
		resume();
		await expect(pending).rejects.toThrow("cancelled during publication");
		expect(mutate).not.toHaveBeenCalled();
		expect(await fs.promises.readdir(path.dirname(file))).toEqual([]);
	});

	it.each(["projection", "mutation"] as const)(
		"refuses a %s update after takeover during owner publication and preserves the successor",
		async (kind) => {
			const file = tempFile();
			const writeFile = fs.promises.writeFile;
			let resume = () => {};
			const held = new Promise<void>((resolve) => {
				resume = resolve;
			});
			let publishing = (_lock: string) => {};
			const started = new Promise<string>((resolve) => {
				publishing = resolve;
			});
			vi.spyOn(fs.promises, "writeFile").mockImplementation(async (...args) => {
				const pendingAt = String(args[0]).indexOf(".owner.pending-");
				if (pendingAt >= 0) {
					publishing(String(args[0]).slice(0, pendingAt));
					await held;
				}
				return writeFile(...args);
			});
			const mutate = vi.fn(async () => "written");
			const pending = kind === "projection" ? withFileLock(file, mutate) : withFileWriteLock(file, mutate);
			const lock = await started;
			fs.rmdirSync(lock);
			fs.mkdirSync(lock);
			const forgetSuccessor = recordLockOwner(lock);
			const successor = fs.readFileSync(`${lock}.owner`, "utf8");
			resume();
			await expect(pending).rejects.toMatchObject({ code: "ECOMPROMISED" });
			expect(mutate).not.toHaveBeenCalled();
			expect(fs.readFileSync(`${lock}.owner`, "utf8")).toBe(successor);
			expect(fs.statSync(lock).isDirectory()).toBe(true);
			expect(fs.readdirSync(path.dirname(file)).sort()).toEqual([path.basename(lock), `${path.basename(lock)}.owner`]);
			forgetSuccessor();
		},
	);

	it("takes the same lock as withFileLockSync: each holder makes the other fail with ELOCKED at once", async () => {
		const file = tempFile();
		await withFileLock(file, async () => {
			expect(() => withFileLockSync(file, () => "second", { attempts: 1 })).toThrow(
				expect.objectContaining({ code: "ELOCKED" }),
			);
		});
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
		// Another process inside its synchronous hold: the lock directory exists.
		fs.mkdirSync(`${file}.lock`);
		await expect(withFileLock(file, async () => "second")).rejects.toMatchObject({ code: "ELOCKED" });
		fs.rmdirSync(`${file}.lock`);
		expect(await withFileLock(file, async () => "free")).toBe("free");
	});

	it("reports a takeover through assertHeld, writes nothing, and leaves the successor's lock in place", async () => {
		const file = tempFile();
		fs.writeFileSync(file, "old");
		const lock = `${file}.lock`;
		await expect(
			withFileLock(file, async (assertHeld) => {
				await assertHeld();
				// Another process judged this holder stale and took over: a new lock directory.
				fs.rmdirSync(lock);
				fs.mkdirSync(lock);
				await atomicWriteFileUnlocked(file, "new", { beforeCommit: assertHeld });
			}),
		).rejects.toMatchObject({ code: "ECOMPROMISED" });
		expect(fs.readFileSync(file, "utf8")).toBe("old");
		expect(fs.existsSync(lock)).toBe(true);
		expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(["view.txt", "view.txt.lock"]);
	});

	it("releases the lock when the update throws", async () => {
		const file = tempFile();
		await expect(
			withFileLock(file, async () => {
				throw new Error("update failed");
			}),
		).rejects.toThrow("update failed");
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
	});
});

describe("atomicWriteFileUnlocked", () => {
	it("replaces the file whole, keeping the requested mode, and writes nothing when beforeCommit throws", async () => {
		const file = tempFile();
		await atomicWriteFileUnlocked(file, "first\n", { mode: 0o600 });
		expect(fs.readFileSync(file, "utf8")).toBe("first\n");
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		await expect(
			atomicWriteFileUnlocked(file, "second\n", {
				beforeCommit: async () => {
					throw new Error("refused");
				},
			}),
		).rejects.toThrow("refused");
		expect(fs.readFileSync(file, "utf8")).toBe("first\n");
		expect(fs.readdirSync(path.dirname(file))).toEqual(["view.txt"]);
	});
});
