import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
	FILE_INDEX_CAP,
	FILE_INDEX_REFRESH_MS,
	getFileIndex,
	getFileIndexStatus,
	resetFileIndexCache,
} from "../src/autocomplete/file-index.ts";

const skip = process.platform === "win32";

describe("file index", { skip }, () => {
	let root = "";
	let cwd = "";

	const write = (relative: string, contents = "x") => {
		const full = join(cwd, relative);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, contents);
	};

	/** A fake fd that logs each spawn and prints `body` (a shell snippet). */
	const fakeFd = (body: string): string => {
		const script = join(root, "fd");
		writeFileSync(script, `#!/bin/sh\necho spawned >> "${join(root, "spawns.log")}"\n${body}\n`);
		chmodSync(script, 0o755);
		return script;
	};
	const spawns = () => {
		try {
			return readFileSync(join(root, "spawns.log"), "utf-8").split("\n").filter(Boolean).length;
		} catch {
			return 0;
		}
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "octocode-file-index-"));
		cwd = join(root, "cwd");
		mkdirSync(cwd);
		resetFileIndexCache();
	});

	afterEach(() => {
		mock.timers.reset();
		mock.restoreAll();
		resetFileIndexCache();
		rmSync(root, { recursive: true, force: true });
	});

	it("streams fd output, strips directory slashes and skips .git and control characters", async () => {
		const fd = fakeFd(`printf 'src/\\nsrc/a.ts\\n.git/config\\nbad\\033name\\nREADME.md\\n'`);
		const entries = await getFileIndex(cwd, fd);
		assert.deepStrictEqual(entries, [
			{ path: "src", isDirectory: true },
			{ path: "src/a.ts", isDirectory: false },
			{ path: "README.md", isDirectory: false },
		]);
		assert.deepStrictEqual(getFileIndexStatus(cwd), { state: "ready", count: 3, truncated: false, source: "fd" });
	});

	it("does not spawn fd again for a second request within the refresh window", async () => {
		const fd = fakeFd(`printf 'a.ts\\n'`);
		await getFileIndex(cwd, fd);
		await getFileIndex(cwd, fd);
		await getFileIndex(cwd, fd);
		assert.strictEqual(spawns(), 1);
	});

	it("shares one build between concurrent first requests", async () => {
		const fd = fakeFd(`printf 'a.ts\\n'`);
		await Promise.all([getFileIndex(cwd, fd), getFileIndex(cwd, fd)]);
		assert.strictEqual(spawns(), 1);
	});

	it("stops at the cap and reports truncation", async () => {
		const fd = fakeFd(`seq 1 ${FILE_INDEX_CAP + 500} | sed 's/^/f/'`);
		const entries = await getFileIndex(cwd, fd);
		assert.strictEqual(entries.length, FILE_INDEX_CAP);
		assert.strictEqual(getFileIndexStatus(cwd).truncated, true);
	});

	it("refreshes in the background after the window and keeps the old index until the new one lands", async () => {
		mock.method(Date, "now", () => 1_000_000);
		const fd = fakeFd(`if [ -f "${join(root, "second")}" ]; then printf 'new.ts\\n'; else printf 'old.ts\\n'; fi`);
		const first = await getFileIndex(cwd, fd);
		assert.deepStrictEqual(
			first.map((entry) => entry.path),
			["old.ts"],
		);
		writeFileSync(join(root, "second"), "");
		mock.method(Date, "now", () => 1_000_000 + FILE_INDEX_REFRESH_MS + 1);
		const during = await getFileIndex(cwd, fd);
		assert.deepStrictEqual(
			during.map((entry) => entry.path),
			["old.ts"],
		);
		let latest = during;
		for (let i = 0; i < 200 && latest[0]?.path !== "new.ts"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			latest = await getFileIndex(cwd, fd);
		}
		assert.strictEqual(latest[0]?.path, "new.ts");
		assert.strictEqual(spawns(), 2);
	});

	it("falls back to git ls-files plus derived directories without fd", async () => {
		execFileSync("git", ["init", "-q"], { cwd });
		write(".gitignore", "ignored.txt\n");
		write("src/deep/tracked.ts");
		write("src/untracked.ts");
		write("ignored.txt");
		execFileSync("git", ["add", "src/deep/tracked.ts"], { cwd });
		const entries = await getFileIndex(cwd, null);
		const paths = entries.map((entry) => `${entry.path}${entry.isDirectory ? "/" : ""}`).sort();
		assert.deepStrictEqual(paths, [".gitignore", "src/", "src/deep/", "src/deep/tracked.ts", "src/untracked.ts"]);
		assert.strictEqual(getFileIndexStatus(cwd).source, "git");
	});

	it("falls back to git when fd fails", async () => {
		execFileSync("git", ["init", "-q"], { cwd });
		write("only.ts");
		const fd = fakeFd("exit 2");
		const entries = await getFileIndex(cwd, fd);
		assert.deepStrictEqual(
			entries.map((entry) => entry.path),
			["only.ts"],
		);
		assert.strictEqual(getFileIndexStatus(cwd).source, "git");
	});

	it("walks the directory when there is neither fd nor a git repository", async () => {
		write("a/b/c.txt");
		write("node_modules/pkg/index.js");
		const entries = await getFileIndex(cwd, null);
		const paths = entries.map((entry) => entry.path).sort();
		assert.deepStrictEqual(paths, ["a", "a/b", "a/b/c.txt"]);
		assert.strictEqual(getFileIndexStatus(cwd).source, "walk");
	});
});
