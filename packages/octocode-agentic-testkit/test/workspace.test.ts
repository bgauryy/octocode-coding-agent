import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessRun } from "../src/process.ts";
import { sandboxAvailable } from "../src/sandbox.ts";
import {
	diffWorkspace,
	globRegExp,
	runVerifier,
	snapshotWorkspace,
	type VerifierResult,
	type WorkspaceDiff,
} from "../src/workspace.ts";

const dirs: string[] = [];
const tmp = (): string => {
	const d = mkdtempSync(join(tmpdir(), "testkit-ws-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(files: Record<string, string | Buffer>): string {
	const d = tmp();
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(join(d, rel, ".."), { recursive: true });
		writeFileSync(join(d, rel), content);
	}
	return d;
}

const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const node = process.execPath;
const run = (dir: string): ProcessRun => ({
	exitCode: 0,
	signal: null,
	timedOut: false,
	durationMs: 1,
	stdout: "",
	stderr: "",
	events: [],
	home: dir,
	workspace: dir,
});

describe("globRegExp", () => {
	it.each([
		["src/**", "src/a.ts", true],
		["src/**", "src/a/b/c.ts", true],
		["src/**", "srcx/a.ts", false],
		["src/**", "a.txt", false],
		["*.ts", "a.ts", true],
		["*.ts", "src/a.ts", false],
		["**/*.ts", "a.ts", true],
		["**/*.ts", "src/deep/a.ts", true],
		["**/node_modules", "node_modules", true],
		["**/node_modules", "pkg/node_modules", true],
		["a?.txt", "ab.txt", true],
		["a?.txt", "a/.txt", false],
		["a.txt", "aXtxt", false],
	])("%s against %s is %s", (glob, path, want) => {
		expect(globRegExp(glob).test(path)).toBe(want);
	});
});

describe("snapshotWorkspace / diffWorkspace", () => {
	it("hashes every file, keeps small text, skips .git and node_modules at any depth", () => {
		const bin = Buffer.from([0, 1, 2, 255]);
		const d = workspace({
			"a.txt": "hello",
			"src/b.ts": "export {}",
			"bin.dat": bin,
			"big.txt": "x".repeat(50),
			".git/HEAD": "ref",
			"node_modules/x/index.js": "",
			"pkg/node_modules/y.js": "",
		});
		symlinkSync("a.txt", join(d, "link"));
		const s = snapshotWorkspace(d, { maxTextBytes: 20 });
		expect(Object.keys(s.files)).toEqual(["a.txt", "big.txt", "bin.dat", "link", "src/b.ts"]);
		expect(s.files["a.txt"]).toEqual({ sha256: sha("hello"), size: 5, text: "hello" });
		expect(s.files["bin.dat"]).toEqual({ sha256: sha(bin), size: 4 });
		expect(s.files["big.txt"]).toEqual({ sha256: sha("x".repeat(50)), size: 50 });
		expect(s.files.link).toEqual({ sha256: sha("a.txt"), size: 5, link: "a.txt" });
	});

	it("`ignore` replaces the default", () => {
		const d = workspace({ ".git/HEAD": "ref", "dist/out.js": "", "a.txt": "" });
		expect(Object.keys(snapshotWorkspace(d, { ignore: ["dist"] }).files)).toEqual([".git/HEAD", "a.txt"]);
	});

	it("throws for a missing directory", () => {
		expect(() => snapshotWorkspace(join(tmp(), "nope"))).toThrow(/workspace directory does not exist/);
	});

	it("diffs added, removed and changed files", () => {
		const d = workspace({ "keep.txt": "same", "edit.txt": "v1", "drop.txt": "x" });
		const before = snapshotWorkspace(d);
		writeFileSync(join(d, "edit.txt"), "v2");
		rmSync(join(d, "drop.txt"));
		writeFileSync(join(d, "new.txt"), "n");
		expect(diffWorkspace(before, snapshotWorkspace(d))).toEqual({
			added: ["new.txt"],
			removed: ["drop.txt"],
			changed: ["edit.txt"],
		});
		expect(diffWorkspace(before, before)).toEqual({ added: [], removed: [], changed: [] });
	});
});

describe("runVerifier", () => {
	const exit = (code: number, extra = ""): string[] => ["-e", `${extra}process.exit(${code})`];
	const reward = (v: string): string => `require("fs").writeFileSync("reward.txt",${JSON.stringify(v)});`;

	it("passes on exit 0 and fails otherwise", async () => {
		const d = tmp();
		expect(await runVerifier(d, node, ["-e", "console.log('ok')"])).toMatchObject({
			pass: true,
			exitCode: 0,
			stdout: "ok\n",
		});
		expect(await runVerifier(d, node, exit(2))).toMatchObject({ pass: false, exitCode: 2 });
	});

	it("grades by the reward file when the verifier writes one", async () => {
		const d = tmp();
		const o = { rewardFile: "reward.txt" };
		expect(await runVerifier(d, node, exit(1, reward("1")), o)).toMatchObject({ pass: true, reward: 1 });
		expect(await runVerifier(d, node, exit(0, reward("0.5\n")), o)).toMatchObject({ pass: false, reward: 0.5 });
		const none = await runVerifier(d, node, exit(0), o);
		expect(none).toMatchObject({ pass: true });
		expect(none).not.toHaveProperty("reward");
	});

	it("removes a reward file the agent planted before the verifier runs", async () => {
		const d = workspace({ "reward.txt": "1" });
		const r = await runVerifier(d, node, exit(1), { rewardFile: "reward.txt" });
		expect(r).toMatchObject({ pass: false, exitCode: 1 });
		expect(r).not.toHaveProperty("reward");
		expect(existsSync(join(d, "reward.txt"))).toBe(false);
	});

	it("throws for a reward file that holds no number, or a path outside the workspace", async () => {
		const d = tmp();
		await expect(runVerifier(d, node, exit(0, reward("great")), { rewardFile: "reward.txt" })).rejects.toThrow(
			/holds no number/,
		);
		await expect(runVerifier(d, node, exit(0), { rewardFile: "../reward.txt" })).rejects.toThrow(/stay inside it/);
		await expect(runVerifier(join(d, "nope"), node, exit(0))).rejects.toThrow(/workspace directory does not exist/);
	});

	it("fails a verifier that times out", async () => {
		const r = await runVerifier(tmp(), node, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 500 });
		expect(r).toMatchObject({ pass: false, timedOut: true });
	});

	it.skipIf(sandboxAvailable() !== undefined)("runs in the sandbox when asked: a write outside fails", async () => {
		const d = tmp();
		const ws = join(d, "ws");
		mkdirSync(ws);
		const outside = join(d, "outside.txt");
		const r = await runVerifier(ws, node, ["-e", `require("fs").writeFileSync(${JSON.stringify(outside)},"x")`], {
			sandbox: { root: ws },
		});
		expect(r).toMatchObject({ pass: false });
		expect(r.stderr).toMatch(/EPERM/);
		expect(existsSync(outside)).toBe(false);
	});
});

