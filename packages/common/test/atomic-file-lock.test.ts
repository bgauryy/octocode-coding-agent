import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import lockfile from "proper-lockfile";
import { atomicWriteFile, atomicWriteFileSync, sha256 } from "../src/atomic-file.ts";
import { withFileWriteLock } from "../src/file-write-lock.ts";

const dirs: string[] = [];
function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-lock-"));
	dirs.push(dir);
	const file = path.join(dir, "file.txt");
	fs.writeFileSync(file, "old");
	return file;
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("cooperative file mutation locks", () => {
	it("keeps the old file and removes the temporary file when a synchronous precommit check fails", () => {
		const file = fixture();
		expect(() =>
			atomicWriteFileSync(file, "new", {
				beforeCommit: () => {
					throw new Error("projection path changed");
				},
			}),
		).toThrow("projection path changed");
		expect(fs.readFileSync(file, "utf8")).toBe("old");
		expect(fs.readdirSync(path.dirname(file))).toEqual(["file.txt"]);
	});
	it("allows only one concurrent replacement of the same expected bytes", async () => {
		const file = fixture();
		const outcomes = await Promise.allSettled([
			atomicWriteFile(file, "first", sha256("old")),
			atomicWriteFile(file, "second", sha256("old")),
		]);
		expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(fs.readdirSync(path.dirname(file))).toEqual(["file.txt"]);
	});
	it("cancels lock wait without modifying the file or releasing another holder", async () => {
		const file = fixture();
		await withFileWriteLock(file, async () => {
			const controller = new AbortController();
			const pending = atomicWriteFile(file, "new", sha256("old"), { signal: controller.signal });
			const rejected = expect(pending).rejects.toThrow();
			await new Promise((resolve) => setTimeout(resolve, 100));
			controller.abort();
			await rejected;
			expect(fs.readFileSync(file, "utf8")).toBe("old");
		});
		await atomicWriteFile(file, "after", sha256("old"));
	});
	it("writes through a dangling symlink and supports maximum-length filenames", async () => {
		const file = fixture();
		const dir = path.dirname(file);
		const target = path.join(dir, "missing.txt");
		const alias = path.join(dir, "link.txt");
		fs.symlinkSync(target, alias);
		await atomicWriteFile(alias, "new", null);
		expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
		expect(fs.readFileSync(target, "utf8")).toBe("new");
		const long = path.join(dir, "a".repeat(255));
		await atomicWriteFile(long, "long", null);
		expect(fs.readFileSync(long, "utf8")).toBe("long");
	});
	it("rejects a symlink cycle without replacing either link", async () => {
		const file = fixture();
		const dir = path.dirname(file);
		const first = path.join(dir, "first.txt");
		const second = path.join(dir, "second.txt");
		fs.symlinkSync("second.txt", first);
		fs.symlinkSync("first.txt", second);
		expect(() => atomicWriteFileSync(first, "new")).toThrow();
		await expect(atomicWriteFile(first, "new")).rejects.toThrow();
		expect(fs.lstatSync(first).isSymbolicLink()).toBe(true);
		expect(fs.lstatSync(second).isSymbolicLink()).toBe(true);
	});
	it("preserves mutation errors and identifies committed writes when lock cleanup fails", async () => {
		const file = fixture();
		vi.spyOn(lockfile, "lock").mockResolvedValue(async () => {
			throw new Error("release failed");
		});
		const original = new Error("mutation failed");
		await expect(
			withFileWriteLock(file, async () => {
				throw original;
			}),
		).rejects.toBe(original);
		await expect(atomicWriteFile(file, "new", sha256("old"))).rejects.toMatchObject({ mutationCompleted: true });
		expect(fs.readFileSync(file, "utf8")).toBe("new");
	});
	it("waits for another process, then rejects its stale digest through a symlink alias", async () => {
		const file = fixture();
		const alias = path.join(path.dirname(file), "alias.txt");
		fs.symlinkSync(file, alias);
		const lockModule = new URL("../src/file-write-lock.ts", import.meta.url).href;
		const script = `import fs from 'node:fs'; import {once} from 'node:events'; import {withFileWriteLock} from ${JSON.stringify(lockModule)}; await withFileWriteLock(process.argv[1], async () => { process.stdout.write('locked'); await once(process.stdin, 'data'); fs.writeFileSync(process.argv[1], 'peer'); }); process.stdin.destroy();`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script, file], {
			cwd: path.dirname(fileURLToPath(import.meta.url)),
			stdio: ["pipe", "pipe", "pipe"],
		});
		const closed = once(child, "close");
		try {
			await Promise.race([
				once(child.stdout, "data"),
				closed.then(([code]) => {
					throw new Error(`child exited ${code}`);
				}),
			]);
			const pending = atomicWriteFile(alias, "mine", sha256("old"));
			const rejected = expect(pending).rejects.toThrow(/changed on disk/);
			let settled = false;
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(settled).toBe(false);
			expect(fs.readFileSync(file, "utf8")).toBe("old");
			child.stdin.end("release");
			await rejected;
			expect(fs.readFileSync(file, "utf8")).toBe("peer");
			expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
			expect((await closed)[0]).toBe(0);
		} finally {
			if (child.exitCode === null) child.kill();
			await closed;
		}
	});
});
