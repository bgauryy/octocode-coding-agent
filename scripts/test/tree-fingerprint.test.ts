import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { changedPaths, fingerprintTree, recentlyEdited, staleTreeReport } from "./tree-fingerprint.ts";

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
const write = (file: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), text);
};

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "tree-fp-"));
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	write("a.txt", "one");
	git("add", ".");
	git("commit", "-qm", "init");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("fingerprintTree", () => {
	it("is stable on an untouched tree and reports nothing", () => {
		const before = fingerprintTree(repo);
		const after = fingerprintTree(repo);
		assert.equal(before.hash, after.hash);
		assert.equal(staleTreeReport(before, after, "rerun"), undefined);
	});

	it("changes on a modify", () => {
		const before = fingerprintTree(repo);
		write("a.txt", "two!");
		const after = fingerprintTree(repo);
		assert.notEqual(before.hash, after.hash);
		assert.deepEqual(changedPaths(before, after), ["a.txt"]);
		assert.match(staleTreeReport(before, after, "rerun") ?? "", /^tree changed during run: 1 files\n {2}a\.txt/);
	});

	it("changes on a create", () => {
		const before = fingerprintTree(repo);
		write("new file.txt", "x");
		assert.deepEqual(changedPaths(before, fingerprintTree(repo)), ["new file.txt"]);
	});

	it("changes on a stage", () => {
		write("a.txt", "two!");
		const before = fingerprintTree(repo);
		git("add", "a.txt");
		const after = fingerprintTree(repo);
		assert.notEqual(before.hash, after.hash);
		assert.deepEqual(changedPaths(before, after), ["a.txt"]);
	});

	it("sees a deletion", () => {
		const before = fingerprintTree(repo);
		fs.rmSync(path.join(repo, "a.txt"));
		assert.deepEqual(changedPaths(before, fingerprintTree(repo)), ["a.txt"]);
	});

	it("ignores .octocode, build output and coverage", () => {
		write("packages/x/keep.txt", "x");
		write("coverage/keep.txt", "x");
		write(".octocode/keep.txt", "x");
		git("add", ".");
		git("commit", "-qm", "dirs");
		const before = fingerprintTree(repo);
		write(".octocode/agent/tmp/log.txt", "x");
		write("packages/x/dist/out.js", "x");
		write("coverage/lcov.info", "x");
		assert.equal(fingerprintTree(repo).hash, before.hash);
	});
});

describe("recentlyEdited", () => {
	it("lists tracked edits inside the window but not untracked files", () => {
		write("a.txt", "two!");
		write("fresh.txt", "x");
		const tree = fingerprintTree(repo);
		assert.deepEqual(recentlyEdited(tree, Date.now(), 10_000), ["a.txt"]);
		assert.deepEqual(recentlyEdited(tree, Date.now() + 60_000, 10_000), []);
	});
});