describe("toHaveWorkspace", () => {
	const files = { "a.txt": "exact text", "src/b.ts": "export const b = 1;\n" };
	const expected = { "a.txt": "exact text", "src/b.ts": /const b = \d/, "gone.txt": null };

	it("passes on a directory, a ProcessRun and a snapshot", () => {
		const d = workspace(files);
		expect(d).toHaveWorkspace(expected);
		expect(run(d)).toHaveWorkspace(expected);
		expect(snapshotWorkspace(d)).toHaveWorkspace(expected);
	});

	it.each([
		["different text", { "a.txt": "other" }, /a\.txt: expected "other", got "exact text"/],
		["a RegExp that does not match", { "src/b.ts": /const c/ }, /src\/b\.ts: expected to match \/const c\//],
		["a file that should not exist", { "a.txt": null }, /a\.txt: expected no file, but it exists/],
		["a missing file", { "missing.txt": "x" }, /missing\.txt: missing/],
		["a directory", { src: "x" }, /src: is a directory/],
	])("fails on %s (directory and snapshot)", (_name, want, message) => {
		const d = workspace(files);
		expect(() => expect(d).toHaveWorkspace(want)).toThrow(message);
		if (!("src" in want)) expect(() => expect(snapshotWorkspace(d)).toHaveWorkspace(want)).toThrow(message);
	});

	it("compares exact text of a large file in a snapshot by hash", () => {
		const d = workspace({ "big.txt": "y".repeat(100) });
		const s = snapshotWorkspace(d, { maxTextBytes: 10 });
		expect(s).toHaveWorkspace({ "big.txt": "y".repeat(100) });
		expect(() => expect(s).toHaveWorkspace({ "big.txt": "z" })).toThrow(/content not kept in the snapshot/);
	});

	it("passes under .not only when something differs", () => {
		const d = workspace(files);
		expect(d).not.toHaveWorkspace({ "a.txt": "other" });
		expect(() => expect(d).not.toHaveWorkspace({ "a.txt": "exact text" })).toThrow(/not to match, but all 1/);
	});

	it("cannot observe a missing directory, also under .not", () => {
		const gone = join(tmp(), "nope");
		expect(() => expect(gone).toHaveWorkspace({ "a.txt": null })).toThrow(/cannot observe: workspace directory/);
		expect(() => expect(gone).not.toHaveWorkspace({ "a.txt": "x" })).toThrow(/cannot observe/);
		expect(() => expect(run(gone)).toHaveWorkspace({ "a.txt": null })).toThrow(/cannot observe/);
		expect(() => expect(42).toHaveWorkspace({ "a.txt": null })).toThrow(/cannot observe: received value/);
	});

	it("cannot observe a RegExp against a snapshot entry without text", () => {
		const s = snapshotWorkspace(workspace({ "bin.dat": Buffer.from([0, 1]) }));
		expect(() => expect(s).not.toHaveWorkspace({ "bin.dat": /x/ })).toThrow(/cannot observe: no text for bin\.dat/);
	});

	it("throws for an empty expectation or a path outside the workspace", () => {
		const d = workspace(files);
		expect(() => expect(d).toHaveWorkspace({})).toThrow(/at least one path/);
		expect(() => expect(d).toHaveWorkspace({ "../x": null })).toThrow(/stay inside it/);
		expect(() => expect(d).toHaveWorkspace({ "/etc/hosts": null })).toThrow(/stay inside it/);
	});
});

describe("toChangeOnly", () => {
	const diff = (d: Partial<WorkspaceDiff>): WorkspaceDiff => ({ added: [], removed: [], changed: [], ...d });

	it("passes when every change matches a glob, and on no change", () => {
		expect(diff({ added: ["src/x.ts"], changed: ["a.txt", "src/deep/y.ts"] })).toChangeOnly(["src/**", "a.txt"]);
		expect(diff({})).toChangeOnly([]);
	});

	it.each([
		["added", diff({ added: ["src/x.ts", "evil.sh"] }), /added evil\.sh/],
		["removed", diff({ removed: ["package.json"] }), /removed package\.json/],
		["changed", diff({ changed: ["b.txt"] }), /changed b\.txt/],
		["nested look-alike", diff({ changed: ["lib/a.txt"] }), /changed lib\/a\.txt/],
	])("fails on a path %s outside the allow-list", (_kind, d, message) => {
		expect(() => expect(d).toChangeOnly(["src/**", "a.txt"])).toThrow(message);
	});

	it("works on a real diff and under .not", () => {
		const d = workspace({ "a.txt": "1" });
		const before = snapshotWorkspace(d);
		writeFileSync(join(d, "b.txt"), "2");
		const changes = diffWorkspace(before, snapshotWorkspace(d));
		expect(changes).not.toChangeOnly(["a.txt"]);
		expect(() => expect(changes).not.toChangeOnly(["*.txt"])).toThrow(/all 1 change\(s\) matched/);
	});

	it("cannot observe a value that is not a diff, also under .not", () => {
		expect(() => expect(snapshotWorkspace(tmp())).toChangeOnly(["**"])).toThrow(/cannot observe: .*WorkspaceDiff/);
		expect(() => expect("dir").not.toChangeOnly([])).toThrow(/cannot observe/);
	});
});

describe("toPassVerifier", () => {
	const result = (r: Partial<VerifierResult>): VerifierResult => ({
		pass: true,
		exitCode: 0,
		timedOut: false,
		stdout: "",
		stderr: "",
		...r,
	});

	it("passes a passing result and fails a failing one with its output", async () => {
		expect(await runVerifier(tmp(), node, ["-e", ""])).toPassVerifier();
		expect(() => expect(result({ pass: false, exitCode: 1, stderr: "1 test failed" })).toPassVerifier()).toThrow(
			/the verifier failed \(exit 1\)[\s\S]*1 test failed/,
		);
		expect(() => expect(result({ pass: false, exitCode: 0, reward: 0.25 })).toPassVerifier()).toThrow(/reward 0\.25/);
		expect(() => expect(result({ pass: false, exitCode: null, timedOut: true })).toPassVerifier()).toThrow(/timed out/);
	});

	it("under .not, fails a passing result", () => {
		expect(result({ pass: false, exitCode: 1 })).not.toPassVerifier();
		expect(() => expect(result({})).not.toPassVerifier()).toThrow(/expected the verifier to fail/);
	});

	it("cannot observe a value that is not a verifier result, also under .not", () => {
		expect(() => expect(run(tmp())).toPassVerifier()).toThrow(/cannot observe: .*VerifierResult/);
		expect(() => expect(undefined).not.toPassVerifier()).toThrow(/cannot observe/);
	});
});
