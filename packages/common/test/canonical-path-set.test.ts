import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalPath } from "../src/canonical-path.ts";
import { canonicalPaths, forgetCanonicalPaths } from "../src/canonical-path-set.ts";

let root: string;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-canonical-set-")));
	forgetCanonicalPaths();
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(root, { recursive: true, force: true });
});

/** The remembered answer must equal a fresh `canonicalPath` of every path, whatever changed in between. */
const expectFresh = (files: string[]) =>
	expect(canonicalPaths(files)).toEqual(files.map((file) => canonicalPath(file)));

describe("canonicalPaths", () => {
	it("reuses a list while nothing it resolves through changes", () => {
		fs.mkdirSync(path.join(root, "home", ".aws"), { recursive: true });
		const files = [path.join(root, "home", ".aws", "credentials"), path.join(root, "home", ".netrc")];
		// Parallel tests create siblings under TMPDIR: freeze stamps for this unchanged-filesystem case only.
		const stat = fs.statSync;
		const stamps = new Map<fs.PathLike, fs.Stats | fs.BigIntStats | undefined>();
		vi.spyOn(fs, "statSync").mockImplementation((file: fs.PathLike, options?: fs.StatOptions) => {
			if (!stamps.has(file)) stamps.set(file, stat(file, options));
			return stamps.get(file);
		});
		expectFresh(files);
		const realpath = vi.spyOn(fs.realpathSync, "native");
		expectFresh(files);
		// Only the fresh comparison above canonicalized: the remembered list did not.
		const calls = realpath.mock.calls.length;
		canonicalPaths(files);
		expect(realpath.mock.calls.length).toBe(calls);
	});

	it("answers again when a missing folder appears as a symlink", () => {
		const home = path.join(root, "home");
		const elsewhere = path.join(root, "elsewhere");
		fs.mkdirSync(home);
		fs.mkdirSync(elsewhere);
		const files = [path.join(home, ".aws", "credentials")];
		expectFresh(files);
		fs.symlinkSync(elsewhere, path.join(home, ".aws"));
		expectFresh(files);
		expect(canonicalPaths(files)[0]).toBe(path.join(elsewhere, "credentials"));
	});

	it("answers again when a symlink is retargeted, also one in the middle of a chain", () => {
		const home = path.join(root, "home");
		for (const dir of ["home", "a", "b", "links"]) fs.mkdirSync(path.join(root, dir));
		fs.symlinkSync(path.join(root, "a"), path.join(root, "links", "hop"));
		fs.symlinkSync(path.join(root, "links", "hop"), path.join(home, ".kube"));
		const files = [path.join(home, ".kube", "config")];
		expectFresh(files);
		expect(canonicalPaths(files)[0]).toBe(path.join(root, "a", "config"));
		// Only the middle link moves: the home folder and the first link stay as they were.
		fs.rmSync(path.join(root, "links", "hop"));
		fs.symlinkSync(path.join(root, "b"), path.join(root, "links", "hop"));
		expectFresh(files);
		expect(canonicalPaths(files)[0]).toBe(path.join(root, "b", "config"));
	});

	it("answers again when the file itself is created as a symlink", () => {
		fs.mkdirSync(path.join(root, "home", ".aws"), { recursive: true });
		fs.writeFileSync(path.join(root, "target"), "x");
		const files = [path.join(root, "home", ".aws", "credentials")];
		expectFresh(files);
		fs.symlinkSync(path.join(root, "target"), files[0]);
		expectFresh(files);
		expect(canonicalPaths(files)[0]).toBe(path.join(root, "target"));
	});

	it("follows a dangling link and a `..` after a link as `canonicalPath` does", () => {
		fs.mkdirSync(path.join(root, "real", "inner"), { recursive: true });
		fs.symlinkSync(path.join(root, "real", "inner"), path.join(root, "link"));
		fs.symlinkSync(path.join(root, "nowhere"), path.join(root, "dangling"));
		const files = [path.join(root, "link", "..", "x"), path.join(root, "dangling", "y")];
		expectFresh(files);
		fs.mkdirSync(path.join(root, "nowhere"));
		expectFresh(files);
	});

	it("never remembers a list with a relative path or a symlink loop", () => {
		fs.symlinkSync(path.join(root, "loop-b"), path.join(root, "loop-a"));
		fs.symlinkSync(path.join(root, "loop-a"), path.join(root, "loop-b"));
		for (const files of [[path.join(root, "loop-a", "x")], ["relative/x"]]) {
			expectFresh(files);
			const realpath = vi.spyOn(fs.realpathSync, "native");
			canonicalPaths(files);
			expect(realpath).toHaveBeenCalled();
			realpath.mockRestore();
		}
	});
});
