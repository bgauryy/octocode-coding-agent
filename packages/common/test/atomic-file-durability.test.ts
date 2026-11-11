import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicWriteFile, atomicWriteFileSync } from "../src/atomic-file.ts";

const dirs: string[] = [];
function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-durability-"));
	dirs.push(dir);
	const file = path.join(dir, "file.txt");
	fs.writeFileSync(file, "old");
	return file;
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Every fsync of the asynchronous writer goes through a FileHandle: count them by what they flushed. */
async function countHandleSyncs(run: () => Promise<void>): Promise<{ files: number; dirs: number }> {
	const probe = await fs.promises.open(os.tmpdir(), "r");
	const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
	await probe.close();
	const counts = { files: 0, dirs: 0 };
	const original = proto.sync;
	vi.spyOn(proto, "sync").mockImplementation(async function (this: fs.promises.FileHandle) {
		if ((await this.stat()).isDirectory()) counts.dirs++;
		else counts.files++;
		return original.call(this);
	});
	await run();
	return counts;
}

describe("atomic write durability", () => {
	it("flushes the data and the directory by default, the data only for `data`, nothing for `none` (sync)", () => {
		const file = fixture();
		const fsync = vi.spyOn(fs, "fsyncSync");
		atomicWriteFileSync(file, "all");
		const all = fsync.mock.calls.length;
		fsync.mockClear();
		atomicWriteFileSync(file, "data", { durability: "data" });
		const data = fsync.mock.calls.length;
		fsync.mockClear();
		atomicWriteFileSync(file, "none", { durability: "none", mode: 0o600 });
		expect([all, data, fsync.mock.calls.length]).toEqual([2, 1, 0]);
		expect(fs.readFileSync(file, "utf8")).toBe("none");
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(fs.readdirSync(path.dirname(file))).toEqual(["file.txt"]);
	});

	it("skips the same fsyncs asynchronously and still replaces the file whole", async () => {
		const file = fixture();
		expect(await countHandleSyncs(() => atomicWriteFile(file, "all"))).toEqual({ files: 1, dirs: 1 });
		vi.restoreAllMocks();
		expect(await countHandleSyncs(() => atomicWriteFile(file, "data", undefined, { durability: "data" }))).toEqual({
			files: 1,
			dirs: 0,
		});
		vi.restoreAllMocks();
		expect(await countHandleSyncs(() => atomicWriteFile(file, "none", undefined, { durability: "none" }))).toEqual({
			files: 0,
			dirs: 0,
		});
		expect(fs.readFileSync(file, "utf8")).toBe("none");
		expect(fs.readdirSync(path.dirname(file)).filter((name) => !name.endsWith(".lock"))).toEqual(["file.txt"]);
	});
});
