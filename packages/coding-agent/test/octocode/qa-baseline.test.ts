import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dropBaseline, readBaseline, recordBaseline } from "../../src/octocode/backlog/qa-baseline.ts";
import { admitsGap } from "../../src/octocode/backlog/qa-run.ts";
import { diffOf } from "../../src/octocode/subagents/qa-review.ts";

let repo: string;
const git = (...args: string[]) =>
	execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
const write = (name: string, text: string) => fs.writeFileSync(path.join(repo, name), text);

beforeEach(() => {
	repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-qa-baseline-")));
	git("init", "-q");
	write("a.ts", "a1\n");
	write("b.ts", "b1\n");
	git("add", ".");
	git("commit", "-q", "-m", "init");
	// Another agent's edit, staged before the item exists.
	write("a.ts", "a2-before-claim\n");
	git("add", "a.ts");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("the QA baseline taken at the claim", () => {
	it("leaves out an edit made before the claim and keeps the item's own", async () => {
		await recordBaseline(repo, "B1");
		write("b.ts", "b2-own\n");
		const baseline = await readBaseline(repo, "B1");
		expect(baseline).toBeDefined();
		const { diff, sinceClaim } = await diffOf(repo, ["a.ts", "b.ts"], baseline);
		expect(sinceClaim).toBe(true);
		expect(diff).toContain("b2-own");
		expect(diff).not.toContain("a2-before-claim");
	});

	it("names a file changed after the claim that the completion does not report", async () => {
		await recordBaseline(repo, "B1");
		write("b.ts", "b2-own\n");
		write("sibling.ts", "new\n");
		const { unreported } = await diffOf(repo, ["b.ts"], await readBaseline(repo, "B1"));
		expect(unreported).toContain("sibling.ts");
		expect(unreported).not.toContain("b.ts");
	});

	it("falls back to the diff against HEAD when no baseline was recorded", async () => {
		expect(await readBaseline(repo, "B9")).toBeUndefined();
		const { diff, unreported, sinceClaim } = await diffOf(repo, ["a.ts"], undefined);
		expect(diff).toContain("a2-before-claim");
		expect(unreported).toBe("");
		expect(sinceClaim).toBe(false);
	});

	// Root writes through read-only folders, so the failing snapshot cannot be staged there.
	it.skipIf(process.getuid?.() === 0)(
		"says it diffed against HEAD when a baseline exists but the tree cannot be read now",
		async () => {
			await recordBaseline(repo, "B1");
			const baseline = await readBaseline(repo, "B1");
			write("b.ts", "b2-own\n");
			// Read-only objects: the snapshot cannot store the new content, so only the diff against HEAD can run.
			const objects = path.join(repo, ".git", "objects");
			const folders = [objects, ...fs.readdirSync(objects).map((name) => path.join(objects, name))].filter((entry) =>
				fs.statSync(entry).isDirectory(),
			);
			for (const folder of folders) fs.chmodSync(folder, 0o555);
			try {
				const { diff, sinceClaim } = await diffOf(repo, ["a.ts", "b.ts"], baseline);
				expect(sinceClaim).toBe(false);
				expect(diff).toContain("a2-before-claim");
			} finally {
				for (const folder of folders) fs.chmodSync(folder, 0o755);
			}
		},
	);

	it("keeps the first baseline on a second claim and removes it on drop", async () => {
		await recordBaseline(repo, "B1");
		const first = await readBaseline(repo, "B1");
		write("b.ts", "b2-own\n");
		await recordBaseline(repo, "B1");
		expect(await readBaseline(repo, "B1")).toBe(first);
		await dropBaseline(repo, "B1");
		expect(await readBaseline(repo, "B1")).toBeUndefined();
		expect(git("for-each-ref", "refs/octocode")).toBe("");
	});

	it("leaves the real index as it was", async () => {
		const before = git("diff", "--cached", "--name-only");
		write("untracked.ts", "x\n");
		await recordBaseline(repo, "B1");
		expect(git("diff", "--cached", "--name-only")).toBe(before);
	});

	it("records nothing outside a git checkout", async () => {
		const plain = fs.mkdtempSync(path.join(os.tmpdir(), "octo-qa-plain-"));
		try {
			await recordBaseline(plain, "B1");
			expect(await readBaseline(plain, "B1")).toBeUndefined();
		} finally {
			fs.rmSync(plain, { recursive: true, force: true });
		}
	});
});

describe("which summaries admit the goal is unmet", () => {
	it.each([
		"Goal not met: ps still spawns twice",
		"The goal was not fully achieved",
		"Not done: the retry path",
		"Partially implemented, the rest is queued",
		"Only partly done",
		"Could not finish the migration",
		"Gap: no test for the failure path",
	])("flags %j", (summary) => expect(admitsGap(summary)).toBe(true));

	it.each([
		"Partial test coverage is a known gap in an unrelated module",
		"Nothing partial remains",
		"Everything is complete and no incomplete work is left",
		"The check did not need a rerun; goal met",
		"Fixed the done guard so the goal is met",
	])("passes %j", (summary) => expect(admitsGap(summary)).toBe(false));
});
